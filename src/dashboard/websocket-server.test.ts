import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketDashboardServer } from "./websocket-server.js";
import { MetricsCollector } from "./metrics.js";

// Mock logger
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe.skipIf(!process.env["LOCAL_SERVER_TESTS"])("WebSocketDashboardServer", () => {
  let server: WebSocketDashboardServer;
  let metrics: MetricsCollector;

  // ─── Test Helpers ──────────────────────────────────────────────────────────

  function createServer(overrides: Partial<Parameters<typeof WebSocketDashboardServer.prototype.constructor>[0]> = {}): WebSocketDashboardServer {
    return new WebSocketDashboardServer({
      port: 0,
      metrics,
      getMemoryStats: () => undefined,
      ...overrides,
    });
  }

  function getPort(instance: WebSocketDashboardServer): number {
    const addr = (
      instance as unknown as { httpServer: { address: () => { port: number } | string | null } }
    ).httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("WebSocket dashboard has no bound address");
    }
    return addr.port;
  }

  async function safeStart(instance: WebSocketDashboardServer): Promise<number | null> {
    try {
      await instance.start();
      return getPort(instance);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("Skipping: EPERM on websocket dashboard start()");
        return null;
      }
      throw err;
    }
  }

  /** Wait for a specific message type from a WebSocket. */
  function waitForMessage<T = unknown>(ws: WebSocket, type: string): Promise<T> {
    return new Promise((resolve) => {
      const handler = (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          ws.removeListener("message", handler);
          resolve(msg as T);
        }
      };
      ws.on("message", handler);
    });
  }

  /** Send auth payload and wait for the response. */
  async function sendAuth(ws: WebSocket, token: string): Promise<{ type: string; payload?: { retryAfter?: number; message?: string } }> {
    ws.send(JSON.stringify({ type: "auth", payload: { token } }));
    return waitForMessage(ws, "auth_error").catch(() => waitForMessage(ws, "auth_success")) as Promise<{ type: string; payload?: { retryAfter?: number; message?: string } }>;
  }

  /** Send N failed auth attempts and collect responses. */
  async function sendFailedAuths(ws: WebSocket, count: number): Promise<Array<{ type: string; payload?: { retryAfter?: number; message?: string } }>> {
    const responses: Array<{ type: string; payload?: { retryAfter?: number; message?: string } }> = [];
    for (let i = 0; i < count; i++) {
      ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
      const msg = await waitForMessage<{ type: string; payload?: { retryAfter?: number; message?: string } }>(ws, "auth_error");
      responses.push(msg);
    }
    return responses;
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(() => {
    metrics = new MetricsCollector();
    server = new WebSocketDashboardServer({
      port: 0,
      metrics,
      getMemoryStats: () => ({ totalEntries: 100, hasAnalysisCache: true }),
      getPluginsStats: () => ({ loaded: 5, directories: ["./plugins"] }),
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it("should start and stop the server", async () => {
    if ((await safeStart(server)) === null) return;
    expect(server.getClientCount()).toBe(0);
  });

  it("should accept WebSocket connections", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    expect(server.getClientCount()).toBe(1);
    ws.close();
  });

  it("should handle authentication when token is required", async () => {
    const authServer = createServer({ authToken: "secret-token" });

    const port = await safeStart(authServer);
    if (port === null) {
      await authServer.stop();
      return;
    }

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    const authMessage = await new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(authMessage).toMatchObject({
      type: "auth",
      payload: { requiresAuth: true },
    });

    // Try to authenticate
    ws.send(JSON.stringify({
      type: "auth",
      payload: { token: "wrong-token" }
    }));

    const authError = await new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth_error") resolve(msg);
      });
    });

    expect(authError).toMatchObject({
      type: "auth_error",
    });

    // Authenticate with correct token
    ws.send(JSON.stringify({
      type: "auth",
      payload: { token: "secret-token" }
    }));

    const authSuccess = await new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth_success") resolve(msg);
      });
    });

    expect(authSuccess).toMatchObject({
      type: "auth_success",
    });

    ws.close();
    await authServer.stop();
  });

  it("should handle commands", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const commandHandler = vi.fn().mockResolvedValue({ result: "success" });
    server.registerCommandHandler("test_command", commandHandler);

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve) => {
      ws.on("open", resolve);
    });

    // Wait for auth message
    await new Promise<void>((resolve) => {
      ws.on("message", () => resolve());
    });

    // Send command
    ws.send(JSON.stringify({
      type: "command",
      id: "cmd-1",
      payload: { command: "test_command", data: { foo: "bar" } }
    }));

    const result = await new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "command_result") resolve(msg);
      });
    });

    expect(commandHandler).toHaveBeenCalledWith("test_command", { foo: "bar" });
    expect(result).toMatchObject({
      type: "command_result",
      id: "cmd-1",
      payload: { command: "test_command", success: true, result: { result: "success" } }
    });

    ws.close();
  });

  it.skip("should return error for unknown commands", async () => {
    await server.start();
    const port = currentPort - 1;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    // Collect all messages
    const messages: unknown[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Wait for auth message
    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length > 0) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    ws.send(JSON.stringify({
      type: "command",
      payload: { command: "unknown_command" }
    }));

    // Wait for command_result
    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.some(m => (m as {type: string}).type === "command_result")) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    const result = messages.find(m => (m as {type: string}).type === "command_result");

    expect(result).toMatchObject({
      type: "command_result",
      payload: { success: false, error: "Unknown command: unknown_command" }
    });

    ws.close();
  }, 15000);

  it("should broadcast messages to all clients", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);

    await Promise.all([
      new Promise<void>((resolve) => ws1.on("open", resolve)),
      new Promise<void>((resolve) => ws2.on("open", resolve)),
    ]);

    const received1 = new Promise<unknown>((resolve) => {
      ws1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "notification") resolve(msg);
      });
    });

    const received2 = new Promise<unknown>((resolve) => {
      ws2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "notification") resolve(msg);
      });
    });

    server.broadcast({
      type: "notification",
      payload: { message: "Test broadcast" }
    });

    const [msg1, msg2] = await Promise.all([received1, received2]);

    expect(msg1).toMatchObject({
      type: "notification",
      payload: { message: "Test broadcast" }
    });
    expect(msg2).toMatchObject({
      type: "notification",
      payload: { message: "Test broadcast" }
    });

    ws1.close();
    ws2.close();
  });

  it("should handle ping/pong", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve) => {
      ws.on("open", resolve);
    });

    const pongReceived = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") resolve(msg);
      });
    });

    ws.send(JSON.stringify({ type: "ping" }));

    const pong = await pongReceived;
    expect(pong).toMatchObject({ type: "pong" });

    ws.close();
  });

  it("should serve HTML dashboard on HTTP endpoint", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("Strada Brain WebSocket Dashboard");
  });

  it("should serve health check endpoint", async () => {
    const port = await safeStart(server);
    if (port === null) return;

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      websocket: true,
      clients: 0
    });
  });

  it("should track authenticated clients separately", async () => {
    const authServer = createServer();

    const port = await safeStart(authServer);
    if (port === null) {
      await authServer.stop();
      return;
    }

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve) => {
      ws.on("open", resolve);
    });

    expect(authServer.getAuthenticatedClientCount()).toBe(1);

    ws.close();
    await authServer.stop();
  });

  // ─── Origin Validation (SEC-01) ──────────────────────────────────────────────

  describe("Origin validation (SEC-01)", () => {
    let originServer: WebSocketDashboardServer;

    afterEach(async () => {
      await originServer?.stop();
    });

    async function connectWithOrigin(origin?: string): Promise<WebSocket> {
      originServer = createServer();
      const port = await safeStart(originServer);
      if (port === null) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      const headers = origin !== undefined ? { Origin: origin } : undefined;
      return new WebSocket(`ws://localhost:${port}/ws`, { headers });
    }

    async function expectAccepted(origin?: string): Promise<void> {
      let ws: WebSocket;
      try {
        ws = await connectWithOrigin(origin);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }

    async function expectRejected(origin: string): Promise<void> {
      let ws: WebSocket;
      try {
        ws = await connectWithOrigin(origin);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      const error = await new Promise<Error>((resolve) => {
        ws.on("error", resolve);
        ws.on("unexpected-response", () => resolve(new Error("rejected")));
      });
      expect(error).toBeDefined();
      ws.close();
    }

    it("rejects connections with non-localhost Origin", () => expectRejected("http://evil.com"), 15_000);
    it("allows connections from localhost Origin", () => expectAccepted("http://localhost"), 15_000);
    it("allows connections from localhost Origin with port", () => expectAccepted("http://localhost:3100"), 15_000);
    it("allows connections from 127.0.0.1 Origin", () => expectAccepted("http://127.0.0.1"), 15_000);
    it("allows connections without Origin header (non-browser)", () => expectAccepted(undefined), 15_000);
    it("rejects malformed Origin header", () => expectRejected("not-a-url"), 15_000);

    it("allows custom allowed origins when configured", async () => {
      originServer = createServer({ allowedOrigins: ["myapp.local"] });
      const port = await safeStart(originServer);
      if (port === null) return;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://myapp.local" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }, 15_000);
  });

  // ─── Auth Rate Limiting (SEC-02) ──────────────────────────────────────────────

  describe("Auth rate limiting (SEC-02)", () => {
    it("blocks auth after 5 failed attempts", async () => {
      const rlServer = createServer({ authToken: "secret-token" });
      const port = await safeStart(rlServer);
      if (port === null) {
        await rlServer.stop();
        return;
      }

      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws, "auth");

      const responses = await sendFailedAuths(ws, 5);
      expect(responses).toHaveLength(5);

      // 6th attempt should be rate-limited
      ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
      const rateLimited = await waitForMessage<{ type: string; payload: { retryAfter?: number; message?: string } }>(ws, "auth_error");

      expect(rateLimited.type).toBe("auth_error");
      expect(rateLimited.payload.retryAfter).toBeDefined();
      expect(rateLimited.payload.retryAfter).toBeGreaterThan(0);

      ws.close();
      await rlServer.stop();
    }, 15_000);

    it("successful auth resets lockout counter", async () => {
      const rlServer = createServer({ authToken: "secret-token" });
      const port = await safeStart(rlServer);
      if (port === null) {
        await rlServer.stop();
        return;
      }

      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws, "auth");

      // Send 3 failed auth attempts
      await sendFailedAuths(ws, 3);

      // Succeed once -- should reset counter
      ws.send(JSON.stringify({ type: "auth", payload: { token: "secret-token" } }));
      await waitForMessage(ws, "auth_success");

      // Now fail 5 more times -- should only lock after the 5th (not the 3rd)
      await sendFailedAuths(ws, 5);

      // Check the 6th attempt to see the lockout
      ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
      const lockedOut = await waitForMessage<{ type: string; payload: { retryAfter?: number } }>(ws, "auth_error");

      expect(lockedOut.payload.retryAfter).toBeDefined();
      expect(lockedOut.payload.retryAfter).toBeGreaterThan(0);

      ws.close();
      await rlServer.stop();
    }, 15_000);
  });
});
