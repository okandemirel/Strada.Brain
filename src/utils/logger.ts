import winston from "winston";
import TransportStream from "winston-transport";
// Leaf module with no dependencies of its own — safe to import here without
// creating a logger <-> security circular dependency.
import { applySecretPatterns, DEFAULT_SECRET_PATTERNS, sanitizeSecretsQuiet } from "../security/secret-patterns.js";

// ---------------------------------------------------------------------------
// Log ring buffer — captures recent entries for the /api/logs dashboard endpoint
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

const LOG_RING_BUFFER: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

export function getLogRingBuffer(): LogEntry[] {
  return [...LOG_RING_BUFFER];
}

/** Maximum serialized byte length for log entry metadata to prevent memory bloat. */
const MAX_META_BYTES = 2048;
/** Maximum message length stored in the ring buffer. */
const MAX_MESSAGE_LENGTH = 4096;
/** Nesting a log line's meta is walked to; deeper values become "[Depth]". */
const MAX_META_DEPTH = 10;
/**
 * Per-string cap for log redaction. The shared 8192 cap is sized for tool
 * output; applied here it silently cut long values (stack traces, provider
 * bodies) in the File and Console logs too.
 */
const MAX_LOG_TEXT_LENGTH = 64 * 1024;

function redactLogText(text: string): string {
  return applySecretPatterns(text, DEFAULT_SECRET_PATTERNS, MAX_LOG_TEXT_LENGTH).content;
}

/**
 * Recursively sanitize the STRING leaf values of a meta value,
 * leaving keys, structure, and non-string scalars untouched.
 *
 * Running the redaction regexes on individual values (never on the serialized
 * JSON) is what makes Bug 2 unreachable: several patterns' character classes
 * admit JSON delimiters ('"', '}', ';'), so sanitizing the serialized string
 * could eat a closing quote/brace and make the whole blob unparseable —
 * previously collapsing every credential-bearing entry to {_sanitizeFailed}.
 * Uses the metrics-quiet path so ring-buffer redaction (defense-in-depth)
 * does not inflate the user-facing "Secrets Sanitized" counter.
 *
 * Meta is caller data, not JSON: a cycle recursed until the stack overflowed
 * and threw into whatever request logged it, and Date/Error/Map values were
 * walked as plain objects and came out as `{}` in every transport (the error
 * text of every `{ error }` log was lost). Cycles and depth are bounded, an
 * Error keeps its name/message/stack/code, and `toJSON` (Date, Buffer) is
 * honoured the way JSON serialization would.
 */
function sanitizeMetaValue(value: unknown, ancestors: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_META_DEPTH) return "[Depth]";
  ancestors.add(value);
  try {
    const next = (v: unknown): unknown => sanitizeMetaValue(v, ancestors, depth + 1);
    if (value instanceof Error) {
      const out: Record<string, unknown> = { name: value.name, message: redactLogText(value.message) };
      if (value.stack) out["stack"] = redactLogText(value.stack);
      const code: unknown = (value as { code?: unknown }).code;
      if (code !== undefined) out["code"] = next(code);
      if (value.cause !== undefined) out["cause"] = next(value.cause);
      return out;
    }
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return next((toJSON as () => unknown).call(value));
    if (value instanceof Map) return next(Object.fromEntries(value));
    if (value instanceof Set) return next([...value]);
    if (Array.isArray(value)) return value.map(next);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = next(v);
    }
    return out;
  } finally {
    // Only the current path counts: the same object under two siblings is
    // shared, not circular.
    ancestors.delete(value);
  }
}

class RingBufferTransport extends TransportStream {
  log(info: { timestamp?: string; level: string; message: string; service?: string; [key: string]: unknown }, callback: () => void): void {
    const { timestamp, level, message, service: _service, ...meta } = info;
    let storedMeta: Record<string, unknown> | undefined;
    if (Object.keys(meta).length > 0) {
      try {
        const serialized = JSON.stringify(meta);
        if (serialized.length > MAX_META_BYTES) {
          // Preview is a plain string, never re-parsed — safe to sanitize directly.
          storedMeta = { _truncated: true, preview: sanitizeSecretsQuiet(serialized.slice(0, 256)) };
        } else {
          // serialized came from JSON.stringify, so JSON.parse always succeeds
          // (preserves the prior Date→string / undefined-drop semantics). We then
          // sanitize only the string LEAF values — never JSON delimiters — so no
          // redaction can corrupt the structure.
          const cloned = JSON.parse(serialized) as Record<string, unknown>;
          storedMeta = sanitizeMetaValue(cloned) as Record<string, unknown>;
        }
      } catch {
        storedMeta = { _truncated: true };
      }
    }
    LOG_RING_BUFFER.push({
      timestamp: String(timestamp ?? new Date().toISOString()),
      level,
      // Plain string — safe to sanitize directly (metrics-quiet on this hot path).
      message: sanitizeSecretsQuiet(String(message).slice(0, MAX_MESSAGE_LENGTH)),
      meta: storedMeta,
    });
    if (LOG_RING_BUFFER.length > MAX_LOG_ENTRIES) {
      LOG_RING_BUFFER.shift();
    }
    this.emit('logged', info);
    callback();
  }
}

let logger: winston.Logger | null = null;

export interface LoggerLike {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Redact secrets for EVERY transport, not just the ring buffer.
 *
 * Redaction used to live only inside `RingBufferTransport.log`, so a value the
 * dashboard showed as `[REDACTED]` was written in clear text to the rotating
 * log file on disk and to stdout — which is exactly where container log
 * collectors and CI job logs pick it up. Running it as a shared winston format
 * means the sanitized `info` object reaches Console, File and the ring buffer
 * alike, and there is one place to audit.
 *
 * String leaves only, never the serialized JSON: the patterns can match
 * characters that double as JSON delimiters, so sanitizing a serialized object
 * would corrupt its structure.
 */
const redactSecretsFormat = winston.format((info) => {
  // Formats run before winston's per-transport level filter, so without this
  // every suppressed debug() line still paid for the full regex pass.
  if (logger && !logger.isLevelEnabled(info.level)) return false;
  if (typeof info.message === "string") {
    info.message = redactLogText(info.message);
  }
  const ancestors = new WeakSet<object>([info]);
  for (const key of Object.keys(info)) {
    if (key === "message" || key === "level" || key === "timestamp") continue;
    const value = (info as Record<string, unknown>)[key];
    (info as Record<string, unknown>)[key] = sanitizeMetaValue(value, ancestors);
  }
  return info;
});

export function createLogger(level: string, logFile: string): winston.Logger {
  if (logger) return logger;

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      // Before json() so the redaction sees structured leaves, and before every
      // transport so none of them can receive an unredacted line.
      redactSecretsFormat(),
      winston.format.json()
    ),
    defaultMeta: { service: "strada-brain" },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length > 1
              ? ` ${JSON.stringify(meta, null, 0)}`
              : "";
            return `${String(timestamp)} [${level}] ${String(message)}${metaStr}`;
          })
        ),
      }),
      new winston.transports.File({
        filename: logFile,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        tailable: true,
        zippedArchive: true,
      }),
      new RingBufferTransport(),
    ],
  });

  return logger;
}

export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error("Logger not initialized. Call createLogger() first.");
  }
  return logger;
}

export function getLoggerSafe(): LoggerLike {
  return logger ?? NOOP_LOGGER;
}
