/**
 * Provider Manager
 *
 * Manages per-chat AI provider selection with SQLite-backed persistence.
 * Wraps provider access so the Orchestrator can resolve the correct
 * provider for each chat based on user preferences or the system default.
 */

import { join } from "node:path";
import type { IAIProvider } from "./provider.interface.js";
import { buildProviderChain, PROVIDER_PRESETS } from "./provider-registry.js";
import { ProviderPreferenceStore } from "./provider-preferences.js";
import { getLogger } from "../../utils/logger.js";
import { LRUCache } from "../../common/lru-cache.js";

export interface ProviderActiveInfo {
  providerName: string;
  model: string;
  isDefault: boolean;
}

const MAX_CACHED_PROVIDERS = 50;

export class ProviderManager {
  private readonly preferences: ProviderPreferenceStore;
  private readonly providerCache = new LRUCache<string, IAIProvider>(MAX_CACHED_PROVIDERS);
  private ollamaVerified = false;

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

  getActiveInfo(chatId: string): ProviderActiveInfo {
    const pref = this.preferences.get(chatId);
    if (!pref) {
      return {
        providerName: this.defaultProvider.name,
        model: "default",
        isDefault: true,
      };
    }

    const preset = PROVIDER_PRESETS[pref.providerName];
    return {
      providerName: pref.providerName,
      model: pref.model ?? this.modelOverrides?.[pref.providerName] ?? preset?.defaultModel ?? "default",
      isDefault: false,
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

  async listAvailableWithModels(): Promise<
    Array<{ name: string; label: string; defaultModel: string; models: string[] }>
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

  listAvailable(): Array<{ name: string; label: string; defaultModel: string }> {
    const available: Array<{ name: string; label: string; defaultModel: string }> = [];

    if (this.isAvailable("claude")) {
      available.push({ name: "claude", label: "Anthropic Claude", defaultModel: this.modelOverrides?.["claude"] ?? "claude-sonnet-4-6-20250514" });
    }

    if (this.ollamaVerified) {
      available.push({ name: "ollama", label: "Ollama (Local)", defaultModel: this.modelOverrides?.["ollama"] ?? "llama3.3" });
    }

    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (this.isAvailable(name)) {
        available.push({
          name,
          label: preset.label,
          defaultModel: this.modelOverrides?.[name] ?? preset.defaultModel,
        });
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
