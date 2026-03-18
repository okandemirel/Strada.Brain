/**
 * Setup Wizard - Minimal HTTP server for first-time configuration.
 *
 * When no valid .env exists, this serves a web UI to configure
 * required settings and writes the .env file.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile, stat, readdir, realpath } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGED_STATIC_DIR = fileURLToPath(new URL("../channels/web/static/", import.meta.url));
const SOURCE_BUILD_STATIC_DIR = resolve(MODULE_DIR, "../../web-portal/dist");
const SETUP_HOST = "127.0.0.1";

function resolveStaticDir(): string {
  if (existsSync(SOURCE_BUILD_STATIC_DIR)) {
    return SOURCE_BUILD_STATIC_DIR;
  }
  return PACKAGED_STATIC_DIR;
}

const STATIC_DIR = resolveStaticDir();

export function injectSetupModeMarker(html: string): string {
  if (html.includes("window.__STRADA_SETUP__")) {
    return html;
  }
  return html.replace(
    "</head>",
    "    <script>window.__STRADA_SETUP__ = true;</script>\n  </head>",
  );
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const KNOWN_LANGUAGES = new Set(["en", "tr", "ja", "ko", "zh", "de", "es", "fr"]);

const KNOWN_PROVIDERS = new Set([
  "claude", "openai", "deepseek", "kimi", "qwen", "gemini",
  "groq", "mistral", "together", "fireworks", "minimax", "ollama",
]);

const KNOWN_EMBEDDING_PROVIDERS = new Set([
  "auto", "openai", "deepseek", "mistral", "together",
  "fireworks", "qwen", "gemini", "ollama",
]);

const KNOWN_OPENAI_AUTH_MODES = new Set(["api-key", "chatgpt-subscription"]);

const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
  "QWEN_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY", "GEMINI_API_KEY",
] as const;

const CHANNEL_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN", "ALLOWED_TELEGRAM_USER_IDS",
  "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
  "WHATSAPP_SESSION_PATH", "WHATSAPP_ALLOWED_NUMBERS",
] as const;

const KNOWN_CHANNELS = new Set(["web", "telegram", "discord", "slack", "whatsapp", "cli"]);

const EMBEDDING_PROVIDER_ENV_KEYS: Record<string, string | null> = {
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  qwen: "QWEN_API_KEY",
  gemini: "GEMINI_API_KEY",
  ollama: null,
};

/** Security headers sent with every HTTP response. */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none';",
};

/**
 * Sanitise a value before embedding it in a .env file line.
 *
 * .env files are line-oriented key=value pairs. A value that contains a
 * newline character (\n or \r) would inject extra lines — potentially
 * overwriting keys that appear later in the file.  We strip every carriage
 * return and newline character so that no injected value can span more than
 * one logical line.
 */
function sanitizeEnvValue(value: unknown): string {
  if (typeof value !== "string") return '""';
  const stripped = value.replace(/[\r\n]/g, "");
  return `"${stripped.replace(/"/g, '\\"')}"`;
}

export function hasConfiguredEmbeddingCandidate(config: Record<string, unknown>): boolean {
  const explicitProvider = typeof config.EMBEDDING_PROVIDER === "string" ? config.EMBEDDING_PROVIDER : "auto";

  if (explicitProvider !== "auto") {
    const envKey = EMBEDDING_PROVIDER_ENV_KEYS[explicitProvider];
    if (envKey === null) {
      return true;
    }
    if (!envKey) {
      return false;
    }
    return typeof config[envKey] === "string" && String(config[envKey]).trim().length > 0;
  }

  const providerChain = typeof config.PROVIDER_CHAIN === "string"
    ? config.PROVIDER_CHAIN.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    : [];

  for (const provider of providerChain) {
    const envKey = EMBEDDING_PROVIDER_ENV_KEYS[provider];
    if (envKey === undefined) {
      continue;
    }
    if (envKey === null) {
      return true;
    }
    if (typeof config[envKey] === "string" && String(config[envKey]).trim().length > 0) {
      return true;
    }
  }

  for (const envKey of Object.values(EMBEDDING_PROVIDER_ENV_KEYS)) {
    if (envKey && typeof config[envKey] === "string" && String(config[envKey]).trim().length > 0) {
      return true;
    }
  }

  return false;
}

export class SetupWizard {
  private server: Server | null = null;
  private readonly port: number;
  private readonly csrfToken = randomUUID();
  private onComplete: (() => void) | null = null;

  constructor(opts?: { port?: number }) {
    this.port = opts?.port ?? 3000;
  }

  /** Starts the wizard and resolves when the user completes setup. */
  async start(): Promise<void> {
    await this.listen();
    await this.waitForCompletion();
  }

