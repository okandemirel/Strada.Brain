/**
 * Unity MCP bridge status routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/mcp/status
 *   POST /api/mcp/reconnect
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { StradaMcpRuntimeStatus } from "../core/strada-mcp-tool-loader.js";
import { sendJson, sendJsonError } from "./server-types.js";
import type { RouteContext } from "./server-types.js";

/**
 * Strip fields that must not leave the process: `sourcePath` is an absolute
 * filesystem path and `activeEditorInstanceId` is an internal identifier with
 * no UI value. Used by BOTH the status and reconnect handlers so neither can
 * leak what the other strips.
 */
function sanitizeStatus(
  status: StradaMcpRuntimeStatus,
): Omit<StradaMcpRuntimeStatus, "sourcePath" | "activeEditorInstanceId"> {
  const { sourcePath: _sourcePath, activeEditorInstanceId: _instanceId, ...safe } = status;
  return safe;
}

/**
 * Try to handle Unity MCP bridge routes. Returns true if the route was handled.
 */
export function handleMcpRoutes(
  url: string,
  method: string,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // GET /api/mcp/status -- Sanitized Unity MCP runtime + bridge status
  if (url === "/api/mcp/status" || url.startsWith("/api/mcp/status?")) {
    const status = ctx.toolRegistry?.getStradaMcpRuntimeStatus?.() ?? null;
    if (!status) {
      sendJson(res, { installed: false, status: null });
      return true;
    }
    sendJson(res, { installed: status.installed, status: sanitizeStatus(status) });
    return true;
  }

  // POST /api/mcp/reconnect -- On-demand Unity editor bridge reconnect
  if (url === "/api/mcp/reconnect" || url.startsWith("/api/mcp/reconnect?")) {
    if (method !== "POST") {
      sendJsonError(res, 405, "Method not allowed");
      return true;
    }
    const registry = ctx.toolRegistry;
    if (!registry?.tryStradaMcpReconnect) {
      sendJsonError(res, 503, "MCP runtime not available");
      return true;
    }
    void registry
      .tryStradaMcpReconnect()
      .then((connected) => {
        const status = registry.getStradaMcpRuntimeStatus?.() ?? null;
        sendJson(res, {
          success: true,
          bridgeConnected: connected,
          status: status ? sanitizeStatus(status) : null,
        });
      })
      .catch((err) => {
        sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
      });
    return true;
  }

  return false;
}
