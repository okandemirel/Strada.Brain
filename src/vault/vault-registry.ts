import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { IVault, VaultId, VaultQuery, VaultQueryResult, VaultHit, VaultStats } from './vault.interface.js';
import { isVaultRootAllowed, redactPathsInMessage, resolveExistingVaultRoot } from './path-policy.js';
import { getLoggerSafe } from '../utils/logger.js';

export interface VaultFactory {
  createVault(rootPath: string): IVault | Promise<IVault>;
  allowedRootPaths?: readonly string[];
}

/** Lifecycle state of a vault's async init(), tracked by the registry. */
export interface VaultInitState {
  status: 'indexing' | 'ready' | 'error';
  /** Present only for status 'error'. Pre-redacted, safe for HTTP responses. */
  error?: string;
}

/**
 * Stats payload surfaced by the dashboard stats routes: base VaultStats plus
 * the registry-tracked init lifecycle. Vaults with no tracked init (e.g.
 * directly registered ones) carry neither `status` nor `error`.
 */
export type VaultStatsWithInit = VaultStats & {
  status?: VaultInitState['status'];
  error?: string;
};

const MAX_INIT_ERROR_CHARS = 200;

/**
 * Safely resolve a realpath. Falls back to the input when the path does
 * not exist or realpath fails for any reason — callers should still get
 * a deterministic, canonicalish path to compare against vault roots.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class VaultRegistry {
  private vaults = new Map<VaultId, IVault>();
  private vaultFactory?: VaultFactory;
  private readonly registerListeners = new Set<(vault: IVault) => void>();
  /**
   * Cache of realpath(rootPath) keyed by the original rootPath string.
   * Populated at register() time to avoid per-call realpathSync cost.
   */
  private rootRealpathCache = new Map<string, string>();
  private initStates = new Map<VaultId, VaultInitState>();
  /**
   * User-facing display names keyed by vault id, supplied at register() time
   * (e.g. the name typed into POST /api/vaults). Vaults registered without a
   * name — the config-driven self/unity/obsidian vaults — are absent here, and
   * callers fall back to a kind-derived label. In-memory only: POST-registered
   * vaults are not persisted, so neither is their name (the vault itself does
   * not survive a restart either).
   */
  private readonly names = new Map<VaultId, string>();

  private setInitState(id: VaultId, state: VaultInitState): void {
    this.initStates.set(id, state);
  }
  getInitState(id: VaultId): VaultInitState | undefined {
    return this.initStates.get(id);
  }

  /**
   * Track a fire-and-forget vault init so stats can report its lifecycle.
   * Attaches its own rejection handler (so `init` can never become an
   * unhandled rejection) and stores a redacted, length-capped error message
   * that is safe to surface over HTTP.
   */
  trackInit(vault: IVault, init: Promise<unknown>): void {
    this.setInitState(vault.id, { status: 'indexing' });
    init.then(
      () => this.setInitState(vault.id, { status: 'ready' }),
      (err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        const safe = redactPathsInMessage(raw, vault.rootPath).slice(0, MAX_INIT_ERROR_CHARS);
        this.setInitState(vault.id, { status: 'error', error: safe });
      },
    );
  }

  register(v: IVault, name?: string): void {
    this.vaults.set(v.id, v);
    this.rootRealpathCache.set(v.rootPath, safeRealpath(v.rootPath));
    if (name !== undefined) this.names.set(v.id, name);
    for (const listener of this.registerListeners) listener(v);
  }

  /** Display name supplied at register() time, or undefined if none was given. */
  getName(id: VaultId): string | undefined { return this.names.get(id); }
  onRegister(listener: (vault: IVault) => void): () => void {
    this.registerListeners.add(listener);
    return () => this.registerListeners.delete(listener);
  }
  setFactory(factory: VaultFactory): void {
    this.vaultFactory = factory;
  }
  hasFactory(): boolean {
    return this.vaultFactory !== undefined;
  }
  async createAndRegister(rootPath: string): Promise<IVault> {
    if (!this.vaultFactory) {
      throw new Error('vault factory unavailable');
    }
    const root = await resolveExistingVaultRoot(rootPath);
    if (!root.ok) {
      throw new Error(root.error);
    }
    const allowedRootPaths = this.vaultFactory.allowedRootPaths ?? [];
    if (allowedRootPaths.length === 0 || !await isVaultRootAllowed(root.realPath, allowedRootPaths)) {
      throw new Error('vault root is outside the allowed project roots');
    }
    const vault = await this.vaultFactory.createVault(root.realPath);
    this.register(vault);
    return vault;
  }
  unregister(id: VaultId): void {
    const v = this.vaults.get(id);
    if (v) this.rootRealpathCache.delete(v.rootPath);
    this.vaults.delete(id);
    this.initStates.delete(id);
    this.names.delete(id);
    // Best-effort dispose: the dashboard DELETE route disposed explicitly, but
    // every other caller silently leaked the vault's watcher fds and SQLite
    // handles for process lifetime. dispose() is idempotent across the vault
    // implementations (guarded store.close, null-safe stopWatch), so the
    // explicit disposes elsewhere stay harmless.
    if (v) void v.dispose().catch(() => undefined);
  }
  get(id: VaultId): IVault | undefined { return this.vaults.get(id); }

  /**
   * The id a caller meant, when they did not have the exact one to hand.
   *
   * Ids are qualified ("self:strada-brain", "obsidian:3f2a1b9c") but the names
   * that reach a caller are the kinds — vault_search's own description offers
   * 'self' as an example. Measured on a live run: the agent followed that
   * description and got "vault not found: self" twice.
   *
   * Exact id wins. Otherwise a kind, or an id prefix, but only when it picks
   * out exactly one vault — an ambiguous guess is not a resolution.
   */
  resolve(requested: string): IVault | undefined {
    const exact = this.vaults.get(requested);
    if (exact) return exact;

    const all = this.list();
    const byKind = all.filter((v) => v.kind === requested);
    if (byKind.length === 1) return byKind[0];

    const byPrefix = all.filter((v) => v.id.startsWith(`${requested}:`));
    if (byPrefix.length === 1) return byPrefix[0];

    // A bare hash. Measured 2026-09-06: every vault_search an agent ever
    // issued in the PixelFlow campaign (three, across two weeks) failed with
    // "vault not found: 4ca9bd33 — registered: unity:4ca9bd33, …": the agent
    // copied the id it saw in a log line without its kind prefix, the exact
    // match missed, and the indexed 84 MB project vault answered nothing. An
    // id that is unambiguous without its prefix is not a wrong id.
    const bySuffix = all.filter((v) => v.id.endsWith(`:${requested}`));
    return bySuffix.length === 1 ? bySuffix[0] : undefined;
  }

  /** Registered ids, for an error that can be acted on rather than guessed at. */
  ids(): string[] { return [...this.vaults.keys()]; }
  list(): IVault[] { return [...this.vaults.values()]; }

  /**
   * Resolve the registered vault whose rootPath is a prefix of the given
   * absolute or relative path. Longest-prefix wins to handle nested vaults.
   *
   * Security: both the input path and each vault rootPath are normalized
   * via `realpathSync` (cached for roots) before prefix comparison. This
   * prevents symlink-based escapes and handles callers that pass non-
   * canonical paths (e.g. /var vs /private/var on macOS).
   *
   * Returns `undefined` if no vault owns the path.
   */
  resolveVaultForPath(absOrRelPath: string, cwd?: string): IVault | undefined {
    const resolved = isAbsolute(absOrRelPath)
      ? absOrRelPath
      : resolve(cwd ?? process.cwd(), absOrRelPath);
    const abs = safeRealpath(resolved);
    let best: IVault | undefined;
    let bestLen = -1;
    for (const v of this.vaults.values()) {
      const rootCanonical = this.rootRealpathCache.get(v.rootPath) ?? safeRealpath(v.rootPath);
      const root = rootCanonical.endsWith(sep) ? rootCanonical : rootCanonical + sep;
      const candidate = abs.endsWith(sep) ? abs : abs + sep;
      if (candidate.startsWith(root) && root.length > bestLen) {
        best = v;
        bestLen = root.length;
      }
    }
    return best;
  }

  async query(q: VaultQuery, vaultIds?: VaultId[]): Promise<VaultQueryResult> {
    const targets = vaultIds?.length
      ? vaultIds.map((id) => this.vaults.get(id)).filter((v): v is IVault => !!v)
      : [...this.vaults.values()];
    const settled = await Promise.allSettled(targets.map((v) => v.query(q)));
    const merged: VaultHit[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        merged.push(...s.value.hits);
      }
    }
    merged.sort((a, b) => b.scores.rrf - a.scores.rrf);
    const capped = q.topK ? merged.slice(0, q.topK) : merged;
    return {
      hits: capped,
      budgetUsed: capped.reduce((a, h) => a + h.chunk.tokenCount, 0),
      truncated: capped.length < merged.length,
    };
  }

  async disposeAll(): Promise<void> {
    // allSettled, not sequential await: one throwing dispose used to abort the
    // loop, and every vault after it leaked its watcher fds and SQLite handles
    // while the map clears below were skipped too.
    const vaults = [...this.vaults.values()];
    const settled = await Promise.allSettled(vaults.map((v) => v.dispose()));
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        getLoggerSafe().warn('[VaultRegistry] vault dispose failed during shutdown', {
          vaultId: vaults[index]?.id,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    this.vaults.clear();
    this.rootRealpathCache.clear();
    this.names.clear();
    this.registerListeners.clear();
    this.initStates.clear();
  }
}
