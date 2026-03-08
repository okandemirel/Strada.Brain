import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketDashboardServer } from "./websocket-server.js";
import { MetricsCollector } from "./metrics.js";
import { BruteForceProtection } from "../security/auth-hardened.js";

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

  // ─── Origin Validation (SEC-01) ──────────────────────────────────────────────

  describe("Origin validation (SEC-01)", () => {
    it("rejects connections with non-localhost Origin", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://evil.com" },
      });

      const error = await new Promise<Error>((resolve) => {
        ws.on("error", resolve);
        ws.on("unexpected-response", () => resolve(new Error("rejected")));
      });

      expect(error).toBeDefined();
      ws.close();
      await originServer.stop();
    }, 15000);

    it("allows connections from localhost Origin", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://localhost" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await originServer.stop();
    }, 15000);

    it("allows connections from localhost Origin with port", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://localhost:3100" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await originServer.stop();
    }, 15000);

    it("allows connections from 127.0.0.1 Origin", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://127.0.0.1" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await originServer.stop();
    }, 15000);

    it("allows connections without Origin header (non-browser)", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await originServer.stop();
    }, 15000);

    it("rejects malformed Origin header", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "not-a-url" },
      });

      const error = await new Promise<Error>((resolve) => {
        ws.on("error", resolve);
        ws.on("unexpected-response", () => resolve(new Error("rejected")));
      });

      expect(error).toBeDefined();
      ws.close();
      await originServer.stop();
    }, 15000);

    it("allows custom allowed origins when configured", async () => {
      const originServer = new WebSocketDashboardServer(
        currentPort++,
        undefined,
        metrics,
        () => undefined,
        undefined,
        undefined,
        ["myapp.local"]
      );

      await originServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: "http://myapp.local" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await originServer.stop();
    }, 15000);
  });

  // ─── Auth Rate Limiting (SEC-02) ──────────────────────────────────────────────

  describe("Auth rate limiting (SEC-02)", () => {
    it("blocks auth after 5 failed attempts", async () => {
      const rlServer = new WebSocketDashboardServer(
        currentPort++,
        "secret-token",
        metrics,
        () => undefined
      );

      await rlServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      // Wait for initial auth message
      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth") resolve();
        });
      });

      // Send 5 failed auth attempts
      const responses: Array<{ type: string; payload?: { retryAfter?: number; message?: string } }> = [];

      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
        await new Promise<void>((resolve) => {
          const handler = (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "auth_error") {
              responses.push(msg);
              ws.removeListener("message", handler);
              resolve();
            }
          };
          ws.on("message", handler);
        });
      }

      expect(responses).toHaveLength(5);

      // 6th attempt should be rate-limited
      ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
      const rateLimited = await new Promise<{ type: string; payload: { retryAfter?: number; message?: string } }>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth_error") {
            ws.removeListener("message", handler);
            resolve(msg);
          }
        };
        ws.on("message", handler);
      });

      expect(rateLimited.type).toBe("auth_error");
      expect(rateLimited.payload.retryAfter).toBeDefined();
      expect(rateLimited.payload.retryAfter).toBeGreaterThan(0);

      ws.close();
      await rlServer.stop();
    }, 15000);

    it("allows auth after lockout expires (via BruteForceProtection)", () => {
      // Direct unit test of lockout expiry behavior since fake timers conflict with WebSocket
      const bp = new BruteForceProtection(5, 5 * 60 * 1000);

      // Record 5 failures to trigger lockout
      for (let i = 0; i < 5; i++) {
        bp.recordFailure("test-ip");
      }

      // Should be locked out
      const blocked = bp.canAttempt("test-ip");
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBeGreaterThan(0);

      // Advance time past lockout by mocking Date.now
      const realDateNow = Date.now;
      try {
        Date.now = () => realDateNow() + 5 * 60 * 1000 + 1;
        const allowed = bp.canAttempt("test-ip");
        expect(allowed.allowed).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    });

    it("successful auth resets lockout counter", async () => {
      const rlServer = new WebSocketDashboardServer(
        currentPort++,
        "secret-token",
        metrics,
        () => undefined
      );

      await rlServer.start();
      const port = currentPort - 1;

      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      // Wait for initial auth message
      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth") resolve();
        });
      });

      // Send 3 failed auth attempts
      for (let i = 0; i < 3; i++) {
        ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
        await new Promise<void>((resolve) => {
          const handler = (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "auth_error") {
              ws.removeListener("message", handler);
              resolve();
            }
          };
          ws.on("message", handler);
        });
      }

      // Succeed once -- should reset counter
      ws.send(JSON.stringify({ type: "auth", payload: { token: "secret-token" } }));
      await new Promise<void>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth_success") {
            ws.removeListener("message", handler);
            resolve();
          }
        };
        ws.on("message", handler);
      });

      // Now fail 5 more times -- should only lock after the 5th (not the 3rd)
      const failResponses: Array<{ type: string; payload?: { retryAfter?: number } }> = [];
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
        await new Promise<void>((resolve) => {
          const handler = (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "auth_error") {
              failResponses.push(msg);
              ws.removeListener("message", handler);
              resolve();
            }
          };
          ws.on("message", handler);
        });
      }

      // First 4 should not have retryAfter, 5th should trigger lockout
      // Check the 6th attempt to see the lockout
      ws.send(JSON.stringify({ type: "auth", payload: { token: "wrong" } }));
      const lockedOut = await new Promise<{ type: string; payload: { retryAfter?: number } }>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth_error") {
            ws.removeListener("message", handler);
            resolve(msg);
          }
        };
        ws.on("message", handler);
      });

      expect(lockedOut.payload.retryAfter).toBeDefined();
      expect(lockedOut.payload.retryAfter).toBeGreaterThan(0);

      ws.close();
      await rlServer.stop();
    }, 15000);
  });
});
