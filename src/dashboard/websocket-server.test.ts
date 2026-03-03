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

describe("WebSocketDashboardServer", () => {
  let server: WebSocketDashboardServer;
  let metrics: MetricsCollector;
  let currentPort = 29999;

  beforeEach(() => {
    metrics = new MetricsCollector();
    server = new WebSocketDashboardServer(
      currentPort++,
      undefined, // No auth token
      metrics,
      () => ({ totalEntries: 100, hasAnalysisCache: true }),
      () => ({ loaded: 5, directories: ["./plugins"] }),
      () => [{ level: "info", message: "Test log", time: new Date().toISOString() }]
    );
  });

  afterEach(async () => {
    await server.stop();
  });

  it("should start and stop the server", async () => {
    await server.start();
    expect(server.getClientCount()).toBe(0);
  });

  it("should accept WebSocket connections", async () => {
    await server.start();
    const port = currentPort - 1;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    expect(server.getClientCount()).toBe(1);
    ws.close();
  });

  it("should handle authentication when token is required", async () => {
    const authServer = new WebSocketDashboardServer(
      currentPort++,
      "secret-token",
      metrics,
      () => undefined
    );

    await authServer.start();
    const port = currentPort - 1;

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
    await server.start();
    const port = currentPort - 1;

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
    await server.start();
    const port = currentPort - 1;

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
    await server.start();
    const port = currentPort - 1;

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
    await server.start();
    const port = currentPort - 1;

    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    
    const html = await response.text();
    expect(html).toContain("Strata Brain WebSocket Dashboard");
  });

  it("should serve health check endpoint", async () => {
    await server.start();
    const port = currentPort - 1;

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
    const authServer = new WebSocketDashboardServer(
      currentPort++,
      undefined, // No auth required
      metrics,
      () => undefined
    );

    await authServer.start();
    const port = currentPort - 1;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve) => {
      ws.on("open", resolve);
    });

    expect(authServer.getAuthenticatedClientCount()).toBe(1);

    ws.close();
    await authServer.stop();
  });
});
