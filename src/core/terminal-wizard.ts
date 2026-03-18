/* eslint-disable no-console -- terminal setup wizard intentionally prints directly to stdout/stderr */
/**
 * Terminal Setup Wizard - Interactive readline-based first-time configuration.
 *
 * Provides a quick terminal alternative to the web-based SetupWizard.
 * Uses only Node.js built-ins (zero external dependencies).
 *
 * Security:
 * - Unity project paths must be absolute and inside the user's home directory.
 * - All .env values are sanitized against newline injection.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const MAX_RETRIES = 3;
const RESPONSE_PROVIDER_CHOICES = [
  "claude", "openai", "deepseek", "kimi", "qwen", "gemini",
  "groq", "mistral", "together", "fireworks", "minimax", "ollama",
] as const;
const EMBEDDING_PROVIDER_CHOICES = [
  "auto", "gemini", "openai", "mistral", "together", "fireworks", "qwen", "ollama",
] as const;
const CHANNEL_CHOICES = ["web", "telegram", "discord", "slack", "whatsapp", "cli"] as const;
const LANGUAGE_CHOICES = ["en", "tr", "ja", "ko", "zh", "de", "es", "fr"] as const;
const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  kimi: "KIMI_API_KEY",
  qwen: "QWEN_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  minimax: "MINIMAX_API_KEY",
};
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  qwen: "Qwen",
  gemini: "Gemini",
  groq: "Groq",
  mistral: "Mistral",
  together: "Together",
  fireworks: "Fireworks",
  minimax: "MiniMax",
  ollama: "Ollama",
};
const DEFAULT_EMBEDDING_PROVIDERS = new Set([
  "gemini", "openai", "mistral", "together", "fireworks", "qwen", "ollama",
]);

export interface WizardAnswers {
  unityProjectPath: string;
  apiKey?: string;
  provider: string;
  openaiAuthMode?: "api-key" | "chatgpt-subscription";
  embeddingProvider: string;
  embeddingApiKey?: string;
  channel: string;
  language: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate that a Unity project path is absolute, exists, is a directory,
 * and resides inside the user's home directory.
 */
export function validateUnityPath(inputPath: string): ValidationResult {
  if (!inputPath || inputPath.trim() === "") {
    return { valid: false, error: "Path cannot be empty." };
  }

  const trimmed = inputPath.trim();

  if (!path.isAbsolute(trimmed)) {
    return { valid: false, error: "Path must be absolute (e.g. /path/to/MyGame)." };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(trimmed);
  } catch {
    return { valid: false, error: `Path does not exist: ${trimmed}` };
  }

  const homedir = os.homedir();
  if (resolved !== homedir && !resolved.startsWith(homedir + "/")) {
    return { valid: false, error: `Path must be inside your home directory (${homedir}).` };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return { valid: false, error: "Path must be a directory." };
  }

  return { valid: true };
}

/**
 * Sanitise a value before embedding it in a .env file line.
 *
 * Strips carriage returns and newline characters to prevent injection
 * of extra lines into the .env file, then trims whitespace.
 */
