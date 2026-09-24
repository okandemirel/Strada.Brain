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
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  buildSetupAccessUrl,
  SETUP_DEFAULT_ENV_KEYS,
  setupOwnedEnvKeysFor,
  type SetupWizard,
} from "./setup-wizard.js";
import {
  getBareCommand,
  getPlatformInstallCommandGuidance,
  getSourceDoctorCommand,
  getSourceInstallCommand,
  getSourceLauncherCommand,
  getSourceSetupCommand,
} from "../common/launcher-guidance.js";
import { resolveDotenvPath } from "../common/runtime-paths.js";
import { describeEffectiveBudget, persistSetup } from "./setup-env-persistence.js";
import {
  formatProviderPreflightFailures,
  preflightResponseProviders,
  type ResponseProviderPreflightResult,
} from "./response-provider-preflight.js";
import { evaluateChainReadiness } from "./chain-readiness.js";
import type { ProviderCredentialMap } from "../agents/providers/provider-registry.js";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "../agents/providers/opencode.js";
import {
  assessStradaMcpLoadTrust,
  buildMcpRecommendation,
  checkStradaDeps,
  installStradaMcpSubmodule,
  type McpInstallTarget,
  type StradaDepsStatus,
} from "../config/strada-deps.js";

const MAX_RETRIES = 3;
type ProviderAuthMode = "api-key" | "chatgpt-subscription" | "claude-subscription";
const RESPONSE_PROVIDER_CHOICES = [
  "claude", "openai", "deepseek", "kimi", "qwen", "gemini",
  "groq", "mistral", "together", "fireworks", "minimax", "opencode", "ollama",
] as const;
const EMBEDDING_PROVIDER_CHOICES = [
  "auto", "gemini", "openai", "mistral", "together", "fireworks", "qwen", "ollama",
] as const;
const CHANNEL_CHOICES = ["web", "telegram", "discord", "slack", "cli"] as const;
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
  opencode: "OPENCODE_API_KEY",
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
  opencode: "OpenCode",
  ollama: "Ollama",
};
const DEFAULT_EMBEDDING_PROVIDERS = new Set([
  "gemini", "openai", "mistral", "together", "fireworks", "qwen", "ollama",
]);
const MODEL_NAME_RE = /^[A-Za-z0-9._:/-]+$/;

/**
 * OpenCode hosted platforms, mirroring the web wizard's choice (audit 10.2 /
 * D26): the terminal wizard could not select `opencode` at all, so its base
 * URL and model never reached .env and the provider ran on registry defaults.
 */
export const OPENCODE_PLATFORM_BASE_URLS = {
  zen: OPENCODE_ZEN_BASE_URL,
  go: OPENCODE_GO_BASE_URL,
} as const;
export type OpencodePlatform = keyof typeof OPENCODE_PLATFORM_BASE_URLS;
export const OPENCODE_PLATFORM_CHOICES = ["zen", "go"] as const;

export function getOpencodeBaseUrl(platform: string | undefined): string {
  const normalized = (platform ?? "").trim().toLowerCase();
  return OPENCODE_PLATFORM_BASE_URLS[normalized as OpencodePlatform] ?? OPENCODE_ZEN_BASE_URL;
}
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_WEB_SETUP_STATIC_DIR = path.resolve(MODULE_DIR, "../../web-portal/dist");
const PACKAGED_WEB_SETUP_STATIC_DIR = path.resolve(MODULE_DIR, "../channels/web/static");
const SETUP_HOST = "127.0.0.1";

