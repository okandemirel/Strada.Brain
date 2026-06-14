/**
 * Provider Model Catalog
 *
 * Caches live `listModels()` results per provider with a TTL so Strada's
 * model lists reflect each provider's actual catalog instead of a stale
 * hardcoded table.
 *
 * Phase 1: pure-ish, dependency-injected, fully unit-tested catalog class.
 * It structurally implements the `ProviderModelCatalogLookup` shape declared
 * in `provider-manager.ts` so a later phase can pass it to
 * `ProviderManager.setModelCatalog()`. No disk I/O, ProviderManager wiring,
 * API routes, or startup integration here — those are Phase 2+.
 */

import type { RefreshResult, ProviderCatalogHealth } from "./provider-types.js";
import type { ProviderOfficialSnapshot } from "./provider-source-registry.js";

/** A single cached model entry. Matches `getProviderModels`'s `{ id }` return. */
export interface ModelInfo {
  readonly id: string;
}

/**
 * The per-provider model lists fed in by the injected loader. In real use this
 * is `() => providerManager.listAvailableWithModels()`, hence the shape mirrors
 * that method's return type (notably `models: string[]`).
 */
export type LoadedProviders = Array<{
  readonly name: string;
  readonly models: string[];
  // listAvailableWithModels() carries more fields; they are accepted but unused
  // here so the real loader's return type assigns cleanly.
  readonly label?: string;
  readonly defaultModel?: string;
}>;

/** A point-in-time snapshot of the whole catalog, used for persistence. */
export interface Snapshot {
  readonly providers: Record<string, { readonly models: ModelInfo[]; readonly fetchedAt: number }>;
}

/**
 * Persistence boundary. The on-DISK implementation is a later phase; here we
 * only define the interface and call it.
 */
