/**
 * WebSocket Dashboard Server
 * 
 * Features: Real-time bidirectional communication, authentication, command handling,
 * automatic metrics push, heartbeat, embedded HTML dashboard.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getLogger } from "../utils/logger.js";
import type { MetricsCollector } from "./metrics.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WSMessageType = 
  | "auth" | "auth_success" | "auth_error" | "metrics" | "command" | "command_result"
  | "error" | "ping" | "pong" | "notification";

export interface WSMessage {
  type: WSMessageType;
  id?: string;
  payload?: unknown;
  timestamp?: number;
}

export interface WSClient extends WebSocket {
  isAuthenticated: boolean;
  clientId: string;
  lastPing: number;
}

export type CommandHandler = (command: string, payload: unknown) => Promise<unknown> | unknown;

// ─── Constants ───────────────────────────────────────────────────────────────

const METRICS_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60000;

// ─── WebSocketDashboardServer Class ──────────────────────────────────────────

export class WebSocketDashboardServer {
  private readonly port: number;
  private readonly authToken: string | undefined;
  private readonly metrics: MetricsCollector;
  private readonly getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;
  private readonly getPluginsStats: (() => { loaded: number; directories: string[] } | undefined) | undefined;
  
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private clients = new Map<string, WSClient>();
  private commandHandlers = new Map<string, CommandHandler>();
  private metricsInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly logger = getLogger();

  constructor(
    port: number,
    authToken: string | undefined,
    metrics: MetricsCollector,
    getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined,
    getPluginsStats?: () => { loaded: number; directories: string[] } | undefined,
    _getLogs?: () => string[] | undefined
  ) {
    this.port = port;
    this.authToken = authToken;
    this.metrics = metrics;
    this.getMemoryStats = getMemoryStats;
    this.getPluginsStats = getPluginsStats;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.httpServer = createServer(this.handleHttpRequest.bind(this));
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wsServer.on("connection", this.handleWsConnection.bind(this));

    return new Promise((resolve) => {
      this.httpServer!.listen(this.port, "127.0.0.1", () => {
        this.logger.info(`WebSocket Dashboard running at http://localhost:${this.port}`);
        this.logger.info(`WebSocket endpoint: ws://localhost:${this.port}/ws`);
        this.startMetricsPush();
        this.startHeartbeat();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.clearIntervals();
    this.clients.forEach(client => client.close());
    this.clients.clear();
    this.wsServer?.close();
    this.wsServer = null;

    if (this.httpServer) {
      return new Promise((resolve) => this.httpServer!.close(() => resolve()));
    }
  }

  // ─── Command Handlers ────────────────────────────────────────────────────────

  registerCommandHandler(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
    this.logger.debug(`Registered command handler: ${command}`);
  }

  unregisterCommandHandler(command: string): void {
    this.commandHandlers.delete(command);
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
      res.end(WEBSOCKET_DASHBOARD_HTML);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  // ─── WebSocket Connection Handler ────────────────────────────────────────────

  private handleWsConnection(ws: WebSocket, req: import("http").IncomingMessage): void {
    const clientId = this.generateClientId();
    const client = ws as WSClient;
    client.isAuthenticated = !this.authToken;
    client.clientId = clientId;
    client.lastPing = Date.now();
    
    this.clients.set(clientId, client);
    this.logger.info("WebSocket client connected", { clientId, ip: req.socket.remoteAddress });

    this.send(client, {
      type: "auth",
      payload: { 
        requiresAuth: !!this.authToken,
        message: this.authToken ? "Please authenticate" : "Authentication not required"
      }
    });

    client.on("message", (data: Buffer) => {
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
        if (!client.isAuthenticated) {
          this.sendError(client, "Not authenticated");
          return;
        }
        void this.handleCommand(client, message);
        break;
      default:
        this.sendError(client, `Unknown message type: ${message.type}`);
    }
  }

  private handleAuth(client: WSClient, payload: { token?: string }): void {
    if (!this.authToken) {
      client.isAuthenticated = true;
      this.send(client, { type: "auth_success", payload: { message: "Authentication not required" } });
      return;
    }

    if (payload?.token === this.authToken) {
      client.isAuthenticated = true;
      this.send(client, { type: "auth_success", payload: { message: "Authenticated successfully" } });
      this.logger.info("Client authenticated", { clientId: client.clientId });
    } else {
      this.send(client, { type: "auth_error", payload: { message: "Invalid token" } });
      this.logger.warn("Authentication failed", { clientId: client.clientId });
    }
  }

  private async handleCommand(client: WSClient, message: WSMessage): Promise<void> {
    const { id, payload } = message;
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

  private startMetricsPush(): void {
    this.metricsInterval = setInterval(() => {
      this.broadcastAuthenticated({
        type: "metrics",
        payload: {
          ...this.metrics.getSnapshot(this.getMemoryStats?.()),
          plugins: this.getPluginsStats?.(),
          connectedClients: this.clients.size,
          authenticatedClients: this.getAuthenticatedClientCount()
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
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

// ─── Embedded Dashboard HTML ─────────────────────────────────────────────────

const WEBSOCKET_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strata Brain WebSocket Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 20px; font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
  .status-indicator { width: 10px; height: 10px; border-radius: 50%; background: #da3633; transition: background 0.3s; }
  .status-indicator.connected { background: #3fb950; }
  .status-indicator.connecting { background: #d29922; animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; transition: transform 0.2s; }
  .card:hover { transform: translateY(-2px); border-color: #58a6ff; }
  .card .label { color: #8b949e; font-size: 0.85rem; margin-bottom: 4px; }
  .card .value { font-size: 1.8rem; font-weight: 700; color: #58a6ff; }
  .card .sub { color: #8b949e; font-size: 0.75rem; margin-top: 4px; }
  .section { margin-bottom: 24px; }
  .section h2 { color: #c9d1d9; font-size: 1.1rem; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; }
  .bar-container { background: #21262d; border-radius: 4px; height: 20px; overflow: hidden; }
  .bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .bar-input { background: #3fb950; }
  .controls { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .btn { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; margin-right: 8px; transition: background 0.2s; }
  .btn:hover { background: #2ea043; }
  .btn.secondary { background: #1f6feb; }
  .btn:disabled { background: #30363d; cursor: not-allowed; }
  .auth-form { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 24px; max-width: 400px; }
  .auth-form input { width: 100%; padding: 10px; margin-bottom: 12px; background: #0f1117; border: 1px solid #30363d; border-radius: 6px; color: #e1e4e8; }
  #last-update { color: #484f58; font-size: 0.75rem; margin-top: 10px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<h1><span id="ws-status" class="status-indicator"></span> Strata Brain WebSocket Dashboard</h1>

<div id="auth-section" class="auth-form hidden">
  <h3>Authentication Required</h3>
  <input type="password" id="auth-token" placeholder="Enter auth token...">
  <button class="btn" onclick="authenticate()">Authenticate</button>
  <p id="auth-error" style="color: #f85149; margin-top: 8px;"></p>
</div>

<div id="dashboard-content" class="hidden">
  <div class="controls">
    <h3>Quick Actions</h3>
    <button class="btn" onclick="sendCommand('reload_plugin')" id="btn-reload">Reload Plugins</button>
    <button class="btn secondary" onclick="sendCommand('clear_cache')">Clear Cache</button>
    <button class="btn secondary" onclick="sendCommand('get_logs')">Get Logs</button>
  </div>
  <div class="grid" id="cards"></div>
  <div class="section">
    <h2>Tool Usage</h2>
    <table id="tool-table">
      <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Distribution</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<p id="last-update">Connecting...</p>

<script>
const WS_URL = 'ws://' + window.location.host + '/ws';
let ws = null, reconnectAttempts = 0, isAuthenticated = false, requiresAuth = false;
const els = {
  status: document.getElementById('ws-status'),
  authSection: document.getElementById('auth-section'),
  authToken: document.getElementById('auth-token'),
  authError: document.getElementById('auth-error'),
  dashboard: document.getElementById('dashboard-content'),
  cards: document.getElementById('cards'),
  toolTable: document.querySelector('#tool-table tbody'),
  lastUpdate: document.getElementById('last-update'),
  btnReload: document.getElementById('btn-reload')
};

function connect() {
  els.status.className = 'status-indicator connecting';
  els.lastUpdate.textContent = 'Connecting...';
  ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    els.status.className = 'status-indicator connected';
    els.lastUpdate.textContent = 'Connected';
    reconnectAttempts = 0;
  };
  
  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); } catch (e) { console.error('Invalid message:', e); }
  };
  
  ws.onclose = () => {
    els.status.className = 'status-indicator';
    els.lastUpdate.textContent = 'Disconnected';
    els.dashboard.classList.add('hidden');
    isAuthenticated = false;
    if (reconnectAttempts < 5) {
      reconnectAttempts++;
      setTimeout(connect, 1000 * reconnectAttempts);
    }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'auth':
      requiresAuth = msg.payload?.requiresAuth;
      if (requiresAuth && !isAuthenticated) {
        els.authSection.classList.remove('hidden');
        els.dashboard.classList.add('hidden');
      } else {
        els.authSection.classList.add('hidden');
        els.dashboard.classList.remove('hidden');
      }
      break;
    case 'auth_success':
      isAuthenticated = true;
      els.authSection.classList.add('hidden');
      els.dashboard.classList.remove('hidden');
      els.authError.textContent = '';
      break;
    case 'auth_error':
      els.authError.textContent = msg.payload?.message || 'Authentication failed';
      break;
    case 'metrics':
      updateDashboard(msg.payload);
      break;
    case 'command_result':
      if (msg.payload?.command === 'reload_plugin') {
        els.lastUpdate.textContent = msg.payload?.success ? 'Plugins reloaded' : 'Reload failed';
      }
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

function authenticate() {
  const token = els.authToken.value.trim();
  if (!token) return;
  ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
}

function sendCommand(command, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'command', payload: { command, data } }));
  if (command === 'reload_plugin') {
    els.btnReload.disabled = true;
    setTimeout(() => els.btnReload.disabled = false, 3000);
  }
}

function updateDashboard(data) {
  els.cards.innerHTML = [
    card('Uptime', fmtDuration(data.uptime)),
    card('Messages', fmt(data.totalMessages)),
    card('Input Tokens', fmt(data.totalTokens?.input || 0)),
    card('Output Tokens', fmt(data.totalTokens?.output || 0)),
    card('Active Sessions', data.activeSessions),
    card('Connected Clients', data.connectedClients || 0),
  ].join('');
  
  const tools = Object.entries(data.toolCallCounts || {}).sort((a, b) => b[1] - a[1]);
  const maxCalls = Math.max(...tools.map(t => t[1]), 1);
  els.toolTable.innerHTML = tools.map(([name, calls]) => {
    const errors = (data.toolErrorCounts || {})[name] || 0;
    const pct = (calls / maxCalls * 100).toFixed(0);
    return \`<tr><td>\${esc(name)}</td><td>\${calls}</td><td>\${errors}</td>
      <td><div class="bar-container"><div class="bar bar-input" style="width:\${pct}%"></div></div></td></tr>\`;
  }).join('');
  
  els.lastUpdate.textContent = 'Last update: ' + new Date().toLocaleTimeString();
}

function card(label, value, sub) {
  return \`<div class="card"><div class="label">\${esc(label)}</div><div class="value">\${esc(value)}</div>
    \${sub ? \`<div class="sub">\${esc(sub)}</div>\` : ''}</div>\`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

els.authToken.addEventListener('keypress', (e) => { if (e.key === 'Enter') authenticate(); });
connect();
</script>
</body>
</html>`;
