import winston from "winston";

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
    defaultMeta: { service: "strata-brain" },
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
        maxFiles: 3,
      }),
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
