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
/**
 * A model-availability error: an OpenAI-compatible gateway reports the configured
 * model id as unknown/unsupported (OpenCode/Zen returns this under a 401 with a
 * `ModelError` body). This is a per-provider CONFIG mismatch, NOT an auth failure —
 * it must remain RETRYABLE so a healthy sibling provider is tried instead of
 * collapsing the chain to a false "All providers failed".
 */
const MODEL_UNSUPPORTED_RE = /ModelError|model[\s\S]{0,80}not supported|unsupported model|no such model|model[\s\S]{0,40}(not found|does not exist)/i;
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
  // Model-not-supported / ModelError is a per-provider config mismatch, not a fatal
  // auth/request error — retryable so the chain fails over to a healthy sibling.
  if (MODEL_UNSUPPORTED_RE.test(msg)) return false;
  if (/\b400\b/.test(msg) && BAD_REQUEST_RE.test(msg)) return true;
  if (/\b403\b/.test(msg) && QUOTA_LIMIT_RE.test(msg)) return false;
  if (/\b40[13]\b/.test(msg)) return true;
  if (INVALID_TOOL_RE.test(msg)) return true;
  return false;
}

/**
 * A provider response that produced no usable output: no visible text AND no tool
 * calls. Detection is by CONTENT only — the token count is intentionally ignored so
 * a dropped/absent usage frame is never mistaken for an empty answer (audit #18).
 */
