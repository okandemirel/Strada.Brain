/**
 * Bootstrap — Provider initialization helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains AI provider initialization, embedding resolution, and related utilities.
 */

import { join } from "node:path";
import type { Config } from "../config/config.js";
import { ClaudeProvider } from "../agents/providers/claude.js";
import { buildProviderChain } from "../agents/providers/provider-registry.js";
import { ProviderManager } from "../agents/providers/provider-manager.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import {
  resolveEmbeddingProvider,
  collectApiKeys,
  describeEmbeddingResolutionFailure,
} from "../rag/embeddings/embedding-resolver.js";
import {
  collectProviderCredentials,
  hasConfiguredOpenAISubscription,
  hasUsableProviderConfig,
  normalizeProviderNames,
} from "./provider-config.js";
import {
  formatProviderPreflightFailures,
  preflightResponseProviders,
} from "./response-provider-preflight.js";
import { AppError } from "../common/errors.js";
import type { EmbeddingResolutionResult, ProviderInitResult } from "./bootstrap-stages.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type * as winston from "winston";

/**
 * Collect provider names that have valid API keys, excluding "claude"/"anthropic"
 * aliases and any names in the optional exclusion set.
 * Prepends "openai" if an OpenAI subscription is configured but not yet listed.
 */
function detectAvailableProviderNames(
  apiKeys: Record<string, string | undefined>,
  config: Config,
  exclude?: ReadonlySet<string>,
): string[] {
  const names = Object.entries(apiKeys)
    .filter(([name, key]) =>
      name !== "claude" && name !== "anthropic" && key && !(exclude?.has(name)),
    )
    .map(([name]) => name);
  if (hasConfiguredOpenAISubscription(config) && !names.includes("openai") && !(exclude?.has("openai"))) {
    names.unshift("openai");
  }
  return names;
}