export interface WizardAnswers {
  unityProjectPath: string;
  providerChain?: string[];
  providerCredentials?: Record<string, string | undefined>;
  providerAuthModes?: Record<string, ProviderAuthMode | undefined>;
  apiKey?: string;
  provider: string;
  openaiAuthMode?: "api-key" | "chatgpt-subscription";
  embeddingProvider: string;
  embeddingApiKey?: string;
  channel: string;
  /** Channel credentials keyed by env key (TELEGRAM_BOT_TOKEN, ...). */
  channelCredentials?: Record<string, string | undefined>;
  /** OpenCode hosted platform: "zen" (default) or "go". */
  opencodePlatform?: string;
  /** Optional OpenCode model id; blank leaves the provider default in place. */
  opencodeDefaultModel?: string;
  language: string;
  /**
   * The operator's answer on loading the Strada.MCP copy that lives inside the
   * Unity project into Brain's process. Undefined when the question was not
   * asked (no MCP, or a copy outside the project), so nothing is written.
   */
  stradaMcpAllowProjectLocal?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate that a Unity project path is absolute, exists, and is a directory.
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

function getEmbeddingProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function getResponseProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function isValidResponseProvider(value: string): boolean {
  return RESPONSE_PROVIDER_CHOICES.includes(value as typeof RESPONSE_PROVIDER_CHOICES[number]);
}

export function getRemainingResponseProviderChoices(
  providerChain: readonly string[],
): readonly string[] {
  const selected = new Set(providerChain.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return RESPONSE_PROVIDER_CHOICES.filter((provider) => !selected.has(provider));
}

function getNormalizedProviderChain(answers: WizardAnswers): string[] {
  const configuredChain = answers.providerChain?.map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  if (configuredChain.length > 0) {
    return [...new Set(configuredChain)];
  }
  return [answers.provider.trim().toLowerCase()];
}

function getProviderAuthMode(
  answers: WizardAnswers,
  providerName: string,
): ProviderAuthMode | undefined {
  return answers.providerAuthModes?.[providerName] ?? (
    providerName === "openai" ? answers.openaiAuthMode : undefined
  );
}

function getProviderCredential(answers: WizardAnswers, providerName: string): string | undefined {
  return answers.providerCredentials?.[providerName] ?? (
    providerName === answers.provider ? answers.apiKey : undefined
  );
}

/** Every chain provider's credential as the wizard collected it (plan 2.5). */
function getChainCredentials(answers: WizardAnswers, providerChain: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const provider of providerChain) {
    const credential = getProviderCredential(answers, provider);
    if (credential !== undefined && credential.trim().length > 0) out[provider] = credential.trim();
  }
  return out;
}

/**
 * The same credentials in the shape the preflight probes with (plan 2.4): the
 * auth mode travels with the key, so an OpenAI subscription is probed as a
 * subscription and not as a missing API key.
 */
function toPreflightCredentials(
  answers: WizardAnswers,
  providerChain: readonly string[],
): ProviderCredentialMap {
  const out: ProviderCredentialMap = {};
  for (const provider of providerChain) {
    const apiKey = getProviderCredential(answers, provider)?.trim();
    const authMode = getProviderAuthMode(answers, provider);
    if (apiKey === undefined && authMode === undefined) continue;
    out[provider] = {
      ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      ...(provider === "openai" && (authMode === "api-key" || authMode === "chatgpt-subscription")
        ? { openaiAuthMode: authMode }
        : {}),
      ...(provider === "claude" && (authMode === "api-key" || authMode === "claude-subscription")
        ? { anthropicAuthMode: authMode }
        : {}),
    };
  }
  return out;
}

function getDefaultEmbeddingProviderForChain(providerChain: readonly string[]): string {
  for (const provider of providerChain) {
    if (DEFAULT_EMBEDDING_PROVIDERS.has(provider)) {
      return provider;
    }
  }
  return "auto";
}

function isValidChannel(value: string): boolean {
  return CHANNEL_CHOICES.includes(value as typeof CHANNEL_CHOICES[number]);
}

function isValidLanguage(value: string): boolean {
  return LANGUAGE_CHOICES.includes(value as typeof LANGUAGE_CHOICES[number]);
}

export interface ChannelCredentialField {
  envKey: string;
  label: string;
  required: boolean;
  hint?: string;
}

/**
 * What a chosen channel must carry before setup may be written (plan 2.4,
 * audit 10.2 / D26). The terminal wizard used to accept `telegram` and write a
 * .env with DEFAULT_CHANNEL=telegram and no bot token: the next boot failed
 * with "TELEGRAM_BOT_TOKEN is required". Same env keys as the web wizard's
 * channel fields, and the required set matches `validateChannelConfig`
 * (an empty allow-list denies every user, so it is required too).
 */
const CHANNEL_CREDENTIAL_FIELDS: Record<string, readonly ChannelCredentialField[]> = {
  web: [],
  cli: [],
  telegram: [
    {
      envKey: "TELEGRAM_BOT_TOKEN",
      label: "Telegram bot token",
      required: true,
      hint: "from @BotFather, e.g. 123456:ABC-DEF...",
    },
    {
      envKey: "ALLOWED_TELEGRAM_USER_IDS",
      label: "Allowed Telegram user IDs",
      required: true,
      hint: "comma-separated numeric ids; an empty list denies everyone",
    },
  ],
  discord: [
    {
      envKey: "DISCORD_BOT_TOKEN",
      label: "Discord bot token",
      required: true,
      hint: "Discord developer portal -> Bot -> Reset Token",
    },
  ],
  slack: [
    { envKey: "SLACK_BOT_TOKEN", label: "Slack bot token", required: true, hint: "xoxb-..." },
    { envKey: "SLACK_APP_TOKEN", label: "Slack app token", required: true, hint: "xapp-... (socket mode)" },
  ],
};

export function getChannelCredentialFields(channel: string): readonly ChannelCredentialField[] {
  return CHANNEL_CREDENTIAL_FIELDS[channel.trim().toLowerCase()] ?? [];
}

/** Every required credential of the chosen channel is present (non-blank). */
export function validateChannelCredentials(
  channel: string,
  values: Record<string, string | undefined> = {},
): ValidationResult {
  const missing = getChannelCredentialFields(channel)
    .filter((field) => field.required && sanitizeEnvValue(values[field.envKey] ?? "") === "")
    .map((field) => field.envKey);

  if (missing.length === 0) {
    return { valid: true };
  }

  return {
    valid: false,
    error: `The ${channel} channel needs ${missing.join(" and ")}. Nothing was written.`,
  };
}

/**
 * True when at least one provider already in the chain can produce embeddings
 * with the credential the person just gave (Ollama needs none).
 *
 * Mirrors `hasAutoEmbeddingCandidate` in the web wizard so both surfaces make
 * the same RAG decision (plan 2.5, audit 10.7).
 */
export function hasAutoEmbeddingCandidate(
  providerChain: readonly string[],
  credentials: Record<string, string | undefined> = {},
): boolean {
  return providerChain.some((raw) => {
    const provider = raw.trim().toLowerCase();
    if (!DEFAULT_EMBEDDING_PROVIDERS.has(provider)) return false;
    if (provider === "ollama") return true;
    return (credentials[provider] ?? "").trim().length > 0;
  });
}

export interface RagDecision {
  ragEnabled: boolean;
  /** "auto" only when RAG is off; otherwise the provider that will embed. */
  embeddingProvider: string;
  /** One line explaining why RAG is off; null when it is on. */
  reason: string | null;
}

/**
 * RAG follows the embedding candidate, never the other way round (plan 2.5,
 * audit 10.7). Choosing Claude and then RAG used to demand an embedding
 * provider the person had no key for, with no way forward; now RAG is simply
 * off with the reason stated.
 */
export function resolveRagSetup(input: {
  providerChain: readonly string[];
  providerCredentials?: Record<string, string | undefined>;
  embeddingProvider?: string;
  embeddingApiKey?: string;
}): RagDecision {
  const chain = input.providerChain
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const credentials = input.providerCredentials ?? {};
  const requested = (input.embeddingProvider ?? "auto").trim().toLowerCase() || "auto";

  if (requested !== "auto") {
    if (requested === "ollama") {
      return { ragEnabled: true, embeddingProvider: "ollama", reason: null };
    }
    const credential = (input.embeddingApiKey ?? credentials[requested] ?? "").trim();
    if (credential.length > 0) {
      return { ragEnabled: true, embeddingProvider: requested, reason: null };
    }
    return {
      ragEnabled: false,
      embeddingProvider: "auto",
      reason: `RAG is off: ${getEmbeddingProviderLabel(requested)} embeddings need an API key and none was given.`,
    };
  }

  if (hasAutoEmbeddingCandidate(chain, credentials)) {
    return {
      ragEnabled: true,
      embeddingProvider: getDefaultEmbeddingProviderForChain(chain),
      reason: null,
    };
  }

  return {
    ragEnabled: false,
    embeddingProvider: "auto",
    reason: "RAG is off: none of the chosen providers can embed. Add a key for "
      + "gemini, openai, mistral, together, fireworks or qwen (or run a local ollama) "
      + "and rerun setup to turn it on.",
  };
}

/**
 * Generate .env file content from wizard answers.
 */
/**
 * The Strada.MCP copy this project would load only with the operator's consent:
 * one that is installed, lives inside the Unity project, and is not already
 * trusted by STRADA_MCP_ALLOW_PROJECT_LOCAL. Null when there is nothing to ask.
 */
export function projectLocalMcpAwaitingTrust(
  deps: Pick<StradaDepsStatus, "mcpInstalled" | "mcpPath">,
  unityProjectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!deps.mcpInstalled || !deps.mcpPath) return null;
  const allowed = (env["STRADA_MCP_ALLOW_PROJECT_LOCAL"] ?? "").trim().toLowerCase();
  const trust = assessStradaMcpLoadTrust(deps.mcpPath, unityProjectPath, {
    mcpAllowProjectLocal: ["true", "1", "yes", "on"].includes(allowed),
  });
  return trust.trusted ? null : deps.mcpPath;
}