function isEmptyProviderResponse(response: ProviderResponse): boolean {
  const hasText = typeof response.text === "string" && response.text.trim().length > 0;
  const hasToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return !hasText && !hasToolCalls;
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
  /**
   * Per-attempt first-response hard timeout (ms); 0 disables it. A provider that
   * accepts the connection but sends no response / first stream chunk within this
   * window is aborted and turned into a RETRYABLE error so the chain counts a
   * failure and fails over — instead of hanging indefinitely on a dead model/endpoint.
   * Streaming attempts clear the timer on their first chunk, so long healthy streams
   * are never cut short (the orchestrator's stall timeout governs mid-stream).
   */
  private readonly attemptTimeoutMs: number;
  /** Number of providers in this chain (used for single-provider detection). */
  get providerCount(): number { return this.providers.length; }
  /** Guards against thundering-herd concurrent probes to the same recovering provider. */
  private readonly probing = new Set<string>();
  /** Throttle flag so the single-point-of-failure warning fires once per collapse. */
  private spofWarned = false;
  // Thinking disable state now lives in ProviderHealthRegistry singleton
  // to survive FallbackChainProvider re-creation on cache misses.

  constructor(providers: IAIProvider[], options: { attemptTimeoutMs?: number } = {}) {
    if (providers.length === 0) {
      throw new Error("FallbackChainProvider requires at least one provider");
    }
    this.providers = providers;
    this.attemptTimeoutMs = Math.max(0, options.attemptTimeoutMs ?? 0);
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

  /**
   * Merge the per-attempt timeout signal into the caller's options so aborting the
   * attempt (on first-response timeout) actually cancels the underlying fetch.
   */
  private withTimeoutSignal(
    options: { signal?: AbortSignal; externalSignal?: AbortSignal } | undefined,
    timeoutSignal?: AbortSignal,
  ): { signal?: AbortSignal; externalSignal?: AbortSignal } | undefined {
    if (!timeoutSignal) return options;
    const composed = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    return { ...options, signal: composed };
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal; externalSignal?: AbortSignal },
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("chat", (provider, safeMessages, ctl) =>
      provider.chat(systemPrompt, safeMessages, tools, this.withTimeoutSignal(options, ctl.timeoutSignal)),
      messages,
      options?.externalSignal,
    );
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    options?: { signal?: AbortSignal; externalSignal?: AbortSignal },
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("streaming", (provider, safeMessages, ctl) => {
      const opts = this.withTimeoutSignal(options, ctl.timeoutSignal);
      if (supportsStreaming(provider)) {
        // The first chunk proves the provider is responding → clear the first-response
        // timer so a long, healthy stream is never cut short.
        const activityAwareChunk: StreamCallback = (chunk) => { ctl.markActivity(); return onChunk(chunk); };
        return provider.chatStream(systemPrompt, safeMessages, tools, activityAwareChunk, opts);
      }
      return provider.chat(systemPrompt, safeMessages, tools, opts);
    }, messages, options?.externalSignal);
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
   * Run a single provider attempt under a first-response hard timeout. Streaming
   * attempts clear the timer on their first chunk (so long, healthy streams are
   * never killed — the orchestrator's stall timeout governs mid-stream); a
   * non-streaming attempt is bounded as a whole. On timeout the underlying call is
   * aborted AND the race rejects, so it settles even if the provider ignores the
   * abort — surfacing a RETRYABLE error the caller's catch counts as a failure → fail
   * over. With attemptTimeoutMs <= 0 the attempt runs unbounded (back-compat).
   */
  private async runAttemptWithTimeout(
    provider: IAIProvider & Partial<IStreamingProvider>,
    attempt: (
      provider: IAIProvider & Partial<IStreamingProvider>,
      messages: ConversationMessage[],
      ctl: { markActivity: () => void; timeoutSignal?: AbortSignal },
    ) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
  ): Promise<ProviderResponse> {
    if (this.attemptTimeoutMs <= 0) {
      return attempt(provider, messages, { markActivity: () => {} });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const markActivity = (): void => {
      if (timer) { clearTimeout(timer); timer = undefined; }
    };
    try {
      return await new Promise<ProviderResponse>((resolve, reject) => {
        timer = setTimeout(() => {
          if (settled) return;
          controller.abort();
          reject(new Error(
            `Provider "${provider.name}" sent no response within ${this.attemptTimeoutMs}ms (unresponsive endpoint or model)`,
          ));
        }, this.attemptTimeoutMs);
        attempt(provider, messages, { markActivity, timeoutSignal: controller.signal })
          .then((r) => { settled = true; resolve(r); })
          .catch((e: unknown) => { settled = true; reject(e instanceof Error ? e : new Error(String(e))); });
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Try each provider in order, falling back on transient errors.
   * Non-retryable errors (400, auth) are re-thrown immediately.
   */
  private async tryWithFallback(
    label: string,
    attempt: (
      provider: IAIProvider & Partial<IStreamingProvider>,
      messages: ConversationMessage[],
      ctl: { markActivity: () => void; timeoutSignal?: AbortSignal },
    ) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
    externalSignal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    const health = ProviderHealthRegistry.getInstance();
    let lastError: Error | null = null;
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
        // Apply thinking suppression based on reasoning timeout history (singleton state).
        if (health.isThinkingDisabled(provider.name) && "disableThinking" in provider) {
          (provider as { disableThinking: boolean }).disableThinking = true;
        }

        const safeMessages = this.stripImages(messages, provider);
        const response = await this.runAttemptWithTimeout(provider, attempt, safeMessages);
        // A resolved-but-empty response (no text AND no tool calls) is NOT a
        // success: a silently-empty provider must not short-circuit the chain and
        // heal its own health while the loop's circuit breaker simultaneously
        // counts it as a failure (audit #1/#2). Treat it as a retryable failure so
        // the next healthy provider is tried. Detection is by content only — the
        // token count is deliberately ignored (a dropped usage frame must not be
        // mistaken for an empty answer; audit #18).
        if (isEmptyProviderResponse(response)) {
          throw new Error(`Provider "${provider.name}" returned an empty response (no text or tool calls)`);
        }
        health.recordSuccess(provider.name);

        // Require 3 consecutive successes before re-enabling thinking to
        // prevent timeout→success→re-enable→timeout cycles.
        if (health.isThinkingDisabled(provider.name)) {
          if (health.recordThinkingSuccess(provider.name)) {
            health.enableThinking(provider.name);
            if ("disableThinking" in provider) {
              (provider as { disableThinking: boolean }).disableThinking = false;
            }
            logger.info("Re-enabled thinking after 3 consecutive successes", {
              provider: provider.name,
            });
          }
        }

        if (attempted > 1) {
          logger.info("Fallback provider succeeded", {
            provider: provider.name,
            attempt: attempted,
          });
        }
        return response;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(String(error));

        // Control-plane cancellation: the EXTERNAL (un-composed) signal aborted this
        // call — a benign cancel (user cancel / task wind-down), NOT a provider outage.
        // Do NOT poison provider health and do NOT fall over to the next provider (it
        // would fail identically on the same aborted signal → a false "All providers
        // failed"). Propagate the cancel so the caller's cancellation path engages.
        // A watchdog stall (externalSignal NOT aborted) falls through to the normal
        // failure handling below, so stall recovery is unchanged and the decision keys
        // on the signal, never the error-message text (audit #6).
        if (externalSignal?.aborted) {
          throw lastError;
        }

        // Quota/billing errors get a long cooldown so the provider is skipped for hours.
        // Overload errors (529/503) get a medium cooldown to let the server recover.
        // Single-provider setups use shorter cooldowns since there is no fallback.
        const isSingleProvider = this.providers.length === 1;
        if (/\b403\b/.test(errorMsg) && QUOTA_LIMIT_RE.test(errorMsg)) {
          const method = isSingleProvider ? "recordQuotaExhaustedShort" : "recordQuotaExhausted";
          health[method](provider.name, errorMsg);
        } else if (OVERLOAD_RE.test(errorMsg)) {
          const method = isSingleProvider ? "recordOverloadedShort" : "recordOverloaded";
          health[method](provider.name, errorMsg);
        } else {
          health.recordFailure(provider.name, errorMsg);
        }

        // Reset thinking success counter on any failure
        health.resetThinkingSuccessCounter(provider.name);

        // SPOF guard: warn (once per collapse) when this failure leaves the chain
        // with at most one working provider, so a dead fallback (expired key,
        // unsupported model) is surfaced instead of silently leaving a single point
        // of failure — health membership != real availability (audit #19).
        if (this.providers.length > 1) {
          const availableCount = this.providers.filter((p) => health.isAvailable(p.name)).length;
          if (availableCount <= 1 && !this.spofWarned) {
            this.spofWarned = true;
            const live = this.providers.find((p) => health.isAvailable(p.name));
            logger.warn("Provider chain collapsed to a single working provider — no real fallback remains", {
              configured: this.providers.length,
              available: availableCount,
              liveProvider: live?.name ?? "none",
              hint: "A configured fallback is failing health (e.g. expired key or unsupported model). Fix it via PROVIDER_CHAIN / credentials so the chain keeps redundancy.",
            });
          } else if (availableCount > 1 && this.spofWarned) {
            this.spofWarned = false; // chain recovered redundancy
          }
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

          // In single-provider mode, disable thinking for future calls so the
          // provider can respond without hitting the CDN/proxy timeout again.
          // State stored in singleton so it survives provider re-creation.
          if (isSingleProvider && !health.isThinkingDisabled(provider.name)) {
            health.disableThinking(provider.name);
            logger.warn("Auto-disabled thinking for single provider after reasoning timeout", {
              provider: provider.name,
            });
          }
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
          if (isReasoningTimeout && isSingleProvider) {
            const thinkingDisabled = health.isThinkingDisabled(provider.name);
            const hint = "Reasoning models (e.g. MiniMax) may exceed the API proxy timeout during extended thinking. "
              + (thinkingDisabled
                ? "Thinking has been auto-disabled for future retries. "
                : "")
              + "To fix: (1) configure a fallback provider via PROVIDER_CHAIN (e.g. PROVIDER_CHAIN=minimax,openai), or "
              + "(2) increase the provider's timeout/proxy limit.";
            logger.error(`Reasoning model timeout with no fallback (${label})`, {
              provider: provider.name,
              error: sanitizeSecrets(errorMsg),
              hint,
              thinkingDisabled,
            });
            throw new Error(
              `Provider "${provider.name}" timed out during reasoning with no fallback available. ${hint} `
              + `Original error: ${sanitizeSecrets(errorMsg)}`,
              { cause: error instanceof Error ? error : undefined },
            );
          }

          logger.error(`All providers failed (${label})`, {
            provider: provider.name,
            error: sanitizeSecrets(errorMsg),
            totalProviders: this.providers.length,
          });
          throw new Error(`All providers failed. Last error: ${sanitizeSecrets(errorMsg)}`, { cause: error instanceof Error ? error : undefined });
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
      : `Last error: ${sanitizeSecrets(lastError?.message ?? "")}`;
    throw new Error(`All providers failed or unavailable. ${detail}`, { cause: lastError ?? undefined });
  }
}
