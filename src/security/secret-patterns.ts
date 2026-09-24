/**
 * Secret Patterns — dependency-free sanitization core.
 *
 * Pure leaf module: it imports nothing (no logger, no config) so low-level
 * modules like utils/logger.ts can use it without creating circular
 * dependencies. The configurable SecretSanitizer class API (with debug
 * logging) lives in ./secret-sanitizer.ts and layers on top of this core.
 *
 * Detects and redacts: API keys, tokens, private keys, credentials.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_KEY_LENGTH = 20;
/** Default maximum sanitized output length before truncation. */
export const MAX_OUTPUT_LENGTH = 8192;
const TRUNCATION_MARKER = "\n... (truncated)";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  redaction: string | ((match: string) => string);
}

export interface SanitizationStats {
  totalMatches: number;
  matchesByPattern: Record<string, number>;
  bytesRemoved: number;
}

export interface SanitizeOptions {
  additionalPatterns?: SecretPattern[];
  excludePatterns?: string[];
  maxLength?: number;
  debug?: boolean;
}

export interface SanitizeResult {
  content: string;
  wasSanitized: boolean;
  stats: SanitizationStats;
}

// ─── Pattern Builders ────────────────────────────────────────────────────────

// The (?<![A-Za-z0-9]) lookbehind keeps the prefix from matching inside a
// longer word: "task-<hex>" lease dirs contain "sk-" and were mangled into
// "ta[REDACTED]" in logs and tool results alike (measured 2026-08-26).
const buildKeyPattern = (prefix: string, suffix = ""): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])${prefix}[a-zA-Z0-9_${suffix}]{${MIN_KEY_LENGTH},}`, "g");

const buildEnvPattern = (keys: string[]): RegExp =>
  new RegExp(
    `(?:${keys.join("|")})["']?\\s*[:=]\\s*["']?[a-zA-Z0-9_\\-\\/+=]{${MIN_KEY_LENGTH},}["']?`,
    "gi",
  );

/**
 * Like buildEnvPattern, but an unquoted value that is immediately called —
 * `cacheKey = BuildCacheKeyForPlayer(profile)` — is code, not a credential.
 * Redacting it mangled C# kept in memory and task results (SEC-9). Quoted
 * values and env/YAML-style values are still redacted.
 */
const buildAssignedSecretPattern = (keys: string[]): RegExp =>
  new RegExp(
    `(?:${keys.join("|")})["']?\\s*[:=]\\s*` +
      `(?:["'][a-zA-Z0-9_\\-\\/+=]{${MIN_KEY_LENGTH},}["']?` +
      `|[a-zA-Z0-9_\\-\\/+=]{${MIN_KEY_LENGTH},}(?![a-zA-Z0-9_\\-\\/+=(]))`,
    "gi",
  );

// ─── Default Patterns ────────────────────────────────────────────────────────

