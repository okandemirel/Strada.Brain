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
import { ProviderPreferenceStore } from "./provider-preferences.js";
import { getLogger } from "../../utils/logger.js";
import { LRUCache } from "../../common/lru-cache.js";
import type { ProviderOfficialSnapshot } from "./provider-source-registry.js";
import type { RefreshResult } from "./model-intelligence.js";

export interface ProviderActiveInfo {
  providerName: string;
  model: string;
  isDefault: boolean;
  selectionMode: "strada-primary-worker";
  executionPolicyNote: string;
}

export interface ProviderDescriptor {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities | null;
  readonly officialSnapshot: ProviderOfficialSnapshot | null;
}

interface ProviderModelCatalogLookup {
  getProviderModels(provider: string): Array<{ id: string }>;
  getProviderOfficialSnapshot?(provider: string): ProviderOfficialSnapshot | undefined;
  refresh?(): Promise<RefreshResult>;
}

const MAX_CACHED_PROVIDERS = 50;
const EXECUTION_POLICY_NOTE =
  "Strada remains the control plane. This selection sets the primary execution worker; planning, review, and synthesis may still route to other providers.";

export class ProviderManager {
  private readonly preferences: ProviderPreferenceStore;
  private readonly providerCache = new LRUCache<string, IAIProvider>(MAX_CACHED_PROVIDERS);
  private readonly primaryProviderCache = new LRUCache<string, IAIProvider>(MAX_CACHED_PROVIDERS);
  private ollamaVerified = false;
  private modelCatalog?: ProviderModelCatalogLookup;

  constructor(
    private readonly defaultProvider: IAIProvider,
    private readonly apiKeys: Record<string, string | undefined>,
    private readonly modelOverrides?: Record<string, string>,
    preferencesDbPath?: string,
    private readonly defaultProviderOrder: readonly string[] = [],
  ) {
    const dbPath = preferencesDbPath ?? join(process.cwd(), ".strada-memory");
    this.preferences = new ProviderPreferenceStore(
      join(dbPath, "provider-preferences.db"),
    );
    this.preferences.initialize();
  }

  getProvider(chatId: string): IAIProvider {
    const pref = this.preferences.get(chatId);
    if (!pref) return this.defaultProvider;

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
      const provider = buildProviderChain(order, this.apiKeys, {
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
        apiKey: this.apiKeys[normalizedName],
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
        selectionMode: "strada-primary-worker",
        executionPolicyNote: EXECUTION_POLICY_NOTE,
      };
    }

    const preset = PROVIDER_PRESETS[pref.providerName];
    return {
      providerName: pref.providerName,
      model: pref.model ?? this.modelOverrides?.[pref.providerName] ?? preset?.defaultModel ?? "default",
      isDefault: false,
      selectionMode: "strada-primary-worker",
      executionPolicyNote: EXECUTION_POLICY_NOTE,
    };
  }

  setPreference(chatId: string, providerName: string, model?: string): void {
    this.preferences.set(chatId, providerName, model);
    getLogger().info("Provider preference set", { chatId, providerName, model });
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
          models = [...new Set([...models, ...catalogModels, p.defaultModel])];
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
  } {
    const capabilities = this.getProviderCapabilities(name, defaultModel);
    const officialSnapshot = this.getProviderOfficialSnapshot(name);
    return {
      name,
      label,
      defaultModel,
      contextWindow: capabilities?.contextWindow,
      thinkingSupported: capabilities?.thinkingSupported,
      specialFeatures: capabilities?.specialFeatures,
      officialSignals: officialSnapshot?.signals,
      officialSourceUrls: officialSnapshot?.sourceUrls,
      catalogUpdatedAt: officialSnapshot?.lastUpdated,
    };
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
      return !!(this.apiKeys["claude"] || this.apiKeys["anthropic"]);
    }
    return !!this.apiKeys[providerName];
  }

  /** Mark Ollama as verified-reachable (called by bootstrap after health check). */
  setOllamaVerified(verified: boolean): void {
    this.ollamaVerified = verified;
  }

  shutdown(): void {
    this.preferences.close();
  }
}
