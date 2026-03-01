import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // AI Providers
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // Telegram (optional — only required when using telegram channel)
  telegramBotToken: z.string().optional(),

  // Security
  allowedTelegramUserIds: z
    .string()
    .transform((s) => s.split(",").map((id) => parseInt(id.trim(), 10)))
    .pipe(z.array(z.number().int().positive()))
    .optional(),
  requireEditConfirmation: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  readOnlyMode: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // Project
  unityProjectPath: z.string().min(1, "UNITY_PROJECT_PATH is required"),

  // Memory
  memoryEnabled: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  memoryDbPath: z.string().default(".strata-memory"),

  // Logging
  logLevel: z
    .enum(["error", "warn", "info", "debug"])
    .default("info"),
  logFile: z.string().default("strata-brain.log"),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse({
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"],
    allowedTelegramUserIds: process.env["ALLOWED_TELEGRAM_USER_IDS"],
    requireEditConfirmation: process.env["REQUIRE_EDIT_CONFIRMATION"],
    readOnlyMode: process.env["READ_ONLY_MODE"],
    unityProjectPath: process.env["UNITY_PROJECT_PATH"],
    memoryEnabled: process.env["MEMORY_ENABLED"],
    memoryDbPath: process.env["MEMORY_DB_PATH"],
    logLevel: process.env["LOG_LEVEL"],
    logFile: process.env["LOG_FILE"],
  });

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const config = result.data;

  // Validate project path is a real directory
  let realPath: string;
  try {
    realPath = realpathSync(config.unityProjectPath);
  } catch {
    throw new Error(`UNITY_PROJECT_PATH does not exist: ${config.unityProjectPath}`);
  }
  try {
    const stats = statSync(realPath);
    if (!stats.isDirectory()) {
      throw new Error(`UNITY_PROJECT_PATH is not a directory: ${config.unityProjectPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new Error(`UNITY_PROJECT_PATH is not a directory: ${config.unityProjectPath}`);
    }
    throw error;
  }
  config.unityProjectPath = realPath;

  cachedConfig = config;
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
