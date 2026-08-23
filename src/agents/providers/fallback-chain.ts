import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
  ProviderCallOptions,
} from "./provider.interface.js";
import type { MessageContent } from "./provider-core.interface.js";
import { supportsStreaming } from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
import { QUOTA_LIMIT_RE } from "../orchestrator-runtime-utils.js";
import { QuotaExhaustedError, QUOTA_EXHAUSTED_PHRASE, sleep } from "../../common/fetch-with-retry.js";
import { CODEX_MODEL_UNSUPPORTED_RE } from "./codex-model-rejection.js";

/**
 * Check whether a provider error is likely caused by the request itself
 * (e.g., malformed tool_calls, invalid schema) rather than a transient
 * provider issue. Non-retryable errors should NOT fall through to the
 * next provider because they would fail identically.
 */
/**
 * Slack added to the bounded all-cooled recovery wait: the sleep runs on the monotonic clock
 * while cooldownUntil is compared against wall-clock Date.now(), so ms-scale timer truncation /
 * clock slew can resolve the sleep a hair before the wall-clock expiry (observed as a CI flake:
 * the loop still saw the provider cooled → attempted=0 abort). Noise-scale vs the 60s wait bound.
 */
const RECOVERY_WAIT_SLACK_MS = 10;

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
/**
 * A ChatGPT/Codex SUBSCRIPTION rejecting the configured model with HTTP 400/404
 * ("The 'X' model is not supported when using Codex with a ChatGPT account." — or
 * Strada's own "... is not accepted by the ChatGPT/Codex subscription endpoint").
 * Unlike the generic MODEL_UNSUPPORTED_RE above (an OpenCode/Zen gateway mismatch
 * that SHOULD fail over to a healthy sibling), this is a STATIC per-provider config
 * mismatch: the subscription only serves a fixed set of Codex models, so retrying or
 * failing over the SAME pinned model just re-fails identically while churning this
 * otherwise-healthy provider's health. It is therefore classified NON-retryable AND
 * excluded from health recording, so the chain surfaces the clear actionable message
 * (set a Codex-supported model / use API-key mode) instead of collapsing to a false
 * "no available provider" when the only sibling is on cooldown.
 *
 * The recogniser regex itself lives in codex-model-rejection.ts so it stays in sync
 * with the message openai.ts/preflight build (a shared cross-module contract).
 */
/** Regex for invalid tool/schema errors */
const INVALID_TOOL_RE = /invalid.*tool|tool.*invalid|invalid.*schema/i;
/** Regex patterns for reasoning model timeout detection */
const ABORT_RE = /abort/i;
const CANCEL_RE = /cancel/i;
const TASK_INTERRUPTED_RE = /task\.interrupted/i;
/** Regex for server overload errors (HTTP 529, 503) — triggers extended cooldown */
const OVERLOAD_RE = /\b(?:529|503)\b/;
/**
 * Regex for rate-limit (HTTP 429) errors. Matched against the terminal error message
 * so a 429-driven failure is classified + reported as rate-limited, NOT as an
 * "unresponsive endpoint". Anchored on the bare 429 status and the explicit
 * "rate-limited" phrasing emitted by fetch-with-retry.ts.
 */
const RATE_LIMIT_RE = /\b429\b|rate.?limit/i;
/**
 * Cross-boundary fallback recogniser for a HARD QUOTA STOP (a 429 whose Retry-After
 * exceeds our entire retry budget). The primary signal is `instanceof QuotaExhaustedError`
 * (preserved across the provider call), but if a wrapper ever flattens it to a plain
 * Error the message still carries this distinct phrase — so the chain reliably classifies
 * it as a quota stop (long cooldown + fail over) rather than a transient rate-limit.
 * Derived from the shared QUOTA_EXHAUSTED_PHRASE constant (the exact literal QuotaExhaustedError
 * builds its message from) so the two stay coupled — if the wording is edited in
 * fetch-with-retry.ts, this recogniser tracks it instead of silently going stale.
 */
const QUOTA_HARD_STOP_RE = new RegExp(QUOTA_EXHAUSTED_PHRASE, "i");