export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  // API Keys (most specific patterns first to prevent greedy matches)
  {
    name: "openai_project_key",
    pattern: buildKeyPattern("sk-proj-", "\\-"),
    redaction: "[REDACTED_OPENAI_PROJECT_KEY]",
  },
  { name: "openai_api_key", pattern: buildKeyPattern("sk-", "\\-"), redaction: "[REDACTED_OPENAI_KEY]" },
  {
    name: "github_token",
    pattern: /gh[pousr]_[a-zA-Z0-9]{20,}/g,
    redaction: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "github_pat",
    pattern: /github_pat_[a-zA-Z0-9]{20,}_[a-zA-Z0-9]{20,}/g,
    redaction: "[REDACTED_GITHUB_PAT]",
  },
  {
    name: "slack_token",
    pattern: /xox[bpas]-[a-zA-Z0-9-]{10,}/g,
    redaction: "[REDACTED_SLACK_TOKEN]",
  },
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g, redaction: "[REDACTED_AWS_KEY]" },
  {
    // Token shape: base64 of the numeric bot id (so it holds a digit), a
    // 6-character timestamp, then the HMAC. Without the digit and the fixed
    // middle length, dotted C# namespaces matched (SEC-9). The lookbehind keeps
    // a match from starting inside a longer dotted identifier.
    name: "discord_token",
    pattern: /(?<![\w.-])[MNO](?=[A-Za-z\d]{0,80}\d)[A-Za-z\d]{20,}\.[\w-]{6}\.[\w-]{20,}/g,
    redaction: "[REDACTED_DISCORD_TOKEN]",
  },
  {
    name: "telegram_token",
    pattern: /\d{8,10}:[a-zA-Z0-9_-]{20,}/g,
    redaction: "[REDACTED_TELEGRAM_TOKEN]",
  },

  // Anthropic keys
  {
    name: "anthropic_api_key",
    pattern: /sk-ant-api03-[a-zA-Z0-9_\-]{20,}/g,
    redaction: "[REDACTED_ANTHROPIC_KEY]",
  },

  // Groq API keys
  { name: "groq_api_key", pattern: /gsk_[a-zA-Z0-9]{20,}/g, redaction: "[REDACTED_GROQ_KEY]" },

  // Google/GCP keys
  { name: "gcp_api_key", pattern: /AIza[0-9A-Za-z_\-]{35}/g, redaction: "[REDACTED_GCP_KEY]" },

  // Azure keys
  {
    name: "azure_key",
    pattern:
      /(?:AZURE_[A-Z_]*KEY|azure[_-](?:storage|api|subscription)[_-]key)["']?\s*[:=]\s*["']?[a-zA-Z0-9+/=]{20,}["']?/gi,
    redaction: "[REDACTED_AZURE_KEY]",
  },

  // WhatsApp/Meta tokens
  { name: "whatsapp_token", pattern: /EAA[a-zA-Z0-9]{20,}/g, redaction: "[REDACTED_META_TOKEN]" },

  // Firebase service account (JSON key identifier)
  {
    name: "firebase_private_key_id",
    pattern: /"private_key_id"\s*:\s*"[a-f0-9]{40}"/g,
    redaction: '"private_key_id": "[REDACTED]"',
  },
  {
    name: "firebase_client_email",
    pattern: /"client_email"\s*:\s*"[^"]*@[^"]*\.iam\.gserviceaccount\.com"/g,
    redaction: '"client_email": "[REDACTED]"',
  },

  {
    name: "jwt_token",
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    redaction: "[REDACTED_JWT]",
  },

  // Auth headers
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
    redaction: "Bearer [REDACTED]",
  },
  {
    name: "basic_auth",
    pattern: /Basic\s+[a-zA-Z0-9+/]{20,}={0,2}/gi,
    redaction: "Basic [REDACTED]",
  },

  // URLs and connections
  {
    name: "slack_webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
    redaction: "[REDACTED_SLACK_WEBHOOK]",
  },
  {
    // The password may itself contain "@": credentials run to the LAST "@"
    // before the host, or the tail of such a password leaked (SEC-9).
    name: "database_url",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:\s/]+:\S*@[^/\s@]+/gi,
    redaction: (match: string) => {
      const urlMatch = match.match(/^(\w+:\/\/)[^:]+:.*(@[^@]+)$/);
      return urlMatch
        ? `${urlMatch[1]}[REDACTED_CREDENTIALS]${urlMatch[2]}`
        : "[REDACTED_DATABASE_URL]";
    },
  },

  // Credentials
  {
    name: "aws_secret_key",
    pattern: buildEnvPattern(["aws_secret", "aws_secret_access_key"]),
    redaction: "[REDACTED_AWS_SECRET]",
  },
  {
    // Any PRIVATE KEY armour (ENCRYPTED, PGP ... BLOCK, ...), up to its END
    // line or, for a partial read that cut the block, the end of the input.
    // Both used to pass through unredacted (SEC-9).
    name: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    redaction: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "connection_password",
    pattern: /(?:password|pwd)=([^;\s&]{4,})/gi,
    redaction: "password=[REDACTED]",
  },

  // Generic patterns (lowest priority)
  {
    name: "api_key",
    pattern: buildEnvPattern(["api_key", "apikey", "api_secret"]),
    redaction: "[REDACTED_API_KEY]",
  },
  { name: "env_value", pattern: /^([A-Z_][A-Z0-9_]*)=(.+)$/gm, redaction: "$1=[REDACTED]" },
  {
    name: "secret_value",
    pattern: buildAssignedSecretPattern(["secret", "token", "password", "key"]),
    redaction: "[REDACTED_SECRET]",
  },
];

// ─── Pure Sanitization Core ──────────────────────────────────────────────────

/**
 * Apply secret patterns to content, redacting matches and capping length.
 * Pure function — the optional `onPatternMatch` callback lets callers layer
 * side effects (e.g. debug logging) without this module depending on them.
 */
export function applySecretPatterns(
  content: string,
  patterns: SecretPattern[],
  maxLength: number,
  onPatternMatch?: (patternName: string, matchCount: number) => void,
): SanitizeResult {
  const stats: SanitizationStats = {
    totalMatches: 0,
    matchesByPattern: {},
    bytesRemoved: 0,
  };

  let result = content;
  const originalLength = content.length;

  for (const pattern of patterns) {
    pattern.pattern.lastIndex = 0;
    const matches = result.match(pattern.pattern);
    if (!matches) continue;

    stats.totalMatches += matches.length;
    stats.matchesByPattern[pattern.name] = matches.length;

    onPatternMatch?.(pattern.name, matches.length);

    // FUNCTION redactions: pass a per-match replacer so each match is redacted
    // from its OWN text (no cross-record corruption: e.g. two different DB URLs
    // each keep their own scheme+host). The function return value is also NOT
    // $-interpreted by String.replace, so a redaction that embeds match-derived
    // text or a secret legally containing "$&"/"$1"/"$`" can't re-insert the
    // raw secret. STRING redactions keep group refs (e.g. env_value "$1=...").
    const { redaction } = pattern;
    result =
      typeof redaction === "function"
        ? result.replace(pattern.pattern, (m) => redaction(m))
        : result.replace(pattern.pattern, redaction);
  }

  stats.bytesRemoved = originalLength - result.length;

  // Apply length cap
  if (result.length > maxLength) {
    result = result.substring(0, maxLength) + TRUNCATION_MARKER;
    stats.bytesRemoved += TRUNCATION_MARKER.length;
  }

  return {
    content: result,
    wasSanitized: stats.totalMatches > 0 || originalLength > maxLength,
    stats,
  };
}

