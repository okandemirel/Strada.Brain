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
      if (attempt === maxRetries) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      logger.debug(`${callerName} network error, retrying`, {
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100, opts.signal);
      continue;
    }

    if (response.ok) return response;

    const status = response.status;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    if (!isRetryable || attempt === maxRetries) {
      const rawText = (await response.text().catch(() => "(unreadable)")).slice(0, 200);
      const errorText = shouldSanitize ? sanitizeSecrets(rawText) : rawText;
      throw new Error(`${callerName} API error ${status}: ${errorText}`);
    }

    // Calculate delay: prefer Retry-After header if available
    let delay: number;
    if (useRetryAfter && response.headers?.get) {
      const retryAfterMs = parseInt(response.headers.get("retry-after") ?? "", 10) * 1000;
      delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, maxDelayMs)
        : baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
    } else {
      delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
    }

    if (drainBody && response.body?.cancel) {
      try { await response.body.cancel(); } catch { /* ignore */ }
    }

    logger.warn(`${callerName} API ${status}, retrying in ${Math.round(delay)}ms`, {
      attempt: attempt + 1,
      maxRetries,
    });

    await sleep(delay, opts.signal);
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
