/**
 * WebSocket Dashboard Server
 * 
 * Features: Real-time bidirectional communication, authentication, command handling,
 * automatic metrics push, heartbeat, embedded HTML dashboard.
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { getLogger } from "../utils/logger.js";
import { BruteForceProtection } from "../security/auth-hardened.js";
import { isAllowedOrigin } from "../security/origin-validation.js";
import type { MetricsCollector } from "./metrics.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WSMessageType =
  | "auth" | "auth_success" | "auth_error" | "metrics" | "command" | "command_result"
  | "error" | "ping" | "pong" | "notification" | "vault:update";

export interface WSMessage {
  type: WSMessageType;
  id?: string;
  payload?: unknown;
  timestamp?: number;
}

export interface WSClient extends WebSocket {
  isAuthenticated: boolean;
  canExecuteCommands: boolean;
  clientId: string;
  lastPing: number;
  remoteIp: string;
  /** Sliding window message timestamps for rate limiting */
  msgTimestamps: number[];
}

export type CommandHandler = (command: string, payload: unknown) => Promise<unknown> | unknown;

export interface WebSocketDashboardServerOptions {
  port: number;
  authToken?: string;
  metrics: MetricsCollector;
  getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;
  getPluginsStats?: () => { loaded: number; directories: string[] } | undefined;
  allowedOrigins?: string[];
  maxAuthAttempts?: number;
  authLockoutMs?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const METRICS_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const WS_RATE_LIMIT_WINDOW_MS = 60_000;
const WS_RATE_LIMIT_MAX_MESSAGES = 120;
const DEFAULT_MAX_AUTH_ATTEMPTS = 5;
const DEFAULT_AUTH_LOCKOUT_MS = 5 * 60 * 1_000;

// ─── WebSocketDashboardServer Class ──────────────────────────────────────────

export class WebSocketDashboardServer {
  private readonly port: number;
  private readonly authToken: string;
  private readonly commandAuthEnabled: boolean;
  private readonly metrics: MetricsCollector;
  private readonly getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;
  private readonly getPluginsStats: (() => { loaded: number; directories: string[] } | undefined) | undefined;
  private readonly allowedOrigins: string[] | undefined;
  private readonly bruteForce: BruteForceProtection;

  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private clients = new Map<string, WSClient>();
  private commandHandlers = new Map<string, CommandHandler>();
  private metricsInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly logger = getLogger();
  private getBudgetSnapshot?: () => unknown;

  constructor(opts: WebSocketDashboardServerOptions) {
    const configuredAuthToken = opts.authToken?.trim() || undefined;
    this.port = opts.port;
    this.authToken = configuredAuthToken ?? randomBytes(32).toString("hex");
    this.commandAuthEnabled = configuredAuthToken !== undefined;
    this.metrics = opts.metrics;
    this.getMemoryStats = opts.getMemoryStats;
    this.getPluginsStats = opts.getPluginsStats;
    this.allowedOrigins = opts.allowedOrigins;
    this.bruteForce = new BruteForceProtection(
      opts.maxAuthAttempts ?? DEFAULT_MAX_AUTH_ATTEMPTS,
      opts.authLockoutMs ?? DEFAULT_AUTH_LOCKOUT_MS,
    );
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.httpServer || this.wsServer) return;

