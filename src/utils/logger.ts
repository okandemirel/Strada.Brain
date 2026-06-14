import winston from "winston";
import TransportStream from "winston-transport";
// Leaf module with no dependencies of its own — safe to import here without
// creating a logger <-> security circular dependency.
import { sanitizeSecretsQuiet } from "../security/secret-patterns.js";

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

/**
 * Recursively sanitize the STRING leaf values of a JSON-safe meta value,
 * leaving keys, structure, and non-string scalars untouched.
 *
 * Running the redaction regexes on individual values (never on the serialized
 * JSON) is what makes Bug 2 unreachable: several patterns' character classes
 * admit JSON delimiters ('"', '}', ';'), so sanitizing the serialized string
 * could eat a closing quote/brace and make the whole blob unparseable —
 * previously collapsing every credential-bearing entry to {_sanitizeFailed}.
 * Uses the metrics-quiet variant so ring-buffer redaction (defense-in-depth)
 * does not inflate the user-facing "Secrets Sanitized" counter.
 */
function sanitizeMetaValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeSecretsQuiet(value);
  if (Array.isArray(value)) return value.map(sanitizeMetaValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeMetaValue(v);
    }
    return out;
  }
  return value;
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

export function createLogger(level: string, logFile: string): winston.Logger {
  if (logger) return logger;

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
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