export interface CatalogPersist {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export interface ProviderModelCatalogOptions {
  /** Injected async loader returning the per-provider model lists. */
  readonly load: () => Promise<LoadedProviders>;
  /** Injected clock so tests control time. Never call Date.now() in the class. */
  readonly now: () => number;
  /** Staleness window in milliseconds. */
  readonly ttlMs: number;
  /** Optional persistence boundary (disk impl is a later phase). */
  readonly persist?: CatalogPersist;
  /** Injectable for tests; defaults to the global `setInterval`. */
  readonly setIntervalFn?: (callback: () => void, ms: number) => IntervalHandle;
  /** Injectable for tests; defaults to the global `clearInterval`. */
  readonly clearIntervalFn?: (handle: IntervalHandle) => void;
}

/** Opaque interval handle; Node's timer exposes `.unref()`, the browser's does not. */
type IntervalHandle = { unref?: () => void };

interface CacheEntry {
  models: ModelInfo[];
  fetchedAt: number;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export class ProviderModelCatalog {
  private readonly load: () => Promise<LoadedProviders>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly persist?: CatalogPersist;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly setIntervalFn: (callback: () => void, ms: number) => IntervalHandle;
  private readonly clearIntervalFn: (handle: IntervalHandle) => void;
  private autoRefreshTimer?: IntervalHandle;
  private refreshInFlight = false;

  constructor(options: ProviderModelCatalogOptions) {
    this.load = options.load;
    this.now = options.now;
    this.ttlMs = options.ttlMs;
    this.persist = options.persist;
    this.setIntervalFn =
      options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms) as unknown as IntervalHandle);
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));
  }

  /**
   * Begin refreshing the catalog every `intervalMs` so model lists stay current
   * without a manual trigger. The interval is `unref`'d so it never keeps the
   * process alive, and overlapping ticks are skipped while a prior refresh is
   * still in flight. Calling again first stops any existing timer.
   */
  startAutoRefresh(intervalMs: number): void {
    this.stopAutoRefresh();
    const timer = this.setIntervalFn(() => {
      if (this.refreshInFlight) {
        return;
      }
      this.refreshInFlight = true;
      void this.refresh().finally(() => {
        this.refreshInFlight = false;
      });
    }, intervalMs);
    timer.unref?.();
    this.autoRefreshTimer = timer;
  }

  /** Stop the periodic refresh started by `startAutoRefresh`. Safe to call when not running. */
  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      this.clearIntervalFn(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  /**
   * Factory that constructs the catalog and seeds the in-memory map from
   * `persist.load()` (if a persistence boundary is configured) so first reads
   * are warm. Constructors cannot be async, so seeding lives here / in init().
   */
  static async create(options: ProviderModelCatalogOptions): Promise<ProviderModelCatalog> {
    const catalog = new ProviderModelCatalog(options);
    await catalog.init();
    return catalog;
  }

  /** Seed the in-memory map from persisted state. Safe to call zero or once. */
  async init(): Promise<void> {
    if (!this.persist) {
      return;
    }
    const snapshot = await this.persist.load();
    if (!snapshot) {
      return;
    }
    for (const [name, entry] of Object.entries(snapshot.providers)) {
      this.cache.set(normalizeName(name), {
        models: entry.models.map((model) => ({ id: model.id })),
        fetchedAt: entry.fetchedAt,
      });
    }
  }

  /**
   * Returns the cached models for a provider, or `[]` if absent.
   * Matches `ProviderModelCatalogLookup.getProviderModels`.
   */
  getProviderModels(provider: string): ModelInfo[] {
    return this.cache.get(normalizeName(provider))?.models ?? [];
  }

  /** Build a serializable snapshot of the current in-memory cache. */
  snapshot(): Snapshot {
    const providers: Record<string, { models: ModelInfo[]; fetchedAt: number }> = {};
    for (const [name, entry] of this.cache.entries()) {
      providers[name] = {
        models: entry.models.map((model) => ({ id: model.id })),
        fetchedAt: entry.fetchedAt,
      };
    }
    return { providers };
  }

  /**
   * `true` if the provider is absent OR its cached entry is older than `ttlMs`.
   */
  isStale(provider: string): boolean {
    const entry = this.cache.get(normalizeName(provider));
    if (!entry) {
      return true;
    }
    return this.now() - entry.fetchedAt > this.ttlMs;
  }

  /** Epoch-ms the provider's cache entry was last refreshed, or `undefined` if absent. */
  getFetchedAt(provider: string): number | undefined {
    return this.cache.get(normalizeName(provider))?.fetchedAt;
  }

  /**
   * Calls the injected loader, refreshes the in-memory map (stamping
   * `fetchedAt = now()`), persists the snapshot, and returns a RefreshResult.
   * A whole-loader rejection is captured in `errors` and never thrown.
   */
  async refresh(): Promise<RefreshResult> {
    const errors: string[] = [];
    let modelsUpdated = 0;

    let loaded: LoadedProviders;
    try {
      loaded = await this.load();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { modelsUpdated: 0, source: "cache", errors };
    }

    const fetchedAt = this.now();
    for (const entry of loaded) {
      const models: ModelInfo[] = entry.models.map((id) => ({ id }));
      this.cache.set(normalizeName(entry.name), { models, fetchedAt });
      modelsUpdated += models.length;
    }

    if (this.persist) {
      try {
        await this.persist.save(this.snapshot());
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return { modelsUpdated, source: "cache", errors };
  }

  /**
   * Optional member of the `ProviderModelCatalogLookup` shape consumed by
   * ProviderManager. Live official snapshots are out of scope for Phase 1
   * (this catalog only tracks live `listModels()` results), so this is a stub.
   */
  getProviderOfficialSnapshot(_provider: string): ProviderOfficialSnapshot | undefined {
    return undefined;
  }

  /**
   * Optional member of the `ProviderModelCatalogLookup` shape consumed by
   * ProviderManager. Catalog-health telemetry is out of scope for Phase 1.
   */
  getCatalogHealth(_provider: string): ProviderCatalogHealth | undefined {
    return undefined;
  }
}

// Compile-time guarantee that ProviderModelCatalog satisfies the structural
// shape ProviderManager.setModelCatalog() expects. This mirrors the
// (non-exported) `ProviderModelCatalogLookup` interface in provider-manager.ts
// without importing it, keeping Phase 1 decoupled from ProviderManager. If the
// real interface drifts, update this local copy in lockstep.
type ProviderModelCatalogLookupShape = {
  getProviderModels(provider: string): Array<{ id: string }>;
  getProviderOfficialSnapshot?(provider: string): ProviderOfficialSnapshot | undefined;
  getCatalogHealth?(provider: string): ProviderCatalogHealth | undefined;
  refresh?(): Promise<RefreshResult>;
};

// Purely type-level assertion (no runtime binding, so `noUnusedLocals` is
// satisfied). `AssertTrue<T>` only resolves when T is exactly `true`; if the
// class stops being assignable to the lookup shape, the conditional yields
// `false` and this alias errors, failing `npm run typecheck`.
type AssertTrue<T extends true> = T;
export type AssertCatalogImplementsLookup = AssertTrue<
  ProviderModelCatalog extends ProviderModelCatalogLookupShape ? true : false
>;
