import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // AI Providers
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  openaiApiKey: z.string().optional(),
  deepseekApiKey: z.string().optional(),
  qwenApiKey: z.string().optional(),
  kimiApiKey: z.string().optional(),
  minimaxApiKey: z.string().optional(),
  groqApiKey: z.string().optional(),
  mistralApiKey: z.string().optional(),
  togetherApiKey: z.string().optional(),
  fireworksApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  // Comma-separated provider names for fallback chain: "claude,deepseek,ollama"
  providerChain: z.string().optional(),

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

  // Dashboard
  dashboardEnabled: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  dashboardPort: z
    .string()
    .transform((s) => parseInt(s, 10))
    .pipe(z.number().int().min(1024).max(65535))
    .default("3100"),

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
    openaiApiKey: process.env["OPENAI_API_KEY"],
    deepseekApiKey: process.env["DEEPSEEK_API_KEY"],
    qwenApiKey: process.env["QWEN_API_KEY"],
    kimiApiKey: process.env["KIMI_API_KEY"],
    minimaxApiKey: process.env["MINIMAX_API_KEY"],
    groqApiKey: process.env["GROQ_API_KEY"],
    mistralApiKey: process.env["MISTRAL_API_KEY"],
    togetherApiKey: process.env["TOGETHER_API_KEY"],
    fireworksApiKey: process.env["FIREWORKS_API_KEY"],
    geminiApiKey: process.env["GEMINI_API_KEY"],
    providerChain: process.env["PROVIDER_CHAIN"],
    dashboardEnabled: process.env["DASHBOARD_ENABLED"],
    dashboardPort: process.env["DASHBOARD_PORT"],
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
