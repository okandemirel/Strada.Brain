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
import { getLogger } from "../../utils/logger.js";
import { LRUCache } from "../../common/lru-cache.js";
import type { ProviderOfficialSnapshot } from "./provider-source-registry.js";
import type { RefreshResult } from "./model-intelligence.js";
import { ProviderCatalog, type ProviderCatalogSnapshot } from "./provider-catalog.js";

export interface ProviderActiveInfo {
  providerName: string;
  model: string;
  isDefault: boolean;
  selectionMode: ProviderSelectionMode;
  executionPolicyNote: string;
}

export interface ProviderDescriptor {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities | null;
  readonly officialSnapshot: ProviderOfficialSnapshot | null;
}

export interface ProviderExecutionCandidate {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly contextWindow?: number;
  readonly thinkingSupported?: boolean;
  readonly specialFeatures?: string[];
  readonly officialSignals?: ProviderOfficialSnapshot["signals"];
  readonly officialSourceUrls?: string[];
  readonly catalogUpdatedAt?: number;
  readonly catalogFreshnessScore?: number;
  readonly catalogAgeMs?: number;
  readonly catalogStale?: boolean;
  readonly officialAlignmentScore?: number;
  readonly capabilityDriftReasons?: string[];
}

export interface ProviderCatalogHealth {
  readonly refreshIntervalMs: number;
  readonly stale: boolean;
  readonly snapshotAgeMs?: number;
}

interface ProviderModelCatalogLookup {
  getProviderModels(provider: string): Array<{ id: string }>;
  getProviderOfficialSnapshot?(provider: string): ProviderOfficialSnapshot | undefined;
  getCatalogHealth?(provider: string): ProviderCatalogHealth | undefined;
  refresh?(): Promise<RefreshResult>;
}