export function generateEnvContent(answers: WizardAnswers): string {
  const lines: string[] = [
    "# Strada Brain Configuration",
    `# Generated by strada setup on ${new Date().toISOString()}`,
    "",
  ];

  lines.push(`UNITY_PROJECT_PATH="${sanitizeEnvValue(answers.unityProjectPath)}"`);
  if (answers.stradaMcpAllowProjectLocal !== undefined) {
    lines.push(`STRADA_MCP_ALLOW_PROJECT_LOCAL=${answers.stradaMcpAllowProjectLocal ? "true" : "false"}`);
  }
  lines.push("");

  const providerChain = getNormalizedProviderChain(answers);
  for (const providerName of providerChain) {
    const envKey = PROVIDER_ENV_KEY_MAP[providerName];
    const authMode = getProviderAuthMode(answers, providerName);
    const credential = getProviderCredential(answers, providerName);
    const sanitizedCredential = credential ? sanitizeEnvValue(credential) : "";

    if (providerName === "claude") {
      lines.push(`ANTHROPIC_AUTH_MODE=${authMode === "claude-subscription" ? "claude-subscription" : "api-key"}`);
      if ((authMode ?? "api-key") === "claude-subscription") {
        if (sanitizedCredential) {
          lines.push(`ANTHROPIC_AUTH_TOKEN="${sanitizedCredential}"`);
        }
      } else if (sanitizedCredential) {
        lines.push(`${envKey}="${sanitizedCredential}"`);
      }
      continue;
    }

    if (providerName === "openai") {
      lines.push(`OPENAI_AUTH_MODE=${authMode ?? "api-key"}`);
      if ((authMode ?? "api-key") === "api-key" && sanitizedCredential) {
        lines.push(`${envKey}="${sanitizedCredential}"`);
      }
      continue;
    }

    if (providerName !== "ollama" && envKey && sanitizedCredential) {
      lines.push(`${envKey}="${sanitizedCredential}"`);
    }
  }
  if (providerChain.includes("opencode")) {
    lines.push(`OPENCODE_BASE_URL=${getOpencodeBaseUrl(answers.opencodePlatform)}`);
    const opencodeModel = sanitizeEnvValue(answers.opencodeDefaultModel ?? "");
    if (opencodeModel && MODEL_NAME_RE.test(opencodeModel)) {
      lines.push(`OPENCODE_DEFAULT_MODEL=${opencodeModel}`);
    }
  }
  lines.push(`PROVIDER_CHAIN=${providerChain.join(",")}`);

  // RAG follows the embedding candidate (plan 2.5, audit 10.7): with nothing
  // that can embed, the file says so explicitly instead of leaving a RAG that
  // cannot index.
  const rag = resolveRagSetup({
    providerChain,
    providerCredentials: getChainCredentials(answers, providerChain),
    embeddingProvider: answers.embeddingProvider,
    embeddingApiKey: answers.embeddingApiKey,
  });
  if (!rag.ragEnabled) {
    lines.push("# RAG stays off until an embedding-capable provider is configured");
    lines.push("RAG_ENABLED=false");
  } else if (rag.embeddingProvider !== "auto") {
    if (
      rag.embeddingProvider === "openai"
      && providerChain.includes("openai")
      && getProviderAuthMode(answers, "openai") === "chatgpt-subscription"
    ) {
      const embeddingKey = sanitizeEnvValue(answers.embeddingApiKey ?? "");
      if (embeddingKey) {
        lines.push(`OPENAI_API_KEY="${embeddingKey}"`);
      }
    } else if (
      rag.embeddingProvider !== "ollama" &&
      !providerChain.includes(rag.embeddingProvider)
    ) {
      const embeddingEnvKey = PROVIDER_ENV_KEY_MAP[rag.embeddingProvider];
      const embeddingKey = sanitizeEnvValue(answers.embeddingApiKey ?? "");
      if (embeddingEnvKey && embeddingKey) {
        lines.push(`${embeddingEnvKey}="${embeddingKey}"`);
      }
    }
    lines.push(`EMBEDDING_PROVIDER=${rag.embeddingProvider}`);
  }
  lines.push("");

  lines.push(`DEFAULT_CHANNEL=${sanitizeEnvValue(answers.channel)}`);
  for (const field of getChannelCredentialFields(answers.channel)) {
    const value = sanitizeEnvValue(answers.channelCredentials?.[field.envKey] ?? "");
    if (value) {
      lines.push(`${field.envKey}="${value}"`);
    }
  }
  lines.push(`LANGUAGE_PREFERENCE=${sanitizeEnvValue(answers.language)}`);
  lines.push("");

  lines.push("STREAMING_ENABLED=true");
  lines.push("REQUIRE_EDIT_CONFIRMATION=true");
  lines.push("DASHBOARD_ENABLED=true");
  lines.push("MULTI_AGENT_ENABLED=true");
  lines.push("TASK_DELEGATION_ENABLED=true");
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
  if (process.platform === "win32") {
    // Escape CMD meta-characters so & does not split the command.
    const escaped = url.replace(/[&|<>^%]/g, "^$&");
    return ["cmd", ["/c", "start", '""', escaped]];
  }
  return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
  const [cmd, args] = getBrowserCommand(url);
  const proc = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    // Prevent Node.js from re-quoting args for cmd.exe (same approach as sindresorhus/open).
    ...(process.platform === "win32" && { windowsVerbatimArguments: true }),
  });
  proc.on("error", () => {
    console.log(`\n  Could not open browser automatically.`);
    console.log(`  Please open: ${url}\n`);
  });
  proc.unref();
}

async function waitForSetupUrlReady(
  url: string,
  maxAttempts = 20,
  delayMs = 150,
): Promise<void> {
  const origin = new URL(url).origin;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const [rootResponse, csrfResponse] = await Promise.all([
        fetch(url, { cache: "no-store" }),
        fetch(`${origin}/api/setup/csrf`, { cache: "no-store" }),
      ]);

      if (!rootResponse.ok || !csrfResponse.ok) {
        throw new Error("setup surface not ready yet");
      }

      const csrfPayload = await csrfResponse.json().catch(() => ({}));
      if (typeof csrfPayload.token === "string" && csrfPayload.token.length > 0) {
        return;
      }
    } catch {
      // The setup server may need a moment to expose the freshly built assets.
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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

    server.listen(port, SETUP_HOST, () => {
      server.close(() => {
        settle(true);
      });
    });
  });
}

