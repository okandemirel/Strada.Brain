/**
 * Provider Manager
 *
 * Manages per-chat AI provider selection with SQLite-backed persistence.
 * Wraps provider access so the Orchestrator can resolve the correct
 * provider for each chat based on user preferences or the system default.
 */

import { join } from "node:path";
import type { IAIProvider } from "./provider.interface.js";
import type { ProviderCapabilities } from "./provider.interface.js";
import { buildProviderChain, createProvider, PROVIDER_PRESETS } from "./provider-registry.js";
import type { ProviderCredentialMap } from "./provider-registry.js";
import { ProviderPreferenceStore } from "./provider-preferences.js";
import type { ProviderSelectionMode } from "./provider-preferences.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { getLogger } from "../../utils/logger.js";
import { ProviderError } from "../../common/errors.js";
import { LRUCache } from "../../common/lru-cache.js";
import type { ProviderOfficialSnapshot } from "./provider-source-registry.js";
import type {
  RefreshResult,
  ProviderActiveInfo,
  ProviderDescriptor,
  ProviderExecutionCandidate,
  ProviderCatalogHealth,
} from "./provider-types.js";
import { ProviderCatalog, type ProviderCatalogSnapshot } from "./provider-catalog.js";
import { canonicalizeProviderName, toBareModelId } from "./provider-identity.js";

// Re-export shared types so existing consumers of this module are unaffected
export type {
  ProviderActiveInfo,
  ProviderDescriptor,
  ProviderExecutionCandidate,
  ProviderCatalogHealth,
} from "./provider-types.js";

interface ProviderModelCatalogLookup {
  getProviderModels(provider: string): Array<{ id: string }>;
  getProviderOfficialSnapshot?(provider: string): ProviderOfficialSnapshot | undefined;
  getCatalogHealth?(provider: string): ProviderCatalogHealth | undefined;
  refresh?(): Promise<RefreshResult>;
  isStale?(provider: string): boolean;
  getFetchedAt?(provider: string): number | undefined;
}

const MAX_CACHED_PROVIDERS = 50;
/** First-response timeouts for one (provider, model) before it is auto-demoted
 *  from the brain-wide global default. Small so a dead model self-heals quickly,
 *  but >1 so a single transient blip doesn't demote a good model. */
const MODEL_UNRESPONSIVE_DEMOTE_THRESHOLD = 2;
const EXECUTION_POLICY_NOTE =
  "Strada remains the control plane. This selection biases routing toward the preferred provider/model, but planning, execution, review, and synthesis may still route dynamically unless an explicit hard pin is requested.";
const HARD_PIN_EXECUTION_POLICY_NOTE =
  "Strada remains the control plane, but this conversation is hard-pinned to the selected provider/model. Planning, execution, review, and synthesis must stay on that provider until the pin is removed.";

const CAPABILITY_ALIGNMENT_NEUTRAL = 0.5;
const CAPABILITY_ALIGNMENT_MISMATCH = 0.25;

function normalizeProviderFeatureTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scoreCatalogFreshness(ageMs: number, refreshIntervalMs: number): number {
  const interval = Math.max(refreshIntervalMs, 60_000);
  const decay = Math.min(ageMs / (interval * 4), 1);
  return Math.max(0.25, 1 - decay * 0.75);
}

function computeOfficialAlignment(
  model: string,
  baseCapabilities: ProviderCapabilities | undefined,
  officialSnapshot: ProviderOfficialSnapshot | undefined,
): { score: number; reasons: string[] } {
  if (!officialSnapshot) {
    return { score: CAPABILITY_ALIGNMENT_NEUTRAL, reasons: [] };
  }

  const officialTags = new Set(officialSnapshot.featureTags.map(normalizeProviderFeatureTag));
  const officialModels = officialSnapshot.signals
    .filter((signal) => signal.kind === "model")
    .map((signal) => signal.value)
    .filter(Boolean);
  const reasons: string[] = [];
  const checks: number[] = [];

  if (officialModels.length > 0) {
    const normalizedModel = normalizeModelId(model);
    const modelMatch = officialModels.some((officialModel) => normalizeModelId(officialModel) === normalizedModel);
    checks.push(modelMatch ? 1 : 0.35);
    if (!modelMatch) {
      reasons.push("default-model-missing-from-official-catalog");
    }
  }

  const capabilityChecks: Array<{
    readonly tag: string;
    readonly enabled: boolean | undefined;
    readonly reason: string;
  }> = [
    {
      tag: "tool-calling",
      enabled: baseCapabilities?.toolCalling,
      reason: "tool-calling-not-reflected-locally",
    },
    {
      tag: "reasoning",
      enabled: baseCapabilities?.thinkingSupported,
      reason: "reasoning-not-reflected-locally",
    },
    {
      tag: "multimodal",
      enabled: baseCapabilities?.vision,
      reason: "multimodal-not-reflected-locally",
    },
    {
      tag: "streaming",
      enabled: baseCapabilities?.streaming,
      reason: "streaming-not-reflected-locally",
    },
  ];

  for (const check of capabilityChecks) {
    if (!officialTags.has(check.tag)) {
      continue;
    }
    const aligned = Boolean(check.enabled);
    checks.push(aligned ? 1 : CAPABILITY_ALIGNMENT_MISMATCH);
    if (!aligned) {
      reasons.push(check.reason);
    }
  }

  if (checks.length === 0) {
    return { score: CAPABILITY_ALIGNMENT_NEUTRAL, reasons };
  }

  return {
    score: checks.reduce((sum, value) => sum + value, 0) / checks.length,
    reasons,
  };
}

