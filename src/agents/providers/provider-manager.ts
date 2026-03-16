/**
 * Provider Manager
 *
 * Manages per-chat AI provider selection with SQLite-backed persistence.
 * Wraps provider access so the Orchestrator can resolve the correct
 * provider for each chat based on user preferences or the system default.
 */

import { join } from "node:path";
import type { IAIProvider } from "./provider.interface.js";
import { createProvider, PROVIDER_PRESETS } from "./provider-registry.js";
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

  constructor(
    private readonly defaultProvider: IAIProvider,
    private readonly apiKeys: Record<string, string | undefined>,
    private readonly modelOverrides?: Record<string, string>,
    preferencesDbPath?: string,
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

    const cacheKey = pref.model
      ? `${pref.providerName}:${pref.model}`
      : pref.providerName;

    const cached = this.providerCache.get(cacheKey);
    if (cached) return cached;

    try {
      const provider = createProvider({
        name: pref.providerName,
        apiKey: this.apiKeys[pref.providerName],
        model: pref.model ?? this.modelOverrides?.[pref.providerName],
      });
      this.providerCache.set(cacheKey, provider);
      return provider;
    } catch (error) {
      getLogger().warn("Failed to create preferred provider, using default", {
        chatId,
        provider: pref.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.defaultProvider;
    }
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
    const cacheKey = `__listing__:${name}`;
    const cached = this.providerCache.get(cacheKey);
    if (cached) return cached;

    try {
      const provider = createProvider({
        name,
        apiKey: this.apiKeys[name],
        model: this.modelOverrides?.[name],
      });
      this.providerCache.set(cacheKey, provider);
      return provider;
    } catch {
      return null;
    }
  }

  listAvailable(): Array<{ name: string; label: string; defaultModel: string }> {
    const available: Array<{ name: string; label: string; defaultModel: string }> = [];

    if (this.isAvailable("claude")) {
      available.push({ name: "claude", label: "Anthropic Claude", defaultModel: this.modelOverrides?.["claude"] ?? "claude-sonnet-4-6-20250514" });
    }

    available.push({ name: "ollama", label: "Ollama (Local)", defaultModel: this.modelOverrides?.["ollama"] ?? "llama3.3" });

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
    if (providerName === "ollama") return true;
    if (providerName === "claude" || providerName === "anthropic") {
      return !!(this.apiKeys["claude"] || this.apiKeys["anthropic"]);
    }
    return !!this.apiKeys[providerName];
  }

  shutdown(): void {
    this.preferences.close();
  }
}
