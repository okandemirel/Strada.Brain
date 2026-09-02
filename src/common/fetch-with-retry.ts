/**
 * Shared HTTP fetch with exponential backoff retry for transient errors (429, 5xx).
 *
 * Consolidates retry logic from openai.ts and openai-embeddings.ts.
 */

import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";

// =============================================================================
// PER-PROVIDER CONCURRENCY LIMITER
// =============================================================================

/**
 * Default ceiling on simultaneous in-flight HTTP calls PER PROVIDER. Strada fans
 * out many concurrent LLM calls per task (supervisor parallel nodes, goal/agent
 * delegations, per-node verification, goal decomposition), and with NO per-key
 * concurrency limit these STACK into a large burst against a single provider API
 * key. Providers like OpenCode (Zen/Go) enforce a per-key concurrency/RPM ceiling,
 * so the burst trips HTTP 429 even though a single-caller tool using the same key
 * never would. This caps the burst PER PROVIDER while preserving real parallelism:
 * when concurrent calls are <= the cap an acquire is instant (zero added latency),
 * only the excess queues. Overridden at bootstrap via configureProviderConcurrency()
 * from config.providerMaxConcurrentRequests (env PROVIDER_MAX_CONCURRENT_REQUESTS).
 */
const DEFAULT_PROVIDER_MAX_CONCURRENT_REQUESTS = 3;

let providerMaxConcurrentRequests = DEFAULT_PROVIDER_MAX_CONCURRENT_REQUESTS;

/**
 * One semaphore per provider, keyed by the stable provider/caller name passed to
 * fetchWithRetry. DIFFERENT providers get DIFFERENT semaphores, so they never block
 * each other — cross-provider parallelism is preserved (no single global cap).
 */
const providerSemaphores = new Map<string, ConcurrencySemaphore>();

/**
 * Queue-based semaphore limiting concurrent in-flight operations. When the limit is
 * reached, acquire() queues until a running operation releases. Exposes explicit
 * acquire()/release() so a permit can be held across BOTH the fetch AND the streamed
 * body consumption (the body is read by the CALLER after fetchWithRetry returns).
 */
class ConcurrencySemaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private limit: number,
    private readonly name: string,
  ) {}

  /** Update the cap at runtime; wake queued waiters if the limit grew. */
  setLimit(limit: number): void {
    this.limit = limit;
    // Each woken waiter reclaims its slot via its own `running++` after the await
    // in acquire(); count admissions locally so the gate advances without the waker
    // mutating `running` (the post-await acquire() owns the increment).
    let admitted = 0;
    while (this.running + admitted < this.limit && this.queue.length > 0) {
      admitted++;
      this.queue.shift()!();
    }
  }

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    // Observability only: pacing kicked in for THIS provider. <= cap = instant acquire
    // above (zero added latency); this logs only when the excess is being queued.
    getLogger().debug(`${this.name} HTTP call queued (per-provider concurrency cap reached)`, {
      provider: this.name,
      cap: this.limit,
    });
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      // Hand the freed permit directly to the next waiter. It reclaims the slot via
      // its own `running++` after the await in acquire(), so the `running--` above
      // and that increment net to zero across this release + that acquire.
      this.queue.shift()!();
    }
  }
}

function getProviderSemaphore(name: string): ConcurrencySemaphore {
  let sem = providerSemaphores.get(name);
  if (!sem) {
    sem = new ConcurrencySemaphore(providerMaxConcurrentRequests, name);
    providerSemaphores.set(name, sem);
  }
  return sem;
}

/**
 * Set the per-provider concurrent-request cap. Called once at bootstrap (mirroring
 * configureAuthManager) so the centralized config — NOT process.env at the call
 * site — drives the limiter. Applies to existing AND future per-provider semaphores.
 * A non-positive value is ignored (the previous/default cap stays in force).
 */