export class ProviderManager {
  private readonly preferences: ProviderPreferenceStore;
  private readonly providerCache = new LRUCache<string, IAIProvider>(MAX_CACHED_PROVIDERS);
  private readonly primaryProviderCache = new LRUCache<string, IAIProvider>(MAX_CACHED_PROVIDERS);
  private readonly catalog: ProviderCatalog;
  private ollamaVerified = false;
  private modelCatalog?: ProviderModelCatalogLookup;
  /** Consecutive first-response timeout strikes per `provider::model`, for auto-demote. */
  private readonly modelUnresponsiveCounts = new Map<string, number>();

  constructor(
    private readonly defaultProvider: IAIProvider,
    private readonly providerCredentials: ProviderCredentialMap,
    private readonly modelOverrides?: Record<string, string>,
    preferencesDbPath?: string,
    private readonly defaultProviderOrder: readonly string[] = [],
    private readonly ollamaBaseUrl?: string,
    private readonly baseUrlOverrides?: Record<string, string>,
    /** Per-attempt first-response timeout (ms) threaded into every chain we build,
     *  so an unresponsive model fails over instead of hanging. 0/undefined = disabled. */
    private readonly providerResponseTimeoutMs?: number,
  ) {
    const dbPath = preferencesDbPath ?? process.env["MEMORY_DB_PATH"] ?? join(process.cwd(), ".strada-memory");
    this.preferences = new ProviderPreferenceStore(
      join(dbPath, "provider-preferences.db"),
    );
    this.preferences.initialize();
    this.seedGlobalDefaultFromMostRecent();
    this.catalog = new ProviderCatalog(this);
  }

  /**
   * One-time migration: preferences set BEFORE the global-mirror existed have no global
   * row, so a churned profile would still revert. If the global default is absent, seed
   * it from the most recent existing selection so pre-fix choices survive profileId
   * churn without forcing the user to re-select. Never overwrites an existing global.
   */
  private seedGlobalDefaultFromMostRecent(): void {
    if (this.preferences.get(ProviderManager.GLOBAL_PREFERENCE_KEY)) {
      return;
    }
    const recent = this.preferences.getMostRecent?.(ProviderManager.GLOBAL_PREFERENCE_KEY);
    if (!recent) {
      return;
    }
    this.preferences.set(
      ProviderManager.GLOBAL_PREFERENCE_KEY,
      recent.providerName,
      recent.model,
      recent.selectionMode,
    );
    getLogger().info("Seeded brain-wide global provider default from most recent selection", {
      providerName: recent.providerName,
      model: recent.model,
    });
  }

  getProvider(chatId: string): IAIProvider {
    const pref = this.resolveEffectivePreference(chatId);
    if (!pref) return this.defaultProvider;

    if (pref.selectionMode === "strada-hard-pin") {
      const pinned = this.buildPrimaryProvider(pref.providerName, pref.model);
      if (pinned) {
        return pinned;
      }
      // A hard pin is a contract: never silently downgrade to the default chain
      // (the previous behavior). Surface the failure so the caller/user can clear
      // the pin or restore credentials instead of unknowingly running elsewhere.
      getLogger().error("Hard-pinned provider could not be built; refusing to silently fall back", {
        chatId,
        provider: pref.providerName,
        model: pref.model,
      });
      throw new ProviderError(
        pref.providerName,
        `Chat ${chatId} is hard-pinned to '${pref.providerName}' but the provider could not be built (credentials removed/rotated after pinning). Clear the pin or restore credentials.`,
        "HARD_PIN_UNAVAILABLE",
        { chatId, model: pref.model },
      );
    }

    const provider = this.buildResilientProvider(pref.providerName, pref.model);
    if (provider) {
      return provider;
    }

    getLogger().warn("Failed to create preferred provider, using default", {
      chatId,
      provider: pref.providerName,
      model: pref.model,
    });
    return this.defaultProvider;
  }