export function sanitizeEnvValue(value: string): string {
  return String(value).replace(/[\r\n"]/g, "").trim();
}

/**
 * Detect the AI provider from the API key prefix.
 *
 * - `sk-ant-` → Claude (Anthropic)
 * - `sk-proj-` → OpenAI (project-scoped)
 * - `AIza` → Gemini (Google)
 * - Fallback → Claude
 */
export function detectProvider(apiKey: string): string {
  if (apiKey.startsWith("sk-ant-")) return "claude";
  if (apiKey.startsWith("sk-proj-")) return "openai";
  if (apiKey.startsWith("AIza")) return "gemini";
  return "claude";
}

function isValidEmbeddingProvider(value: string): boolean {
  return EMBEDDING_PROVIDER_CHOICES.includes(value as typeof EMBEDDING_PROVIDER_CHOICES[number]);
}

function getDefaultEmbeddingProvider(provider: string): string {
  return DEFAULT_EMBEDDING_PROVIDERS.has(provider) ? provider : "auto";
}

function getEmbeddingProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function getResponseProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function isValidResponseProvider(value: string): boolean {
  return RESPONSE_PROVIDER_CHOICES.includes(value as typeof RESPONSE_PROVIDER_CHOICES[number]);
}

function isValidChannel(value: string): boolean {
  return CHANNEL_CHOICES.includes(value as typeof CHANNEL_CHOICES[number]);
}

function isValidLanguage(value: string): boolean {
  return LANGUAGE_CHOICES.includes(value as typeof LANGUAGE_CHOICES[number]);
}

/**
 * Generate .env file content from wizard answers.
 */
export function generateEnvContent(answers: WizardAnswers): string {
  const lines: string[] = [
    "# Strada Brain Configuration",
    `# Generated by strada setup on ${new Date().toISOString()}`,
    "",
  ];

  lines.push(`UNITY_PROJECT_PATH="${sanitizeEnvValue(answers.unityProjectPath)}"`);
  lines.push("");

  const sanitizedKey = answers.apiKey ? sanitizeEnvValue(answers.apiKey) : "";
  const primaryEnvKey = PROVIDER_ENV_KEY_MAP[answers.provider];
  if (answers.provider === "openai") {
    lines.push(`OPENAI_AUTH_MODE=${answers.openaiAuthMode ?? "api-key"}`);
    if (answers.apiKey) lines.push(`${primaryEnvKey}="${sanitizedKey}"`);
  } else if (answers.provider !== "ollama") {
    if (answers.apiKey) lines.push(`${primaryEnvKey}="${sanitizedKey}"`);
  }
  lines.push(`PROVIDER_CHAIN=${answers.provider}`);

  if (answers.embeddingProvider && answers.embeddingProvider !== "auto") {
    if (
      answers.embeddingProvider === "openai"
      && answers.provider === "openai"
      && answers.openaiAuthMode === "chatgpt-subscription"
    ) {
      const embeddingKey = sanitizeEnvValue(answers.embeddingApiKey ?? "");
      if (embeddingKey) {
        lines.push(`OPENAI_API_KEY="${embeddingKey}"`);
      }
    } else if (answers.embeddingProvider !== "ollama" && answers.embeddingProvider !== answers.provider) {
      const embeddingEnvKey = PROVIDER_ENV_KEY_MAP[answers.embeddingProvider];
      const embeddingKey = sanitizeEnvValue(answers.embeddingApiKey ?? "");
      if (embeddingEnvKey && embeddingKey) {
        lines.push(`${embeddingEnvKey}="${embeddingKey}"`);
      }
    }
    lines.push(`EMBEDDING_PROVIDER=${answers.embeddingProvider}`);
  }
  lines.push("");

  lines.push(`DEFAULT_CHANNEL=${sanitizeEnvValue(answers.channel)}`);
  lines.push(`LANGUAGE_PREFERENCE=${sanitizeEnvValue(answers.language)}`);
  lines.push("");

  lines.push("STREAMING_ENABLED=true");
  lines.push("REQUIRE_EDIT_CONFIRMATION=true");
  lines.push("DASHBOARD_ENABLED=true");
  lines.push("MULTI_AGENT_ENABLED=true");
  lines.push("LOG_LEVEL=info");
  lines.push("WEB_CHANNEL_PORT=3000");
  lines.push("DASHBOARD_PORT=3100");
  lines.push("");

  return lines.join("\n") + "\n";
}

/**
 * Ask a question with validation and retry logic.
 * Throws after MAX_RETRIES consecutive invalid answers.
 */
async function askWithRetry(
  rl: readline.Interface,
  question: string,
  validate: (input: string) => ValidationResult,
  retries = MAX_RETRIES,
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const answer = await rl.question(question);
    const result = validate(answer);
    if (result.valid) return answer.trim();
    console.error(`  \u2717 ${result.error}`);
    if (i < retries - 1) console.log("  Please try again.");
  }
  throw new Error("Maximum retries exceeded.");
}

/**
 * Attempt to open a URL in the user's default browser.
 * Fails silently if no browser can be launched.
 */
function getBrowserCommand(url: string): [string, string[]] {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
  const [cmd, args] = getBrowserCommand(url);
  const proc = spawn(cmd, args, { stdio: "ignore", detached: true });
  proc.on("error", () => {
    console.log(`\n  Could not open browser automatically.`);
    console.log(`  Please open: ${url}\n`);
  });
  proc.unref();
}

async function canBindLocalhostPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;

    const cleanup = () => {
      server.removeAllListeners();
    };

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    server.once("error", () => {
      server.close(() => settle(false));
    });

    server.listen(port, "localhost", () => {
      server.close(() => {
        settle(true);
      });
    });
  });
}

