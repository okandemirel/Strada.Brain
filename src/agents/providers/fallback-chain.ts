import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
} from "./provider.interface.js";
import type { MessageContent } from "./provider-core.interface.js";
import { supportsStreaming } from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
import { QUOTA_LIMIT_RE } from "../orchestrator-runtime-utils.js";

/**
 * Check whether a provider error is likely caused by the request itself
 * (e.g., malformed tool_calls, invalid schema) rather than a transient
 * provider issue. Non-retryable errors should NOT fall through to the
 * next provider because they would fail identically.
 */
/** Regex for provider-specific reasoning protocol errors that should fall through */
const REASONING_CONTENT_RE = /reasoning_content/i;
/** Regex for HTTP 400 errors caused by malformed request body or schema */
const BAD_REQUEST_RE = /bad.?request|invalid|malformed/i;
/** Regex for invalid tool/schema errors */
const INVALID_TOOL_RE = /invalid.*tool|tool.*invalid|invalid.*schema/i;
/** Regex patterns for reasoning model timeout detection */
const ABORT_RE = /abort/i;
const CANCEL_RE = /cancel/i;
const TASK_INTERRUPTED_RE = /task\.interrupted/i;
/** Regex for server overload errors (HTTP 529, 503) — triggers extended cooldown */
const OVERLOAD_RE = /\b(?:529|503)\b/;

function isNonRetryableRequestError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (REASONING_CONTENT_RE.test(msg)) return false;
  if (/\b400\b/.test(msg) && BAD_REQUEST_RE.test(msg)) return true;
  if (/\b403\b/.test(msg) && QUOTA_LIMIT_RE.test(msg)) return false;
  if (/\b40[13]\b/.test(msg)) return true;
  if (INVALID_TOOL_RE.test(msg)) return true;
  return false;
}

/**
 * Provider that chains multiple AI providers with automatic fallback.
 *
 * Tries providers in order. If one fails, falls through to the next.
 * Non-retryable errors (400 bad request, auth failures) are re-thrown
 * immediately without trying subsequent providers.
 * Logs each attempt and failure for observability.
 */
