/**
 * Shared HTTP fetch with exponential backoff retry for transient errors (429, 5xx).
 *
 * Consolidates retry logic from openai.ts and openai-embeddings.ts.
 */

import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";

export interface FetchWithRetryOptions {
  /** Maximum retry attempts (default 3) */
  maxRetries?: number;
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
   */
  onBackoff?: (info: { status: number; delayMs: number }) => void;
}

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  callerName: "HTTP",
  useRetryAfter: true,
  drainBody: true,
  sanitizeErrors: true,
} as const;

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const callerName = opts.callerName ?? DEFAULTS.callerName;
  const useRetryAfter = opts.useRetryAfter ?? DEFAULTS.useRetryAfter;
  const drainBody = opts.drainBody ?? DEFAULTS.drainBody;
  const shouldSanitize = opts.sanitizeErrors ?? DEFAULTS.sanitizeErrors;

  const logger = getLogger();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      const fetchInit = opts.signal ? { ...init, signal: opts.signal } : init;
      response = await fetch(url, fetchInit);
    } catch (err) {
      // If the signal itself caused the abort, don't retry — propagate immediately
      if (opts.signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (attempt === maxRetries) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      logger.debug(`${callerName} network error, retrying`, {
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't pass signal to sleep — it may be expired from the fetch timeout
      await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100);
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

    // Calculate delay: prefer Retry-After header if available (often shorter than the
    // exponential default), so a 429 with a short Retry-After is honored verbatim.
    let delay: number;
    if (useRetryAfter && response.headers?.get) {
      const retryAfterMs = parseFloat(response.headers.get("retry-after") ?? "") * 1000;
      delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, maxDelayMs)
        : baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
    } else {
      delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
    }

    if (drainBody && response.body?.cancel) {
      try { await response.body.cancel(); } catch { /* ignore */ }
    }

    // Tell the caller we are about to wait ON PURPOSE during a retry backoff. The
    // FallbackChain uses this to reset its first-response silence timer (a deliberate
    // backoff is us waiting, not the endpoint being unresponsive) and to remember that
    // the failure cause is rate-limiting (429), so a later timeout/exhaustion is
    // reported honestly as rate-limited rather than "unresponsive endpoint".
    opts.onBackoff?.({ status, delayMs: delay });

    logger.warn(`${callerName} API ${status}, retrying in ${Math.round(delay)}ms`, {
      attempt: attempt + 1,
      maxRetries,
    });

    await sleep(delay);
  }

  throw new Error(`${callerName} max retries exceeded`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