export async function findAvailableSetupWizardPort(
  preferredPort: number,
  maxAttempts = 20,
  canUsePort: (port: number) => Promise<boolean> = canBindLocalhostPort,
): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (await canUsePort(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find an available setup wizard port after checking ${maxAttempts} ports starting at ${preferredPort}.`,
  );
}

/**
 * Run the interactive terminal setup wizard.
 *
 * Prompts the user for Unity project path, API key, channel, and language.
 * Writes a .env file with the collected configuration.
 * Alternatively, launches the web-based SetupWizard if the user prefers.
 */
export async function runTerminalWizard(
  options?: { mode?: "terminal" | "web" },
): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  let intentionalClose = false;
  rl.on("close", () => {
    if (!intentionalClose) {
      console.log("\n\nSetup cancelled.");
      process.exit(0);
    }
  });

  try {
    console.log("\n\uD83E\uDD89 Strada Brain Setup");
    console.log("\u2501".repeat(30));
    console.log("");

    let useWebWizard = options?.mode === "web";
    if (!options?.mode) {
      console.log("? Setup method:");
      console.log("  1) Terminal (quick setup)");
      console.log("  2) Web Browser (full setup)");
      console.log("     Tip: next time you can jump straight in with `strada setup --web`.");
      const method = await rl.question("  Choose [1/2] (default: 1): ");
      useWebWizard = method.trim() === "2";
    }

    if (useWebWizard) {
      intentionalClose = true;
      rl.close();
      const requestedPort = process.env["SETUP_WIZARD_PORT"]
        ? parseInt(process.env["SETUP_WIZARD_PORT"], 10)
        : 3000;
      const port = await findAvailableSetupWizardPort(requestedPort);
      const { SetupWizard } = await import("./setup-wizard.js");
      const wizard = new SetupWizard({ port });
      const url = `http://localhost:${port}/setup`;
      if (port !== requestedPort) {
        console.log(
          `\n\u26A0\uFE0F  Port ${requestedPort} is already in use. Starting the setup wizard on http://localhost:${port}/setup instead.`,
        );
      }
      await wizard.listen();
      console.log(`\n\uD83C\uDF10 Opening setup at ${url}...`);
      console.log(`   (Open this URL in your browser if it didn't open automatically)\n`);
      openBrowser(url);
      await wizard.waitForCompletion();
      return;
    }

    console.log("");
    console.log("  Terminal setup supports every built-in response provider.");
    console.log("  You can still switch workers later from Strada's dashboard or routing commands.\n");

    const unityPath = await askWithRetry(
      rl,
      "? Unity project path: ",
      validateUnityPath,
    );

    const providerAnswer = await askWithRetry(
      rl,
      `? Primary AI provider (${RESPONSE_PROVIDER_CHOICES.join("/")}) [default: claude]: `,
      (input) => {
        const value = input.trim().toLowerCase()
        if (!value) return { valid: true }
        if (!isValidResponseProvider(value)) {
          return { valid: false, error: `Supported providers: ${RESPONSE_PROVIDER_CHOICES.join(", ")}.` }
        }
        return { valid: true }
      },
    );
    const provider = providerAnswer.trim().toLowerCase() || "claude";

    let openaiAuthMode: "api-key" | "chatgpt-subscription" | undefined;
    let apiKey: string | undefined;
    if (provider === "openai") {
      const authModeAnswer = await askWithRetry(
        rl,
        "? OpenAI auth mode (api-key/chatgpt-subscription) [default: api-key]: ",
        (input) => {
          const normalized = input.trim().toLowerCase()
          if (!normalized) return { valid: true }
          if (normalized !== "api-key" && normalized !== "chatgpt-subscription") {
            return { valid: false, error: "Supported modes: api-key, chatgpt-subscription." }
          }
          return { valid: true }
        },
      );
      openaiAuthMode = (authModeAnswer.trim().toLowerCase() || "api-key") as "api-key" | "chatgpt-subscription";
      if (openaiAuthMode === "api-key") {
        apiKey = await askWithRetry(
          rl,
          "? OpenAI API key: ",
          (input) => {
            if (!input || input.trim().length < 8) {
              return { valid: false, error: "API key seems too short." };
            }
            return { valid: true };
          },
        );
      } else {
        console.log("  Using local Codex/ChatGPT subscription auth from ~/.codex/auth.json")
        console.log("  Note: this covers OpenAI conversation turns only, not OpenAI embeddings or API quota.")
      }
    } else {
      if (provider === "ollama") {
        console.log("  Ollama selected. No API key is required for the local response worker.");
      } else {
        apiKey = await askWithRetry(
          rl,
          `? ${getResponseProviderLabel(provider)} API key: `,
          (input) => {
            if (!input || input.trim().length < 8) {
              return { valid: false, error: "API key seems too short." };
            }
            return { valid: true };
          },
        );
      }
    }
    const defaultEmbeddingProvider = getDefaultEmbeddingProvider(provider);
    const embeddingAnswer = await askWithRetry(
      rl,
      `? Embedding provider (${EMBEDDING_PROVIDER_CHOICES.join("/")}) [default: ${defaultEmbeddingProvider}]: `,
      (input) => {
        const normalized = input.trim().toLowerCase();
        if (!normalized) return { valid: true };
        if (!isValidEmbeddingProvider(normalized)) {
          return { valid: false, error: "Unsupported embedding provider." };
        }
        return { valid: true };
      },
    );
    const embeddingProvider = embeddingAnswer.trim().toLowerCase() || defaultEmbeddingProvider;

    let embeddingApiKey: string | undefined;
    if (embeddingProvider === "openai" && provider === "openai" && openaiAuthMode === "chatgpt-subscription") {
      console.log("  OpenAI embeddings still require an OpenAI API key when conversation uses subscription auth.")
    }
    if (embeddingProvider !== "auto" && embeddingProvider !== "ollama" && embeddingProvider !== provider) {
      embeddingApiKey = await askWithRetry(
        rl,
        `? ${getEmbeddingProviderLabel(embeddingProvider)} embedding API key: `,
        (input) => {
          if (!input || input.trim().length < 8) {
            return { valid: false, error: "API key seems too short." };
          }
          return { valid: true };
        },
      );
    } else if (embeddingProvider === "openai" && provider === "openai" && openaiAuthMode === "chatgpt-subscription") {
      embeddingApiKey = await askWithRetry(
        rl,
        "? OpenAI embedding API key: ",
        (input) => {
          if (!input || input.trim().length < 8) {
            return { valid: false, error: "API key seems too short." };
          }
          return { valid: true };
        },
      );
    }

    const channelAnswer = await askWithRetry(
      rl,
      `? Default channel (${CHANNEL_CHOICES.join("/")}) [default: web]: `,
      (input) => {
        const normalized = input.trim().toLowerCase();
        if (!normalized) return { valid: true };
        if (!isValidChannel(normalized)) {
          return { valid: false, error: `Supported channels: ${CHANNEL_CHOICES.join(", ")}.` };
        }
        return { valid: true };
      },
    );
    const channel = channelAnswer.trim().toLowerCase() || "web";

    const langAnswer = await askWithRetry(
      rl,
      `? Language (${LANGUAGE_CHOICES.join("/")}) [default: en]: `,
      (input) => {
        const normalized = input.trim().toLowerCase();
        if (!normalized) return { valid: true };
        if (!isValidLanguage(normalized)) {
          return { valid: false, error: `Supported languages: ${LANGUAGE_CHOICES.join(", ")}.` };
        }
        return { valid: true };
      },
    );
    const language = langAnswer.trim().toLowerCase() || "en";

    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const overwrite = await rl.question("\n\u26A0 .env already exists. Overwrite? [y/N]: ");
      if (overwrite.trim().toLowerCase() !== "y") {
        console.log("\nSetup cancelled. Existing .env preserved.");
        intentionalClose = true;
        rl.close();
        return;
      }
    }

    const envContent = generateEnvContent({
      unityProjectPath: unityPath,
      apiKey: apiKey?.trim(),
      provider,
      openaiAuthMode,
      embeddingProvider,
      embeddingApiKey: embeddingApiKey?.trim(),
      channel,
      language,
    });

    fs.writeFileSync(envPath, envContent, { encoding: "utf-8", mode: 0o600 });

    console.log("\n\u2705 .env created!");
    console.log("   Source checkout next steps:");
    console.log("   1) Run `./strada doctor` from this repo root.");
    console.log("   2) If you want the bare `strada` command everywhere, run `./strada install-command` once.");
    console.log("   3) Then use either `strada doctor` / `strada start` or keep using `./strada ...`.\n");
    intentionalClose = true;
    rl.close();
  } catch (err) {
    intentionalClose = true;
    rl.close();
    if ((err as Error).message === "Maximum retries exceeded.") {
      console.error("\nToo many invalid attempts. Please try again.");
      process.exit(1);
    }
    throw err;
  }
}
