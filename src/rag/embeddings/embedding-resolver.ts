/**
 * Embedding Provider Resolver
 *
 * Factory function that resolves which embedding provider to use based on
 * the configured EMBEDDING_PROVIDER and PROVIDER_CHAIN settings.
 */

import type { Config } from "../../config/config.js";
import { EMBEDDING_PRESETS } from "../../common/constants.js";
import { PROVIDER_PRESETS } from "../../agents/providers/provider-registry.js";
import { OpenAIEmbeddingProvider } from "./openai-embeddings.js";
import { OllamaEmbeddingProvider } from "./ollama-embeddings.js";
import type { IEmbeddingProvider } from "../rag.interface.js";

export interface EmbeddingResolution {
  provider: IEmbeddingProvider;
  source: string;
}

/** Build a map of provider name -> API key from config. */
export function collectApiKeys(config: Config): Record<string, string | undefined> {
  return {
    claude: config.anthropicApiKey,
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    deepseek: config.deepseekApiKey,
    qwen: config.qwenApiKey,
    kimi: config.kimiApiKey,
    minimax: config.minimaxApiKey,
    groq: config.groqApiKey,
    mistral: config.mistralApiKey,
    together: config.togetherApiKey,
    fireworks: config.fireworksApiKey,
    gemini: config.geminiApiKey,
  };
}

interface CreateProviderOptions {
  modelOverride?: string;
  baseUrlOverride?: string;
  dimensionsOverride?: number;
  sourcePrefix: string;
}

/**
 * Create an embedding provider for a named provider.
 * Returns null if the provider is unsupported or the API key is missing.
 */
function createEmbeddingProvider(
  name: string,
  apiKeys: Record<string, string | undefined>,
  options: CreateProviderOptions,
): EmbeddingResolution | null {
  const preset = EMBEDDING_PRESETS[name];
  if (!preset || !preset.supported) return null;

  const source = `${options.sourcePrefix}:${name}`;

  if (name === "ollama") {
    return {
      provider: new OllamaEmbeddingProvider({
        model: options.modelOverride ?? preset.model,
        baseUrl: options.baseUrlOverride,
      }),
      source,
    };
  }

  const apiKey = apiKeys[name];
  if (!apiKey) return null;

  const providerPreset = PROVIDER_PRESETS[name];
  const baseUrl = options.baseUrlOverride ?? providerPreset?.baseUrl;

  const requestDimensions = options.dimensionsOverride
    && preset.supportedDimensions.includes(options.dimensionsOverride)
    ? options.dimensionsOverride
    : undefined;

  return {
    provider: new OpenAIEmbeddingProvider({
      apiKey,
      model: options.modelOverride ?? preset.model,
      baseUrl,
      dimensions: preset.dimensions,
      requestDimensions,
      batchSize: preset.maxBatchSize,
      label: preset.label,
    }),
    source,
  };
}

const AUTO_FALLBACK_ORDER = [
  "gemini", "openai", "deepseek", "mistral",
  "together", "fireworks", "qwen", "ollama",
] as const;

/**
 * Resolve which embedding provider to use.
 *
 * Resolution order:
 * 1. Explicit provider (not "auto") -- look up in EMBEDDING_PRESETS
 * 2. "auto" -- scan provider chain for first embedding-capable provider
 * 3. "auto" fallback -- try any configured embedding-capable provider in priority order
 * 4. None found -- return null (RAG disabled)
 */
export function resolveEmbeddingProvider(config: Config): EmbeddingResolution | null {
  const providerName = config.rag.provider;
  const apiKeys = collectApiKeys(config);
  const modelOverride = config.rag.model;

  const dimensionsOverride = config.rag.dimensions;

  // 1. Explicit provider (not "auto")
  if (providerName !== "auto") {
    return createEmbeddingProvider(providerName, apiKeys, {
      modelOverride,
      baseUrlOverride: config.rag.baseUrl,
      dimensionsOverride,
      sourcePrefix: "explicit",
    });
  }

  // 2. Auto mode -- scan provider chain for first embedding-capable provider
  const autoOptions: CreateProviderOptions = { modelOverride, dimensionsOverride, sourcePrefix: "auto" };

  const chainNames = config.providerChain
    ? config.providerChain.split(",").map((s) => s.trim().toLowerCase())
    : [];

  for (const name of chainNames) {
    const result = createEmbeddingProvider(name, apiKeys, autoOptions);
    if (result) return result;
  }

  // 3. Fallback -- use any configured embedding-capable provider, even if the
  // response chain itself contains only non-embedding models like Kimi/Claude.
  const triedProviders = new Set(chainNames);
  const fallbackSourcePrefix = chainNames.length > 0 ? "auto-fallback" : "auto";
  const fallbackCandidates = chainNames.length > 0
    ? AUTO_FALLBACK_ORDER.filter((name) => name !== "ollama")
    : AUTO_FALLBACK_ORDER;

  for (const name of fallbackCandidates) {
    if (triedProviders.has(name)) continue;
    const result = createEmbeddingProvider(name, apiKeys, {
      modelOverride,
      dimensionsOverride,
      sourcePrefix: fallbackSourcePrefix,
    });
    if (result) return result;
  }

  return null;
}
