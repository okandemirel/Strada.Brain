/**
 * Setup Wizard - Minimal HTTP server for first-time configuration.
 *
 * When no valid .env exists, this serves a web UI to configure
 * required settings and writes the .env file.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, stat, readdir, realpath } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const STATIC_DIR = new URL("../channels/web/static/", import.meta.url).pathname;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
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

export class SetupWizard {
  private server: Server | null = null;
  private readonly port: number;
  private readonly csrfToken = randomUUID();

  constructor(opts?: { port?: number }) {
    this.port = opts?.port ?? 3000;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
      this.server!.once("error", reject);
    });

    console.log(`Setup wizard running at http://localhost:${this.port}`);

    // Keep alive
    await new Promise<void>(() => {});
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
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
    let filePath: string;

    // Map routes to setup files
    if (url === "/" || url === "/index.html" || url === "/setup.html") {
      filePath = join(STATIC_DIR, "setup.html");
    } else {
      // Use resolve() to normalise the path and assert it still lives inside
      // STATIC_DIR, blocking both ../ and URL-encoded (%2e%2e) traversals.
      const rawSegment = url.split("?")[0]!;
      const candidate = resolve(join(STATIC_DIR, rawSegment));
      const safeRoot = resolve(STATIC_DIR);
      if (!candidate.startsWith(safeRoot + "/") && candidate !== safeRoot) {
        res.writeHead(403, SECURITY_HEADERS);
        res.end("Forbidden");
        return;
      }
      filePath = candidate;
    }

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentType });
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

  private async handleValidatePath(url: string, res: ServerResponse): Promise<void> {
    const params = new URL(url, "http://localhost").searchParams;
    const rawPath = params.get("path") ?? "";

    const pathError = this.validatePathSafety(rawPath);
    if (pathError) {
      this.json(res, 400, { valid: false, error: pathError });
      return;
    }

    try {
      const resolved = await realpath(rawPath);
      const home = homedir();
      if (resolved !== home && !resolved.startsWith(home + "/")) {
        this.json(res, 400, { valid: false, error: "Path must be inside your home directory" });
        return;
      }

      const stats = await stat(resolved);
      if (stats.isDirectory()) {
        this.json(res, 200, { valid: true });
      } else {
        this.json(res, 200, { valid: false, error: "Path is not a directory" });
      }
    } catch {
      this.json(res, 200, { valid: false, error: "Path does not exist" });
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

    // At least one provider API key must be present (Ollama excluded — no key needed)
    const providerKeys = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "QWEN_API_KEY",
      "KIMI_API_KEY",
      "MINIMAX_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "TOGETHER_API_KEY",
      "FIREWORKS_API_KEY",
      "GEMINI_API_KEY",
    ];
    const hasProvider =
      providerKeys.some((k) => config[k]) || config.PROVIDER_CHAIN?.includes("ollama");
    if (!hasProvider) {
      this.json(res, 400, { success: false, error: "At least one AI provider key is required" });
      return;
    }

    // Sanitize all values to remove newline characters before writing to .env.
    const lines: string[] = [
      "# Generated by Strada.Brain Setup Wizard",
      `UNITY_PROJECT_PATH=${sanitizeEnvValue(config.UNITY_PROJECT_PATH)}`,
    ];

    // Write all provider API keys that are present
    for (const key of providerKeys) {
      if (config[key]) lines.push(`${key}=${sanitizeEnvValue(config[key])}`);
    }

    // Write provider chain for multi-provider fallback (validate names)
    const KNOWN_PROVIDERS = new Set([
      "claude",
      "openai",
      "deepseek",
      "kimi",
      "qwen",
      "gemini",
      "groq",
      "mistral",
      "together",
      "fireworks",
      "minimax",
      "ollama",
    ]);
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
    if (config.TELEGRAM_BOT_TOKEN)
      lines.push(`TELEGRAM_BOT_TOKEN=${sanitizeEnvValue(config.TELEGRAM_BOT_TOKEN)}`);
    if (config.ALLOWED_TELEGRAM_USER_IDS)
      lines.push(`ALLOWED_TELEGRAM_USER_IDS=${sanitizeEnvValue(config.ALLOWED_TELEGRAM_USER_IDS)}`);
    if (config.DISCORD_BOT_TOKEN)
      lines.push(`DISCORD_BOT_TOKEN=${sanitizeEnvValue(config.DISCORD_BOT_TOKEN)}`);
    if (config.SLACK_BOT_TOKEN)
      lines.push(`SLACK_BOT_TOKEN=${sanitizeEnvValue(config.SLACK_BOT_TOKEN)}`);
    if (config.SLACK_APP_TOKEN)
      lines.push(`SLACK_APP_TOKEN=${sanitizeEnvValue(config.SLACK_APP_TOKEN)}`);

    // Always add some defaults
    lines.push("");
    lines.push("# Defaults");
    lines.push("STREAMING_ENABLED=true");
    lines.push("REQUIRE_EDIT_CONFIRMATION=true");
    lines.push("LOG_LEVEL=info");

    const envPath = join(process.cwd(), ".env");

    try {
      await writeFile(envPath, lines.join("\n") + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.json(res, 500, { success: false, error: `Failed to write .env: ${msg}` });
      return;
    }

    this.json(res, 200, { success: true });

    // Exit after a short delay so the response can be sent.
    // In daemon mode, the process will auto-restart with the new config.
    setTimeout(() => process.exit(0), 500);
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
