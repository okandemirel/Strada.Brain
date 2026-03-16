/**
 * Web Channel - Browser-based chat interface
 *
 * HTTP server for static files + WebSocket for real-time communication.
 * Binds to 127.0.0.1 only (local access).
 */

import {
  createServer,
  type Server,
  type IncomingMessage as HttpReq,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedOrigin } from "../../security/origin-validation.js";
import { validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
import type {
  IChannelAdapter,
  IChannelStreaming,
  IChannelRichMessaging,
  IChannelInteractive,
  ConfirmationRequest,
  Attachment,
} from "../channel.interface.js";
import type { IncomingMessage } from "../channel-messages.interface.js";
import { classifyErrorMessage } from "../../utils/error-messages.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

interface WsClient {
  ws: WebSocket;
  chatId: string;
  /** Message count in current rate-limit window. */
  msgCount: number;
  /** Timestamp (ms) when current rate-limit window started. */
  windowStart: number;
}

interface PendingConfirmation {
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
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

const STATIC_DIR = new URL("static/", import.meta.url).pathname;

/** Rate limit: max messages per window. */
const WS_RATE_LIMIT = 20;
/** Rate limit window duration in ms (10 seconds). */
const WS_RATE_WINDOW_MS = 10_000;

export class WebChannel
  implements IChannelAdapter, IChannelStreaming, IChannelRichMessaging, IChannelInteractive
{
  readonly name = "web";

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: MessageHandler | null = null;
  private healthy = false;
  private clients = new Map<string, WsClient>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  /** Recently disconnected chatIds eligible for reconnect (5 min TTL) */
  private recentlyDisconnected = new Map<string, number>();

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly RECONNECT_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly port: number = 3000,
    private readonly dashboardPort: number = 3100,
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttp(req, res));

    // maxPayload: 25 MiB accommodates the 20 MB media validation limit with
    // room for base64 overhead (~33% inflation).
    // verifyClient: reject WebSocket connections whose Origin header does not
    // match localhost, blocking cross-origin WebSocket hijacking from a
    // malicious page open in the same browser.
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: 25 * 1024 * 1024,
      verifyClient: ({ req }: { req: HttpReq }) => isAllowedOrigin(req.headers.origin),
    });
    this.wss.on("connection", (ws) => this.handleWsConnection(ws));

    await new Promise<void>((res, rej) => {
      this.server!.listen(this.port, "localhost", () => res());
      this.server!.once("error", rej);
    });

    this.healthy = true;

    // Periodically prune expired entries from the reconnect map
    this._reconnectCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.recentlyDisconnected) {
        if (now - ts > WebChannel.RECONNECT_TTL_MS) {
          this.recentlyDisconnected.delete(id);
        }
      }
    }, WebChannel.RECONNECT_TTL_MS);

    console.log(`Web channel running at http://localhost:${this.port}`);
  }

  private _reconnectCleanupInterval: ReturnType<typeof setInterval> | undefined;

  async disconnect(): Promise<void> {
    this.healthy = false;

    if (this._reconnectCleanupInterval) {
      clearInterval(this._reconnectCleanupInterval);
    }
    this.recentlyDisconnected.clear();

    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timer);
      pending.resolve("timeout");
    }
    this.pendingConfirmations.clear();

    for (const [, client] of this.clients) {
      client.ws.close(1000, "Server shutting down");
    }
    this.clients.clear();

    this.wss?.close();
    await new Promise<void>((res) => {
      if (this.server) {
        this.server.close(() => res());
      } else {
        res();
      }
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.sendToClient(chatId, {
      type: "text",
      text,
      messageId: randomUUID(),
    });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    this.sendToClient(chatId, {
      type: "markdown",
      text: markdown,
      messageId: randomUUID(),
    });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    this.sendToClient(chatId, { type: "typing", active: true });
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    this.sendToClient(chatId, {
      type: "text",
      text: `[Attachment: ${attachment.name}]`,
      messageId: randomUUID(),
    });
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const confirmId = randomUUID();

    this.sendToClient(req.chatId, {
      type: "confirmation",
      confirmId,
      question: req.question,
      options: req.options,
      details: req.details,
    });

    return new Promise<string>((done) => {
      const timer = setTimeout(
        () => {
          this.pendingConfirmations.delete(confirmId);
          done("timeout");
        },
        5 * 60 * 1000,
      );

      this.pendingConfirmations.set(confirmId, { resolve: done, timer });
    });
  }

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    const streamId = randomUUID();
    this.sendToClient(chatId, { type: "stream_start", streamId, text: "" });
    return streamId;
  }

  async updateStreamingMessage(
    chatId: string,
    streamId: string,
    accumulatedText: string,
  ): Promise<void> {
    this.sendToClient(chatId, { type: "stream_update", streamId, text: accumulatedText });
  }

  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string,
  ): Promise<void> {
    this.sendToClient(chatId, { type: "stream_end", streamId, text: finalText });
  }

  // ===========================================================================
  // HTTP Handler
  // ===========================================================================

  /** Security headers sent with every HTTP response. */
  private static readonly SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self'; " +
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; " +
      "img-src 'self' data: blob:; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none';",
  };

  private async handleHttp(req: HttpReq, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    // Health endpoint for Docker/K8s liveness probes
    if (url === "/health") {
      const body = JSON.stringify({
        status: this.healthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        channel: "web",
        uptime: process.uptime(),
        clients: this.clients.size,
      });
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Proxy /api/* requests to the dashboard server (same-origin solution)
    if (url.startsWith("/api/")) {
      await this.proxyToDashboard(req, res, url);
      return;
    }

    // Only allow GET for static files
    if (req.method !== "GET") {
      res.writeHead(405, WebChannel.SECURITY_HEADERS);
      res.end("Method Not Allowed");
      return;
    }

    const rawSegment = url.split("?")[0]!;

    // Try to serve the exact static file first
    if (rawSegment !== "/") {
      const candidate = resolve(join(STATIC_DIR, rawSegment));
      const safeRoot = resolve(STATIC_DIR);
      if (!candidate.startsWith(safeRoot + "/") && candidate !== safeRoot) {
        res.writeHead(403, WebChannel.SECURITY_HEADERS);
        res.end("Forbidden");
        return;
      }
      try {
        const data = await readFile(candidate);
        const ext = extname(candidate);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": contentType });
        res.end(data);
        return;
      } catch {
        // File not found — fall through to SPA fallback
      }
    }

    // SPA fallback: serve index.html for all non-file routes (client-side routing)
    try {
      const data = await readFile(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      res.writeHead(404, WebChannel.SECURITY_HEADERS);
      res.end("Not Found");
    }
  }

  // ===========================================================================
  // WebSocket Handler
  // ===========================================================================

  private handleWsConnection(ws: WebSocket): void {
    let chatId: string = randomUUID();
    let assignedId = false;

    const client: WsClient = { ws, chatId, msgCount: 0, windowStart: Date.now() };
    this.clients.set(chatId, client);

    // Send welcome with chatId
    this.sendJson(ws, { type: "connected", chatId });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;

        // Handle reconnect: reuse old chatId if recently disconnected
        if (!assignedId && data.type === "reconnect" && typeof data.chatId === "string") {
          const oldId = data.chatId;
          // Validate UUID format to prevent arbitrary string injection
          if (WebChannel.UUID_RE.test(oldId)) {
            const disconnectedAt = this.recentlyDisconnected.get(oldId);
            const withinTtl = disconnectedAt && (Date.now() - disconnectedAt) < WebChannel.RECONNECT_TTL_MS;
            const existing = this.clients.get(oldId);
            if (withinTtl && (!existing || existing.ws.readyState !== 1)) {
              // Remove stale entry and remap
              if (existing) this.clients.delete(oldId);
              this.recentlyDisconnected.delete(oldId);
              this.clients.delete(chatId);
              chatId = oldId;
              client.chatId = oldId;
              this.clients.set(chatId, client);
              this.sendJson(ws, { type: "connected", chatId });
            }
          }
          assignedId = true;
          return;
        }
        assignedId = true;

        this.handleWsMessage(chatId, data);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      const current = this.clients.get(chatId);
      if (current && current.ws === ws) {
        this.clients.delete(chatId);
        // Allow reconnect within TTL window
        this.recentlyDisconnected.set(chatId, Date.now());
      }
    });

    ws.on("error", () => {
      const current = this.clients.get(chatId);
      if (current && current.ws === ws) {
        this.clients.delete(chatId);
        this.recentlyDisconnected.set(chatId, Date.now());
      }
    });
  }

  private handleWsMessage(chatId: string, data: Record<string, unknown>): void {
    const client = this.clients.get(chatId);
    if (client) {
      const now = Date.now();
      if (now - client.windowStart > WS_RATE_WINDOW_MS) {
        client.msgCount = 0;
        client.windowStart = now;
      }
      client.msgCount++;
      if (client.msgCount > WS_RATE_LIMIT) {
        this.sendToClient(chatId, {
          type: "text",
          text: "Rate limit exceeded. Please slow down.",
          messageId: randomUUID(),
        });
        client.ws.close(1008, "Rate limit exceeded");
        this.clients.delete(chatId);
        return;
      }
    }

    switch (data.type) {
      case "message": {
        const text = String(data.text ?? "").trim();
        const rawAttachments = data.attachments as Array<{
          type?: string;
          name?: string;
          mimeType?: string;
          data?: string; // base64
          size?: number;
        }> | undefined;

        if (!text && (!rawAttachments || rawAttachments.length === 0)) return;
        if (!this.handler) return;

        // Convert base64 attachments to Attachment[] with validation
        const attachments: Attachment[] = [];
        if (rawAttachments && Array.isArray(rawAttachments)) {
          for (const raw of rawAttachments.slice(0, 5)) { // Max 5 attachments per message
            const mimeType = raw.mimeType || raw.type; // Frontend sends "type", normalize to mimeType
            if (!raw.name || !mimeType) continue;
            const buf = raw.data ? Buffer.from(raw.data, "base64") : undefined;
            const size = buf?.length ?? raw.size ?? 0;

            // Validate before accepting
            const attachType = mimeType.startsWith("image/") ? "image"
              : mimeType.startsWith("video/") ? "video"
              : mimeType.startsWith("audio/") ? "audio" : "file";
            const validation = validateMediaAttachment({ mimeType, size, type: attachType });
            if (!validation.valid) {
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: unsupported format or invalid content.`,
                messageId: randomUUID(),
              });
              continue;
            }
            if (buf && !validateMagicBytes(buf, mimeType)) {
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: unsupported format or invalid content.`,
                messageId: randomUUID(),
              });
              continue;
            }

            attachments.push({
              type: attachType as Attachment["type"],
              name: raw.name,
              mimeType,
              data: buf,
              size,
            });
          }
        }

        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          userId: `web-${chatId}`,
          text: text || "",
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: new Date(),
        };

        this.handler(msg).catch((err) => {
          this.sendToClient(chatId, {
            type: "text",
            text: classifyErrorMessage(err),
            messageId: randomUUID(),
          });
        });
        break;
      }

      case "confirmation_response": {
        const confirmId = String(data.confirmId ?? "");
        const option = String(data.option ?? "");
        const pending = this.pendingConfirmations.get(confirmId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingConfirmations.delete(confirmId);
          pending.resolve(option);
        }
        break;
      }

      case "provider_switch": {
        const provider = String(data.provider ?? "").trim();
        if (!provider || !this.handler) break;
        const model = typeof data.model === "string" ? data.model.trim() : "";
        const text = `/model ${provider}${model ? "/" + model : ""}`;
        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          userId: `web-${chatId}`,
          text,
          timestamp: new Date(),
        };
        this.handler(msg).catch(() => {
          this.sendToClient(chatId, {
            type: "text",
            text: "Failed to switch provider. Please try again.",
            messageId: randomUUID(),
          });
        });
        break;
      }

      case "autonomous_toggle": {
        const enabled = Boolean(data.enabled);
        if (!this.handler) break;
        const hours = typeof data.hours === "number" && data.hours > 0 ? data.hours : undefined;
        const text = `/autonomous ${enabled ? "on" : "off"}${hours ? " " + hours : ""}`;
        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          userId: `web-${chatId}`,
          text,
          timestamp: new Date(),
        };
        this.handler(msg).catch(() => {
          this.sendToClient(chatId, {
            type: "text",
            text: "Failed to toggle autonomous mode. Please try again.",
            messageId: randomUUID(),
          });
        });
        break;
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private sendToClient(chatId: string, data: Record<string, unknown>): void {
    const client = this.clients.get(chatId);
    if (!client || client.ws.readyState !== 1) return;
    this.sendJson(client.ws, data);
  }

  private sendJson(ws: WebSocket, data: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Connection may have closed
    }
  }

  /** Allowlisted dashboard API paths for proxy forwarding. */
  private static readonly ALLOWED_PROXY_PATHS = new Set([
    "/api/metrics",
    "/api/daemon",
    "/api/maintenance",
    "/api/chain-resilience",
    "/api/agents",
    "/api/delegations",
    "/api/consolidation",
    "/api/deployment",
    "/api/config",
    "/api/tools",
    "/api/channels",
    "/api/sessions",
    "/api/logs",
    "/api/identity",
    "/api/personality",
    "/api/personality/profiles",
    "/api/personality/switch",
    "/api/memory",
  ]);

  /** Paths that accept POST or DELETE in addition to GET. */
  private static readonly MUTABLE_PROXY_PATHS = new Set([
    "/api/personality/profiles",
    "/api/personality/switch",
    "/api/user/autonomous",
    "/api/providers/switch",
  ]);

  /**
   * Proxy /api/* requests to the dashboard server (same-origin solution).
   * GET is allowed for all allowlisted paths; POST/DELETE only for mutable paths.
   */
  private async proxyToDashboard(req: HttpReq, res: ServerResponse, url: string): Promise<void> {
    const method = req.method ?? "GET";

    // Allowlist check (strip query string for matching)
    const pathOnly = url.split("?")[0]!;
    const isAllowed =
      WebChannel.ALLOWED_PROXY_PATHS.has(pathOnly) ||
      pathOnly.startsWith("/api/goals") ||
      pathOnly.startsWith("/api/agent-metrics") ||
      pathOnly.startsWith("/api/triggers") ||
      pathOnly.startsWith("/api/personality/profiles/") ||
      pathOnly === "/api/providers/available" ||
      pathOnly === "/api/providers/active" ||
      pathOnly === "/api/user/autonomous";

    if (!isAllowed) {
      res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Method check: GET always allowed, POST/DELETE only for mutable paths
    const isMutable =
      WebChannel.MUTABLE_PROXY_PATHS.has(pathOnly) ||
      pathOnly.startsWith("/api/personality/profiles/");
    if (method !== "GET" && !(isMutable && (method === "POST" || method === "DELETE"))) {
      res.writeHead(405, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      // Defense-in-depth: validate constructed URL points to expected target
      const target = new URL(url, `http://127.0.0.1:${this.dashboardPort}`);
      if (target.hostname !== "127.0.0.1" || target.port !== String(this.dashboardPort)) {
        res.writeHead(400, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request" }));
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // Forward auth header if present (so dashboard token works through proxy)
      const proxyHeaders: Record<string, string> = { "Accept": "application/json" };
      const authHeader = req.headers["authorization"];
      if (authHeader) proxyHeaders["Authorization"] = Array.isArray(authHeader) ? authHeader[0]! : authHeader;

      const fetchOpts: RequestInit = {
        method,
        signal: controller.signal,
        headers: proxyHeaders,
      };
      if (method === "POST" || method === "DELETE") {
        fetchOpts.headers = { ...proxyHeaders, "Content-Type": "application/json" };
        const bodyChunks: Buffer[] = [];
        let bodySize = 0;
        const PROXY_BODY_LIMIT = 64 * 1024; // 64KB
        let bodyReadAborted = false;
        await new Promise<void>((resolve, reject) => {
          req.on("data", (chunk: Buffer) => {
            bodySize += chunk.length;
            if (bodySize > PROXY_BODY_LIMIT) {
              req.destroy();
              reject(new Error("Body too large"));
              return;
            }
            bodyChunks.push(chunk);
          });
          req.on("end", () => resolve());
          req.on("error", reject);
        }).catch(() => {
          bodyReadAborted = true;
          clearTimeout(timeout);
          res.writeHead(413, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
        if (bodyReadAborted) return;
        if (bodyChunks.length > 0) {
          fetchOpts.body = Buffer.concat(bodyChunks).toString();
        }
      }

      const response = await fetch(target.href, fetchOpts);
      clearTimeout(timeout);

      const body = await response.text();
      res.writeHead(response.status, {
        ...WebChannel.SECURITY_HEADERS,
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(body);
    } catch {
      res.writeHead(503, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dashboard API unavailable", hint: "Set DASHBOARD_ENABLED=true" }));
    }
  }
}