    this.httpServer = createServer(this.handleHttpRequest.bind(this));
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      path: "/ws",
      maxPayload: 1 * 1024 * 1024,
      verifyClient: ({ req }: { req: import("http").IncomingMessage }) => isAllowedOrigin(req.headers.origin, this.allowedOrigins),
    });
    this.wsServer.on("connection", this.handleWsConnection.bind(this));

    return new Promise((resolve, reject) => {
      const httpServer = this.httpServer!;

      const onError = (error: NodeJS.ErrnoException): void => {
        httpServer.off("listening", onListening);
        this.wsServer?.close();
        this.wsServer = null;
        this.httpServer = null;
        reject(error);
      };

      const onListening = (): void => {
        httpServer.off("error", onError);
        this.logger.info(`WebSocket Dashboard running at http://localhost:${this.port}`);
        this.logger.info(`WebSocket endpoint: ws://localhost:${this.port}/ws`);
        if (!this.commandAuthEnabled) {
          this.logger.info("WebSocket dashboard command mode disabled because DASHBOARD_AUTH_TOKEN is not configured");
        }
        this.startMetricsPush();
        this.startHeartbeat();
        resolve();
      };

      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      try {
        httpServer.listen(this.port, "127.0.0.1");
      } catch (error) {
        onError(error as NodeJS.ErrnoException);
      }
    });
  }

  async stop(): Promise<void> {
    this.clearIntervals();
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;

    this.clients.forEach(client => client.terminate());
    this.clients.clear();
    this.wsServer = null;
    this.httpServer = null;

    const closeWs = wsServer
      ? new Promise<void>((resolve) => wsServer.close(() => resolve()))
      : Promise.resolve();

    const closeHttp = httpServer
      ? new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
      })
      : Promise.resolve();

    await Promise.all([closeWs, closeHttp]);
  }

  // ─── Command Handlers ────────────────────────────────────────────────────────

  registerCommandHandler(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
    this.logger.debug(`Registered command handler: ${command}`);
  }

  unregisterCommandHandler(command: string): void {
    this.commandHandlers.delete(command);
  }

  setGetBudgetSnapshot(fn: () => unknown): void {
    this.getBudgetSnapshot = fn;
  }

  // ─── Broadcasting ────────────────────────────────────────────────────────────

  broadcast(message: Omit<WSMessage, "timestamp">): void {
    const data = JSON.stringify({ ...message, timestamp: Date.now() });
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
  }

  broadcastAuthenticated(message: Omit<WSMessage, "timestamp">): void {
    const data = JSON.stringify({ ...message, timestamp: Date.now() });
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.isAuthenticated) client.send(data);
    });
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  getClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter(c => c.isAuthenticated).length;
  }

  // ─── HTTP Request Handler ────────────────────────────────────────────────────

  private handleHttpRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", websocket: true, clients: this.clients.size }));
      return;
    }

    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(this.renderDashboardHtml());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  // ─── WebSocket Connection Handler ────────────────────────────────────────────

  private handleWsConnection(ws: WebSocket, req: import("http").IncomingMessage): void {
    const clientId = this.generateClientId();
    const client = ws as WSClient;
    client.isAuthenticated = !this.commandAuthEnabled;
    client.canExecuteCommands = false;
    client.clientId = clientId;
    client.lastPing = Date.now();
    client.remoteIp = req.socket.remoteAddress ?? "unknown";
    client.msgTimestamps = [];

    this.clients.set(clientId, client);
    this.logger.info("WebSocket client connected", { clientId, ip: client.remoteIp });

    this.send(client, {
      type: "auth",
      payload: {
        requiresAuth: this.commandAuthEnabled,
        commandMode: this.commandAuthEnabled,
        readOnly: !this.commandAuthEnabled,
        message: this.commandAuthEnabled ? "Please authenticate" : "Read-only dashboard",
      }
    });

    client.on("message", (data: Buffer) => {
      // Per-client rate limiting (sliding window)
      const now = Date.now();
      client.msgTimestamps = client.msgTimestamps.filter((t) => now - t < WS_RATE_LIMIT_WINDOW_MS);
      if (client.msgTimestamps.length >= WS_RATE_LIMIT_MAX_MESSAGES) {
        this.sendError(client, "Rate limit exceeded. Try again later.");
        return;
      }
      client.msgTimestamps.push(now);

      try {
        this.handleMessage(client, JSON.parse(data.toString()) as WSMessage);
      } catch {
        this.sendError(client, "Invalid JSON message");
      }
    });

    client.on("close", () => {
      this.clients.delete(clientId);
      this.logger.info("WebSocket client disconnected", { clientId });
    });

    client.on("error", (err) => {
      this.logger.error("WebSocket client error", { clientId, error: err.message });
      this.clients.delete(clientId);
    });
  }

  // ─── Message Handlers ────────────────────────────────────────────────────────

  private handleMessage(client: WSClient, message: WSMessage): void {
    switch (message.type) {
      case "auth":
        this.handleAuth(client, message.payload as { token?: string });
        break;
      case "ping":
        this.send(client, { type: "pong", payload: {} });
        break;
      case "pong":
        client.lastPing = Date.now();
        break;
      case "command":
        if (!client.isAuthenticated || !client.canExecuteCommands) {
          this.sendError(client, this.commandAuthEnabled
            ? "Not authenticated"
            : "Dashboard command mode requires DASHBOARD_AUTH_TOKEN");
          return;
        }
        void this.handleCommand(client, message);
        break;
      default:
        this.sendError(client, `Unknown message type: ${message.type}`);
    }
  }

  private handleAuth(client: WSClient, payload: { token?: string }): void {
    if (!this.commandAuthEnabled) {
      client.isAuthenticated = true;
      client.canExecuteCommands = false;
      this.send(client, {
        type: "auth_success",
        payload: { message: "Read-only dashboard", readOnly: true },
      });
      return;
    }

    // Check brute-force protection
    const check = this.bruteForce.canAttempt(client.remoteIp);
    if (!check.allowed) {
      this.send(client, {
        type: "auth_error",
        payload: { message: "Too many failed attempts. Try again later.", retryAfter: check.retryAfter },
      });
      return;
    }

    // Constant-time comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(payload?.token ?? "");
    const authBuffer = Buffer.from(this.authToken);
    const tokenMatch = tokenBuffer.length === authBuffer.length &&
      timingSafeEqual(tokenBuffer, authBuffer);
    if (tokenMatch) {
      client.isAuthenticated = true;
      client.canExecuteCommands = true;
      this.bruteForce.recordSuccess(client.remoteIp);
      this.send(client, { type: "auth_success", payload: { message: "Authenticated successfully" } });
      this.logger.info("Client authenticated", { clientId: client.clientId });
    } else {
      this.bruteForce.recordFailure(client.remoteIp);
      const attempts = this.bruteForce.getAttemptCount(client.remoteIp);
      this.send(client, { type: "auth_error", payload: { message: "Invalid token" } });
      this.logger.warn("Authentication failed", { clientId: client.clientId, attempts });
    }
  }

  private async handleCommand(client: WSClient, message: WSMessage): Promise<void> {
    const { id, payload } = message;

    if (!client.canExecuteCommands) {
      this.sendError(client, this.commandAuthEnabled
        ? "Not authenticated"
        : "Dashboard command mode requires DASHBOARD_AUTH_TOKEN", id);
      return;
    }

    if (!payload || typeof payload !== "object") {
      this.sendError(client, "Command payload must be an object", id);
      return;
    }

    const { command, data } = payload as { command: string; data?: unknown };

    if (!command) {
      this.sendError(client, "Command name required", id);
      return;
    }

    const handler = this.commandHandlers.get(command);
    if (!handler) {
      this.sendError(client, `Unknown command: ${command}`, id);
      return;
    }

    try {
      this.logger.debug("Executing command", { clientId: client.clientId, command });
      const result = await handler(command, data);
      this.send(client, { type: "command_result", id, payload: { command, success: true, result } });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error("Command execution failed", { clientId: client.clientId, command, error: errorMessage });
      this.send(client, { type: "command_result", id, payload: { command, success: false, error: errorMessage } });
    }
  }

  // ─── Utility Methods ─────────────────────────────────────────────────────────

  private send(client: WSClient, message: Omit<WSMessage, "timestamp">): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ ...message, timestamp: Date.now() }));
    }
  }

  private sendError(client: WSClient, error: string, id?: string): void {
    this.send(client, { type: "error", id, payload: { error } });
  }

  private renderDashboardHtml(): string {
    const bootstrapAuthToken = null;
    const commands = this.commandAuthEnabled ? [...this.commandHandlers.keys()].sort() : [];
    return WEBSOCKET_DASHBOARD_HTML
      .replace("__BOOTSTRAP_AUTH_TOKEN__", JSON.stringify(bootstrapAuthToken))
      .replace("__BOOTSTRAP_COMMANDS__", JSON.stringify(commands));
  }

  private startMetricsPush(): void {
    this.metricsInterval = setInterval(() => {
      if (this.getAuthenticatedClientCount() === 0) return;
      this.broadcastAuthenticated({
        type: "metrics",
        payload: {
          ...this.metrics.getSnapshot(this.getMemoryStats?.()),
          plugins: this.getPluginsStats?.(),
          connectedClients: this.clients.size,
          authenticatedClients: this.getAuthenticatedClientCount(),
          budget: this.getBudgetSnapshot?.() ?? null,
        }
      });
    }, METRICS_INTERVAL_MS);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [clientId, client] of this.clients) {
        if (now - client.lastPing > HEARTBEAT_TIMEOUT_MS) {
          this.logger.warn("Client heartbeat timeout", { clientId });
          client.close();
          this.clients.delete(clientId);
        } else {
          this.send(client, { type: "ping" });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearIntervals(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private generateClientId(): string {
    return `client_${randomUUID()}`;
  }
}

// ─── Embedded Dashboard HTML ─────────────────────────────────────────────────

// Extracted from an inline literal into templates/ (lintable, diffable, copied
// to dist by build-package's broad non-.ts asset rule). Static page — no
// server-side interpolation.
const WEBSOCKET_DASHBOARD_HTML = readFileSync(
  new URL("./templates/ws-dashboard.html", import.meta.url),
  "utf-8",
);

