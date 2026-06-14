/**
 * Secret Sanitizer - Prevents accidental exposure of sensitive data
 *
 * Detects and redacts: API keys, tokens, private keys, credentials.
 *
 * The dependency-free pattern table and pure sanitization core live in
 * ./secret-patterns.ts (a leaf module that utils/logger.ts can import
 * without circular dependencies); this module layers the configurable
 * SecretSanitizer class API and debug logging on top.
 */

import { getLogger } from "../utils/logger.js";
import {
  DEFAULT_SECRET_PATTERNS,
  MAX_OUTPUT_LENGTH,
  emitSanitizationEvent,
  sanitizeSecrets as applyDefaultSanitization,
  type SanitizationStats,
  type SanitizeOptions,
  type SanitizeResult,
  type SecretPattern,
} from "./secret-patterns.js";

export { DEFAULT_SECRET_PATTERNS, setSanitizationCallback } from "./secret-patterns.js";
export type {
  SecretPattern,
  SanitizationStats,
  SanitizeOptions,
  SanitizeResult,
} from "./secret-patterns.js";

/**
 * Truncation suffix appended when sanitized output exceeds `maxLength`.
 *
 * Re-declared locally (it is module-private in ./secret-patterns.ts) because
 * `SecretSanitizer.sanitize()` performs its own refined bytesRemoved accounting
 * — per-pattern clamped shrinkage plus truncated-source-byte counting — that is
 * verified by the class-level statistics tests and is not reproducible from the
 * leaf `applySecretPatterns` return value alone. Keep this string in sync with
 * the leaf's TRUNCATION_MARKER.
 */
const TRUNCATION_MARKER = "\n... (truncated)";

// ─── SecretSanitizer Class ───────────────────────────────────────────────────

export class SecretSanitizer {
  private readonly patterns: SecretPattern[];
  private readonly maxLength: number;
  private readonly debug: boolean;

  constructor(options: SanitizeOptions = {}) {
    this.patterns = this.buildPatterns(options);
    this.maxLength = options.maxLength ?? MAX_OUTPUT_LENGTH;
    this.debug = options.debug ?? false;
  }

  private buildPatterns(options: SanitizeOptions): SecretPattern[] {
    let patterns = [...DEFAULT_SECRET_PATTERNS];

    if (options.excludePatterns) {
      patterns = patterns.filter((p) => !options.excludePatterns!.includes(p.name));
    }
    if (options.additionalPatterns) {
      patterns.push(...options.additionalPatterns);
    }

    return patterns;
  }

  sanitize(content: string): SanitizeResult {
    const stats: SanitizationStats = {
      totalMatches: 0,
      matchesByPattern: {},
      bytesRemoved: 0,
    };

    let result = content;
    let bytesRemoved = 0;
    const originalLength = content.length;

    for (const pattern of this.patterns) {
      pattern.pattern.lastIndex = 0;
      const matches = result.match(pattern.pattern);
      if (!matches) continue;

      stats.totalMatches += matches.length;
      stats.matchesByPattern[pattern.name] = matches.length;

      if (this.debug) {
        getLogger().info(
          `[SecretSanitizer] Matched ${pattern.name}: ${matches.length} occurrence(s)`,
        );
      }

      const lengthBefore = result.length;
      if (typeof pattern.redaction === "function") {
        // Evaluate the redaction per-match from each match's OWN text. Passing a
        // precomputed string (derived from matches[0]) re-used the first match's
        // scheme/host for every later match, and any `$&`/`$1` in a matched host
        // re-injected the plaintext via String.replace's pattern semantics.
        const fn = pattern.redaction;
        result = result.replace(pattern.pattern, (match) => fn(match));
      } else {
        // String redactions intentionally keep `$1` back-reference semantics.
        result = result.replace(pattern.pattern, pattern.redaction);
      }
      // Accumulate per-pattern shrinkage, clamped at 0: a redaction marker longer
      // than the matched secret counts as 0, never as negative bytesRemoved.
      bytesRemoved += Math.max(0, lengthBefore - result.length);
    }

    stats.bytesRemoved = bytesRemoved;

    // Apply length cap
    if (result.length > this.maxLength) {
      const lengthBeforeTruncation = result.length;
      result = result.substring(0, this.maxLength) + TRUNCATION_MARKER;
      // Count the source bytes actually dropped by truncation — the appended
      // marker is added output, not removed bytes.
      stats.bytesRemoved += lengthBeforeTruncation - this.maxLength;
    }

    return {
      content: result,
      wasSanitized: stats.totalMatches > 0 || originalLength > this.maxLength,
      stats,
    };
  }

  containsSecrets(content: string): boolean {
    return this.patterns.some((p) => {
      p.pattern.lastIndex = 0;
      return p.pattern.test(content);
    });
  }

  getActivePatterns(): string[] {
    return this.patterns.map((p) => p.name);
  }
}

// ─── Convenience Functions ───────────────────────────────────────────────────

let globalSanitizer: SecretSanitizer | null = null;

function getGlobalSanitizer(): SecretSanitizer {
  globalSanitizer ??= new SecretSanitizer();
  return globalSanitizer;
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeSecrets(message);
}

export function sanitizeSecrets(content: string, options?: SanitizeOptions): string {
  if (options) {
    const result = new SecretSanitizer(options).sanitize(content);
    emitSanitizationEvent(result.stats.totalMatches);
    return result.content;
  }
  return applyDefaultSanitization(content);
}

export function hasSecrets(content: string): boolean {
  return getGlobalSanitizer().containsSecrets(content);
}

/**
 * Recursively walk an arbitrary value, sanitizing every string leaf via
 * {@link sanitizeSecrets}. Preserves object/array shape, pass-through for
 * numbers / booleans / null / bigint. Functions and symbols are dropped to
 * `undefined` rather than leaking (matches the policy of the former private
 * `sanitizeDeep` helper in `agentdb-memory.ts`).
 *
 * Protects against cyclic references via a WeakSet guard — cycles resolve to
 * `"[Circular]"` strings rather than blowing the stack. Callers should treat
 * the returned value as a *new* tree (primitive leaves may alias the input,
 * but every container is freshly allocated).
 *
 * Exported so memory-write paths can share one canonical deep-sanitize policy
 * (see review finding #3: DRY extraction).
 */
export function sanitizeSecretsDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  return walk(value, seen) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeSecrets(value);
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return undefined;
  if (t !== "object") return value;

  // Object / array path — guard against cycles.
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, seen);
  }
  return out;
}

export function createSanitizationReport(
  results: SanitizeResult[],
  context: string,
): Record<string, unknown> {
  const patternsHit = new Set<string>();
  let totalMatches = 0;
  let totalBytesRemoved = 0;

  for (const result of results) {
    totalMatches += result.stats.totalMatches;
    totalBytesRemoved += result.stats.bytesRemoved;
    Object.keys(result.stats.matchesByPattern).forEach((p) => patternsHit.add(p));
  }

  return {
    context,
    totalOperations: results.length,
    totalMatches,
    totalBytesRemoved,
    uniquePatternsHit: Array.from(patternsHit),
    sanitizationRate: results.filter((r) => r.wasSanitized).length / results.length,
  };
}