export function configureProviderConcurrency(cap: number): void {
  if (!Number.isFinite(cap) || cap < 1) return;
  providerMaxConcurrentRequests = Math.floor(cap);
  for (const sem of providerSemaphores.values()) {
    sem.setLimit(providerMaxConcurrentRequests);
  }
}

/**
 * Optional per-provider REQUEST-RATE floor (min ms between request starts).
 * The semaphore caps concurrency but not throughput: three permanently
 * saturated streams for days is a sustained profile a flat-fee subscription
 * account is not expected to produce. Default 0 = disabled; enable via env
 * PROVIDER_MIN_REQUEST_INTERVAL_MS for accounts that need gentler pacing.
 */
const providerMinRequestIntervalMs = (() => {
  const raw = Number(process.env["PROVIDER_MIN_REQUEST_INTERVAL_MS"] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.min(60_000, Math.floor(raw)) : 0;
})();
const providerNextAllowedAt = new Map<string, number>();

async function paceProviderStart(name: string): Promise<void> {
  if (providerMinRequestIntervalMs <= 0) return;
  const now = Date.now();
  const next = Math.max(now, providerNextAllowedAt.get(name) ?? 0);
  providerNextAllowedAt.set(name, next + providerMinRequestIntervalMs);
  if (next > now) {
    await new Promise((r) => setTimeout(r, next - now));
  }
}

/** Reset limiter state to defaults — test-only helper. */
export function __resetProviderConcurrency(): void {
  providerMaxConcurrentRequests = DEFAULT_PROVIDER_MAX_CONCURRENT_REQUESTS;
  providerSemaphores.clear();
}

export interface FetchWithRetryOptions {
  /** Maximum retry attempts (default 3) */
  maxRetries?: number;
  /**
   * Maximum retries for a TRANSPORT failure — fetch rejecting outright, as
   * opposed to a server answering with a status. Defaults higher than
   * maxRetries because there is nothing about the request to change: the
   * network is unreachable, and only time fixes that.
   */
  networkMaxRetries?: number;
  /** Ceiling on a single transport backoff (default 60s). */
  networkMaxDelayMs?: number;
  /** Base delay in ms for exponential backoff (default 500) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default 60_000) */
  maxDelayMs?: number;
  /** Name shown in log messages and errors */
  callerName?: string;
  /** Respect Retry-After header (default true) */
  useRetryAfter?: boolean;
  /** Drain response body on retryable failures (default true) */
  drainBody?: boolean;
  /** Sanitize error text using secret sanitizer (default true) */
  sanitizeErrors?: boolean;
  /** AbortSignal for cancellation — propagated to fetch() */
  signal?: AbortSignal;
  /**
   * Fired immediately BEFORE a deliberate retry backoff sleep, carrying the HTTP
   * status that triggered the retry and the backoff duration. Lets a caller (the
   * FallbackChain) distinguish "we are waiting ON PURPOSE during a retry backoff"
   * from "the endpoint is silent": it can reset its first-response timer so a
   * deliberate backoff is not counted against the silence budget, and remember that
   * the failure was rate-limited (429) rather than an unresponsive endpoint.
   *
   * For a retryable 429 the callback also carries the parsed rate-limit headers and a
   * truncated response body (the provider's error message) so the FallbackChain can
   * classify/surface WHY the 429 happened. NEVER carries Authorization/auth headers
   * or any secret — only the named rate-limit headers + truncated body.
   */
  onBackoff?: (info: BackoffInfo) => void;
}

/** Rate-limit diagnostics surfaced on a retryable 429 (no auth headers / secrets). */
export interface RateLimitDiagnostics {
  /** Subset of rate-limit headers present on the response (lowercased keys). */
  headers: Record<string, string>;
  /** Truncated (<=500 char) response body — the provider error message. */
  body: string;
}

export interface BackoffInfo {
  status: number;
  delayMs: number;
  /** Present only for a 429 — the rate-limit headers + truncated body. */
  rateLimit?: RateLimitDiagnostics;
}

/**
 * Thrown when a 429 is a HARD QUOTA STOP — the provider has signalled (via Retry-After)
 * that it will not recover within our ENTIRE retry budget (maxRetries * maxDelayMs), so
 * retrying is futile. Distinct, NON-RETRYABLE error type so fetchWithRetry stops
 * immediately (no further attempts) and the FallbackChain can fail over to the next
 * provider AND put the quota-blocked provider into a long cooldown (≈ the Retry-After),
 * instead of wasting the whole retry budget on a provider that is down for days.
 *
 * The message is the human-readable reason (enriched from the response body when it
 * matches a quota pattern); the structured fields carry the provider name and the
 * Retry-After duration so the chain can size the cooldown. NO secrets are ever carried
 * (the body is run through the secret sanitizer + truncated before enrichment).
 */
/**
 * The exact human-readable phrase embedded in every {@link QuotaExhaustedError} message
 * (see the throw site below). EXPORTED + shared so the cross-module recognisers that must
 * re-detect a flattened-to-plain-Error quota stop (fallback-chain's QUOTA_HARD_STOP_RE,
 * orchestrator-runtime-utils' shared classifier, goal-decomposer's outage check) derive
 * from this single literal instead of hard-coding their own copy — if the wording is ever
 * edited here, the recognisers stay in sync instead of silently stopping matching.
 */
export const QUOTA_EXHAUSTED_PHRASE = "usage quota exhausted";

export class QuotaExhaustedError extends Error {
  /** Always false — this error must never be retried. */
  readonly retryable = false as const;
  /** Provider/caller name (callerName) so the chain knows which provider to cool down. */
  readonly provider: string;
  /** Parsed Retry-After in ms — the chain sizes its cooldown from this. */
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number, message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Quota / balance / usage-limit patterns. SECONDARY signal only: used to ENRICH the
 * surfaced message (extract a human reason) for a 429 already classified as a hard stop
 * by the Retry-After threshold. NEVER the sole gate — a brittle provider-specific string
 * must not by itself decide to stop retrying (the durable gate is the derived threshold).
 */
const QUOTA_BODY_RE = /usage limit|quota|insufficient|balance|out of credit|UsageLimitError|limitName/i;

/**
 * Format a millisecond duration as a short, human-friendly reset hint ("~3d", "~5h",
 * "~12m", "~45s") for the user-facing message. Always rounds to the largest sensible
 * unit so the surfaced reason reads naturally.
 */
export function formatResetDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "soon";
  const sec = Math.round(ms / 1000);
  if (sec >= 86_400) return `~${Math.round(sec / 86_400)}d`;
  if (sec >= 3_600) return `~${Math.round(sec / 3_600)}h`;
  if (sec >= 60) return `~${Math.round(sec / 60)}m`;
  return `~${sec}s`;
}

/**
 * Extract a concise human reason from a (sanitized, truncated) 429 body when it matches a
 * quota pattern. Returns undefined when the body is not quota-shaped (so only the generic
 * reason is used). The body is already secret-sanitized + truncated by the caller.
 */
function extractQuotaReason(body: string): string | undefined {
  if (!body || !QUOTA_BODY_RE.test(body)) return undefined;
  // Prefer the provider's own "message" field if present (OpenAI-compatible error
  // envelope), else fall back to the first non-empty line of the matched body.
  const msgMatch = body.match(/"message"\s*:\s*"([^"]{1,160})"/i);
  if (msgMatch?.[1]) return msgMatch[1].trim();
  const firstLine = body.split(/[\r\n]/).map((l) => l.trim()).find((l) => l.length > 0);
  return firstLine ? firstLine.slice(0, 160) : undefined;
}

