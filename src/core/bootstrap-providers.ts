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
import { ProviderModelCatalog } from "../agents/providers/provider-model-catalog.js";
import { createProviderModelCatalogStore } from "../agents/providers/provider-model-catalog-store.js";
import { validateConfiguredModel } from "../agents/providers/validate-configured-model.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import {
  resolveEmbeddingProvider,
  collectApiKeys,
  describeEmbeddingResolutionFailure,
} from "../rag/embeddings/embedding-resolver.js";
import {
  collectProviderCredentials,
  hasConfiguredAnthropicSubscription,
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
  if (hasConfiguredAnthropicSubscription(config) && !names.includes("claude") && !(exclude?.has("claude"))) {
    names.unshift("claude");
  }
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
  // Resolved once and reused for the chat-provider base-URL wiring AND the
  // reachability probe below, so a custom OLLAMA_BASE_URL affects chat too
  // (previously it only affected the probe and embeddings).
  const ollamaBaseUrl = config.ollamaBaseUrl ?? "http://localhost:11434";

  // Per-provider base-URL overrides handed to buildProviderChain/ProviderManager.
  // ollama is always present (resolved above); opencode (and any future provider)
  // base URLs come from config.providerBaseUrls (sourced from OPENCODE_BASE_URL).
  const baseUrlOverrides: Record<string, string> = {
    ...config.providerBaseUrls,
    ollama: ollamaBaseUrl,
  };

  let defaultProvider: IAIProvider;
  let defaultProviderOrder: string[] = [];

  // 1) Explicit provider chain
  if (config.providerChain) {
    const requestedNames = normalizeProviderNames(config.providerChain);
    const configuredNames = requestedNames.filter((name) =>
      name === "openai" && hasConfiguredOpenAISubscription(config)
        ? true
        : hasUsableProviderConfig(name, apiKeys, config),
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
      baseUrlOverrides,
    );
    // Graceful degradation: boot on whatever is healthy, and abort only when
    // NOTHING is.
    //
    // An earlier version also aborted when the PRIMARY provider failed, healthy
    // fallbacks or not — which defeats the point of configuring a chain. Measured:
    // the ChatGPT subscription returned HTTP 429 usage_limit_reached with
    // resets_in_seconds 580320 (6.7 days), and because OpenAI leads the chain,
    // Strada.Brain could not start at all for those 6.7 days — with a healthy Kimi
    // key sitting right behind it in the same chain. The error named only OpenAI,
    // so nothing in it suggested a working fallback existed.
    //
    // The primary failing is worth saying loudly, because the user gets a different
    // model than they asked for; it is not worth refusing to run.
    if (preflightResult.failures.length > 0) {
      if (preflightResult.passedProviderIds.length === 0) {
        throw new AppError(
          `Configured AI providers failed preflight. ${formatProviderPreflightFailures(preflightResult.failures)}`,
          "NO_HEALTHY_AI_PROVIDER",
        );
      }

      const primaryName = configuredNames[0]?.trim().toLowerCase();
      const primaryFailed = Boolean(
        primaryName && !preflightResult.passedProviderIds.includes(primaryName),
      );
      const notice = primaryFailed
        ? `Primary AI provider "${primaryName}" failed preflight; running on "${preflightResult.passedProviderIds[0]}" instead. ${formatProviderPreflightFailures(preflightResult.failures)}`
        : `Some configured AI providers failed preflight and were skipped: ${formatProviderPreflightFailures(preflightResult.failures)}`;
      notices.push(notice);
      logger.warn(
        primaryFailed
          ? "Primary AI provider failed preflight; falling back"
          : "Some AI providers failed preflight; continuing with healthy providers",
        {
          failed: preflightResult.failures.map((f) => f.providerId),
          healthy: preflightResult.passedProviderIds,
          ...(primaryFailed ? { demotedPrimary: primaryName } : {}),
        },
      );
    }

    // Demote, don't drop: a CONFIGURED provider that failed preflight while
    // holding usable credentials (e.g. a quota window mid-reset) stays in the
    // chain at the TAIL. The chain's health gating skips it while cooled and
    // readmits it the moment its cooldown expires. Excluding it composed a
    // session that could never use a provider recovering an hour later —
    // measured live twice today: boots at 16:13 and 20:17 inside an OpenAI
    // reset window ran whole sessions on the quota-dead fallback while the
    // configured primary sat recovered.
    const demotedConfigured = configuredNames
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n && !preflightResult.passedProviderIds.includes(n));
    const chainOrder = [...preflightResult.passedProviderIds, ...demotedConfigured];
    defaultProviderOrder = chainOrder;
    defaultProvider = buildProviderChain(chainOrder, providerCredentials, {
      models: config.providerModels,
      baseUrls: baseUrlOverrides,
      attemptTimeoutMs: config.llmProviderFirstResponseTimeoutMs,
    });
    logger.info("AI provider chain initialized", {
      chain: chainOrder,
      ...(demotedConfigured.length > 0 ? { demotedTail: demotedConfigured } : {}),
    });

    // Auto-detect additional providers with valid keys as silent fallbacks
    const additionalNames = detectAvailableProviderNames(apiKeys, config, new Set(configuredNames));

    if (additionalNames.length > 0) {
      const fallbackPreflight = await preflightResponseProviders(
        additionalNames,
        providerCredentials,
        config.providerModels,
        baseUrlOverrides,
      );
      if (fallbackPreflight.passedProviderIds.length > 0) {
        const allProviderIds = [...defaultProviderOrder, ...fallbackPreflight.passedProviderIds];
        defaultProviderOrder = allProviderIds;
        defaultProvider = buildProviderChain(allProviderIds, providerCredentials, {
          models: config.providerModels,
          baseUrls: baseUrlOverrides,
          attemptTimeoutMs: config.llmProviderFirstResponseTimeoutMs,
        });
        notices.push(
          `Auto-appended fallback providers: ${fallbackPreflight.passedProviderIds.join(", ")}`,
        );
        logger.warn("AI provider chain with auto-fallbacks", { chain: allProviderIds });
      }
    }
  }
  // 2) Anthropic key present — use ClaudeProvider directly
  else if (config.anthropicApiKey || hasConfiguredAnthropicSubscription(config)) {
    defaultProviderOrder = ["claude"];
    defaultProvider = hasConfiguredAnthropicSubscription(config)
      ? new ClaudeProvider({ mode: "claude-subscription", authToken: config.anthropicAuthToken! })
      : new ClaudeProvider(config.anthropicApiKey!);
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
      baseUrlOverrides,
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
      baseUrls: baseUrlOverrides,
      attemptTimeoutMs: config.llmProviderFirstResponseTimeoutMs,
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

  // The chain's per-attempt FIRST-RESPONSE timeout is its own short budget
  // (llmProviderFirstResponseTimeoutMs, default 90s) — deliberately distinct from
  // the orchestrator's 10-min stream-initial/thinking window. A provider silent for
  // ~90s is dead, so the chain aborts + fails over fast; the chain timer clears on
  // the first chunk, leaving the orchestrator's stall/thinking-aware watchdog to
  // govern a long, healthy stream mid-flight. onModelUnresponsive lets the manager
  // auto-demote a model that repeatedly fails to respond from the global default.
  const providerManager = new ProviderManager(
    defaultProvider,
    providerCredentials,
    config.providerModels,
    config.memory.dbPath,
    defaultProviderOrder,
    ollamaBaseUrl,
    config.providerBaseUrls,
    config.llmProviderFirstResponseTimeoutMs,
  );

  // Verify Ollama reachability before marking it available for routing.
  // Escalate to a visible notice when Ollama is actually requested (in the
  // provider chain or as the embedding/RAG provider) so a stopped server or a
  // wrong OLLAMA_BASE_URL is actionable instead of being silently dropped.
  const ollamaWanted =
    (config.providerChain ? normalizeProviderNames(config.providerChain).includes("ollama") : false)
    || config.rag.provider === "ollama";
  try {
    const ollamaRes = await fetch(`${ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (ollamaRes.ok) {
      providerManager.setOllamaVerified(true);
      logger.info("Ollama verified as reachable", { baseUrl: ollamaBaseUrl });
    } else if (ollamaWanted) {
      const notice = `Ollama is configured but returned HTTP ${ollamaRes.status} at ${ollamaBaseUrl}; excluding from routing. Check that Ollama is running.`;
      notices.push(notice);
      logger.warn(notice);
    } else {
      logger.debug("Ollama not reachable, excluding from routing");
    }
  } catch {
    if (ollamaWanted) {
      const notice = `Ollama is configured but unreachable at ${ollamaBaseUrl}; excluding from routing. Start Ollama ('ollama serve') or fix OLLAMA_BASE_URL.`;
      notices.push(notice);
      logger.warn(notice);
    } else {
      logger.debug("Ollama not reachable, excluding from routing");
    }
  }

  // Wire the dynamic model catalog: warm-seed from the on-disk snapshot (so the
  // first model list is populated even before a live refresh), then kick a
  // non-blocking refresh once providers are ready. The 6h TTL keeps live
  // `listModels()` results fresh without hammering provider APIs. This runs only
  // in the normal app boot path (initializeAIProvider is never invoked by the
  // setup wizard), so the wizard is unaffected.
  const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const CATALOG_AUTO_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
  const catalogStore = createProviderModelCatalogStore(config.memory.dbPath);
  const modelCatalog = await ProviderModelCatalog.create({
    load: () => providerManager.listAvailableWithModels(),
    now: Date.now,
    ttlMs: CATALOG_TTL_MS,
    persist: catalogStore,
  });
  providerManager.setModelCatalog(modelCatalog);
  // Non-blocking: must NOT block startup and must NOT break boot if it fails.
  // After the live refresh resolves, validate each active provider's CONFIGURED
  // model against the now-live catalog and WARN (only) if it's stale — a model
  // the provider no longer offers fails silently at runtime, so we surface a
  // startup warning + a suggested current model. We never mutate runtime config.
  void providerManager
    .refreshModelCatalog()
    .then(() => {
      // listAvailable() yields each active provider's canonical `name` (the same
      // key the catalog normalizes on) and its `defaultModel` — the configured
      // model id (config.providerModels override, else the preset default).
      for (const { name, defaultModel } of providerManager.listAvailable()) {
        const live = modelCatalog.getProviderModels(name).map((model) => model.id);
        const result = validateConfiguredModel(name, defaultModel, live);
        if (!result.ok) {
          logger.warn(
            "Configured model not offered by provider — it may fail; pick a current model",
            {
              provider: name,
              configuredModel: defaultModel,
              suggestion: result.corrected,
              reason: result.reason,
            },
          );
        }
      }
    })
    .catch((error) =>
      logger.warn("Initial provider model catalog refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  // Keep the catalog continuously fresh so the setup wizard, admin panel, and
  // chat model picker reflect newly available models (e.g. a new Codex slug)
  // without a manual refresh. The timer is unref'd, so it never holds the
  // process open, and overlapping ticks are skipped internally — non-blocking
  // and cannot break boot.
  modelCatalog.startAutoRefresh(CATALOG_AUTO_REFRESH_MS);

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
    // Rate-limiting (HTTP 429) is transient — the bare "429" token matches both the
    // legacy "api error 429" phrasing and the honest "rate-limited (HTTP 429)"
    // classification from fetch-with-retry.
    "rate-limited",
    "429",
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

    // Health-gate locally-served embedding providers. resolveEmbeddingProvider
    // can select a local Ollama embedding endpoint in AUTO mode WITHOUT checking
    // it is reachable. Handing back a live-but-dead provider made every file/
    // memory embed call throw "fetch failed" (flooding the log with ~1 line per
    // file). If the local endpoint is unreachable, degrade to the hash fallback
    // (cachedProvider undefined) with one actionable notice instead.
    if (/^ollama/i.test(resolution.provider.name)) {
      const baseUrl = config.rag.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
      let reachable = false;
      try {
        const probe = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        reachable = probe.ok;
      } catch {
        reachable = false;
      }
      if (!reachable) {
        const notice =
          `Embeddings unavailable for ${consumerLabel}: the local Ollama embedding endpoint at ${baseUrl} is not reachable. ` +
          "Start Ollama and pull an embedding model (e.g. `ollama pull nomic-embed-text`), or set OPENAI_API_KEY / GEMINI_API_KEY. " +
          "Falling back to low-quality hash embeddings for now.";
        logger.warn("Embeddings: Ollama selected but unreachable; using hash fallback", {
          provider: resolution.provider.name,
          baseUrl,
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
