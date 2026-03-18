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
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_WEB_SETUP_STATIC_DIR = path.resolve(MODULE_DIR, "../../web-portal/dist");
const PACKAGED_WEB_SETUP_STATIC_DIR = path.resolve(MODULE_DIR, "../channels/web/static");
const SETUP_HOST = "127.0.0.1";
const SETUP_QUERY_PARAM = "strada-setup";

export interface WizardAnswers {
  unityProjectPath: string;
  providerChain?: string[];
  providerCredentials?: Record<string, string | undefined>;
  providerAuthModes?: Record<string, "api-key" | "chatgpt-subscription" | undefined>;
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
export function validateUnityPath(inputPath: string, homeDir: string = os.homedir()): ValidationResult {
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

  const homedir = homeDir;
  let resolvedHome = homedir;
  try {
    resolvedHome = fs.realpathSync(homedir);
  } catch {
    resolvedHome = homedir;
  }

  if (resolved !== resolvedHome && !resolved.startsWith(resolvedHome + "/")) {
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
): "api-key" | "chatgpt-subscription" | undefined {
  return answers.providerAuthModes?.[providerName] ?? (
    providerName === "openai" ? answers.openaiAuthMode : undefined
  );
}

function getProviderCredential(answers: WizardAnswers, providerName: string): string | undefined {
  return answers.providerCredentials?.[providerName] ?? (
    providerName === answers.provider ? answers.apiKey : undefined
  );
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

  const providerChain = getNormalizedProviderChain(answers);
  for (const providerName of providerChain) {
    const envKey = PROVIDER_ENV_KEY_MAP[providerName];
    const authMode = getProviderAuthMode(answers, providerName);
    const credential = getProviderCredential(answers, providerName);
    const sanitizedCredential = credential ? sanitizeEnvValue(credential) : "";

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
  lines.push(`PROVIDER_CHAIN=${providerChain.join(",")}`);

  if (answers.embeddingProvider && answers.embeddingProvider !== "auto") {
    if (
      answers.embeddingProvider === "openai"
      && providerChain.includes("openai")
      && getProviderAuthMode(answers, "openai") === "chatgpt-subscription"
    ) {
      const embeddingKey = sanitizeEnvValue(answers.embeddingApiKey ?? "");
      if (embeddingKey) {
        lines.push(`OPENAI_API_KEY="${embeddingKey}"`);
      }
    } else if (
      answers.embeddingProvider !== "ollama" &&
      !providerChain.includes(answers.embeddingProvider)
    ) {
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

function buildSetupAccessUrl(port: number): string {
  const params = new URLSearchParams({
    [SETUP_QUERY_PARAM]: "1",
    t: Date.now().toString(),
  });
  return `http://${SETUP_HOST}:${port}/?${params.toString()}`;
}

async function waitForSetupUrlReady(
  url: string,
  maxAttempts = 20,
  delayMs = 150,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
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
  return fs.existsSync(path.join(SOURCE_WEB_SETUP_STATIC_DIR, "index.html"))
    || fs.existsSync(path.join(PACKAGED_WEB_SETUP_STATIC_DIR, "index.html"));
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

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(parts: string[]): string {
  return parts.map((part) => shellEscape(part)).join(" ");
}

export function getSuggestedNodeUpgradeCommand(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
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

export function buildWebSetupUpgradeShellScript(
  nvmDir: string,
  cwd: string = process.env["STRADA_INSTALL_ROOT"] ?? process.cwd(),
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
    cwd: process.cwd(),
    env: { ...process.env, NVM_DIR: nvmDir },
  });

  return result.status === 0;
}

export function getPostSetupWebLaunchCommand(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = env["STRADA_INSTALL_ROOT"] ?? process.cwd(),
): { command: string; args: string[]; cwd: string } {
  const launcherPath = env["STRADA_LAUNCHER_PATH"];
  if (launcherPath) {
    return {
      command: launcherPath,
      args: ["start", "--channel", "web"],
      cwd,
    };
  }

  return {
    command: "node",
    args: [...process.execArgv, process.argv[1] ?? "", "start", "--channel", "web"].filter(Boolean),
    cwd,
  };
}

function handoffToMainWebAppAfterSetup(): void {
  const launch = getPostSetupWebLaunchCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

async function promptForWebSetupUpgrade(
  rl: readline.Interface,
): Promise<"rerun" | "manual-upgrade"> {
  console.log(
    `\n  Web setup needs Node.js 20.19+ or 22.12+ to build the full portal experience. Current Node: ${process.versions.node}.`,
  );
  const nvmDir = resolveNvmDir();
  const suggestedCommand = getSuggestedNodeUpgradeCommand();
  if (nvmDir && suggestedCommand) {
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
  } else {
    console.log("  Suggested upgrade path: install Node.js 22 LTS from nodejs.org.");
  }

  const answer = await rl.question("  Open the Node.js download page now? [Y/n]: ");
  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === "y" || normalized === "yes") {
    openBrowser("https://nodejs.org/en/download");
  }

  console.log("");
  console.log("  After upgrading Node.js, run `strada setup --web` (or `./strada setup --web`) again.");
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

  if (!fs.existsSync(path.join(process.cwd(), "web-portal", "node_modules"))) {
    console.log("\n  Installing web setup dependencies...");
    const installResult = spawnSync("npm", ["install", "--prefix", "web-portal"], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    if (installResult.status !== 0) {
      return { ready: false, needsNodeUpgrade: false };
    }
  }

  console.log("\n  Preparing web setup assets...");
  const buildResult = spawnSync("npm", ["--prefix", "web-portal", "run", "build"], {
    stdio: "inherit",
    cwd: process.cwd(),
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
      console.log("  1) Web Browser (recommended)");
      console.log("  2) Terminal");
      console.log("     Tip: next time you can jump straight in with `strada setup --web`.");
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
          const nvmDir = resolveNvmDir();
          if (!nvmDir) {
            throw new Error("Strada could not locate nvm after approval. Please install Node.js 22 manually.");
          }
          if (!continueWebSetupAfterNodeUpgrade(nvmDir)) {
            console.log("\n  Strada could not finish the automatic Node.js upgrade flow.");
            console.log("  Please upgrade to Node.js 22 manually, then rerun `strada setup --web`.\n");
          }
          return;
        }
        const termFallback = await rl.question(
          "  Web setup requires Node.js 20.19+. Continue with terminal setup instead? [Y/n]: ",
        );
        if (termFallback.trim().toLowerCase() === "n") {
          intentionalClose = true;
          rl.close();
          return;
        }
        useWebWizard = false;
      } else if (!webAssets.ready) {
        console.log("  Unable to prepare the web setup bundle right now.");
        const termFallback = await rl.question(
          "  Continue with terminal setup instead? [Y/n]: ",
        );
        if (termFallback.trim().toLowerCase() === "n") {
          console.log("\n  Fix the build issue and rerun `strada setup --web`.\n");
          intentionalClose = true;
          rl.close();
          return;
        }
        useWebWizard = false;
      } else {
        intentionalClose = true;
        rl.close();
        const requestedPort = process.env["SETUP_WIZARD_PORT"]
          ? parseInt(process.env["SETUP_WIZARD_PORT"], 10)
          : 3000;
        const port = await findAvailableSetupWizardPort(requestedPort);
        const { SetupWizard } = await import("./setup-wizard.js");
        const wizard = new SetupWizard({ port });
        const url = buildSetupAccessUrl(port);
        if (port !== requestedPort) {
          console.log(
            `\n\u26A0\uFE0F  Port ${requestedPort} is already in use. Starting the setup wizard on ${url} instead.`,
          );
        }
        await wizard.listen();
        await waitForSetupUrlReady(url);
        console.log(`\n\uD83C\uDF10 Opening setup at ${url}...`);
        console.log(`   (Open this URL in your browser if it didn't open automatically)\n`);
        openBrowser(url);
        await wizard.waitForCompletion();
        await wizard.shutdown();
        console.log(`\nConfiguration saved. Launching Strada web app at http://${SETUP_HOST}:${port}/ ...\n`);
        handoffToMainWebAppAfterSetup();
        return;
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
    const providerAuthModes: Record<string, "api-key" | "chatgpt-subscription" | undefined> = {};

    for (const providerName of providerChain) {
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

    const openaiAuthMode = providerAuthModes["openai"];
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
      providerChain,
      providerCredentials,
      providerAuthModes,
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