export async function findAvailableSetupWizardPort(
  preferredPort: number,
  maxAttempts = 1000,
  canUsePort: (port: number) => Promise<boolean> = canBindLocalhostPort,
  fallbackPorts: readonly number[] = [5050, 5100, 5173, 8080, 8787, 9000, 9100, 10000, 12000, 18080],
): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (await canUsePort(candidate)) {
      return candidate;
    }
  }

  for (const candidate of fallbackPorts) {
    if (candidate >= preferredPort && candidate < preferredPort + maxAttempts) {
      continue;
    }
    if (await canUsePort(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find an available setup wizard port after checking ${maxAttempts} ports starting at ${preferredPort}.`,
  );
}

export function nodeSupportsWebPortalBuild(nodeVersion: string = process.versions.node): boolean {
  const [rawMajor = 0, rawMinor = 0] = nodeVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(rawMajor) ? rawMajor : 0;
  const minor = Number.isFinite(rawMinor) ? rawMinor : 0;
  if (major > 22) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

function hasWebSetupAssets(): boolean {
  const candidateRoots = [SOURCE_WEB_SETUP_STATIC_DIR, PACKAGED_WEB_SETUP_STATIC_DIR];

  for (const root of candidateRoots) {
    const indexPath = path.join(root, "index.html");
    const assetsDir = path.join(root, "assets");

    if (!fs.existsSync(indexPath) || !fs.existsSync(assetsDir)) {
      continue;
    }

    try {
      const assetEntries = fs.readdirSync(assetsDir);
      if (assetEntries.some((entry) => entry.endsWith(".js") || entry.endsWith(".css"))) {
        return true;
      }
    } catch {
      // Try the next candidate root.
    }
  }

  return false;
}

export function resolveNvmDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const candidates = [env["NVM_DIR"], path.join(homeDir, ".nvm")].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "nvm.sh"))) {
      return candidate;
    }
  }
  return null;
}

function commandExists(
  command: string,
  platform: NodeJS.Platform = process.platform,
  spawnSyncFn: typeof spawnSync = spawnSync,
): boolean {
  const lookupCommand = platform === "win32" ? "where" : "which";
  const result = spawnSyncFn(lookupCommand, [command], { stdio: "ignore" });
  return result.status === 0;
}

export type NodeUpgradeStrategy =
  | { kind: "posix-nvm"; suggestedCommand: string; nvmDir: string }
  | { kind: "windows-nvm"; suggestedCommand: string }
  | { kind: "winget"; suggestedCommand: string }
  | { kind: "download" };

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(parts: string[]): string {
  return parts.map((part) => shellEscape(part)).join(" ");
}

export function getSuggestedNodeUpgradeCommand(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  commandExistsFn: (command: string, platform: NodeJS.Platform) => boolean = (commandName, commandPlatform) =>
    commandExists(commandName, commandPlatform),
): string | null {
  if (platform === "win32") {
    if (commandExistsFn("nvm", platform)) {
      return "nvm install 22.12.0; nvm use 22.12.0";
    }
    if (commandExistsFn("winget", platform)) {
      return "winget install OpenJS.NodeJS.LTS";
    }
    return null;
  }

  const nvmDir = resolveNvmDir(env, homeDir)
  if (!nvmDir) return null

  try {
    const versionsDir = path.join(nvmDir, "versions", "node")
    const hasNode22 = fs.readdirSync(versionsDir).some((entry) => entry.startsWith("v22."))
    return hasNode22
      ? "nvm use --delete-prefix 22 --silent"
      : "nvm install 22 && nvm use --delete-prefix 22 --silent"
  } catch {
    return "nvm install 22 && nvm use --delete-prefix 22 --silent"
  }
}

function getNpmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function resolveNodeUpgradeStrategy(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  commandExistsFn: (command: string, platform: NodeJS.Platform) => boolean = (commandName, commandPlatform) =>
    commandExists(commandName, commandPlatform),
): NodeUpgradeStrategy {
  if (platform === "win32") {
    const suggestedCommand = getSuggestedNodeUpgradeCommand(env, homeDir, platform, commandExistsFn);
    if (suggestedCommand?.startsWith("nvm ")) {
      return { kind: "windows-nvm", suggestedCommand };
    }
    if (suggestedCommand?.startsWith("winget ")) {
      return { kind: "winget", suggestedCommand };
    }
    return { kind: "download" };
  }

  const nvmDir = resolveNvmDir(env, homeDir);
  const suggestedCommand = getSuggestedNodeUpgradeCommand(env, homeDir, platform, commandExistsFn);
  if (nvmDir && suggestedCommand) {
    return { kind: "posix-nvm", suggestedCommand, nvmDir };
  }
  return { kind: "download" };
}

/**
 * WHERE THE CODE IS, which is not where the runtime state is.
 *
 * `initializeRuntimeEnvironment` chdirs to the CONFIG root, so on a packaged
 * install — and, since STRADA_SOURCE_CHECKOUT became three-state, inside a
 * checkout whose operator chose the app-home layout — `process.cwd()` is
 * `~/.strada`. These paths then looked for `web-portal/` there and ran
 * `npm install --prefix web-portal` in the user's state directory (round 13
 * #36). The portal's source belongs to the INSTALL root.
 */
function codeRoot(): string {
  const configured = process.env["STRADA_INSTALL_ROOT"]?.trim();
  if (configured) return configured;
  // MODULE_DIR is <root>/src/core or <root>/dist/core; the root is two up.
  return path.resolve(MODULE_DIR, "..", "..");
}

export function buildWebSetupUpgradeShellScript(
  nvmDir: string,
  cwd: string = codeRoot(),
  relaunchCommand: string[] = process.env["STRADA_LAUNCHER_PATH"]
    ? [process.env["STRADA_LAUNCHER_PATH"], "setup", "--web"]
    : ["node", ...process.execArgv, process.argv[1] ?? "", "setup", "--web"],
): string {
  return [
    "set -e",
    "ORIGINAL_HOME=\"$HOME\"",
    "STRADA_TMP_HOME=$(mktemp -d \"${TMPDIR:-/tmp}/strada-home.XXXXXX\")",
    "trap 'rm -rf \"$STRADA_TMP_HOME\"' EXIT",
    "export HOME=\"$STRADA_TMP_HOME\"",
    "mkdir -p \"$HOME\"",
    "if [ -f \"$ORIGINAL_HOME/.npmrc\" ]; then",
    "  grep -Evi '^\\s*(prefix|globalconfig)\\s*=' \"$ORIGINAL_HOME/.npmrc\" > \"$HOME/.npmrc\" || true",
    "fi",
    "unset NPM_CONFIG_PREFIX npm_config_prefix NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig NPM_CONFIG_USERCONFIG npm_config_userconfig",
    `export NVM_DIR=${shellEscape(nvmDir)}`,
    process.env["STRADA_INSTALL_ROOT"]
      ? `export STRADA_INSTALL_ROOT=${shellEscape(process.env["STRADA_INSTALL_ROOT"])}`
      : "",
    process.env["STRADA_SOURCE_CHECKOUT"] === "true"
      ? "export STRADA_SOURCE_CHECKOUT='true'"
      : "",
    process.env["STRADA_LAUNCHER_PATH"]
      ? `export STRADA_LAUNCHER_PATH=${shellEscape(process.env["STRADA_LAUNCHER_PATH"])}`
      : "",
    ". \"$NVM_DIR/nvm.sh\"",
    `nvm use --delete-prefix ${shellEscape(`v${process.versions.node}`)} --silent >/dev/null || true`,
    "if nvm ls 22 >/dev/null 2>&1; then",
    "  nvm use --delete-prefix 22 --silent >/dev/null",
    "else",
    "  nvm install 22",
    "  nvm use --delete-prefix 22 --silent >/dev/null",
    "fi",
    "STRADA_NODE_PATH=\"$(nvm which 22)\"",
    "if [ ! -x \"$STRADA_NODE_PATH\" ]; then",
    "  echo \"Strada could not locate the upgraded Node.js binary after nvm install.\"",
    "  exit 1",
    "fi",
    "export PATH=\"$(dirname \"$STRADA_NODE_PATH\"):$PATH\"",
    "export HOME=\"$ORIGINAL_HOME\"",
    "rm -rf \"$STRADA_TMP_HOME\"",
    "trap - EXIT",
    `cd ${shellEscape(cwd)}`,
    `exec ${buildShellCommand(relaunchCommand.filter(Boolean))}`,
  ].filter(Boolean).join("\n");
}

function continueWebSetupAfterNodeUpgrade(nvmDir: string): boolean {
  const shellScript = buildWebSetupUpgradeShellScript(nvmDir);
  const result = spawnSync("bash", ["-lc", shellScript], {
    stdio: "inherit",
    cwd: codeRoot(),
    env: { ...process.env, NVM_DIR: nvmDir },
  });

  return result.status === 0;
}

interface LaunchWebSetupWizardOptions {
  requestedPort?: number;
  findPort?: (preferredPort: number) => Promise<number>;
  createWizard?: (port: number) => Promise<SetupWizard> | SetupWizard;
  waitForUrlReady?: (url: string) => Promise<void>;
  openBrowserFn?: (url: string) => void;
}

export async function launchWebSetupWizard(
  options: LaunchWebSetupWizardOptions = {},
): Promise<SetupWizard> {
  const requestedPort = options.requestedPort
    ?? (process.env["SETUP_WIZARD_PORT"] ? parseInt(process.env["SETUP_WIZARD_PORT"], 10) : 3000);
  const port = await (options.findPort ?? findAvailableSetupWizardPort)(requestedPort);
  const createWizard = options.createWizard ?? (async (nextPort: number) => {
    const { SetupWizard } = await import("./setup-wizard.js");
    return new SetupWizard({ port: nextPort });
  });
  const wizard = await createWizard(port);
  const url = buildSetupAccessUrl(port);

  if (port !== requestedPort) {
    console.log(
      `\n\u26A0\uFE0F  Port ${requestedPort} is already in use. Starting the setup wizard on ${url} instead.`,
    );
  }

  await wizard.listen();
  await (options.waitForUrlReady ?? waitForSetupUrlReady)(url);
  console.log(`\n\uD83C\uDF10 Opening setup at ${url}...`);
  console.log("   (Open this URL in your browser if it didn't open automatically)\n");
  (options.openBrowserFn ?? openBrowser)(url);
  await wizard.waitForCompletion();
  console.log(`\nConfiguration saved. Launching Strada web app at http://${SETUP_HOST}:${port}/ ...\n`);

  return wizard;
}

async function promptForWebSetupUpgrade(
  rl: readline.Interface,
): Promise<"rerun" | "manual-upgrade"> {
  const platform = process.platform;
  const webSetupCommand = getSourceSetupCommand(platform, "web");
  console.log(
    `\n  Web setup needs Node.js 20.19+ or 22.12+ to build the full portal experience. Current Node: ${process.versions.node}.`,
  );
  const upgradeStrategy = resolveNodeUpgradeStrategy();
  if (upgradeStrategy.kind === "posix-nvm") {
    const suggestedCommand = upgradeStrategy.suggestedCommand;
    const alreadyInstalled = !suggestedCommand.includes("install 22");
    console.log(
      alreadyInstalled
        ? "  Strada can switch to an already installed compatible Node.js with nvm and continue directly to web setup."
        : "  Strada can install a compatible Node.js with nvm and continue directly to web setup.",
    );
    console.log("  It runs the upgrade inside a temporary clean HOME so incompatible `prefix` / `globalconfig` npm settings do not block nvm.");
    console.log(`  It will run: ${suggestedCommand}`);
    const answer = await rl.question(
      `${alreadyInstalled ? "  Use the compatible Node.js version now" : "  Install the required Node.js version now"} and continue to web setup? [Y/n]: `,
    );
    const normalized = answer.trim().toLowerCase();
    if (!normalized || normalized === "y" || normalized === "yes") {
      console.log("");
      console.log("  Installing the required Node.js version and relaunching Strada web setup...\n");
      return "rerun";
    }
  } else if (upgradeStrategy.kind === "windows-nvm" || upgradeStrategy.kind === "winget") {
    console.log(
      upgradeStrategy.kind === "windows-nvm"
        ? "  Strada detected nvm-windows and can guide the upgrade from a PowerShell window."
        : "  Strada detected winget and can guide the Node.js LTS install from a PowerShell window.",
    );
    console.log(`  Run in PowerShell: ${upgradeStrategy.suggestedCommand}`);
    console.log(`  Then rerun: ${webSetupCommand}`);
    const answer = await rl.question("  Open a PowerShell window with that command now? [Y/n]: ");
    const normalized = answer.trim().toLowerCase();
    if (!normalized || normalized === "y" || normalized === "yes") {
      const guidance = `${upgradeStrategy.suggestedCommand}; Write-Host ''; Write-Host 'After the install finishes, rerun ${webSetupCommand}'`;
      spawn("cmd", ["/c", "start", '""', "powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", guidance], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } else {
    console.log("  Suggested upgrade path: install Node.js 22 LTS from nodejs.org.");
    const answer = await rl.question("  Open the Node.js download page now? [Y/n]: ");
    const normalized = answer.trim().toLowerCase();
    if (!normalized || normalized === "y" || normalized === "yes") {
      openBrowser("https://nodejs.org/en/download");
    }
  }

  console.log("");
  console.log(`  After upgrading Node.js, run \`${webSetupCommand}\` again.`);
  console.log("  Web remains the primary setup flow; Strada will not silently switch you to terminal setup.\n");
  return "manual-upgrade";
}

function ensureWebSetupAssetsReady(): { ready: boolean; needsNodeUpgrade: boolean } {
  if (hasWebSetupAssets()) {
    return { ready: true, needsNodeUpgrade: false };
  }

  if (!nodeSupportsWebPortalBuild()) {
    return { ready: false, needsNodeUpgrade: true };
  }

  if (!fs.existsSync(path.join(codeRoot(), "web-portal", "node_modules"))) {
    console.log("\n  Installing web setup dependencies...");
    const installResult = spawnSync(getNpmCommand(), ["install", "--prefix", "web-portal"], {
      stdio: "inherit",
      cwd: codeRoot(),
      shell: process.platform === "win32",
    });
    if (installResult.status !== 0) {
      return { ready: false, needsNodeUpgrade: false };
    }
  }

  console.log("\n  Preparing web setup assets...");
  const buildResult = spawnSync(getNpmCommand(), ["--prefix", "web-portal", "run", "build"], {
    stdio: "inherit",
    cwd: codeRoot(),
    shell: process.platform === "win32",
  });
  return {
    ready: buildResult.status === 0 && hasWebSetupAssets(),
    needsNodeUpgrade: false,
  };
}

/**
 * Run the interactive terminal setup wizard.
 *
 * Prompts the user for Unity project path, API key, channel, and language.
 * Writes a .env file with the collected configuration.
 * Alternatively, launches the web-based SetupWizard if the user prefers.
 */
/**
 * What the TERMINAL wizard is the authority for.
 *
 * It never asks about the daily budget, so it states nothing about it — and a
 * key the wizard owns but does not emit is REMOVED, which is why running
 * `strada setup` used to delete an existing STRADA_BUDGET_DAILY_USD and turn
 * a deliberate freeze into no limit at all (Codex round 9 #16, through the CLI
 * entry point instead of the portal's).
 */
export const TERMINAL_WIZARD_OWNED_ENV_KEYS = setupOwnedEnvKeysFor({});

export async function runTerminalWizard(
  options?: { mode?: "terminal" | "web" },
): Promise<SetupWizard | undefined> {
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
      console.log("  1) Web Browser (recommended)");
      console.log("  2) Terminal");
      console.log(`     Tip: next time you can jump straight in with \`${getSourceSetupCommand(process.platform, "web")}\`.`);
      const method = await rl.question("  Choose [1/2] (default: 1): ");
      useWebWizard = method.trim() !== "2";
    }

    if (useWebWizard) {
      const webAssets = ensureWebSetupAssetsReady();
      if (!webAssets.ready && webAssets.needsNodeUpgrade) {
        const upgradeAction = await promptForWebSetupUpgrade(rl);
        if (upgradeAction === "rerun") {
          intentionalClose = true;
          rl.close();
          const nodeUpgradeStrategy = resolveNodeUpgradeStrategy();
          if (nodeUpgradeStrategy.kind !== "posix-nvm") {
            throw new Error("Strada could not locate nvm after approval. Please install Node.js 22 manually.");
          }
          if (!continueWebSetupAfterNodeUpgrade(nodeUpgradeStrategy.nvmDir)) {
          console.log("\n  Strada could not finish the automatic Node.js upgrade flow.");
          console.log(`  Please upgrade to Node.js 22 manually, then rerun \`${getSourceSetupCommand(process.platform, "web")}\`.\n`);
          }
          return undefined;
        }
        const termFallback = await rl.question(
          "  Web setup requires Node.js 20.19+. Continue with terminal setup instead? [Y/n]: ",
        );
        if (termFallback.trim().toLowerCase() === "n") {
          intentionalClose = true;
          rl.close();
          return undefined;
        }
        useWebWizard = false;
      } else if (!webAssets.ready) {
        console.log("  Unable to prepare the web setup bundle right now.");
        const termFallback = await rl.question(
          "  Continue with terminal setup instead? [Y/n]: ",
        );
        if (termFallback.trim().toLowerCase() === "n") {
          console.log(`\n  Fix the build issue and rerun \`${getSourceSetupCommand(process.platform, "web")}\`.\n`);
          intentionalClose = true;
          rl.close();
          return undefined;
        }
        useWebWizard = false;
      } else {
        intentionalClose = true;
        rl.close();
        return await launchWebSetupWizard();
      }
    }

    console.log("");
    console.log("  Terminal setup supports every built-in response provider.");
    console.log("  You can still switch workers later from Strada's dashboard or routing commands.\n");

    const unityPath = await askWithRetry(
      rl,
      "? Unity project path: ",
      validateUnityPath,
    );

    const stradaDeps = checkStradaDeps(unityPath, {
      mcpPath: process.env["STRADA_MCP_PATH"],
    });
    const mcpRecommendation = buildMcpRecommendation(stradaDeps, {
      mcpPath: process.env["STRADA_MCP_PATH"],
    });
    console.log("");
    console.log("  Strada dependency summary:");
    console.log(`    Core: ${stradaDeps.coreInstalled ? `installed (v${stradaDeps.coreVersion ?? "unknown"})` : "missing"}`);
    console.log(`    Modules: ${stradaDeps.modulesInstalled ? `installed (v${stradaDeps.modulesVersion ?? "unknown"})` : "missing"}`);
    console.log(`    MCP: ${stradaDeps.mcpInstalled ? `installed (v${stradaDeps.mcpVersion ?? "unknown"})` : "missing (recommended)"}`);
    if (!stradaDeps.coreInstalled) {
      console.log("    Warning: reduced Strada framework awareness until Strada.Core is available.");
    }
    if (!stradaDeps.mcpInstalled) {
      console.log(`    Why MCP is recommended: ${mcpRecommendation.reason}`);
      console.log(`    Unlocks: ${mcpRecommendation.featureList.join("; ")}`);
      if (mcpRecommendation.discoveryHint) {
        console.log(`    Detection: ${mcpRecommendation.discoveryHint}`);
      }
      if (mcpRecommendation.installHint) {
        console.log(`    Install flow: ${mcpRecommendation.installHint}`);
      }
    } else if (mcpRecommendation.discoveryHint) {
      console.log(`    MCP detection: ${mcpRecommendation.discoveryHint}`);
    }
    console.log("");

    if (!stradaDeps.mcpInstalled) {
      console.log("  Strada.Brain can install Strada.MCP for this project as a git submodule.");
      console.log("  It will add the checkout to your Unity project, wire `com.strada.mcp` into Packages/manifest.json, and run `npm install` inside the checkout so Brain can load the MCP runtime.\n");
      const installMcpNow = await rl.question("  Install Strada.MCP now? [Y/n]: ");
      if (installMcpNow.trim().toLowerCase() !== "n") {
        const targetAnswer = await askWithRetry(
          rl,
          "  Install location [packages/assets] (default: packages): ",
          (input) => {
            const normalized = input.trim().toLowerCase();
            if (!normalized || normalized === "packages" || normalized === "assets") {
              return { valid: true };
            }
            return { valid: false, error: "Choose `packages` or `assets`." };
          },
        );
        const installTarget: McpInstallTarget = targetAnswer.trim().toLowerCase() === "assets"
          ? "assets"
          : "packages";
        console.log("");
        console.log(`  Installing Strada.MCP into ${installTarget === "packages" ? "Packages/Submodules" : "Assets"}...`);
        const installResult = await installStradaMcpSubmodule(unityPath, installTarget, {
          mcpPath: process.env["STRADA_MCP_PATH"],
          mcpRepoUrl: process.env["STRADA_MCP_REPO_URL"],
        });
        if (installResult.kind === "err") {
          console.log(`  Failed to install Strada.MCP: ${installResult.error}`);
        } else {
          console.log("  Strada.MCP installed.");
          console.log(`    Submodule: ${installResult.value.submodulePath}`);
          console.log(`    Unity package: ${installResult.value.manifestDependency}`);
          if (installResult.value.npmInstallRan) {
            console.log("    Runtime bootstrap: npm install completed in the submodule checkout.");
          }
        }
        console.log("");
      }
    }

    // A Strada.MCP copy inside the project runs in Brain's own process, next to
    // every API key, and the agent's file tools can change it — so it loads only
    // with the operator's explicit yes (COR-12), asked here rather than left for
    // the operator to discover as missing Unity tools.
    let stradaMcpAllowProjectLocal: boolean | undefined;
    const untrustedMcpPath = projectLocalMcpAwaitingTrust(
      checkStradaDeps(unityPath, { mcpPath: process.env["STRADA_MCP_PATH"] }),
      unityPath,
    );
    if (untrustedMcpPath) {
      console.log(`  Strada.MCP at ${untrustedMcpPath} is inside this Unity project.`);
      console.log("  Brain loads it into its own process, where your API keys live, and the agent's file tools can edit it.");
      const trustAnswer = await rl.question("  Trust this copy and load its Unity tools? [Y/n]: ");
      stradaMcpAllowProjectLocal = trustAnswer.trim().toLowerCase() !== "n";
      console.log("");
    }

    const providerAnswer = await askWithRetry(
      rl,
      `? Response providers — comma-separated for multi-provider chain (${RESPONSE_PROVIDER_CHOICES.join("/")})\n  [default: claude]: `,
      (input) => {
        const normalized = input.trim().toLowerCase();
        if (!normalized) return { valid: true };
        const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          if (!isValidResponseProvider(part)) {
            return {
              valid: false,
              error: `Unsupported provider "${part}". Supported providers: ${RESPONSE_PROVIDER_CHOICES.join(", ")}.`,
            };
          }
        }
        const unique = new Set(parts);
        if (unique.size !== parts.length) {
          return { valid: false, error: "Duplicate providers in chain." };
        }
        return { valid: true };
      },
    );
    const normalizedProviders = providerAnswer.trim().toLowerCase();
    const providerChain = normalizedProviders
      ? normalizedProviders.split(",").map((p) => p.trim()).filter(Boolean)
      : ["claude"];

    if (providerChain.length === 1) {
      while (true) {
        const remainingProviders = getRemainingResponseProviderChoices(providerChain);
        if (remainingProviders.length === 0) {
          break;
        }

        const addMoreAnswer = await rl.question(
          "? Add another response provider for fallback / multi-agent orchestration? [y/N]: ",
        );
        const normalizedAddMore = addMoreAnswer.trim().toLowerCase();
        if (normalizedAddMore !== "y" && normalizedAddMore !== "yes") {
          break;
        }

        const additionalProvider = await askWithRetry(
          rl,
          `? Additional response provider (${remainingProviders.join("/")}) : `,
          (input) => {
            const normalized = input.trim().toLowerCase();
            if (!normalized) {
              return { valid: false, error: "Choose one provider to add." };
            }
            if (!isValidResponseProvider(normalized)) {
              return {
                valid: false,
                error: `Unsupported provider "${normalized}". Supported providers: ${remainingProviders.join(", ")}.`,
              };
            }
            if (providerChain.includes(normalized)) {
              return { valid: false, error: `${normalized} is already in the response chain.` };
            }
            return { valid: true };
          },
        );

        providerChain.push(additionalProvider.trim().toLowerCase());
      }
    }

    if (providerChain.length > 1) {
      console.log(`  Response provider chain: ${providerChain.join(" -> ")}`);
    }
    const provider = providerChain[0] ?? "claude";
    const providerCredentials: Record<string, string | undefined> = {};
    const providerAuthModes: Record<string, ProviderAuthMode | undefined> = {};

    for (const providerName of providerChain) {
      if (providerName === "claude") {
        const authModeAnswer = await askWithRetry(
          rl,
          `? Claude auth mode for ${providerName} (api-key/claude-subscription) [default: api-key]: `,
          (input) => {
            const normalized = input.trim().toLowerCase();
            if (!normalized) return { valid: true };
            if (normalized !== "api-key" && normalized !== "claude-subscription") {
              return { valid: false, error: "Supported modes: api-key, claude-subscription." };
            }
            return { valid: true };
          },
        );
        const authMode = (authModeAnswer.trim().toLowerCase() || "api-key") as ProviderAuthMode;
        providerAuthModes[providerName] = authMode;
        if (authMode === "claude-subscription") {
          console.log("  Claude subscription mode needs a bearer token generated by the local Claude CLI.");
          console.log("  Run `claude auth login --claudeai` and then `claude setup-token`, then paste the generated token here.");
          console.log("  Warning: Anthropic documents claude.ai subscription auth as restricted outside Claude Code and Claude.ai. Use at your own risk.");
          providerCredentials[providerName] = await askWithRetry(
            rl,
            "? Claude auth token: ",
            (input) => {
              if (!input || input.trim().length < 16) {
                return { valid: false, error: "Auth token seems too short." };
              }
              return { valid: true };
            },
          );
        } else {
          providerCredentials[providerName] = await askWithRetry(
            rl,
            "? Claude API key: ",
            (input) => {
              if (!input || input.trim().length < 8) {
                return { valid: false, error: "API key seems too short." };
              }
              return { valid: true };
            },
          );
        }
        continue;
      }

      if (providerName === "openai") {
        const authModeAnswer = await askWithRetry(
          rl,
          `? OpenAI auth mode for ${providerName} (api-key/chatgpt-subscription) [default: api-key]: `,
          (input) => {
            const normalized = input.trim().toLowerCase();
            if (!normalized) return { valid: true };
            if (normalized !== "api-key" && normalized !== "chatgpt-subscription") {
              return { valid: false, error: "Supported modes: api-key, chatgpt-subscription." };
            }
            return { valid: true };
          },
        );
        const authMode = (authModeAnswer.trim().toLowerCase() || "api-key") as "api-key" | "chatgpt-subscription";
        providerAuthModes[providerName] = authMode;
        if (authMode === "api-key") {
          providerCredentials[providerName] = await askWithRetry(
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
          console.log("  Using local Codex/ChatGPT subscription auth from ~/.codex/auth.json");
          console.log("  Note: this covers OpenAI conversation turns only, not OpenAI embeddings or API quota.");
        }
        continue;
      }

      if (providerName === "ollama") {
        console.log("  Ollama selected in the response chain. No API key is required for the local response worker.");
        continue;
      }

      providerCredentials[providerName] = await askWithRetry(
        rl,
        `? ${getResponseProviderLabel(providerName)} API key: `,
        (input) => {
          if (!input || input.trim().length < 8) {
            return { valid: false, error: "API key seems too short." };
          }
          return { valid: true };
        },
      );
    }

    const openaiAuthMode = providerAuthModes["openai"] === "chatgpt-subscription"
      ? "chatgpt-subscription"
      : providerAuthModes["openai"] === "api-key"
        ? "api-key"
        : undefined;
    const apiKey = providerCredentials[provider];
    const defaultEmbeddingProvider = getDefaultEmbeddingProviderForChain(providerChain);
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
    if (
      embeddingProvider === "openai" &&
      providerChain.includes("openai") &&
      providerAuthModes["openai"] === "chatgpt-subscription"
    ) {
      console.log("  OpenAI embeddings still require an OpenAI API key when conversation uses subscription auth.")
    }
    if (
      embeddingProvider !== "auto" &&
      embeddingProvider !== "ollama" &&
      !providerChain.includes(embeddingProvider)
    ) {
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
    } else if (
      embeddingProvider === "openai" &&
      providerChain.includes("openai") &&
      providerAuthModes["openai"] === "chatgpt-subscription"
    ) {
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

    // A CHANNEL WITHOUT ITS TOKEN IS NOT A CHANNEL (plan 2.4 / audit 10.2 /
    // D26): the wizard let a person pick telegram, discord or slack and wrote
    // a .env with no token, so the daemon booted with a channel it could not
    // open. Every required credential of the chosen channel is asked for here
    // and validated before anything is written.
    const channelCredentials: Record<string, string> = {};
    for (const field of getChannelCredentialFields(channel)) {
      const hint = field.hint === undefined ? "" : " (" + field.hint + ")";
      channelCredentials[field.envKey] = await askWithRetry(
        rl,
        "? " + field.label + hint + ": ",
        (input) => {
          if (field.required && sanitizeEnvValue(input) === "") {
            return { valid: false, error: field.label + " is required for the " + channel + " channel." };
          }
          return { valid: true };
        },
      );
    }
    const channelCheck = validateChannelCredentials(channel, channelCredentials);
    if (!channelCheck.valid) {
      console.log("\n❌ " + (channelCheck.error ?? "the channel is missing a credential"));
      intentionalClose = true;
      rl.close();
      return undefined;
    }

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

    const sep = "\u2501".repeat(34);
    console.log("\n" + sep);
    console.log("  Configuration Summary");
    console.log(sep);
    console.log(`  Unity project:   ${unityPath}`);
    console.log(`  Provider chain:  ${providerChain.join(" -> ")}`);
    console.log(`  Embedding:       ${embeddingProvider}`);
    console.log(`  Channel:         ${channel}`);
    console.log(`  Language:        ${language}`);
    console.log(sep);

    // PREFLIGHT BEFORE THE WRITE (plan 2.4): the wizard wrote a chain it had
    // never probed, so a mistyped key became a daemon that could not answer.
    // Nothing is written when no provider in the chain can be reached.
    const preflightCredentials = toPreflightCredentials(
      { providerCredentials, providerAuthModes, provider, apiKey, openaiAuthMode } as WizardAnswers,
      providerChain,
    );
    console.log("\n⚙ Probing the provider chain…");
    let preflight: ResponseProviderPreflightResult;
    try {
      preflight = await preflightResponseProviders([...providerChain], preflightCredentials);
    } catch (err) {
      console.log("\n❌ The provider chain could not be probed (" + (err instanceof Error ? err.message : String(err)) + "). Nothing was written.");
      intentionalClose = true;
      rl.close();
      return undefined;
    }
    const readiness = evaluateChainReadiness(preflight, { requestedProviderIds: providerChain });
    if (readiness.state === "unavailable") {
      console.log("\n❌ No provider in the chain answered: " + formatProviderPreflightFailures(preflight.failures));
      console.log("Nothing was written — fix the credentials and run setup again.");
      intentionalClose = true;
      rl.close();
      return undefined;
    }
    if (readiness.warning !== undefined) console.log("⚠ " + readiness.warning);

    const envPath = resolveDotenvPath({ moduleUrl: import.meta.url });
    if (fs.existsSync(envPath)) {
      const overwrite = await rl.question("\n\u26A0 .env already exists. Update it? Keys you added by hand are kept. [y/N]: ");
      if (overwrite.trim().toLowerCase() !== "y") {
        console.log("\nSetup cancelled. Existing .env preserved.");
        intentionalClose = true;
        rl.close();
        return undefined;
      }
    }

    const envContent = generateEnvContent({
      unityProjectPath: unityPath,
      providerChain,
      providerCredentials,
      providerAuthModes,
      apiKey: apiKey?.trim(),
      provider,
      openaiAuthMode,
      embeddingProvider,
      embeddingApiKey: embeddingApiKey?.trim(),
      channel,
      channelCredentials,
      language,
      stradaMcpAllowProjectLocal,
    });

    // Merge, never rewrite: hand-added keys survive, and the file is read
    // back so the summary shows what the runtime will load (plan 2.1).
    const persisted = await persistSetup(envPath, envContent.split("\n"), {
      ownedKeys: TERMINAL_WIZARD_OWNED_ENV_KEYS,
      defaultKeys: SETUP_DEFAULT_ENV_KEYS,
    });

    console.log("\n\u2705 .env " + (persisted.replaced.length > 0 || persisted.preserved.length > 0 ? "updated" : "created") + "!");
    if (persisted.preserved.length > 0) {
      console.log(`   Kept ${persisted.preserved.length} existing key(s): ${persisted.preserved.join(", ")}`);
    }
    console.log(`   Effective PROVIDER_CHAIN: ${persisted.effective["PROVIDER_CHAIN"] ?? "(unset)"}`);
    console.log(`   Effective budget: ${describeEffectiveBudget(persisted.effective).display}`);
    console.log("   Source checkout next steps:");
    console.log(`   1) Run \`${getSourceDoctorCommand(process.platform)}\` from this repo root.`);
    console.log(`   2) If you want the bare \`strada\` command everywhere, run \`${getSourceInstallCommand(process.platform)}\` once.`);
    console.log(`   3) Then use either \`${getBareCommand(["doctor"])}\` / \`${getBareCommand(["start"])}\` or keep using \`${getSourceLauncherCommand(process.platform)} ...\`.`);
    for (const line of getPlatformInstallCommandGuidance(process.platform)) {
      console.log(`      ${line}`);
    }
    console.log("");
    intentionalClose = true;
    rl.close();
    return undefined;
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