function isNonRetryableRequestError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (REASONING_CONTENT_RE.test(msg)) return false;
  // A ChatGPT/Codex subscription rejecting its pinned model is a STATIC config
  // mismatch (the subscription serves a fixed Codex model set): retrying/failing
  // over re-fails identically and churns an otherwise-healthy provider, so treat it
  // as non-retryable and surface the actionable message. Checked BEFORE the generic
  // MODEL_UNSUPPORTED_RE so the Codex case is not misread as a fail-over-able gateway
  // mismatch.
  if (CODEX_MODEL_UNSUPPORTED_RE.test(msg)) return true;
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
/** Long enough for a transient blip to pass, short enough not to stall a task. */
const EMPTY_RESPONSE_RETRY_DELAY_MS = 1_500;

function isEmptyProviderResponse(response: ProviderResponse): boolean {
  const hasText = typeof response.text === "string" && response.text.trim().length > 0;
  const hasToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return !hasText && !hasToolCalls;
}

/**
 * Thrown by the per-attempt first-response timeout. Distinct type so the catch
 * path can both treat it as a retryable failure (fail over) AND notify
 * onModelUnresponsive, which lets the manager auto-demote a model that keeps
 * failing to respond.
 */
class FirstResponseTimeoutError extends Error {}

/**
 * Thrown when an attempt fails specifically because the provider rate-limited us
 * (HTTP 429) — either the provider's retry wrapper exhausted its 429 retries, or a
 * 429 backoff was still in flight when the budget elapsed. Distinct type so the
 * catch path reports it honestly as rate-limiting instead of "unresponsive endpoint",
 * and so it is NOT counted as an unresponsive-streak auto-demote signal (a
 * rate-limited model is alive, just throttled).
 */
class RateLimitedError extends Error {}

/** Canonical provider name + model id for one chain position (for auto-demote). */
export interface ChainAttemptMeta {
  readonly provider: string;
  readonly model: string;
}

/**
 * Control surface handed to a single provider attempt. `markActivity` proves the
 * endpoint is alive (stream chunk or deliberate retry backoff) and resets the
 * first-response timer; `onBackoff` is forwarded to the provider's HTTP retry wrapper
 * so a deliberate 429 backoff resets the timer AND is classified as rate-limiting;
 * `timeoutSignal` cancels the underlying call when the first-response budget elapses.
 */
interface AttemptControl {
  markActivity: () => void;
  onBackoff: (info: { status: number; delayMs: number }) => void;
  timeoutSignal?: AbortSignal;
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
  /** Canonical provider+model per chain position, for auto-demote notifications. */
  private readonly attemptMeta: readonly ChainAttemptMeta[];
  /** Called when an attempt times out with no first response (→ auto-demote candidate). */
  private readonly onModelUnresponsive?: (provider: string, model: string) => void;
  /** Called when an attempt succeeds (clears a model's unresponsive streak). */
  private readonly onModelResponsive?: (provider: string, model: string) => void;
  /** Number of providers in this chain (used for single-provider detection). */
  get providerCount(): number { return this.providers.length; }
  /** Guards against thundering-herd concurrent probes to the same recovering provider. */
  private readonly probing = new Set<string>();
  /** Throttle flag so the single-point-of-failure warning fires once per collapse. */
  private spofWarned = false;
  // Thinking disable state now lives in ProviderHealthRegistry singleton
  // to survive FallbackChainProvider re-creation on cache misses.

