import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketDashboardServer } from "./websocket-server.js";
import { MetricsCollector } from "./metrics.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createServer(authToken?: string): WebSocketDashboardServer {
  return new WebSocketDashboardServer({
    port: 0,
    authToken,
    metrics: new MetricsCollector(),
    getMemoryStats: () => undefined,
  });
}

function extractBootstrapToken(html: string): string | null {
  const match = html.match(/const BOOTSTRAP_AUTH_TOKEN = ("[^"]+"|null);/);
  if (!match) {
    throw new Error("Missing BOOTSTRAP_AUTH_TOKEN bootstrap script");
  }
  return JSON.parse(match[1]!) as string | null;
}

function extractBootstrapCommands(html: string): string[] {
  const match = html.match(/const BOOTSTRAP_COMMANDS = (\[[^\n]*\]);/);
  if (!match) {
    throw new Error("Missing BOOTSTRAP_COMMANDS bootstrap script");
  }
  return JSON.parse(match[1]!) as string[];
}

function createClient(remoteIp = "127.0.0.1"): {
  isAuthenticated: boolean;
  canExecuteCommands: boolean;
  clientId: string;
  lastPing: number;
  remoteIp: string;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    isAuthenticated: false,
    canExecuteCommands: false,
    clientId: "client-1",
    lastPing: Date.now(),
    remoteIp,
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  };
}

describe("WebSocketDashboardServer auth bootstrap", () => {
  it("does not embed a generated bootstrap token when command auth is not configured", () => {
    const server = createServer();
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapToken(html)).toBeNull();
  });

  it("does not embed configured auth tokens into the dashboard HTML", () => {
    const server = createServer("secret-token");
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapToken(html)).toBeNull();
    expect(html).not.toContain("secret-token");
  });

  it("does not expose command handlers unless an explicit auth token is configured", () => {
    const server = createServer();
    server.registerCommandHandler("reload_plugin", vi.fn());
    server.registerCommandHandler("clear_cache", vi.fn());

    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapCommands(html)).toEqual([]);
  });

  it("treats empty auth tokens as unconfigured read-only mode", () => {
    const server = createServer("   ");
    server.registerCommandHandler("clear_cache", vi.fn());
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();
    const client = createClient();

    (server as unknown as {
      handleAuth(clientArg: typeof client, payload: { token?: string }): void;
    }).handleAuth(client, { token: "" });

    expect(extractBootstrapCommands(html)).toEqual([]);
    expect(client.isAuthenticated).toBe(true);
    expect(client.canExecuteCommands).toBe(false);
  });

  it("embeds registered command handlers when an explicit auth token is configured", () => {
    const server = createServer("secret-token");
    server.registerCommandHandler("reload_plugin", vi.fn());
    server.registerCommandHandler("clear_cache", vi.fn());

    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapCommands(html)).toEqual(["clear_cache", "reload_plugin"]);
  });

  it("authenticates command mode only with the configured token", () => {
    const server = createServer("secret-token");
    const client = createClient();

    (server as unknown as {
      handleAuth(clientArg: typeof client, payload: { token?: string }): void;
    }).handleAuth(client, { token: "secret-token" });

    expect(client.isAuthenticated).toBe(true);
    expect(client.canExecuteCommands).toBe(true);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining("\"auth_success\""));
  });

  it("rejects invalid tokens when command mode is configured", () => {
    const server = createServer("secret-token");
    const client = createClient();

    (server as unknown as {
      handleAuth(clientArg: typeof client, payload: { token?: string }): void;
    }).handleAuth(client, { token: "wrong-token" });

    expect(client.isAuthenticated).toBe(false);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining("\"auth_error\""));
  });

  it("keeps command execution read-only when no explicit token is configured", async () => {
    const server = createServer();
    server.registerCommandHandler("clear_cache", vi.fn());
    const client = createClient();
    client.isAuthenticated = true;

    await (server as unknown as {
      handleCommand(clientArg: typeof client, message: { type: string; id: string; payload: { command: string } }): Promise<void>;
    }).handleCommand(client, {
      type: "command",
      id: "cmd-1",
      payload: { command: "clear_cache" },
    });

    expect(client.send).toHaveBeenCalledWith(expect.stringContaining("DASHBOARD_AUTH_TOKEN"));
  });

  it("broadcastAuthenticated excludes unauthenticated clients", () => {
    const server = createServer("secret-token");
    const unauthenticated = createClient();
    const authenticated = createClient();
    authenticated.isAuthenticated = true;
    const clients = new Map([
      ["unauthenticated", unauthenticated],
      ["authenticated", authenticated],
    ]);

    (server as unknown as { clients: typeof clients }).clients = clients;
    server.broadcastAuthenticated({ type: "vault:update", payload: { vaultId: "v1" } });

    expect(unauthenticated.send).not.toHaveBeenCalled();
    expect(authenticated.send).toHaveBeenCalledWith(expect.stringContaining("\"vault:update\""));
  });
});
