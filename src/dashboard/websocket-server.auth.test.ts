import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketDashboardServer } from "./websocket-server.js";
import { MetricsCollector } from "./metrics.js";

vi.mock("../utils/logger.js", () => ({
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
  clientId: string;
  lastPing: number;
  remoteIp: string;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    isAuthenticated: false,
    clientId: "client-1",
    lastPing: Date.now(),
    remoteIp,
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  };
}

describe("WebSocketDashboardServer auth bootstrap", () => {
  it("embeds a generated bootstrap token when no static token is configured", () => {
    const server = createServer();
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    const bootstrapToken = extractBootstrapToken(html);

    expect(typeof bootstrapToken).toBe("string");
    expect(bootstrapToken).toHaveLength(64);
  });

  it("does not embed configured auth tokens into the dashboard HTML", () => {
    const server = createServer("secret-token");
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapToken(html)).toBeNull();
    expect(html).not.toContain("secret-token");
  });

  it("embeds registered command handlers into the dashboard HTML", () => {
    const server = createServer();
    server.registerCommandHandler("reload_plugin", vi.fn());
    server.registerCommandHandler("clear_cache", vi.fn());

    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();

    expect(extractBootstrapCommands(html)).toEqual(["clear_cache", "reload_plugin"]);
  });

  it("authenticates a client with the generated bootstrap token", () => {
    const server = createServer();
    const html = (server as unknown as {
      renderDashboardHtml(): string;
    }).renderDashboardHtml();
    const bootstrapToken = extractBootstrapToken(html);
    const client = createClient();

    expect(bootstrapToken).not.toBeNull();

    (server as unknown as {
      handleAuth(clientArg: typeof client, payload: { token?: string }): void;
    }).handleAuth(client, { token: bootstrapToken! });

    expect(client.isAuthenticated).toBe(true);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining("\"auth_success\""));
  });

  it("rejects invalid tokens even when using a generated bootstrap token", () => {
    const server = createServer();
    const client = createClient();

    (server as unknown as {
      handleAuth(clientArg: typeof client, payload: { token?: string }): void;
    }).handleAuth(client, { token: "wrong-token" });

    expect(client.isAuthenticated).toBe(false);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining("\"auth_error\""));
  });
});