export class FallbackChainProvider implements IAIProvider, IStreamingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly providers: IAIProvider[];
  /** Guards against thundering-herd concurrent probes to the same recovering provider. */
  private readonly probing = new Set<string>();

  constructor(providers: IAIProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackChainProvider requires at least one provider");
    }
    this.providers = providers;
    this.name = `chain(${providers.map((p) => p.name).join("→")})`;
    // Aggregate capabilities - use primary provider's limits where sensible
    this.capabilities = {
      maxTokens: providers[0]!.capabilities.maxTokens,
      streaming: providers.some((p) => p.capabilities.streaming),
      structuredStreaming: providers.some((p) => p.capabilities.structuredStreaming),
      toolCalling: providers.every((p) => p.capabilities.toolCalling),
      vision: providers.some((p) => p.capabilities.vision),
      systemPrompt: providers.every((p) => p.capabilities.systemPrompt),
      contextWindow: Math.max(...providers.map(p => p.capabilities.contextWindow ?? 0)),
      thinkingSupported: providers.some(p => p.capabilities.thinkingSupported),
      specialFeatures: [...new Set(providers.flatMap(p => p.capabilities.specialFeatures ?? []))],
    };
  }

  /**
   * Strip image content blocks from messages when the target provider
   * doesn't support vision. Text-only content is preserved as-is.
   */
  private stripImages(
    messages: ConversationMessage[],
    provider: IAIProvider
  ): ConversationMessage[] {
    if (provider.capabilities.vision) return messages;

    return messages.map((msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") return msg;
      const filtered = (msg.content as MessageContent[]).filter(
        (block) => block.type !== "image"
      );
      // If all blocks were images, replace with a placeholder so the message isn't empty
      if (filtered.length === 0) {
        return { ...msg, content: "[image removed — provider does not support vision]" };
      }
      // If only text remains, collapse to plain string for simplicity
      if (filtered.length === 1 && filtered[0]!.type === "text") {
        return { ...msg, content: filtered[0]!.text };
      }
      return { ...msg, content: filtered };
    }) as ConversationMessage[];
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("chat", (provider, safeMessages) =>
      provider.chat(systemPrompt, safeMessages, tools, options),
      messages,
    );
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("streaming", (provider, safeMessages) => {
      if (supportsStreaming(provider)) {
        return provider.chatStream(systemPrompt, safeMessages, tools, onChunk, options);
      }
      return provider.chat(systemPrompt, safeMessages, tools, options);
    }, messages);
  }

  async healthCheck(): Promise<boolean> {
    for (const provider of this.providers) {
      if (!provider.healthCheck) {
        return true;
      }
      try {
        if (await provider.healthCheck()) {
          return true;
        }
      } catch {
        // Try the next provider in the chain.
      }
    }
    return false;
  }

  async listModels(): Promise<string[]> {
    for (const provider of this.providers) {
      if (!provider.listModels) {
        continue;
      }
      try {
        const models = await provider.listModels();
        if (models.length > 0) {
          return models;
        }
      } catch {
        // Try the next provider in the chain.
      }
    }
    return [];
  }

  /**
   * Try each provider in order, falling back on transient errors.
   * Non-retryable errors (400, auth) are re-thrown immediately.
   */
  private async tryWithFallback(
    label: string,
    attempt: (provider: IAIProvider & Partial<IStreamingProvider>, messages: ConversationMessage[]) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    const health = ProviderHealthRegistry.getInstance();
    let lastError = "";
    let attempted = 0;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;

      // Skip providers that are currently unhealthy (cooldown not expired)
      if (!health.isAvailable(provider.name)) {
        logger.debug(`Skipping unhealthy provider (${label})`, {
          provider: provider.name,
          status: health.getStatus(provider.name),
        });
        continue;
      }

      // Lightweight probe for providers that just exited cooldown but haven't proven healthy yet.
      // The probing guard prevents thundering-herd concurrent probes to the same provider.
      if (health.isRecovering(provider.name) && !this.probing.has(provider.name)) {
        this.probing.add(provider.name);
        try {
          await provider.chat(
            "Reply with OK",
            [{ role: "user", content: "health check" }] as ConversationMessage[],
            [], // no tools
            { signal: AbortSignal.timeout(15_000) },
          );
          health.recordSuccess(provider.name, "probe");
          logger.info("Provider health probe succeeded (probe-only recovery)", { provider: provider.name });
        } catch (probeErr) {
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          health.recordFailure(provider.name, probeMsg);
          logger.warn("Provider health probe failed, skipping", { provider: provider.name, error: sanitizeSecrets(probeMsg) });
          continue;
        } finally {
          this.probing.delete(provider.name);
        }
      } else if (health.isRecovering(provider.name) && this.probing.has(provider.name)) {
        // Another concurrent call is already probing this provider — skip
        logger.debug("Skipping provider, probe already in flight", { provider: provider.name });
        continue;
      }

      attempted++;
      try {
        const safeMessages = this.stripImages(messages, provider);
        const response = await attempt(provider, safeMessages);
        health.recordSuccess(provider.name);
        if (attempted > 1) {
          logger.info("Fallback provider succeeded", {
            provider: provider.name,
            attempt: attempted,
          });
        }
        return response;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = errorMsg;

        // Quota/billing errors get a long cooldown so the provider is skipped for hours.
        // Overload errors (529/503) get a medium cooldown to let the server recover.
        if (/\b403\b/.test(errorMsg) && QUOTA_LIMIT_RE.test(errorMsg)) {
          health.recordQuotaExhausted(provider.name, errorMsg);
        } else if (OVERLOAD_RE.test(errorMsg)) {
          health.recordOverloaded(provider.name, errorMsg);
        } else {
          health.recordFailure(provider.name, errorMsg);
        }

        // Detect reasoning model timeout pattern: the provider's CDN/proxy
        // may abort long-running reasoning requests before the model responds.
        // Guard: only warn if the error looks like an external abort, not a
        // deliberate cancellation from the Brain's own control plane (task cancel,
        // stall-abort, user abort).
        const isReasoningTimeout = ABORT_RE.test(errorMsg)
          && provider.capabilities.thinkingSupported
          && !CANCEL_RE.test(errorMsg)
          && !TASK_INTERRUPTED_RE.test(errorMsg);

        if (isReasoningTimeout) {
          logger.warn(`Possible reasoning model timeout (${label})`, {
            provider: provider.name,
            hint: "Reasoning models may need more time than the API proxy allows. Consider adding a faster fallback provider or reducing prompt complexity.",
          });
        }

        if (isNonRetryableRequestError(error)) {
          logger.error(`Non-retryable provider error (${label}), not trying fallbacks`, {
            provider: provider.name,
            error: sanitizeSecrets(errorMsg),
          });
          throw error;
        }

        const remaining = this.providers.slice(i + 1).filter((p) => health.isAvailable(p.name));
        if (remaining.length === 0) {
          if (isReasoningTimeout && this.providers.length === 1) {
            const hint = "Reasoning models (e.g. MiniMax) may exceed the API proxy timeout during extended thinking. "
              + "To fix: (1) configure a fallback provider via PROVIDER_CHAIN (e.g. PROVIDER_CHAIN=minimax,openai), or "
              + "(2) increase the provider's timeout/proxy limit.";
            logger.error(`Reasoning model timeout with no fallback (${label})`, {
              provider: provider.name,
              error: sanitizeSecrets(errorMsg),
              hint,
            });
            throw new Error(
              `Provider "${provider.name}" timed out during reasoning with no fallback available. ${hint} `
              + `Original error: ${sanitizeSecrets(errorMsg)}`,
            );
          }

          logger.error(`All providers failed (${label})`, {
            provider: provider.name,
            error: sanitizeSecrets(errorMsg),
            totalProviders: this.providers.length,
          });
          throw new Error(`All providers failed. Last error: ${sanitizeSecrets(errorMsg)}`);
        }

        logger.warn(`Provider failed (${label}), trying next healthy provider`, {
          failedProvider: provider.name,
          nextProvider: remaining[0]!.name,
          error: errorMsg,
        });
      }
    }

    const detail = attempted === 0
      ? "All providers are in cooldown. Try again later."
      : `Last error: ${sanitizeSecrets(lastError)}`;
    throw new Error(`All providers failed or unavailable. ${detail}`);
  }
}
