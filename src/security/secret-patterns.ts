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

const buildKeyPattern = (prefix: string, suffix = ""): RegExp =>
  new RegExp(`${prefix}[a-zA-Z0-9_${suffix}]{${MIN_KEY_LENGTH},}`, "g");

const buildEnvPattern = (keys: string[]): RegExp =>
  new RegExp(
    `(?:${keys.join("|")})["']?\\s*[:=]\\s*["']?[a-zA-Z0-9_\\-\\/+=]{${MIN_KEY_LENGTH},}["']?`,
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
    name: "discord_token",
    pattern: /[MN][A-Za-z\d]{20,}\.[\w-]{6,}\.[\w-]{20,}/g,
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
    name: "database_url",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^/\s]+/gi,
    redaction: (match: string) => {
      const urlMatch = match.match(/^(\w+:\/\/)[^:]+:[^@]+(@.+)$/);
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
    name: "private_key",
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
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
    pattern: buildEnvPattern(["secret", "token", "password", "key"]),
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

    const redaction =
      typeof pattern.redaction === "function"
        ? pattern.redaction(matches[0] ?? "")
        : pattern.redaction;
    result = result.replace(pattern.pattern, redaction);
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