/**
 * Rate-limit / quota headers safe to log (provider-agnostic OpenAI-compatible set
 * plus generic concurrency hints). Authorization, cookies, and API keys are NEVER
 * in this list, so they can never leak into a log line.
 */
const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-limit-concurrency",
  "x-ratelimit-remaining-concurrency",
  "x-concurrency-limit",
] as const;

/** Max chars of a 429 response body we log/surface (truncate the provider message). */
const MAX_RATE_LIMIT_BODY_CHARS = 500;

/**
 * Read the allow-listed rate-limit headers (never auth/secret headers) and a
 * truncated response body for a retryable 429, so the 429 reason becomes VISIBLE
 * instead of being silently drained. Body read failures degrade to "" — diagnostics
 * are best-effort and must never break the retry path.
 */
async function extractRateLimitDiagnostics(
  response: Response,
  shouldSanitize: boolean,
): Promise<RateLimitDiagnostics> {
  const headers: Record<string, string> = {};
  if (response.headers?.get) {
    for (const name of RATE_LIMIT_HEADER_NAMES) {
      const value = response.headers.get(name);
      if (value !== null && value !== undefined) headers[name] = value;
    }
  }
  let body = "";
  try {
    const raw = (await response.text()).slice(0, MAX_RATE_LIMIT_BODY_CHARS);
    body = shouldSanitize ? sanitizeSecrets(raw) : raw;
  } catch {
    body = "(unreadable)";
  }
  return { headers, body };
}

