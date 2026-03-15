import winston from "winston";
import TransportStream from "winston-transport";

// ---------------------------------------------------------------------------
// Log ring buffer — captures recent entries for the /api/logs dashboard endpoint
// ---------------------------------------------------------------------------

interface LogEntry {
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

class RingBufferTransport extends TransportStream {
  log(info: { timestamp?: string; level: string; message: string; service?: string; [key: string]: unknown }, callback: () => void): void {
    const { timestamp, level, message, service, ...meta } = info;
    let truncatedMeta: Record<string, unknown> | undefined;
    if (Object.keys(meta).length > 0) {
      try {
        const serialized = JSON.stringify(meta);
        truncatedMeta = serialized.length > MAX_META_BYTES
          ? { _truncated: true, preview: serialized.slice(0, 256) }
          : (meta as Record<string, unknown>);
      } catch {
        truncatedMeta = { _truncated: true };
      }
    }
    LOG_RING_BUFFER.push({
      timestamp: String(timestamp ?? new Date().toISOString()),
      level,
      message: String(message).slice(0, MAX_MESSAGE_LENGTH),
      meta: truncatedMeta,
    });
    if (LOG_RING_BUFFER.length > MAX_LOG_ENTRIES) {
      LOG_RING_BUFFER.shift();
    }
    this.emit('logged', info);
    callback();
  }
}

let logger: winston.Logger | null = null;

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
