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

const EMBEDDING_PROVIDER_ENV_KEYS: Readonly<Record<string, string | null>> = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  qwen: "QWEN_API_KEY",
  gemini: "GEMINI_API_KEY",
  ollama: null,
};

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

export function describeEmbeddingResolutionFailure(config: Config, consumersLabel: string): string {
  const providerName = config.rag.provider;
  const apiKeys = collectApiKeys(config);

  if (providerName !== "auto") {
    const preset = EMBEDDING_PRESETS[providerName];
    if (!preset?.supported) {
      return `Embeddings unavailable for ${consumersLabel}: EMBEDDING_PROVIDER=${providerName} does not support embeddings.`;
    }
    if (providerName === "ollama") {
      return `Embeddings unavailable for ${consumersLabel}: Ollama embeddings are configured but the local Ollama endpoint is not usable.`;
    }
    const envKey = EMBEDDING_PROVIDER_ENV_KEYS[providerName];
    return `Embeddings unavailable for ${consumersLabel}: EMBEDDING_PROVIDER=${providerName} requires ${envKey ?? "a matching credential"}.`;
  }

  const chainNames = config.providerChain
    ? config.providerChain.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const supportedInChain = chainNames.filter((name) => EMBEDDING_PRESETS[name]?.supported);
  const missingCredentialsInChain = supportedInChain.filter((name) => name !== "ollama" && !apiKeys[name]);

  if (supportedInChain.length === 0) {
    const chainLabel = chainNames.length > 0 ? chainNames.join(", ") : "(empty)";
    return (
      `Embeddings unavailable for ${consumersLabel}: PROVIDER_CHAIN only contains non-embedding providers (${chainLabel}). ` +
      "Configure an embedding-capable provider such as Gemini, OpenAI, Mistral, Together, Fireworks, Qwen, or Ollama."
    );
  }

  if (missingCredentialsInChain.length > 0) {
    const missingKeys = missingCredentialsInChain
      .map((name) => EMBEDDING_PROVIDER_ENV_KEYS[name])
      .filter((envKey): envKey is string => Boolean(envKey));
    return (
      `Embeddings unavailable for ${consumersLabel}: embedding-capable providers in PROVIDER_CHAIN are missing credentials (${missingCredentialsInChain.join(", ")}). ` +
      `Add ${missingKeys.join(", ")} or set EMBEDDING_PROVIDER=ollama for local embeddings.`
    );
  }

  const standaloneCandidates = AUTO_FALLBACK_ORDER
    .filter((name) => name !== "ollama" && !supportedInChain.includes(name))
    .filter((name) => Boolean(apiKeys[name]));
  if (standaloneCandidates.length === 0) {
    return (
      `Embeddings unavailable for ${consumersLabel}: no standalone embedding credential is configured outside the response chain. ` +
      "Add GEMINI_API_KEY or OPENAI_API_KEY, or configure local Ollama embeddings."
    );
  }

  return `Embeddings unavailable for ${consumersLabel}: no usable embedding-capable provider could be initialized.`;
}

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