const DEFAULTS = {
  maxRetries: 3,
  // Measured 2026-08-21: an internet outage during a run produced "fetch
  // failed", the three status-retries were spent in 3.5 seconds, the run
  // recorded a provider health failure and settled as blocked:ask_user — then
  // sat waiting for an answer nobody would give for the next thirty-one
  // minutes. A run is supposed to stop for budget or rate limits, not for a
  // network that came back a few minutes later. Ten attempts capped at a
  // minute each is about four minutes of patience, and it costs nothing: no
  // work is possible while the network is down.
  networkMaxRetries: 10,
  networkMaxDelayMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  callerName: "HTTP",
  useRetryAfter: true,
  drainBody: true,
  sanitizeErrors: true,
} as const;

/**
 * Fetch with exponential-backoff retry, bounded by a PER-PROVIDER concurrency limiter.
 *
 * The permit is acquired BEFORE the first fetch and released only once the returned
 * response body is fully consumed (or the call throws) — so a STREAMING response holds
 * its permit for the lifetime of the stream (the caller reads the body after this
 * returns), correctly bounding simultaneous in-flight connections per provider key. A
 * throw/timeout releases the permit in a finally, so a permit can never leak.
 */
/**
 * What was thrown, in words a log line can carry.
 *
 * `String(err)` renders a plain object as "[object Object]", and that is what
 * nine of ten retry lines said while OpenCode was unreachable on 2026-08-22.
 * Even an Error is not enough on its own: fetch throws TypeError("fetch
 * failed") and puts the reason — ECONNREFUSED, ENOTFOUND, a socket timeout —
 * in `cause`. Follow the chain, name the code, and cap the result so a large
 * object cannot flood the log.
 */