export async function initializeAIProvider(
  config: Config,
  logger: winston.Logger,
): Promise<ProviderInitResult> {
  const apiKeys = collectApiKeys(config);
  const providerCredentials = collectProviderCredentials(config);
  const notices: string[] = [];
  let healthCheckPassed: boolean | undefined;

  let defaultProvider: IAIProvider;
  let defaultProviderOrder: string[] = [];

  // 1) Explicit provider chain
  if (config.providerChain) {
    const requestedNames = normalizeProviderNames(config.providerChain);
    const configuredNames = requestedNames.filter((name) =>
      name === "openai" && hasConfiguredOpenAISubscription(config)
        ? true
        : hasUsableProviderConfig(name, apiKeys),
    );
    const unavailableNames = requestedNames.filter((name) => !configuredNames.includes(name));

    if (unavailableNames.length > 0) {
      throw new AppError(
        `Configured AI providers are missing usable credentials: ${unavailableNames.join(", ")}.`,
        "NO_AI_PROVIDER",
      );
    }

    const preflightResult = await preflightResponseProviders(
      configuredNames,
      providerCredentials,
      config.providerModels,
    );
    if (preflightResult.failures.length > 0) {
      throw new AppError(
        `Configured AI providers failed preflight. ${formatProviderPreflightFailures(preflightResult.failures)}`,
        "NO_HEALTHY_AI_PROVIDER",
      );
    }

    defaultProviderOrder = preflightResult.passedProviderIds;
    defaultProvider = buildProviderChain(preflightResult.passedProviderIds, providerCredentials, {
      models: config.providerModels,
    });
    logger.info("AI provider chain initialized", { chain: preflightResult.passedProviderIds });

    // Auto-detect additional providers with valid keys as silent fallbacks
    const additionalNames = detectAvailableProviderNames(apiKeys, config, new Set(configuredNames));

    if (additionalNames.length > 0) {
      const fallbackPreflight = await preflightResponseProviders(
        additionalNames,
        providerCredentials,
        config.providerModels,
      );
      if (fallbackPreflight.passedProviderIds.length > 0) {
        const allProviderIds = [...defaultProviderOrder, ...fallbackPreflight.passedProviderIds];
        defaultProviderOrder = allProviderIds;
        defaultProvider = buildProviderChain(allProviderIds, providerCredentials, {
          models: config.providerModels,
        });
        notices.push(
          `Auto-appended fallback providers: ${fallbackPreflight.passedProviderIds.join(", ")}`,
        );
        logger.warn("AI provider chain with auto-fallbacks", { chain: allProviderIds });
      }
    }
  }
  // 2) Anthropic key present — use ClaudeProvider directly
  else if (config.anthropicApiKey) {
    defaultProviderOrder = ["claude"];
    defaultProvider = new ClaudeProvider(config.anthropicApiKey);
    logger.info("AI provider initialized", { name: defaultProvider.name });
  }
  // 3) No explicit chain and no Anthropic key — auto-detect from available keys
  else {
    const detectedNames = detectAvailableProviderNames(apiKeys, config);

    if (detectedNames.length === 0) {
      throw new AppError(
        "No AI provider configured. Please set at least one provider API key.",
        "NO_AI_PROVIDER",
      );
    }

    const preflightResult = await preflightResponseProviders(
      detectedNames,
      providerCredentials,
      config.providerModels,
    );
    if (preflightResult.failures.length > 0) {
      const notice = `Configured AI providers failed preflight and were skipped: ${formatProviderPreflightFailures(preflightResult.failures)}`;
      notices.push(notice);
      logger.warn("Configured AI providers failed preflight", {
        failedProviders: preflightResult.failures,
      });
    }
    if (preflightResult.passedProviderIds.length === 0) {
      throw new AppError(
        `No AI provider passed preflight. ${formatProviderPreflightFailures(preflightResult.failures)}`,
        "NO_HEALTHY_AI_PROVIDER",
      );
    }

    defaultProviderOrder = preflightResult.passedProviderIds;
    defaultProvider = buildProviderChain(preflightResult.passedProviderIds, providerCredentials, {
      models: config.providerModels,
    });
    logger.info("AI provider auto-detected from available keys", {
      chain: preflightResult.passedProviderIds,
    });
  }

  // Run health check (non-blocking — warn only)
  if (defaultProvider.healthCheck) {
    healthCheckPassed = await defaultProvider.healthCheck();
    const logMethod = healthCheckPassed ? "info" : "warn";
    const message = healthCheckPassed
      ? "AI provider health check passed"
      : "AI provider health check failed — API may be unreachable or key invalid";
    logger[logMethod](message, { name: defaultProvider.name });
  }

  const providerManager = new ProviderManager(
    defaultProvider,
    providerCredentials,
    config.providerModels,
    config.memory.dbPath,
    defaultProviderOrder,
  );

  // Verify Ollama reachability before marking it available for routing
  const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  try {
    const ollamaRes = await fetch(`${ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (ollamaRes.ok) {
      providerManager.setOllamaVerified(true);
      logger.info("Ollama verified as reachable");
    }
  } catch {
    logger.debug("Ollama not reachable, excluding from routing");
  }

  logger.info("ProviderManager initialized with per-chat switching support");

  return {
    manager: providerManager,
    notices,
    healthCheckPassed,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientEmbeddingVerificationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return [
    "fetch failed",
    "network",
    "timed out",
    "timeout",
    "aborted",
    "econnreset",
    "econnrefused",
    "enotfound",
    "eai_again",
    "etimedout",
    "api error 429",
    "api error 500",
    "api error 502",
    "api error 503",
    "api error 504",
  ].some((token) => message.includes(token));
}

export function describeEmbeddingConsumers(config: Config): string[] {
  const consumers: string[] = [];
  if (config.rag.enabled) {
    consumers.push("RAG");
  }
  if (config.memory.enabled) {
    consumers.push("memory/learning");
  }
  return consumers;
}

/**
 * Resolve and cache the embedding provider independently from the RAG pipeline.
 * This allows the embedding provider to be shared with AgentDBMemory and learning.
 */
export async function resolveAndCacheEmbeddings(
  config: Config,
  logger: winston.Logger,
): Promise<EmbeddingResolutionResult> {
  const embeddingConsumers = describeEmbeddingConsumers(config);
  if (embeddingConsumers.length === 0) {
    logger.info(
      "Embeddings: semantic subsystems disabled by configuration, no embedding provider resolved",
    );
    return {
      status: {
        state: "disabled",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        verified: false,
        usingHashFallback: true,
        notice: "RAG and semantic memory are disabled by configuration",
      },
    };
  }

  if (!config.rag.enabled) {
    logger.info("Embeddings: RAG disabled, but keeping embeddings active for memory/learning");
  }

  const consumerLabel = embeddingConsumers.join(" and ");

  try {
    const resolution = resolveEmbeddingProvider(config);
    if (!resolution) {
      const notice = describeEmbeddingResolutionFailure(config, consumerLabel);
      logger.warn("Embeddings: no compatible embedding provider found", {
        consumers: embeddingConsumers,
      });
      return {
        notice,
        status: {
          state: "degraded",
          ragEnabled: config.rag.enabled,
          configuredProvider: config.rag.provider,
          configuredModel: config.rag.model,
          configuredDimensions: config.rag.dimensions,
          verified: false,
          usingHashFallback: true,
          notice,
        },
      };
    }

    logger.info(`Embeddings: using ${resolution.provider.name}`, {
      source: resolution.source,
      dimensions: resolution.provider.dimensions,
    });

    const cachedProvider = new CachedEmbeddingProvider(resolution.provider, {
      persistPath: join(config.memory.dbPath, "cache"),
    });
    await cachedProvider.initialize();

    return {
      cachedProvider,
      status: {
        state: "active",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        resolvedProviderName: resolution.provider.name,
        resolutionSource: resolution.source,
        activeDimensions: resolution.provider.dimensions,
        verified: false,
        usingHashFallback: false,
      },
    };
  } catch (error) {
    const notice = `Embeddings unavailable: initialization failed for ${consumerLabel}.`;
    logger.warn("Embedding resolution failed", {
      error: error instanceof Error ? error.message : String(error),
      consumers: embeddingConsumers,
    });
    return {
      notice,
      status: {
        state: "degraded",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        verified: false,
        usingHashFallback: true,
        notice,
      },
    };
  }
}