const MAX_CACHED_PROVIDERS = 50;
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

  constructor(
    private readonly defaultProvider: IAIProvider,
    private readonly providerCredentials: ProviderCredentialMap,
    private readonly modelOverrides?: Record<string, string>,
    preferencesDbPath?: string,
    private readonly defaultProviderOrder: readonly string[] = [],
  ) {
    const dbPath = preferencesDbPath ?? process.env["MEMORY_DB_PATH"] ?? join(process.cwd(), ".strada-memory");
    this.preferences = new ProviderPreferenceStore(
      join(dbPath, "provider-preferences.db"),
    );
    this.preferences.initialize();
    this.catalog = new ProviderCatalog(this);
  }

  getProvider(chatId: string): IAIProvider {
    const pref = this.preferences.get(chatId);
    if (!pref) return this.defaultProvider;

    const provider = pref.selectionMode === "strada-hard-pin"
      ? this.buildPrimaryProvider(pref.providerName, pref.model)
      : this.buildResilientProvider(pref.providerName, pref.model);
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
    const normalizedPrimary = primaryName.trim().toLowerCase();
    const seen = new Set<string>();
    const order: string[] = [];

    if (normalizedPrimary) {
      seen.add(normalizedPrimary);
      order.push(normalizedPrimary);
    }

    for (const name of this.defaultProviderOrder) {
      const normalized = name.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      order.push(normalized);
    }

    return order;
  }

  private buildCacheKey(order: readonly string[], primaryName: string, model?: string): string {
    return `chain:${order.join(">")}:${primaryName}:${model ?? "(default)"}`;
  }

  private getDefaultPrimaryName(): string {
    return this.defaultProviderOrder[0] ?? this.defaultProvider.name.trim().toLowerCase();
  }

  private getDefaultModelForProvider(name: string): string {
    if (name === "claude" || name === "anthropic") {
      return this.modelOverrides?.[name] ?? "claude-sonnet-4-6-20250514";
    }
    if (name === "ollama") {
      return this.modelOverrides?.[name] ?? "llama3.3";
    }
    return this.modelOverrides?.[name] ?? PROVIDER_PRESETS[name]?.defaultModel ?? "default";
  }

  private buildPrimaryProvider(name: string, model?: string): IAIProvider | null {
    const normalizedName = name.trim().toLowerCase();
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
    const pref = this.preferences.get(chatId);
    if (!pref) {
      const defaultProviderName = this.getDefaultPrimaryName();
      return {
        providerName: defaultProviderName,
        model: this.getDefaultModelForProvider(defaultProviderName),
        isDefault: true,
        selectionMode: "strada-preference-bias",
        executionPolicyNote: EXECUTION_POLICY_NOTE,
      };
    }

    const preset = PROVIDER_PRESETS[pref.providerName];
    return {
      providerName: pref.providerName,
      model: pref.model ?? this.modelOverrides?.[pref.providerName] ?? preset?.defaultModel ?? "default",
      isDefault: false,
      selectionMode: pref.selectionMode,
      executionPolicyNote: pref.selectionMode === "strada-hard-pin"
        ? HARD_PIN_EXECUTION_POLICY_NOTE
        : EXECUTION_POLICY_NOTE,
    };
  }

  setPreference(
    chatId: string,
    providerName: string,
    model?: string,
    selectionMode: ProviderSelectionMode = "strada-preference-bias",
  ): void {
    this.preferences.set(chatId, providerName, model, selectionMode);
    getLogger().info("Provider preference set", { chatId, providerName, model, selectionMode });
  }

  clearPreference(chatId: string): void {
    this.preferences.delete(chatId);
    getLogger().info("Provider preference cleared", { chatId });
  }

  setModelCatalog(modelCatalog?: ProviderModelCatalogLookup): void {
    this.modelCatalog = modelCatalog;
  }

  async refreshModelCatalog(): Promise<RefreshResult | null> {
    if (!this.modelCatalog?.refresh) {
      return null;
    }
    return this.modelCatalog.refresh();
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
    const AGGREGATE_TIMEOUT = 8_000;
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
        (resolve) => setTimeout(() => resolve(available.map((p) => ({
          status: "fulfilled" as const,
          value: { ...p, models: [p.defaultModel] },
        }))), AGGREGATE_TIMEOUT),
      ),
    ]);
    return settled.map((r) => r.status === "fulfilled" ? r.value : { name: "", label: "", defaultModel: "", models: [] }).filter(r => r.name);
  }

  /**
   * Get a provider instance by name. Used by ProviderRouter to
   * materialize a routing decision into an IAIProvider.
   * Returns null if provider cannot be created.
   */
  getProviderByName(name: string): IAIProvider | null {
    return this.buildResilientProvider(name);
  }

  private getProviderOfficialSnapshot(name: string): ProviderOfficialSnapshot | undefined {
    return this.modelCatalog?.getProviderOfficialSnapshot?.(name.trim().toLowerCase());
  }

  private getProviderCatalogHealth(name: string): ProviderCatalogHealth | undefined {
    return this.modelCatalog?.getCatalogHealth?.(name.trim().toLowerCase());
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
    if (name === "claude" || name === "anthropic") {
      return "Anthropic Claude";
    }
    if (name === "ollama") {
      return "Ollama (Local)";
    }
    return PROVIDER_PRESETS[name]?.label ?? name;
  }

  private resolveExecutionPoolNames(chatId?: string): string[] {
    const preferred = chatId ? this.preferences.get(chatId) : undefined;
    const preferredProvider = preferred?.providerName;
    const primaryName = preferredProvider?.trim().toLowerCase() || this.getDefaultPrimaryName();
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
    const preferred = chatId ? this.preferences.get(chatId) : undefined;

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
    if (providerName === "ollama") return this.ollamaVerified;
    if (providerName === "claude" || providerName === "anthropic") {
      return !!(
        this.providerCredentials["claude"]?.apiKey
        || this.providerCredentials["anthropic"]?.apiKey
        || this.providerCredentials["claude"]?.anthropicAuthToken
        || this.providerCredentials["anthropic"]?.anthropicAuthToken
      );
    }
    if (providerName === "openai") {
      const credential = this.providerCredentials["openai"];
      return Boolean(
        credential?.apiKey
        || credential?.openaiAuthMode === "chatgpt-subscription"
        || (credential?.openaiSubscriptionAccessToken && credential?.openaiSubscriptionAccountId)
        || credential?.openaiChatgptAuthFile,
      );
    }
    return !!this.providerCredentials[providerName]?.apiKey;
  }

  /** Mark Ollama as verified-reachable (called by bootstrap after health check). */
  setOllamaVerified(verified: boolean): void {
    this.ollamaVerified = verified;
  }

  shutdown(): void {
    this.preferences.close();
  }
}