  constructor(providers: IAIProvider[], options: {
    attemptTimeoutMs?: number;
    attemptMeta?: readonly ChainAttemptMeta[];
    onModelUnresponsive?: (provider: string, model: string) => void;
    onModelResponsive?: (provider: string, model: string) => void;
  } = {}) {
    if (providers.length === 0) {
      throw new Error("FallbackChainProvider requires at least one provider");
    }
    this.providers = providers;
    this.attemptTimeoutMs = Math.max(0, options.attemptTimeoutMs ?? 0);
    this.attemptMeta = options.attemptMeta ?? [];
    this.onModelUnresponsive = options.onModelUnresponsive;
    this.onModelResponsive = options.onModelResponsive;
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
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("chat", (provider, safeMessages, ctl) =>
      provider.chat(systemPrompt, safeMessages, tools, {
        ...this.withTimeoutSignal(options, ctl.timeoutSignal),
        onBackoff: ctl.onBackoff,
      }),
      messages,
      options?.externalSignal,
    );
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("streaming", (provider, safeMessages, ctl) => {
      const opts = { ...this.withTimeoutSignal(options, ctl.timeoutSignal), onBackoff: ctl.onBackoff };
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
  /**
   * The first-response budget for one provider: its own declaration, or the
   * chain's.
   *
   * A declared value wins outright rather than being clamped to the chain's,
   * because the point of declaring one is to say the chain's is wrong for this
   * endpoint — in either direction. Nonsense (zero, negative, NaN) falls back to
   * the chain rather than disabling the protection.
   */
  private firstResponseBudgetFor(provider: IAIProvider): number {
    const declared = provider.capabilities?.firstResponseTimeoutMs;
    return typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? declared
      : this.attemptTimeoutMs;
  }

  private async runAttemptWithTimeout(
    provider: IAIProvider & Partial<IStreamingProvider>,
    attempt: (
      provider: IAIProvider & Partial<IStreamingProvider>,
      messages: ConversationMessage[],
      ctl: AttemptControl,
    ) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
  ): Promise<ProviderResponse> {
    if (this.attemptTimeoutMs <= 0) {
      return attempt(provider, messages, { markActivity: () => {}, onBackoff: () => {} });
    }
    // Per provider, because only the provider knows which endpoint it is talking
    // to. A queued free tier is silent for reasons that are not a fault, and one
    // chain-wide number cannot be right for it and for an endpoint that answers
    // in two seconds at the same time. Only consulted when the chain has a
    // budget at all: a chain with timeouts disabled stays disabled.
    const budgetMs = this.firstResponseBudgetFor(provider);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let disarmed = false;
    // Tracks whether the provider's own retry wrapper hit a 429 and waited on a
    // deliberate backoff. If so, a budget-exhaustion is reported as rate-limiting,
    // not as an unresponsive endpoint (the endpoint DID respond — with a 429).
    let rateLimited = false;
    const fire = (): void => {
      if (settled) return;
      controller.abort();
      // Honest classification: if the silence was actually a deliberate 429 backoff,
      // surface it as rate-limiting; otherwise it is a genuinely unresponsive endpoint.
      reject(rateLimited
        ? new RateLimitedError(
            `Provider "${provider.name}" rate-limited (HTTP 429) — retry backoff exceeded the ${budgetMs}ms first-response budget`,
          )
        : new FirstResponseTimeoutError(
            `Provider "${provider.name}" sent no response within ${budgetMs}ms (unresponsive endpoint or model)`,
          ));
    };
    // markActivity proves the endpoint is genuinely streaming → PERMANENTLY clear the
    // first-response timer so a long, healthy stream is never cut short (the
    // orchestrator's stall watchdog governs mid-stream from here). Used by streaming
    // attempts on their first chunk.
    const markActivity = (): void => {
      disarmed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
    };
    // A deliberate retry backoff is us waiting ON PURPOSE, not the endpoint being silent.
    // EXTEND the deadline by the backoff duration (rather than permanently disarm) so a
    // transient 429 retry can complete in-budget WHILE the unresponsive-endpoint
    // protection stays intact for any silence AFTER the backoff. A 429 also flags the
    // attempt so a budget overrun is reported as rate-limiting, not "unresponsive".
    const onBackoff = (info: { status: number; delayMs: number }): void => {
      if (settled || disarmed) return;
      if (info.status === 429) rateLimited = true;
      if (timer) clearTimeout(timer);
      const extend = Number.isFinite(info.delayMs) && info.delayMs > 0 ? info.delayMs : 0;
      timer = setTimeout(fire, budgetMs + extend);
    };
    let reject!: (reason: unknown) => void;
    try {
      return await new Promise<ProviderResponse>((res, rej) => {
        reject = rej;
        timer = setTimeout(fire, budgetMs);
        attempt(provider, messages, { markActivity, onBackoff, timeoutSignal: controller.signal })
          .then((r) => { settled = true; res(r); })
          .catch((e: unknown) => { settled = true; rej(e instanceof Error ? e : new Error(String(e))); });
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
      ctl: AttemptControl,
    ) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
    externalSignal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    const health = ProviderHealthRegistry.getInstance();
    let lastError: Error | null = null;
    let attempted = 0;

    // Transient all-cooled guard: when EVERY provider is currently on cooldown but the
    // soonest is about to recover (within the bounded recovery window), wait once rather
    // than failing the whole task on a brief cooldown overlap. suggestRecoveryWaitMs()
    // returns null the moment any provider is usable (→ no wait, use it) or when the
    // soonest recovery is beyond the window (genuinely-down/quota-blocked → fall through
    // to the loop, which surfaces the accurate "all in cooldown" terminal error). After
    // the sleep the recovered provider becomes isAvailable and the loop probes it.
    if (!externalSignal?.aborted) {
      // Scope the decision to THIS chain's providers — a chain holding a subset of the
      // globally-tracked providers must not wait for (or be blocked by) one it cannot use.
      const waitMs = health.suggestRecoveryWaitMs(Date.now(), this.providers.map((p) => p.name));
      if (waitMs !== null && waitMs > 0) {
        logger.info(`All providers transiently cooled; waiting ${waitMs}ms for soonest recovery before aborting (${label})`, {
          waitMs,
          totalProviders: this.providers.length,
        });
        // RECOVERY_WAIT_SLACK_MS: setTimeout runs on the MONOTONIC clock while cooldownUntil is
        // compared against wall-clock Date.now(); ms-scale timer truncation / clock slew can make
        // the sleep resolve a hair BEFORE the wall-clock expiry, so the loop below would still see
        // the provider cooled and abort with attempted=0 (caught as a real CI flake). The slack is
        // noise-scale against a wait bounded at PROVIDER_HEALTH_RECOVERY_WAIT_MS (default 60s).
        await sleep(waitMs + RECOVERY_WAIT_SLACK_MS, externalSignal);
      }
    }

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
        let response = await this.runAttemptWithTimeout(provider, attempt, safeMessages);
        // A resolved-but-empty response (no text AND no tool calls) is NOT a
        // success: a silently-empty provider must not short-circuit the chain and
        // heal its own health while the loop's circuit breaker simultaneously
        // counts it as a failure (audit #1/#2). Treat it as a retryable failure so
        // the next healthy provider is tried. Detection is by content only — the
        // token count is deliberately ignored (a dropped usage frame must not be
        // mistaken for an empty answer; audit #18).
        if (isEmptyProviderResponse(response)) {
          // Falling through is the better answer when there is somewhere to fall
          // to. When there is not, "retryable" has to mean something: measured
          // 2026-08-22, run 39 died on six empty answers in nine seconds from
          // the only live provider, and a direct probe two minutes later got a
          // normal reply. The condition was transient and had already passed.
          const somewhereToFallTo = this.providers
            .slice(i + 1)
            .some((p) => health.isAvailable(p.name));
          if (somewhereToFallTo) {
            throw new Error(`Provider "${provider.name}" returned an empty response (no text or tool calls)`);
          }

          logger.warn(`Empty response from the only live provider; asking once more (${label})`, {
            provider: provider.name,
          });
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS, externalSignal);
          response = await this.runAttemptWithTimeout(provider, attempt, safeMessages);
          if (isEmptyProviderResponse(response)) {
            // Twice running is not a blip; a provider with nothing to say twice
            // really has nothing to say.
            throw new Error(`Provider "${provider.name}" returned an empty response (no text or tool calls)`);
          }
        }
        health.recordSuccess(provider.name);
        const okMeta = this.attemptMeta[i];
        if (okMeta) this.onModelResponsive?.(okMeta.provider, okMeta.model);

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

        // A first-response timeout (provider stayed silent) is a strong "this model
        // is unresponsive" signal — notify so the manager can auto-demote it from the
        // global default after a couple of strikes. A RATE-LIMITED failure is NOT an
        // unresponsive signal (the endpoint answered — with a 429), so it must NOT
        // trigger auto-demote. Both still fall through to the normal failure handling
        // below (retryable → fail over).
        if (error instanceof FirstResponseTimeoutError) {
          const meta = this.attemptMeta[i];
          if (meta) this.onModelUnresponsive?.(meta.provider, meta.model);
        }

        // HARD QUOTA STOP: a 429 whose Retry-After exceeds our entire retry budget — the
        // provider cannot recover within our window (e.g. a weekly usage-limit reset days
        // out). fetch-with-retry already failed FAST (non-retryable QuotaExhaustedError),
        // so we did NOT burn the retry budget. Put THIS provider into a long cooldown
        // sized ≈ the Retry-After (capped) so it is skipped for the rest of the session,
        // then fall through to the normal failover so the NEXT provider is tried
        // IMMEDIATELY. This is distinct from a transient 429 (medium overload cooldown
        // below): a quota stop will not heal in minutes, so a medium cooldown would just
        // re-pick the dead provider next call.
        const quotaHardStop = error instanceof QuotaExhaustedError ? error : undefined;
        const isQuotaHardStop = quotaHardStop !== undefined || QUOTA_HARD_STOP_RE.test(errorMsg);

        // Is this failure caused by rate-limiting (HTTP 429)? Either the timeout fired
        // mid-429-backoff (RateLimitedError), or the provider's retry wrapper exhausted
        // its 429 retries and threw a "rate-limited (HTTP 429)" message. A hard quota stop
        // is handled on its own (long cooldown) branch, NOT as a transient rate-limit.
        const isRateLimited = !isQuotaHardStop
          && (error instanceof RateLimitedError || RATE_LIMIT_RE.test(errorMsg));

        // Quota/billing (403) errors get a long cooldown so the provider is skipped for
        // hours. Overload (529/503) AND rate-limit (429) errors get a medium cooldown to
        // let the server recover — a 429 is transient throttling, not a billing block, so
        // it must NOT inherit the multi-hour quota cooldown. Single-provider setups use
        // shorter cooldowns since there is no fallback.
        const isSingleProvider = this.providers.length === 1;
        // A ChatGPT/Codex subscription rejecting its pinned model is a static CONFIG
        // mismatch, NOT a provider-health problem — recording a failure (or cooldown)
        // would churn an otherwise-healthy provider for hours. Skip health recording
        // entirely; the non-retryable classification below surfaces the clear,
        // actionable message and stops the chain from collapsing.
        const isCodexModelConfigError = CODEX_MODEL_UNSUPPORTED_RE.test(errorMsg);
        if (isCodexModelConfigError) {
          // intentionally record nothing — provider stays healthy for a corrected model
        } else if (isQuotaHardStop) {
          // Size the cooldown from the provider's Retry-After (capped). A single-provider
          // setup still gets the hard-stop cooldown — there is no sibling to fall over to,
          // and futilely retrying a days-out quota block helps no one; isAvailable()
          // auto-recovers once the cooldown expires.
          health.recordQuotaHardStop(
            provider.name,
            quotaHardStop?.retryAfterMs ?? Number.NaN,
            errorMsg,
          );
        } else if (/\b403\b/.test(errorMsg) && QUOTA_LIMIT_RE.test(errorMsg)) {
          const method = isSingleProvider ? "recordQuotaExhaustedShort" : "recordQuotaExhausted";
          health[method](provider.name, errorMsg);
        } else if (OVERLOAD_RE.test(errorMsg) || isRateLimited) {
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

        // A hard quota stop is surfaced with a DISTINCT, accurate reason (not "rate-limited"
        // and not "unresponsive"): the provider's usage quota is exhausted and it has been
        // cooled down — we either fail over to the next provider, or terminate with the
        // quota reason when none remain.
        if (isQuotaHardStop) {
          if (remaining.length === 0) {
            logger.error(`Provider usage quota exhausted, no available provider (${label})`, {
              provider: provider.name,
              error: sanitizeSecrets(errorMsg),
              totalProviders: this.providers.length,
            });
            throw new Error(
              `Provider "${provider.name}": ${sanitizeSecrets(errorMsg)} — no available provider`,
              { cause: error instanceof Error ? error : undefined },
            );
          }
          logger.warn(`Provider usage quota exhausted, failing over (${label})`, {
            failedProvider: provider.name,
            nextProvider: remaining[0]!.name,
            error: sanitizeSecrets(errorMsg),
          });
          continue;
        }

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
