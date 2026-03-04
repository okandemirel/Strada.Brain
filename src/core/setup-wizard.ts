/**
 * Setup Wizard - Minimal HTTP server for first-time configuration.
 *
 * When no valid .env exists, this serves a web UI to configure
 * required settings and writes the .env file.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, extname, resolve } from "node:path";

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
    "base-uri 'none';",
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
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

export class SetupWizard {
  private server: Server | null = null;
  private readonly port: number;

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
      if (url.startsWith("/api/setup/validate-path") && method === "GET") {
        await this.handleValidatePath(url, res);
        return;
      }

      if (url === "/api/setup" && method === "POST") {
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

  private async handleValidatePath(url: string, res: ServerResponse): Promise<void> {
    const params = new URL(url, "http://localhost").searchParams;
    const rawPath = params.get("path") ?? "";

    // Block directory traversal sequences
    if (rawPath.includes("..")) {
      this.json(res, 400, { valid: false, error: "Invalid path: directory traversal not allowed" });
      return;
    }

    // Only allow absolute paths that begin with a filesystem root.
    // This prevents the endpoint from being used to probe relative paths or
    // enumerate arbitrary parts of the filesystem via crafted inputs.
    if (!rawPath.startsWith("/")) {
      this.json(res, 400, { valid: false, error: "Only absolute paths are accepted" });
      return;
    }

    try {
      const stats = await stat(rawPath);
      if (stats.isDirectory()) {
        this.json(res, 200, { valid: true });
      } else {
        this.json(res, 200, { valid: false, error: "Path is not a directory" });
      }
    } catch {
      this.json(res, 200, { valid: false, error: "Path does not exist" });
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
    if (!config.ANTHROPIC_API_KEY) {
      this.json(res, 400, { success: false, error: "ANTHROPIC_API_KEY is required" });
      return;
    }
    if (!config.UNITY_PROJECT_PATH) {
      this.json(res, 400, { success: false, error: "UNITY_PROJECT_PATH is required" });
      return;
    }

    // Sanitize all values to remove newline characters before writing to .env.
    // A value containing \n or \r would inject extra lines into the file,
    // potentially overwriting keys that appear later (e.g. overriding
    // ANTHROPIC_API_KEY a second time with an attacker-controlled value).
    const lines: string[] = [
      "# Generated by Strada.Brain Setup Wizard",
      `ANTHROPIC_API_KEY=${sanitizeEnvValue(config.ANTHROPIC_API_KEY)}`,
      `UNITY_PROJECT_PATH=${sanitizeEnvValue(config.UNITY_PROJECT_PATH)}`,
    ];

    if (config.OPENAI_API_KEY)
      lines.push(`OPENAI_API_KEY=${sanitizeEnvValue(config.OPENAI_API_KEY)}`);
    if (config.TELEGRAM_BOT_TOKEN)
      lines.push(`TELEGRAM_BOT_TOKEN=${sanitizeEnvValue(config.TELEGRAM_BOT_TOKEN)}`);
    if (config.ALLOWED_TELEGRAM_USER_IDS)
      lines.push(
        `ALLOWED_TELEGRAM_USER_IDS=${sanitizeEnvValue(config.ALLOWED_TELEGRAM_USER_IDS)}`,
      );
    if (config.DISCORD_BOT_TOKEN)
      lines.push(`DISCORD_BOT_TOKEN=${sanitizeEnvValue(config.DISCORD_BOT_TOKEN)}`);

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
