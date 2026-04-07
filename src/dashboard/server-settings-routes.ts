/**
 * Settings and budget API routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/budget
 *   GET  /api/budget/history
 *   POST /api/budget/config
 *   GET  /api/settings/rate-limits
 *   POST /api/settings/rate-limits
 *   GET/POST /api/settings/voice
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import { sendJson, sendJsonError } from "./server-types.js";
import type { RouteContext } from "./server-types.js";

/**
 * Try to handle settings and budget routes. Returns true if the route was handled.
 */
export function handleSettingsRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // GET /api/budget -- Budget snapshot + config
  if (url === "/api/budget" || url.startsWith("/api/budget?")) {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    try {
      const snapshot = ctx.unifiedBudgetManager.getSnapshot();
      const config = ctx.unifiedBudgetManager.getConfig();
      sendJson(res, { ...snapshot, config });
    } catch (err) {
      sendJsonError(res, 500, err instanceof Error ? err.message : "Budget snapshot failed");
    }
    return true;
  }

  // GET /api/budget/history -- Daily spend history
  if (url.startsWith("/api/budget/history")) {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    const params = new URL(url, "http://localhost").searchParams;
    const days = Math.min(Math.max(parseInt(params.get("days") ?? "7", 10), 1), 30);
    const entries = ctx.unifiedBudgetManager.getDailyHistory(days);
    sendJson(res, { entries });
    return true;
  }

  // POST /api/budget/config -- Update budget configuration
  if (url === "/api/budget/config" && method === "POST") {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
      if (!parsed) return; // readJsonBody already sent the error response
      try {
        ctx.unifiedBudgetManager!.updateConfig(parsed as Parameters<UnifiedBudgetManager["updateConfig"]>[0]);
        sendJson(res, { success: true, config: ctx.unifiedBudgetManager!.getConfig() });
      } catch (err) {
        sendJsonError(res, 400, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // GET /api/settings/rate-limits -- Read rate limit overrides
  if ((url === "/api/settings/rate-limits" || url.startsWith("/api/settings/rate-limits?")) && (method === "GET" || !method)) {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    const mpm = ctx.daemonStorage?.getSettingsOverride("rate_limit_messages_per_minute") ?? "0";
    const mph = ctx.daemonStorage?.getSettingsOverride("rate_limit_messages_per_hour") ?? "0";
    const tpd = ctx.daemonStorage?.getSettingsOverride("rate_limit_tokens_per_day") ?? "0";
    sendJson(res, { messagesPerMinute: Number(mpm), messagesPerHour: Number(mph), tokensPerDay: Number(tpd) });
    return true;
  }

  // POST /api/settings/rate-limits -- Save rate limit overrides
  if (url === "/api/settings/rate-limits" && method === "POST") {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
      if (!parsed) return;
      try {
        const storage = ctx.daemonStorage!;
        if (parsed.messagesPerMinute !== undefined) {
          storage.setSettingsOverride("rate_limit_messages_per_minute", String(parsed.messagesPerMinute));
        }
        if (parsed.messagesPerHour !== undefined) {
          storage.setSettingsOverride("rate_limit_messages_per_hour", String(parsed.messagesPerHour));
        }
        if (parsed.messagesPerDay !== undefined) {
          storage.setSettingsOverride("rate_limit_messages_per_day", String(parsed.messagesPerDay));
        }
        sendJson(res, { success: true });
      } catch (err) {
        sendJsonError(res, 400, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // GET/POST /api/settings/voice -- Voice settings per chatId scope
  if (url === "/api/settings/voice" || url.startsWith("/api/settings/voice?")) {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    const voiceParams = new URL(url, "http://localhost").searchParams;
    const chatId = voiceParams.get("chatId") ?? "global";

    if (method === "GET" || method === "HEAD") {
      const storage = ctx.daemonStorage;
      const enabled = storage.getSettingsOverride("voice_enabled", chatId);
      const language = storage.getSettingsOverride("voice_language", chatId);
      const speed = storage.getSettingsOverride("voice_speed", chatId);
      sendJson(res, {
        enabled: enabled !== undefined ? enabled === "true" : null,
        language: language ?? null,
        speed: speed !== undefined ? parseFloat(speed) : null,
        chatId,
      });
      return true;
    }

    if (method === "POST") {
      void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
        if (!parsed) return;
        try {
          const storage = ctx.daemonStorage!;
          if (parsed.enabled !== undefined) {
            storage.setSettingsOverride("voice_enabled", String(Boolean(parsed.enabled)), chatId);
          }
          if (parsed.language !== undefined) {
            storage.setSettingsOverride("voice_language", String(parsed.language), chatId);
          }
          if (parsed.speed !== undefined) {
            storage.setSettingsOverride("voice_speed", String(parsed.speed), chatId);
          }
          sendJson(res, { success: true });
        } catch (err) {
          sendJsonError(res, 400, err instanceof Error ? err.message : String(err));
        }
      });
      return true;
    }

    sendJsonError(res, 405, "Method not allowed");
    return true;
  }

  return false;
}