export function describeThrown(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err === "string") return err === "" ? "(empty string thrown)" : err;
  if (typeof err !== "object") return String(err);

  const parts: string[] = [];
  const record = err as Record<string, unknown>;
  if (err instanceof Error && err.message !== "") parts.push(err.message);

  for (const key of ["code", "errno", "syscall", "hostname"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
  }

  if (parts.length === 0) {
    try {
      const json = JSON.stringify(err);
      parts.push(json === undefined || json === "{}" ? `(${Object.prototype.toString.call(err)})` : json);
    } catch {
      parts.push(`(${Object.prototype.toString.call(err)})`);
    }
  }

  // fetch nests the real reason one level down; two is as deep as it goes.
  const cause = record["cause"];
  if (cause !== undefined && cause !== null && depth < 2) {
    parts.push(`caused by ${describeThrown(cause, depth + 1)}`);
  }

  return parts.join(" ").slice(0, 300);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const callerName = opts.callerName ?? DEFAULTS.callerName;
  const semaphore = getProviderSemaphore(callerName);

  const queuedAt = Date.now();
  await semaphore.acquire();
  const queuedMs = Date.now() - queuedAt;
  if (queuedMs > 1_000) {
    // Time spent waiting for a per-provider permit is OUR pacing, not the
    // endpoint being silent — but it used to be charged against the caller's
    // first-response deadline: with cap 3 and 4 parallel nodes, the 4th sat in
    // this queue until the 90s clock fired, was killed as an "unresponsive
    // endpoint", and fed the auto-demote signal. Restart the caller's stall
    // budget now that the wait is over (status 0 = local queueing, delayMs 0 =
    // full budget from this moment).
    opts.onBackoff?.({ status: 0, delayMs: 0 });
    getLogger().debug(`${callerName} HTTP call admitted after queueing`, {
      provider: callerName,
      queuedMs,
    });
  }
  await paceProviderStart(callerName);
  let permitHeld = true;
  const release = (): void => {
    if (permitHeld) {
      permitHeld = false;
      semaphore.release();
    }
  };
  try {
    const response = await runFetchLoop(url, init, opts);
    // Hold the permit until the body is fully consumed/closed (streaming) — the caller
    // reads it after we return. If there is no body, release now.
    if (response.body) {
      return attachReleaseOnBodyClose(response, release);
    }
    release();
    return response;
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Wrap response.body so the per-provider permit is released exactly once, when the
 * stream is fully read, cancelled, or errors. Lets a streaming caller hold the permit
 * for the connection's whole lifetime without leaking it.
 */
function attachReleaseOnBodyClose(response: Response, release: () => void): Response {
  const original = response.body;
  if (!original) {
    release();
    return response;
  }
  const reader = original.getReader();
  // A ReadableStream that proxies the original body and releases the permit exactly
  // once — when the stream ends (close), errors, or is cancelled by the caller. This
  // covers BOTH the non-streaming path (.json() reads to close) and the streaming path
  // (caller reads chunk-by-chunk, or cancels the reader mid-stream).
  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  // Re-wrap so downstream sees a normal Response whose body releases the permit on
  // completion. Headers/status/statusText are preserved.
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function runFetchLoop(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const networkMaxRetries = opts.networkMaxRetries ?? DEFAULTS.networkMaxRetries;
  const networkMaxDelayMs = opts.networkMaxDelayMs ?? DEFAULTS.networkMaxDelayMs;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const callerName = opts.callerName ?? DEFAULTS.callerName;
  const useRetryAfter = opts.useRetryAfter ?? DEFAULTS.useRetryAfter;
  const drainBody = opts.drainBody ?? DEFAULTS.drainBody;
  const shouldSanitize = opts.sanitizeErrors ?? DEFAULTS.sanitizeErrors;

  const logger = getLogger();

  // Transport failures get their own budget, so a network blip cannot spend the
  // status-retry allowance and a status storm cannot spend the network one.
  let networkAttempt = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      const fetchInit = opts.signal ? { ...init, signal: opts.signal } : init;
      response = await fetch(url, fetchInit);
    } catch (err) {
      // An abort is ours, not the network's.
      //
      // Callers pass their signal in the fetch init — openai.ts does at four
      // call sites — and this only ever asked opts.signal. So a stall watchdog
      // or a task cancel looked exactly like a transport failure and was
      // retried ten times, backing off to a minute each, against a signal that
      // could never become un-aborted. Measured 2026-08-22: ten such retries
      // across two hours, every one carrying "This operation was aborted",
      // while the provider answered a direct request in three seconds.
      const effectiveSignal = opts.signal ?? (init as { signal?: AbortSignal }).signal;
      const wasAborted =
        effectiveSignal?.aborted === true ||
        (err instanceof Error && (err.name === "AbortError" || /\baborted\b/iu.test(err.message)));
      if (wasAborted) {
        throw err instanceof Error ? err : new Error(describeThrown(err));
      }
      if (networkAttempt >= networkMaxRetries) {
        // Say it out loud before leaving. Measured 2026-08-22: a provider went
        // unreachable, ten attempts were spent over nearly two hours, and the
        // budget ran out without a single line — the run then sat alive and
        // silent for four more, and the only way to learn what had happened was
        // to count retry warnings by hand.
        logger.error(`${callerName} gave up: ${networkMaxRetries} network attempts exhausted`, {
          attempts: networkMaxRetries,
          error: describeThrown(err),
        });
        throw err instanceof Error ? err : new Error(describeThrown(err));
      }
      const networkDelay = Math.min(
        baseDelayMs * Math.pow(2, networkAttempt) + Math.random() * 100,
        networkMaxDelayMs,
      );
      logger.warn(`${callerName} network error, retrying in ${Math.round(networkDelay)}ms`, {
        attempt: networkAttempt + 1,
        maxRetries: networkMaxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      networkAttempt++;
      // A transport failure is not a turn against the status budget: the server
      // never answered, so nothing was learned about whether it would.
      attempt--;
      // Don't pass signal to sleep — it may be expired from the fetch timeout
      await sleep(networkDelay);
      continue;
    }

    if (response.ok) return response;

    const status = response.status;
    // 529 = server overloaded — don't retry internally, let FallbackChain circuit-break
    const isOverloaded = status === 529;
    const isRetryable = !isOverloaded && (status === 429 || (status >= 500 && status < 600));

    if (!isRetryable || attempt === maxRetries) {
      const rawText = (await response.text().catch(() => "(unreadable)")).slice(0, 200);
      const errorText = shouldSanitize ? sanitizeSecrets(rawText) : rawText;
      // Honest classification: a 429 that has exhausted its retries is RATE-LIMITED,
      // not a generic API error — tag the message so upstream (FallbackChain,
      // goal-decomposition surfacing) reports "rate-limited" instead of misdiagnosing
      // it as an unresponsive endpoint.
      const prefix = status === 429 ? `${callerName} rate-limited (HTTP 429)` : `${callerName} API error ${status}`;
      throw new Error(`${prefix}: ${errorText}`);
    }

    // Parse Retry-After (seconds → ms) once: it both sizes the backoff delay AND drives
    // the hard-quota-stop classification below. NaN/<=0 means the header is absent/invalid.
    const rawRetryAfterMs = useRetryAfter && response.headers?.get
      ? parseFloat(response.headers.get("retry-after") ?? "") * 1000
      : NaN;
    const hasRetryAfter = Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs > 0;

    // Calculate delay: prefer Retry-After header if available (often shorter than the
    // exponential default), so a 429 with a short Retry-After is honored verbatim.
    const delay = hasRetryAfter
      ? Math.min(rawRetryAfterMs, maxDelayMs)
      : baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;

    // For a retryable 429, READ the rate-limit headers + a truncated body BEFORE the
    // body is drained, so the true 429 reason (per-key concurrency, RPM, token quota)
    // becomes VISIBLE instead of being silently discarded. extractRateLimitDiagnostics
    // reads the body, which also drains it (no separate cancel needed in that case).
    let rateLimit: RateLimitDiagnostics | undefined;
    if (status === 429) {
      rateLimit = await extractRateLimitDiagnostics(response, shouldSanitize);
    } else if (drainBody && response.body?.cancel) {
      try { await response.body.cancel(); } catch { /* ignore */ }
    }

    // HARD QUOTA STOP: a 429 whose Retry-After exceeds our ENTIRE retry budget
    // (maxRetries * maxDelayMs — the max total time we could ever spend retrying, since
    // each retry is capped at maxDelayMs) cannot succeed within our window. Retrying is
    // futile and just wastes the budget (e.g. OpenCode's "Weekly usage limit reached.
    // Resets in 3 days" with retry-after ≈ 279094s). The threshold is DERIVED from
    // existing config, not a magic number. Throw a NON-RETRYABLE QuotaExhaustedError NOW
    // (no further attempts) so the FallbackChain fails over to the next provider and puts
    // this one into a long cooldown ≈ the Retry-After. The PRIMARY gate is the threshold;
    // the body pattern only ENRICHES the human message, it is never the sole gate.
    // Subscription-style 429s carry the reset in the BODY, not the header —
    // measured live 2026-08-28: OpenAI Plus returned
    // {"type":"usage_limit_reached","resets_in_seconds":5640} with NO
    // Retry-After, so a 94-minute plan reset was retried on the exponential
    // schedule and hammered the account for the whole window.
    //
    // Both sources are reconciled, and the LONGER reset drives the gate. What was
    // wrong (audited 2026-09-02): the body was consulted only when the header was
    // absent, so `Retry-After: 60` alongside `resets_in_seconds: 580320` (6.7 days)
    // never hard-stopped — the wrapper burned the whole retry budget, threw a
    // plain "rate-limited (HTTP 429)", and the FallbackChain filed the account as
    // a 5-10 minute overload, re-dialing it for the rest of the week. The gate
    // asks "can this recover inside our budget"; a body-stated multi-day reset
    // answers no regardless of the header. The short header still sizes the
    // immediate backoff (`delay` above) when neither source is over the budget.
    let effectiveRetryAfterMs = hasRetryAfter ? rawRetryAfterMs : 0;
    if (status === 429 && rateLimit?.body) {
      const bodyReset = /"resets_in_seconds"\s*:\s*(\d+)/.exec(rateLimit.body);
      if (bodyReset) {
        const bodyResetMs = Number(bodyReset[1]) * 1000;
        if (Number.isFinite(bodyResetMs) && bodyResetMs > effectiveRetryAfterMs) {
          effectiveRetryAfterMs = bodyResetMs;
        }
      }
    }
    const effectiveHasRetryAfter = effectiveRetryAfterMs > 0;

    if (status === 429 && effectiveHasRetryAfter && effectiveRetryAfterMs > maxRetries * maxDelayMs) {
      const reset = formatResetDuration(effectiveRetryAfterMs);
      const quotaReason = rateLimit ? extractQuotaReason(rateLimit.body) : undefined;
      const detail = quotaReason ? `: ${quotaReason}` : "";
      throw new QuotaExhaustedError(
        callerName,
        effectiveRetryAfterMs,
        `${callerName} ${QUOTA_EXHAUSTED_PHRASE} (resets in ${reset})${detail}`,
      );
    }

    // Tell the caller we are about to wait ON PURPOSE during a retry backoff. The
    // FallbackChain uses this to reset its first-response silence timer (a deliberate
    // backoff is us waiting, not the endpoint being unresponsive) and to remember that
    // the failure cause is rate-limiting (429), so a later timeout/exhaustion is
    // reported honestly as rate-limited rather than "unresponsive endpoint". For a 429
    // the parsed rate-limit headers + truncated body ride along so the chain can
    // classify/surface WHY (never any auth header or secret).
    opts.onBackoff?.({ status, delayMs: delay, rateLimit });

    if (status === 429 && rateLimit) {
      logger.warn(`${callerName} API 429, retrying in ${Math.round(delay)}ms`, {
        attempt: attempt + 1,
        maxRetries,
        rateLimitHeaders: rateLimit.headers,
        body: rateLimit.body,
      });
    } else {
      logger.warn(`${callerName} API ${status}, retrying in ${Math.round(delay)}ms`, {
        attempt: attempt + 1,
        maxRetries,
      });
    }

    await sleep(delay);
  }

  throw new Error(`${callerName} max retries exceeded`);
}

/**
 * Sleep for `ms`, rejecting early if `signal` aborts. Exported for reuse by callers
 * that need a bounded, abortable wait (e.g. FallbackChain waiting for the soonest
 * provider cooldown to expire) without re-implementing the abort plumbing.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Aborted")); return; }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      }, { once: true });
    }
  });
}