// ─── Sanitization Event Callback ─────────────────────────────────────────────

let onSanitized: ((count: number) => void) | null = null;

/**
 * Register a callback invoked whenever sanitizeSecrets redacts secrets.
 * Used by MetricsCollector to track sanitization events.
 */
export function setSanitizationCallback(cb: ((count: number) => void) | null): void {
  onSanitized = cb;
}

/** Fire the registered sanitization callback when redactions occurred. */
export function emitSanitizationEvent(count: number): void {
  if (count > 0) {
    onSanitized?.(count);
  }
}

// ─── Default Sanitize Convenience ────────────────────────────────────────────

/**
 * Sanitize content with the default pattern set and length cap.
 * Dependency-free equivalent of secret-sanitizer.ts's no-options path —
 * safe to import from leaf modules such as utils/logger.ts.
 */
export function sanitizeSecrets(content: string): string {
  const result = applySecretPatterns(content, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);
  emitSanitizationEvent(result.stats.totalMatches);
  return result.content;
}

// ─── Redaction Without a Length Cap ──────────────────────────────────────────
//
// sanitizeSecrets() also cuts its output at MAX_OUTPUT_LENGTH, which is right
// for logs and display and wrong for anything that is stored and read back: a
// cut through serialized JSON makes the row unparseable, and a cut final
// answer is simply lost text. Stored data is redacted with the functions
// below instead (SEC-3).

/** Redact secrets from `content` without truncating it. For persisted text. */
export function redactSecrets(content: string): string {
  const result = applySecretPatterns(content, DEFAULT_SECRET_PATTERNS, Number.POSITIVE_INFINITY);
  emitSanitizationEvent(result.stats.totalMatches);
  return result.content;
}

/**
 * Redact every string inside `value`, keeping its shape, so the result still
 * serializes to valid JSON. Regexes run over serialized JSON can eat quotes
 * and braces; running them per string leaf cannot.
 *
 * A property's key is part of the evidence ("password", "api_key", ...): the
 * serialized form used to supply it, so each property value is also checked
 * as a `"key":"value"` pair and replaced whole when only the pair matches.
 * Functions and symbols are dropped; cycles become "[Circular]".
 */
export function redactSecretsDeep<T>(value: T): T {
  return redactNode(value, undefined, new WeakSet<object>()) as T;
}

/** `JSON.stringify(redactSecretsDeep(value))` — the storage form of structured data. */
export function stringifyRedacted(value: unknown): string {
  return JSON.stringify(redactSecretsDeep(value));
}

function redactNode(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLeaf(value, key);
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "function" || t === "symbol") return undefined;
  if (t !== "object") return value;
  // Keep what JSON.stringify would do with dates and other toJSON objects.
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    return redactNode((withToJson.toJSON as () => unknown).call(value), key, seen);
  }
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => redactNode(item, undefined, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A key can carry a secret too (a map keyed by token); the old
    // serialized-form redaction covered keys, so this must as well.
    const safeKey = redactSecrets(k);
    // defineProperty, not assignment: a "__proto__" key must stay data.
    Object.defineProperty(out, safeKey, {
      value: redactNode(v, safeKey, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function redactLeaf(value: string, key: string | undefined): string {
  const redacted = redactSecrets(value);
  if (redacted !== value || key === undefined) return redacted;
  const pair = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  const probe = applySecretPatterns(pair, DEFAULT_SECRET_PATTERNS, Number.POSITIVE_INFINITY);
  if (probe.stats.totalMatches === 0) return value;
  emitSanitizationEvent(probe.stats.totalMatches);
  return "[REDACTED_SECRET]";
}

/**
 * Like {@link sanitizeSecrets} but does NOT fire the sanitization metric event.
 *
 * The logger applies this on every ring-buffer write as defense-in-depth, not
 * as a distinct exposure event. Routine lines (e.g. "DEBUG=true", "token=...")
 * trip the env_value/secret_value patterns and would otherwise inflate the
 * user-facing "Secrets Sanitized" counter on the dashboard. Redaction still
 * happens; only the metric emission is suppressed for this hot path.
 */
export function sanitizeSecretsQuiet(content: string): string {
  return applySecretPatterns(content, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH).content;
}