  /** Starts listening and resolves once the HTTP server is ready. */
  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, SETUP_HOST, () => resolve());
      this.server!.once("error", reject);
    });

    console.log(`Setup wizard running at http://${SETUP_HOST}:${this.port}`);
  }

  /** Resolves when the user completes the setup flow and saves config. */
  async waitForCompletion(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.onComplete = resolve;
    });

    // Don't stop the wizard server yet — let the caller (index.ts) stop it
    // after the main app is ready, so the frontend can keep polling /health.
  }

  /** Stops the wizard server. Called by the app after bootstrap completes. */
  async shutdown(): Promise<void> {
    await this.stop();
  }

  private stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // API endpoints
      if (url.startsWith("/api/setup/browse") && method === "GET") {
        await this.handleBrowse(url, res);
        return;
      }

      if (url.startsWith("/api/setup/validate-path") && method === "GET") {
        await this.handleValidatePath(url, res);
        return;
      }

      if (url === "/api/setup/csrf" && method === "GET") {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ token: this.csrfToken }));
        return;
      }

      if (url === "/api/setup" && method === "POST") {
        const token = req.headers["x-csrf-token"];
        if (token !== this.csrfToken) {
          this.json(res, 403, { success: false, error: "Invalid CSRF token" });
          return;
        }
        await this.handleSaveConfig(req, res);
        return;
      }

      // Static files
      if (method === "GET") {
        await this.serveStatic(url, res);
        return;
      }

      res.writeHead(405, SECURITY_HEADERS);
      res.end("Method Not Allowed");
    } catch {
      res.writeHead(500, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  private async serveStatic(url: string, res: ServerResponse): Promise<void> {
    const rawSegment = url.split("?")[0]!;

    // For known static file extensions, serve directly from STATIC_DIR
    const ext = extname(rawSegment);
    if (ext && MIME_TYPES[ext]) {
      const candidate = resolve(join(STATIC_DIR, rawSegment));
      const safeRoot = resolve(STATIC_DIR);
      if (!candidate.startsWith(safeRoot + "/") && candidate !== safeRoot) {
        res.writeHead(403, SECURITY_HEADERS);
        res.end("Forbidden");
        return;
      }
      try {
        const data = await readFile(candidate);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentType, "Cache-Control": "no-store" });
        res.end(data);
        return;
      } catch {
        // Fall through to SPA fallback
      }
    }

    // SPA fallback: serve index.html for all non-file routes (client-side routing)
    const indexPath = join(STATIC_DIR, "index.html");
    try {
      const data = injectSetupModeMarker(await readFile(indexPath, "utf-8"));
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end("Not Found");
    }
  }

  /**
   * Validate that a path is absolute and contains no traversal sequences.
   * Returns an error string if invalid, or null if the path is safe.
   */
  private validatePathSafety(path: string): string | null {
    if (path.includes("..")) return "Invalid path: directory traversal not allowed";
    if (!path.startsWith("/")) return "Only absolute paths are accepted";
    return null;
  }

  private async validateProjectPathForSave(
    rawPath: string,
  ): Promise<{ valid: true; resolved: string } | { valid: false; error: string }> {
    const pathError = this.validatePathSafety(rawPath);
    if (pathError) {
      return { valid: false, error: pathError };
    }

    let resolved: string;
    try {
      resolved = await realpath(rawPath);
    } catch {
      return { valid: false, error: "Path does not exist" };
    }

    const home = homedir();
    if (resolved !== home && !resolved.startsWith(home + "/")) {
      return { valid: false, error: "Path must be inside your home directory" };
    }

    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        return { valid: false, error: "Path is not a directory" };
      }
    } catch {
      return { valid: false, error: "Path does not exist" };
    }

    return { valid: true, resolved };
  }

  private async handleValidatePath(url: string, res: ServerResponse): Promise<void> {
    const params = new URL(url, "http://localhost").searchParams;
    const rawPath = params.get("path") ?? "";

    const result = await this.validateProjectPathForSave(rawPath);
    if (result.valid) {
      this.json(res, 200, { valid: true });
    } else {
      this.json(res, 200, { valid: false, error: result.error });
    }
  }

  private async handleBrowse(url: string, res: ServerResponse): Promise<void> {
    const params = new URL(url, "http://localhost").searchParams;
    const rawPath = params.get("path") || homedir();
    const showHidden = params.get("hidden") === "1";

    const pathError = this.validatePathSafety(rawPath);
    if (pathError) {
      this.json(res, 400, { error: pathError });
      return;
    }

    let resolved: string;
    try {
      resolved = await realpath(rawPath);
    } catch {
      this.json(res, 200, {
        path: rawPath,
        entries: [],
        isUnityProject: false,
        error: "Path does not exist",
      });
      return;
    }

    const home = homedir();
    if (resolved !== home && !resolved.startsWith(home + "/")) {
      this.json(res, 403, { error: "Browsing outside your home directory is not permitted" });
      return;
    }

    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        this.json(res, 400, { error: "Path is not a directory" });
        return;
      }

      const dirents = await readdir(resolved, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory())
        .filter((d) => showHidden || !d.name.startsWith("."))
        .map((d) => ({ name: d.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const entryNames = new Set(dirents.map((d) => d.name));
      const isUnityProject = entryNames.has("Assets") && entryNames.has("ProjectSettings");

      this.json(res, 200, { path: resolved, entries, isUnityProject });
    } catch {
      this.json(res, 200, {
        path: rawPath,
        entries: [],
        isUnityProject: false,
        error: "Cannot read directory",
      });
    }
  }

  private async handleSaveConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    let config: Record<string, string>;

    try {
      config = JSON.parse(body) as Record<string, string>;
    } catch {
      this.json(res, 400, { success: false, error: "Invalid JSON" });
      return;
    }

    // Validate required fields
    if (!config.UNITY_PROJECT_PATH) {
      this.json(res, 400, { success: false, error: "UNITY_PROJECT_PATH is required" });
      return;
    }

    const validatedProjectPath = await this.validateProjectPathForSave(config.UNITY_PROJECT_PATH);
    if (!validatedProjectPath.valid) {
      this.json(res, 400, { success: false, error: validatedProjectPath.error });
      return;
    }

    // At least one provider API key must be present (Ollama excluded — no key needed)
    const hasProvider =
      PROVIDER_ENV_KEYS.some((k) => config[k])
      || config.PROVIDER_CHAIN?.includes("ollama")
      || config.OPENAI_AUTH_MODE === "chatgpt-subscription";
    if (!hasProvider) {
      this.json(res, 400, { success: false, error: "At least one AI provider key is required" });
      return;
    }

    if (config.OPENAI_AUTH_MODE && !KNOWN_OPENAI_AUTH_MODES.has(String(config.OPENAI_AUTH_MODE))) {
      this.json(res, 400, { success: false, error: "Invalid OPENAI_AUTH_MODE value" });
      return;
    }

    // Validate LANGUAGE_PREFERENCE if provided
    if (config.LANGUAGE_PREFERENCE && !KNOWN_LANGUAGES.has(String(config.LANGUAGE_PREFERENCE))) {
      this.json(res, 400, { success: false, error: "Invalid LANGUAGE_PREFERENCE value" });
      return;
    }

    // Validate WHATSAPP_SESSION_PATH — must not contain directory traversal
    if (config.WHATSAPP_SESSION_PATH && String(config.WHATSAPP_SESSION_PATH).includes("..")) {
      this.json(res, 400, { success: false, error: "WHATSAPP_SESSION_PATH must not contain '..'" });
      return;
    }

    // Sanitize all values to remove newline characters before writing to .env.
    const lines: string[] = [
      "# Generated by Strada.Brain Setup Wizard",
      `UNITY_PROJECT_PATH=${sanitizeEnvValue(validatedProjectPath.resolved)}`,
    ];

    // Write all provider API keys that are present
    for (const key of PROVIDER_ENV_KEYS) {
      if (config[key]) lines.push(`${key}=${sanitizeEnvValue(config[key])}`);
    }
    if (config.OPENAI_AUTH_MODE) {
      lines.push(`OPENAI_AUTH_MODE=${sanitizeEnvValue(config.OPENAI_AUTH_MODE)}`);
    }
    if (config.OPENAI_CHATGPT_AUTH_FILE) {
      lines.push(`OPENAI_CHATGPT_AUTH_FILE=${sanitizeEnvValue(config.OPENAI_CHATGPT_AUTH_FILE)}`);
    }

    // Write provider chain for multi-provider fallback (validate names)
    if (config.PROVIDER_CHAIN) {
      const names = String(config.PROVIDER_CHAIN)
        .split(",")
        .map((s) => s.trim());
      if (names.some((n) => !KNOWN_PROVIDERS.has(n))) {
        this.json(res, 400, { success: false, error: "Invalid provider name in PROVIDER_CHAIN" });
        return;
      }
      lines.push(`PROVIDER_CHAIN=${sanitizeEnvValue(config.PROVIDER_CHAIN)}`);
    }

    // Channel-specific config
    for (const key of CHANNEL_ENV_KEYS) {
      if (config[key]) lines.push(`${key}=${sanitizeEnvValue(config[key])}`);
    }

    // RAG configuration
    if (config.RAG_ENABLED === "false") {
      lines.push("", "# RAG (Code Search)", "RAG_ENABLED=false");
    } else if (config.EMBEDDING_PROVIDER && config.EMBEDDING_PROVIDER !== "auto") {
      if (!KNOWN_EMBEDDING_PROVIDERS.has(String(config.EMBEDDING_PROVIDER))) {
        this.json(res, 400, { success: false, error: "Invalid EMBEDDING_PROVIDER value" });
        return;
      }
      lines.push("", "# RAG (Code Search)", `EMBEDDING_PROVIDER=${sanitizeEnvValue(config.EMBEDDING_PROVIDER)}`);
    }

    if (config.RAG_ENABLED !== "false" && !hasConfiguredEmbeddingCandidate(config)) {
      this.json(res, 400, {
        success: false,
        error: "RAG requires an embedding-capable provider with a usable credential (or Ollama).",
      });
      return;
    }

    // Language preference (default: en)
    const lang = config.LANGUAGE_PREFERENCE && KNOWN_LANGUAGES.has(String(config.LANGUAGE_PREFERENCE))
      ? String(config.LANGUAGE_PREFERENCE)
      : "en";
    lines.push("", "# Language", `LANGUAGE_PREFERENCE=${sanitizeEnvValue(lang)}`);

    // Gemini embedding recommendation: auto-set when Gemini key is present
    // and no explicit EMBEDDING_PROVIDER was already written above.
    const hasGeminiKey = !!config.GEMINI_API_KEY;
    const hasExplicitEmbedding = !!(config.EMBEDDING_PROVIDER && config.EMBEDDING_PROVIDER !== "auto");
    const ragDisabled = config.RAG_ENABLED === "false";
    if (hasGeminiKey && !hasExplicitEmbedding && !ragDisabled) {
      lines.push("", "# Gemini offers free embedding with excellent quality", `EMBEDDING_PROVIDER=${sanitizeEnvValue("gemini")}`);
    }

    // System preset
    const KNOWN_PRESETS = new Set(["free", "budget", "balanced", "performance", "premium"]);
    if (config.SYSTEM_PRESET && KNOWN_PRESETS.has(String(config.SYSTEM_PRESET))) {
      lines.push("", "# System Preset", `SYSTEM_PRESET=${sanitizeEnvValue(String(config.SYSTEM_PRESET))}`);
    }

    // Channel selection
    if (config._channel && KNOWN_CHANNELS.has(String(config._channel))) {
      lines.push("", "# Channel", `DEFAULT_CHANNEL=${sanitizeEnvValue(String(config._channel))}`);
    }

    // Write the port so the main app starts on the same port as the wizard
    lines.push(
      "",
      "# Web Channel",
      `WEB_CHANNEL_PORT=${this.port}`,
      "DASHBOARD_PORT=3100",
    );

    // Daemon mode
    if (config.STRADA_DAEMON_ENABLED === "true") {
      const budget = Number(config.STRADA_DAEMON_DAILY_BUDGET);
      const safeBudget = Number.isFinite(budget) && budget >= 0.5 && budget <= 10 ? budget : 1.0;
      lines.push(
        "",
        "# Daemon Mode",
        "STRADA_DAEMON_ENABLED=true",
        `STRADA_DAEMON_DAILY_BUDGET=${safeBudget}`,
        "STRADA_DAEMON_HEARTBEAT_INTERVAL=30000",
      );
    }

    // Autonomy
    if (config.AUTONOMOUS_DEFAULT_HOURS) {
      const hours = Number(config.AUTONOMOUS_DEFAULT_HOURS);
      if (Number.isFinite(hours) && hours >= 1 && hours <= 168) {
        lines.push(
          "",
          "# Autonomy",
          `AUTONOMOUS_DEFAULT_HOURS=${hours}`,
        );
      }
    }

    // Always add some defaults
    lines.push(
      "",
      "# Defaults",
      "STREAMING_ENABLED=true",
      "REQUIRE_EDIT_CONFIRMATION=true",
      "DASHBOARD_ENABLED=true",
      "MULTI_AGENT_ENABLED=true",
      "LOG_LEVEL=info",
    );

    const envPath = join(process.cwd(), ".env");

    try {
      await writeFile(envPath, lines.join("\n") + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.json(res, 500, { success: false, error: `Failed to write .env: ${msg}` });
      return;
    }

    this.json(res, 200, { success: true });

    // Signal completion after a delay so the response and any follow-up polling can be handled
    setTimeout(() => {
      if (this.onComplete) this.onComplete();
    }, 2000);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX = 64 * 1024; // 64KB limit

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX) {
          req.destroy();
          reject(new Error("Body too large"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
