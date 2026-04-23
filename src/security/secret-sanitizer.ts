/**
 * Secret Sanitizer - Prevents accidental exposure of sensitive data
 *
 * Detects and redacts: API keys, tokens, private keys, credentials
 */

// ─── Constants ───────────────────────────────────────────────────────────────

import { getLogger } from "../utils/logger.js";

const MIN_KEY_LENGTH = 20;
const MAX_OUTPUT_LENGTH = 8192;
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

      const redaction =
        typeof pattern.redaction === "function"
          ? pattern.redaction(matches[0] ?? "")
          : pattern.redaction;
      result = result.replace(pattern.pattern, redaction);
    }

    stats.bytesRemoved = originalLength - result.length;

    // Apply length cap
    if (result.length > this.maxLength) {
      result = result.substring(0, this.maxLength) + TRUNCATION_MARKER;
      stats.bytesRemoved += TRUNCATION_MARKER.length;
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
let onSanitized: ((count: number) => void) | null = null;

function getGlobalSanitizer(): SecretSanitizer {
  globalSanitizer ??= new SecretSanitizer();
  return globalSanitizer;
}

/**
 * Register a callback invoked whenever sanitizeSecrets redacts secrets.
 * Used by MetricsCollector to track sanitization events.
 */
export function setSanitizationCallback(cb: ((count: number) => void) | null): void {
  onSanitized = cb;
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeSecrets(message);
}

export function sanitizeSecrets(content: string, options?: SanitizeOptions): string {
  if (options) {
    const result = new SecretSanitizer(options).sanitize(content);
    if (result.stats.totalMatches > 0) {
      onSanitized?.(result.stats.totalMatches);
    }
    return result.content;
  }
  const result = getGlobalSanitizer().sanitize(content);
  if (result.stats.totalMatches > 0) {
    onSanitized?.(result.stats.totalMatches);
  }
  return result.content;
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
