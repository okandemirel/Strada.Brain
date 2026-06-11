import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpRoutes } from "./server-mcp-routes.js";
import {
  createMockReq,
  createMockRes,
  responseJson,
  waitForResponse,
  type MockRes,
} from "./test-support/mock-http.js";
import type { RouteContext } from "./server-types.js";
import type { StradaMcpRuntimeStatus } from "../core/strada-mcp-tool-loader.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// SAMPLE DATA
// =============================================================================

const sampleStatus: StradaMcpRuntimeStatus = {
  installed: true,
  sourcePath: "/Users/secret/path",
  version: "1.2.3",
  toolCount: 14,
  resourceCount: 3,
  promptCount: 2,
  bridgeConfigured: true,
  bridgeConnected: true,
  bridgeState: "connected",
  availableToolCount: 12,
  unavailableToolCount: 2,
  activeEditorPort: 6400,
  activeEditorInstanceId: "abc",
  activeEditorProjectName: "MyGame",
  editorSelectionSource: "discovery",
  editorDiscoveryCount: 1,
};

function ctxWithRegistry(registry: unknown): RouteContext {
  return { toolRegistry: registry } as unknown as RouteContext;
}

// =============================================================================
// TESTS
// =============================================================================

describe("handleMcpRoutes", () => {
  let res: MockRes & ServerResponse;
  let req: IncomingMessage;

  beforeEach(() => {
    res = createMockRes();
    req = createMockReq();
  });

  describe("GET /api/mcp/status", () => {
    it("returns not-installed payload when ctx has no toolRegistry", () => {
      const handled = handleMcpRoutes("/api/mcp/status", "GET", req, res, {} as RouteContext);
      expect(handled).toBe(true);
      expect((res as MockRes).statusCode).toBe(200);
      expect(responseJson(res)).toEqual({ installed: false, status: null });
    });

    it("returns sanitized status without sourcePath or activeEditorInstanceId", () => {
      const registry = {
        getStradaMcpRuntimeStatus: vi.fn(() => sampleStatus),
      };
      const handled = handleMcpRoutes("/api/mcp/status", "GET", req, res, ctxWithRegistry(registry));
      expect(handled).toBe(true);
      expect((res as MockRes).statusCode).toBe(200);
      const body = responseJson(res);
      expect(body.installed).toBe(true);
      const status = body.status as Record<string, unknown>;
      expect(status.bridgeState).toBe("connected");
      expect(status.bridgeConnected).toBe(true);
      expect(status.toolCount).toBe(14);
      expect(status.availableToolCount).toBe(12);
      expect(status.activeEditorProjectName).toBe("MyGame");
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("sourcePath");
      expect(raw).not.toContain("activeEditorInstanceId");
      expect(raw).not.toContain("/Users/");
    });

    it("returns not-installed payload when registry status is null", () => {
      const registry = {
        getStradaMcpRuntimeStatus: vi.fn(() => null),
      };
      const handled = handleMcpRoutes("/api/mcp/status", "GET", req, res, ctxWithRegistry(registry));
      expect(handled).toBe(true);
      expect(responseJson(res)).toEqual({ installed: false, status: null });
    });
  });

  describe("POST /api/mcp/reconnect", () => {
    it("reconnects and returns sanitized status", async () => {
      const tryStradaMcpReconnect = vi.fn().mockResolvedValue(true);
      const registry = {
        getStradaMcpRuntimeStatus: vi.fn(() => sampleStatus),
        tryStradaMcpReconnect,
      };
      const handled = handleMcpRoutes("/api/mcp/reconnect", "POST", req, res, ctxWithRegistry(registry));
      expect(handled).toBe(true);
      await waitForResponse(res);
      expect(tryStradaMcpReconnect).toHaveBeenCalledTimes(1);
      const body = responseJson(res);
      expect(body.success).toBe(true);
      expect(body.bridgeConnected).toBe(true);
      expect((body.status as Record<string, unknown>).bridgeState).toBe("connected");
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("sourcePath");
      expect(raw).not.toContain("activeEditorInstanceId");
      expect(raw).not.toContain("/Users/");
    });

    it("returns 503 when no reconnect-capable registry is available", () => {
      const handled = handleMcpRoutes("/api/mcp/reconnect", "POST", req, res, {} as RouteContext);
      expect(handled).toBe(true);
      expect((res as MockRes).statusCode).toBe(503);
    });

    it("returns 405 for GET /api/mcp/reconnect", () => {
      const registry = {
        getStradaMcpRuntimeStatus: vi.fn(() => sampleStatus),
        tryStradaMcpReconnect: vi.fn().mockResolvedValue(true),
      };
      const handled = handleMcpRoutes("/api/mcp/reconnect", "GET", req, res, ctxWithRegistry(registry));
      expect(handled).toBe(true);
      expect((res as MockRes).statusCode).toBe(405);
      expect(registry.tryStradaMcpReconnect).not.toHaveBeenCalled();
    });
  });

  describe("route matching", () => {
    it("returns false for unknown /api/mcp URLs", () => {
      const handled = handleMcpRoutes("/api/mcp/foo", "GET", req, res, {} as RouteContext);
      expect(handled).toBe(false);
      expect(res.writeHead).not.toHaveBeenCalled();
    });
  });
});