  private buildResilientProvider(primaryName: string, model?: string): IAIProvider | null {
    const order = this.buildFallbackOrder(primaryName);
    if (order.length === 0) {
      return null;
    }
    if (order.length === this.defaultProviderOrder.length &&
        order.every((name, index) => name === this.defaultProviderOrder[index]) &&
        !model) {
      return this.defaultProvider;
    }

    const cacheKey = this.buildCacheKey(order, primaryName, model);
    const cached = this.providerCache.get(cacheKey);
    if (cached) return cached;

    try {
      const provider = buildProviderChain(order, this.providerCredentials, {
        models: model ? { ...this.modelOverrides, [primaryName]: model } : this.modelOverrides,
        baseUrls: this.resolveBaseUrlOverrides(),
        attemptTimeoutMs: this.providerResponseTimeoutMs,
        onModelUnresponsive: (p, m) => this.recordModelUnresponsive(p, m),
        onModelResponsive: (p, m) => this.recordModelResponsive(p, m),
      });
      this.providerCache.set(cacheKey, provider);
      return provider;
    } catch (error) {
      getLogger().warn("Failed to create preferred provider, using default", {
        provider: primaryName,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildFallbackOrder(primaryName: string): string[] {
    const normalizedPrimary = canonicalizeProviderName(primaryName) ?? primaryName.trim().toLowerCase();
    const seen = new Set<string>();
    const order: string[] = [];

    if (normalizedPrimary) {
      seen.add(normalizedPrimary);
      order.push(normalizedPrimary);
    }

    for (const name of this.defaultProviderOrder) {
      const normalized = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      order.push(normalized);
    }

    return order;
  }

  private buildCacheKey(order: readonly string[], primaryName: string, model?: string): string {
    return `chain:${order.join(">")}:${primaryName}:${model ?? "(default)"}`;
  }

  /**
   * Per-provider base-URL overrides handed to buildProviderChain. Merges the
   * ollama base URL (threaded separately for backward compatibility) with any
   * additional overrides (e.g. opencode's OPENCODE_BASE_URL). Returns undefined
   * when there is nothing to override so the registry uses preset base URLs.
   */
  private resolveBaseUrlOverrides(): Record<string, string> | undefined {
    const merged: Record<string, string> = { ...this.baseUrlOverrides };
    if (this.ollamaBaseUrl) {
      merged["ollama"] = this.ollamaBaseUrl;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private getDefaultPrimaryName(): string {
    return canonicalizeProviderName(this.defaultProviderOrder[0] ?? this.defaultProvider.name)
      ?? this.defaultProvider.name.trim().toLowerCase();
  }

  private getDefaultModelForProvider(name: string): string {
    const canonicalName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    if (canonicalName === "claude" || canonicalName === "anthropic") {
      return this.modelOverrides?.[canonicalName] ?? "claude-sonnet-4-6-20250514";
    }
    if (canonicalName === "ollama") {
      return this.modelOverrides?.[canonicalName] ?? "llama3.3";
    }
    return this.modelOverrides?.[canonicalName] ?? PROVIDER_PRESETS[canonicalName]?.defaultModel ?? "default";
  }

  private buildPrimaryProvider(name: string, model?: string): IAIProvider | null {
    const normalizedName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    if (!normalizedName) {
      return null;
    }

    const cacheKey = `primary:${normalizedName}:${model ?? "(default)"}`;
    const cached = this.primaryProviderCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const provider = createProvider({
        name: normalizedName,
        apiKey: this.providerCredentials[normalizedName]?.apiKey,
        openaiAuthMode: this.providerCredentials[normalizedName]?.openaiAuthMode,
        openaiChatgptAuthFile: this.providerCredentials[normalizedName]?.openaiChatgptAuthFile,
        openaiSubscriptionAccessToken: this.providerCredentials[normalizedName]?.openaiSubscriptionAccessToken,
        openaiSubscriptionAccountId: this.providerCredentials[normalizedName]?.openaiSubscriptionAccountId,
        model: model ?? this.modelOverrides?.[normalizedName],
        baseUrl: this.resolveBaseUrlOverrides()?.[normalizedName],
      });
      this.primaryProviderCache.set(cacheKey, provider);
      return provider;
    } catch (error) {
      getLogger().warn("Failed to create primary provider metadata", {
        provider: normalizedName,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  getActiveInfo(chatId: string): ProviderActiveInfo {
    const pref = this.resolveEffectivePreference(chatId);
    if (!pref) {
      const defaultProviderName = this.getDefaultPrimaryName();
      return this.withHealth({
        providerName: defaultProviderName,
        model: this.getDefaultModelForProvider(defaultProviderName),
        isDefault: true,
        selectionMode: "strada-preference-bias",
        executionPolicyNote: EXECUTION_POLICY_NOTE,
      });
    }

    const providerName = canonicalizeProviderName(pref.providerName) ?? pref.providerName;
    return this.withHealth({
      providerName,
      // Route through getDefaultModelForProvider (as the no-preference branch
      // does) so providers without a PROVIDER_PRESETS entry — claude/anthropic/
      // ollama — report their real default instead of the literal "default".
      model: pref.model ?? this.getDefaultModelForProvider(providerName),
      isDefault: false,
      selectionMode: pref.selectionMode,
      executionPolicyNote: pref.selectionMode === "strada-hard-pin"
        ? HARD_PIN_EXECUTION_POLICY_NOTE
        : EXECUTION_POLICY_NOTE,
    });
  }

  /**
   * Attach live provider health to ProviderActiveInfo, but ONLY when the provider is
   * NOT healthy — so a user/dashboard can see "this provider is degraded/down (last
   * error: …)" instead of silently discovering it at call time (RC-3). When healthy or
   * unknown the object is returned unchanged (keeps the common shape minimal).
   */
  private withHealth(info: ProviderActiveInfo): ProviderActiveInfo {
    const entry = ProviderHealthRegistry.getInstance().getEntry(info.providerName);
    if (!entry || entry.status === "healthy") {
      return info;
    }
    return {
      ...info,
      healthStatus: entry.status,
      ...(entry.lastError ? { healthError: entry.lastError } : {}),
    };
  }

  /**
   * Stable, identity-independent key that mirrors the most recent explicit selection
   * as a brain-wide default. Per-provider/model preferences were keyed by the EPHEMERAL
   * web profileId; when that churned (page reload / new browser / lost token → a fresh
   * `issue()`), the per-profile row was orphaned and getActiveInfo/getProvider silently
   * reverted to the SYSTEM DEFAULT — the chronic "no matter what I pick it reverts". The
   * mirror lets a brand-new profile inherit the last selection instead of reverting. An
   * explicit per-chat preference still takes precedence. The sentinel cannot collide with
   * a real chatId/profileId (those are UUIDs / channel-scoped ids).
   */
  private static readonly GLOBAL_PREFERENCE_KEY = "__strada_global_default__";

  /**
   * Resolve the effective preference for a chat: the explicit per-chat row if present,
   * otherwise the brain-wide global default (mirror). Centralised so every read path
   * (getActiveInfo, getProvider, listExecutionCandidates) resolves identically.
   */
  private resolveEffectivePreference(chatId: string) {
    return this.preferences.get(chatId)
      ?? this.preferences.get(ProviderManager.GLOBAL_PREFERENCE_KEY);
  }

  /**
   * Whether the live model catalog confirms `provider` serves `model`. Used to
   * gate what may become the brain-wide GLOBAL default. An empty/unknown catalog
   * for the provider means "cannot determine" (catalog not yet warmed, or probe
   * failed) and must NOT be treated as invalid — only a KNOWN, non-empty catalog
   * that omits the model returns false. Matches both bare and `provider/`-namespaced ids.
   */
  private isModelKnownToCatalog(providerName: string, model: string): boolean {
    const known = this.modelCatalog?.getProviderModels(providerName) ?? [];
    if (known.length === 0) return true; // catalog unknown — cannot disprove, don't block
    const bare = toBareModelId(model);
    return known.some((m) => {
      return m.id === model || toBareModelId(m.id) === bare || m.id === `${providerName}/${model}`;
    });
  }

  setPreference(
    chatId: string,
    providerName: string,
    model?: string,
    selectionMode: ProviderSelectionMode = "strada-preference-bias",
  ): void {
    const canonicalName = canonicalizeProviderName(providerName) ?? providerName.trim().toLowerCase();
    this.preferences.set(chatId, canonicalName, model, selectionMode);
    // Mirror to the stable global key so the selection survives web-profileId churn.
    // Guard against recursing on the sentinel itself. Do NOT mirror a model the live
    // catalog says the provider no longer serves: a per-chat pick is the user's own
    // (explicit) risk, but a de-supported model must never silently become the
    // brain-wide default for every other chat (the per-chat row still applies).
    if (chatId !== ProviderManager.GLOBAL_PREFERENCE_KEY) {
      if (!model || this.isModelKnownToCatalog(canonicalName, model)) {
        this.preferences.set(ProviderManager.GLOBAL_PREFERENCE_KEY, canonicalName, model, selectionMode);
      } else {
        getLogger().warn("Not mirroring an unlisted model to the global default", {
          providerName: canonicalName,
          model,
          hint: "The live catalog does not list this model; the per-chat preference still applies but the brain-wide default is left unchanged so other chats are unaffected.",
        });
      }
    }
    getLogger().info("Provider preference set", {
      chatId,
      providerName: canonicalName,
      originalProviderName: providerName,
      model,
      selectionMode,
    });
  }

  clearPreference(chatId: string): void {
    this.preferences.delete(chatId);
    getLogger().info("Provider preference cleared", { chatId });
  }

  setModelCatalog(modelCatalog?: ProviderModelCatalogLookup): void {
    this.modelCatalog = modelCatalog;
  }

  /**
   * Record that a (provider, model) attempt timed out with no first response. After
   * MODEL_UNRESPONSIVE_DEMOTE_THRESHOLD strikes, if that model is the brain-wide global
   * default AND was auto-selected (strada-preference-bias, not a deliberate hard pin),
   * demote it: clear the global default so new chats fall back to the provider's own
   * default model. A dead model thus self-heals instead of hanging every new chat.
   */
  recordModelUnresponsive(providerName: string, model: string): void {
    if (!model) return;
    const canonical = canonicalizeProviderName(providerName) ?? providerName.trim().toLowerCase();
    const key = `${canonical}::${model}`;
    const strikes = (this.modelUnresponsiveCounts.get(key) ?? 0) + 1;
    this.modelUnresponsiveCounts.set(key, strikes);
    if (strikes < MODEL_UNRESPONSIVE_DEMOTE_THRESHOLD) return;

    const globalPref = this.preferences.get(ProviderManager.GLOBAL_PREFERENCE_KEY);
    const matchesGlobalDefault = globalPref
      && globalPref.selectionMode === "strada-preference-bias"
      && (canonicalizeProviderName(globalPref.providerName) ?? globalPref.providerName) === canonical
      // Model match, OR a provider-only default (no explicit model): in that
      // case the chain only ever runs the provider's DEFAULT model, so the model that
      // just timed out IS that default — demote the provider-only default too.
      // Compare BARE-vs-BARE: the chain reports bare runtime ids (e.g. OpenCode's
      // `qwen3.6-plus`) while the preference stores the namespaced form
      // (`opencode/qwen3.6-plus`); strict equality would silently never fire.
      && (toBareModelId(globalPref.model) === toBareModelId(model) || !globalPref.model);
    if (matchesGlobalDefault) {
      this.preferences.delete(ProviderManager.GLOBAL_PREFERENCE_KEY);
      this.modelUnresponsiveCounts.delete(key);
      getLogger().warn("Auto-demoted an unresponsive model from the global default", {
        providerName: canonical,
        model,
        strikes,
        hint: "New chats fall back to the provider's default model; set a different model to re-pin.",
      });
    }
  }

  /** Clear a model's unresponsive streak after a successful attempt. */
  recordModelResponsive(providerName: string, model: string): void {
    if (!model) return;
    const canonical = canonicalizeProviderName(providerName) ?? providerName.trim().toLowerCase();
    this.modelUnresponsiveCounts.delete(`${canonical}::${model}`);
  }

  async refreshModelCatalog(): Promise<RefreshResult | null> {
    if (!this.modelCatalog?.refresh) {
      return null;
    }
    return this.modelCatalog.refresh();
  }

  /**
   * Minimal freshness lookup for the dynamic model catalog, surfaced so dashboard
   * routes can annotate per-provider model lists with staleness without reaching
   * into the catalog directly. Returns `undefined` when no catalog is wired.
   */
  getModelCatalogFreshness(name: string): { stale: boolean; fetchedAt?: number } | undefined {
    if (!this.modelCatalog) {
      return undefined;
    }
    const canonicalName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    const stale = this.modelCatalog.isStale?.(canonicalName) ?? true;
    const fetchedAt = this.modelCatalog.getFetchedAt?.(canonicalName);
    return fetchedAt === undefined ? { stale } : { stale, fetchedAt };
  }

  getCatalogSnapshot(identityKey?: string): ProviderCatalogSnapshot {
    return this.catalog.snapshot(identityKey);
  }

  getRoutingMetadata(providerName: string, model?: string, identityKey?: string) {
    return this.catalog.getRoutingMetadata(providerName, model, identityKey);
  }

  async listAvailableWithModels(): Promise<
    Array<{
      name: string;
      label: string;
      defaultModel: string;
      models: string[];
      contextWindow?: number;
      thinkingSupported?: boolean;
      specialFeatures?: string[];
      officialSignals?: ProviderOfficialSnapshot["signals"];
      officialSourceUrls?: string[];
      catalogUpdatedAt?: number;
    }>
  > {
    const available = this.listAvailable();
    const AGGREGATE_TIMEOUT = 30_000;
    // Capture the fallback timer so it can be cleared once the race settles.
    // Otherwise, whenever allSettled wins (the normal case), the 30s timer stays
    // ref'd on the event loop — delaying clean shutdown and stacking one timer
    // per call under bursty dashboard polling.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled(
        available.map(async (p) => {
          let models = [p.defaultModel];
          try {
            const provider = this.getProviderByName(p.name);
            if (provider?.listModels) {
              models = await provider.listModels();
            }
          } catch {
            // Fallback to default model
          }
          const catalogModels = this.modelCatalog?.getProviderModels(p.name).map((model) => model.id) ?? [];
          const officialModels = this.getProviderOfficialSnapshot(p.name)?.signals
            .filter((signal) => signal.kind === "model")
            .map((signal) => signal.value) ?? [];
          models = [...new Set([...models, ...catalogModels, ...officialModels, p.defaultModel])];
          return { ...p, models };
        }),
      ),
      new Promise<PromiseSettledResult<{ name: string; label: string; defaultModel: string; models: string[] }>[]>(
        (resolve) => {
          timeoutId = setTimeout(() => resolve(available.map((p) => ({
            status: "fulfilled" as const,
            value: { ...p, models: [p.defaultModel] },
          }))), AGGREGATE_TIMEOUT);
        },
      ),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    return settled.map((r) => r.status === "fulfilled" ? r.value : { name: "", label: "", defaultModel: "", models: [] }).filter(r => r.name);
  }

  /**
   * Get a provider instance by name. Used by ProviderRouter to
   * materialize a routing decision into an IAIProvider.
   * Returns null if provider cannot be created.
   */
  getProviderByName(name: string, model?: string): IAIProvider | null {
    return this.buildResilientProvider(canonicalizeProviderName(name) ?? name, model);
  }

  /**
   * Build a resilient provider chain with a custom fallback order.
   * The caller is responsible for providing the order (e.g., ranked by task fitness
   * via ProviderRouter.resolveRanked). Primary provider model override is applied
   * to the first entry in the order.
   */
  buildResilientProviderWithOrder(order: string[], primaryModel?: string): IAIProvider | null {
    if (order.length === 0) return null;

    const normalizedOrder = order
      .map((name) => canonicalizeProviderName(name) ?? name.trim().toLowerCase())
      .filter(Boolean);

    if (normalizedOrder.length === 0) return null;

    const cacheKey = this.buildCacheKey(normalizedOrder, normalizedOrder[0]!, primaryModel);
    const cached = this.providerCache.get(cacheKey);
    if (cached) return cached;

    try {
      const models = primaryModel
        ? { ...this.modelOverrides, [normalizedOrder[0]!]: primaryModel }
        : this.modelOverrides;
      const provider = buildProviderChain(normalizedOrder, this.providerCredentials, {
        models,
        baseUrls: this.resolveBaseUrlOverrides(),
        attemptTimeoutMs: this.providerResponseTimeoutMs,
        onModelUnresponsive: (p, m) => this.recordModelUnresponsive(p, m),
        onModelResponsive: (p, m) => this.recordModelResponsive(p, m),
      });
      this.providerCache.set(cacheKey, provider);
      return provider;
    } catch (error) {
      getLogger().warn("Failed to create provider chain with custom order", {
        order: normalizedOrder,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  getPrimaryProviderByName(name: string, model?: string): IAIProvider | null {
    return this.buildPrimaryProvider(canonicalizeProviderName(name) ?? name, model);
  }

  private getProviderOfficialSnapshot(name: string): ProviderOfficialSnapshot | undefined {
    const canonicalName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    return this.modelCatalog?.getProviderOfficialSnapshot?.(canonicalName);
  }

  private getProviderCatalogHealth(name: string): ProviderCatalogHealth | undefined {
    const canonicalName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    return this.modelCatalog?.getCatalogHealth?.(canonicalName);
  }

  private mergeCapabilities(
    name: string,
    model?: string,
  ): ProviderCapabilities | undefined {
    const baseCapabilities = this.buildPrimaryProvider(name, model)?.capabilities;
    const officialSnapshot = this.getProviderOfficialSnapshot(name);
    if (!baseCapabilities && !officialSnapshot) {
      return undefined;
    }

    const specialFeatures = [
      ...(baseCapabilities?.specialFeatures ?? []),
      ...(officialSnapshot?.featureTags ?? []),
    ];

    return {
      maxTokens: baseCapabilities?.maxTokens ?? 0,
      streaming: baseCapabilities?.streaming ?? false,
      structuredStreaming: baseCapabilities?.structuredStreaming ?? false,
      toolCalling: baseCapabilities?.toolCalling ?? false,
      vision: baseCapabilities?.vision ?? false,
      systemPrompt: baseCapabilities?.systemPrompt ?? true,
      contextWindow: baseCapabilities?.contextWindow,
      thinkingSupported: baseCapabilities?.thinkingSupported,
      specialFeatures: [...new Set(specialFeatures)],
    };
  }

  private buildCatalogTelemetry(
    name: string,
    model: string,
  ): Pick<
    ProviderExecutionCandidate,
    "catalogUpdatedAt" | "catalogFreshnessScore" | "catalogAgeMs" | "catalogStale" | "officialAlignmentScore" | "capabilityDriftReasons"
  > {
    const officialSnapshot = this.getProviderOfficialSnapshot(name);
    const health = this.getProviderCatalogHealth(name);
    const baseCapabilities = this.buildPrimaryProvider(name, model)?.capabilities;
    const snapshotAgeMs = health?.snapshotAgeMs
      ?? (officialSnapshot ? Math.max(0, Date.now() - officialSnapshot.lastUpdated) : undefined);
    const refreshIntervalMs = health?.refreshIntervalMs ?? 24 * 60 * 60 * 1000;
    const { score: officialAlignmentScore, reasons: capabilityDriftReasons } = computeOfficialAlignment(
      model,
      baseCapabilities,
      officialSnapshot,
    );

    return {
      catalogUpdatedAt: officialSnapshot?.lastUpdated,
      catalogFreshnessScore: snapshotAgeMs !== undefined
        ? scoreCatalogFreshness(snapshotAgeMs, refreshIntervalMs)
        : (health?.stale === true ? 0.35 : CAPABILITY_ALIGNMENT_NEUTRAL),
      catalogAgeMs: snapshotAgeMs,
      catalogStale: health?.stale ?? false,
      officialAlignmentScore,
      capabilityDriftReasons,
    };
  }

  /**
   * A SINGLE provider that can actually see, or null.
   *
   * Never route a vision question through the fallback chain: its capability
   * flag is an OR across members (fallback-chain.ts sets
   * `vision: providers.some(...)`) and it strips the image block when it
   * routes to a text-only member — so the chain answers "yes I can see" and
   * then answers the question blind. That fabricated pass is why two
   * visual-conformance attempts were refused on review (audited 2026-09-03).
   */
  getVisionProvider(): { provider: IAIProvider; name: string; model?: string } | null {
    for (const entry of this.listAvailable()) {
      const capabilities = this.getProviderCapabilities(entry.name, entry.defaultModel);
      if (capabilities?.vision !== true) continue;
      const provider = this.buildPrimaryProvider(entry.name, entry.defaultModel);
      if (!provider) continue;
      // The built instance must claim vision on its OWN capabilities, not by
      // inheriting a chain's aggregate.
      if (provider.capabilities?.vision !== true) continue;
      return { provider, name: entry.name, model: entry.defaultModel };
    }
    return null;
  }

  getProviderCapabilities(name: string, model?: string): ProviderCapabilities | undefined {
    return this.mergeCapabilities(name, model);
  }

  describeAvailable(): ProviderDescriptor[] {
    return this.listAvailable().map((entry) => ({
      ...entry,
      capabilities: this.getProviderCapabilities(entry.name, entry.defaultModel) ?? null,
      officialSnapshot: this.getProviderOfficialSnapshot(entry.name) ?? null,
    }));
  }

  private buildAvailableEntry(name: string, label: string, defaultModel: string): {
    name: string;
    label: string;
    defaultModel: string;
    contextWindow?: number;
    thinkingSupported?: boolean;
    specialFeatures?: string[];
    officialSignals?: ProviderOfficialSnapshot["signals"];
    officialSourceUrls?: string[];
    catalogUpdatedAt?: number;
    catalogFreshnessScore?: number;
    catalogAgeMs?: number;
    catalogStale?: boolean;
    officialAlignmentScore?: number;
    capabilityDriftReasons?: string[];
  } {
    const capabilities = this.getProviderCapabilities(name, defaultModel);
    const officialSnapshot = this.getProviderOfficialSnapshot(name);
    const catalogTelemetry = this.buildCatalogTelemetry(name, defaultModel);
    return {
      name,
      label,
      defaultModel,
      contextWindow: capabilities?.contextWindow,
      thinkingSupported: capabilities?.thinkingSupported,
      specialFeatures: capabilities?.specialFeatures,
      officialSignals: officialSnapshot?.signals,
      officialSourceUrls: officialSnapshot?.sourceUrls,
      ...catalogTelemetry,
    };
  }

  private getProviderLabel(name: string): string {
    const canonicalName = canonicalizeProviderName(name) ?? name.trim().toLowerCase();
    if (canonicalName === "claude" || canonicalName === "anthropic") {
      return "Anthropic Claude";
    }
    if (canonicalName === "ollama") {
      return "Ollama (Local)";
    }
    return PROVIDER_PRESETS[canonicalName]?.label ?? canonicalName;
  }

  private resolveExecutionPoolNames(chatId?: string): string[] {
    const preferred = chatId ? this.resolveEffectivePreference(chatId) : undefined;
    const preferredProvider = preferred?.providerName;
    const primaryName = canonicalizeProviderName(preferredProvider) || this.getDefaultPrimaryName();
    if (preferred?.selectionMode === "strada-hard-pin") {
      return this.isAvailable(primaryName) ? [primaryName] : [];
    }
    const orderedPool = this.buildFallbackOrder(primaryName).filter((name) => this.isAvailable(name));

    if (orderedPool.length > 0) {
      return orderedPool;
    }

    return this.listAvailable().map((entry) => entry.name);
  }

  listExecutionCandidates(chatId?: string): ProviderExecutionCandidate[] {
    const preferred = chatId ? this.resolveEffectivePreference(chatId) : undefined;

    return this.resolveExecutionPoolNames(chatId).map((name) => {
      const model =
        preferred?.providerName === name
          ? preferred.model ?? this.getDefaultModelForProvider(name)
          : this.getDefaultModelForProvider(name);
      return this.buildAvailableEntry(name, this.getProviderLabel(name), model);
    });
  }

  listAvailable(): Array<{
    name: string;
    label: string;
    defaultModel: string;
    contextWindow?: number;
    thinkingSupported?: boolean;
    specialFeatures?: string[];
    officialSignals?: ProviderOfficialSnapshot["signals"];
    officialSourceUrls?: string[];
    catalogUpdatedAt?: number;
  }> {
    const available: Array<{
      name: string;
      label: string;
      defaultModel: string;
      contextWindow?: number;
      thinkingSupported?: boolean;
      specialFeatures?: string[];
      officialSignals?: ProviderOfficialSnapshot["signals"];
      officialSourceUrls?: string[];
      catalogUpdatedAt?: number;
    }> = [];

    if (this.isAvailable("claude")) {
      available.push(this.buildAvailableEntry(
        "claude",
        "Anthropic Claude",
        this.modelOverrides?.["claude"] ?? "claude-sonnet-4-6-20250514",
      ));
    }

    if (this.ollamaVerified) {
      available.push(this.buildAvailableEntry(
        "ollama",
        "Ollama (Local)",
        this.modelOverrides?.["ollama"] ?? "llama3.3",
      ));
    }

    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (this.isAvailable(name)) {
        available.push(this.buildAvailableEntry(
          name,
          preset.label,
          this.modelOverrides?.[name] ?? preset.defaultModel,
        ));
      }
    }

    return available;
  }

  isAvailable(providerName: string): boolean {
    const canonicalName = canonicalizeProviderName(providerName) ?? providerName.trim().toLowerCase();
    if (canonicalName === "ollama") return this.ollamaVerified;
    if (canonicalName === "claude" || canonicalName === "anthropic") {
      return !!(
        this.providerCredentials["claude"]?.apiKey
        || this.providerCredentials["anthropic"]?.apiKey
        || (
          this.providerCredentials["claude"]?.anthropicAuthMode === "claude-subscription"
          && this.providerCredentials["claude"]?.anthropicAuthToken
        )
        || (
          this.providerCredentials["anthropic"]?.anthropicAuthMode === "claude-subscription"
          && this.providerCredentials["anthropic"]?.anthropicAuthToken
        )
      );
    }
    if (canonicalName === "openai") {
      const credential = this.providerCredentials["openai"];
      return Boolean(
        credential?.apiKey
        || credential?.openaiAuthMode === "chatgpt-subscription"
        || (credential?.openaiSubscriptionAccessToken && credential?.openaiSubscriptionAccountId)
        || credential?.openaiChatgptAuthFile,
      );
    }
    return !!this.providerCredentials[canonicalName]?.apiKey;
  }

  /** Mark Ollama as verified-reachable (called by bootstrap after health check). */
  setOllamaVerified(verified: boolean): void {
    this.ollamaVerified = verified;
  }

  shutdown(): void {
    this.preferences.close();
  }
}
