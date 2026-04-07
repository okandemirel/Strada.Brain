/**
 * Daemon-related API routes for the dashboard server.
 *
 * Handles:
 *   POST /api/daemon/approvals/:id/(approve|deny)
 *   POST /api/daemon/start, /api/daemon/stop
 *   GET  /api/daemon
 *   POST /api/update
 *   POST /api/webhook
 *   GET  /api/triggers
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateWebhookAuth } from "../daemon/triggers/webhook-trigger.js";
import type { IdentityState } from "../identity/identity-state.js";
import { sendJson, sendJsonError, type RouteContext } from "./server-types.js";

/**
 * Try to handle daemon-related routes. Returns true if the route was handled.
 */
export function handleDaemonRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // Daemon approval management endpoints (POST)
  if (url.startsWith("/api/daemon/approvals/") && method === "POST") {
    const match = url.match(/^\/api\/daemon\/approvals\/([^/]+)\/(approve|deny)$/);
    if (!match) {
      sendJsonError(res, 404, "Not found");
      return true;
    }

    const approvalId = match[1]!;
    const action = match[2]!;

    if (!ctx.daemonApprovalQueue) {
      sendJsonError(res, 503, "Daemon not active");
      return true;
    }

    const entry = ctx.daemonApprovalQueue.getById(approvalId);
    if (!entry) {
      sendJsonError(res, 404, "Approval not found");
      return true;
    }

    try {
      if (action === "approve") {
        ctx.daemonApprovalQueue.approve(approvalId, "dashboard");
      } else {
        ctx.daemonApprovalQueue.deny(approvalId, "dashboard");
      }
      sendJson(res, { status: action === "approve" ? "approved" : "denied" });
    } catch {
      sendJsonError(res, 400, `Failed to ${action} approval`);
    }
    return true;
  }

  // Daemon start/stop endpoints (POST)
  if ((url === "/api/daemon/start" || url === "/api/daemon/stop") && method === "POST") {
    if (!ctx.daemonHeartbeatLoop) {
      sendJsonError(res, 503, "Daemon not configured. Start with --daemon flag.");
      return true;
    }

    if (url === "/api/daemon/start") {
      if (ctx.daemonHeartbeatLoop.isRunning()) {
        sendJson(res, { status: "already_running" });
        return true;
      }
      ctx.daemonHeartbeatLoop.start();
      sendJson(res, { status: "started" });
    } else {
      if (!ctx.daemonHeartbeatLoop.isRunning()) {
        sendJson(res, { status: "already_stopped" });
        return true;
      }
      ctx.daemonHeartbeatLoop.stop();
      sendJson(res, { status: "stopped" });
    }
    return true;
  }

  // Daemon status endpoint (GET)
  if (url === "/api/daemon" || url.startsWith("/api/daemon?")) {
    if (!ctx.daemonHeartbeatLoop) {
      // No daemon running — still return identity if available
      let fallbackIdentity: IdentityState | null = null;
      if (ctx.identityManager) {
        try { fallbackIdentity = ctx.identityManager.getState(); } catch { /* non-fatal */ }
      }
      sendJson(res, {
        running: false,
        configured: false,
        triggers: [],
        budget: { usedUsd: 0, limitUsd: 0, pct: 0 },
        approvalQueue: [],
        identity: fallbackIdentity,
        capabilityManifest: ctx.capabilityManifest ?? null,
        bootReport: ctx.bootReport ?? null,
        triggerHistory: [],
        startupNotices: ctx.startupNotices,
      });
      return true;
    }

    const status = ctx.daemonHeartbeatLoop.getDaemonStatus();
    const triggers = ctx.daemonRegistry?.getAll() ?? [];
    const pending = ctx.daemonApprovalQueue?.getPending() ?? [];

    const triggerList = triggers.map((t) => {
      const cb = ctx.daemonHeartbeatLoop!.getCircuitBreaker(t.metadata.name);
      const nextRun = t.getNextRun();
      return {
        name: t.metadata.name,
        type: t.metadata.type,
        state: t.getState(),
        circuitState: cb ? cb.getState() : "CLOSED",
        lastFired: null,
        nextRun: nextRun ? nextRun.toISOString() : null,
      };
    });

    // Identity enrichment (Plan 18-03)
    let identity: IdentityState | null = null;
    if (ctx.identityManager) {
      try {
        identity = ctx.identityManager.getState();
      } catch {
        identity = null;
      }
    }

    // Trigger history from registry metadata
    const triggerHistory = buildTriggerHistory(triggers, ctx);

    sendJson(res, {
      running: status.running,
      configured: true,
      intervalMs: status.intervalMs,
      triggers: triggerList,
      budget: {
        usedUsd: status.budgetUsage.usedUsd,
        limitUsd: status.budgetUsage.limitUsd ?? 0,
        pct: status.budgetUsage.pct,
      },
      approvalQueue: pending.map((e) => ({
        id: e.id,
        toolName: e.toolName,
        triggerName: e.triggerName,
        status: e.status,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
      })),
      identity,
      capabilityManifest: ctx.capabilityManifest ?? null,
      bootReport: ctx.bootReport ?? null,
      triggerHistory,
      startupNotices: ctx.startupNotices,
    });
    return true;
  }

  // POST /api/update -- Trigger immediate update check
  if (method === "POST" && url === "/api/update") {
    if (!ctx.autoUpdater) {
      sendJsonError(res, 503, "Auto-updater not available");
      return true;
    }
    const now = Date.now();
    if (now - ctx.lastUpdateCheckMs < 60_000) {
      const retryAfter = Math.ceil((60_000 - (now - ctx.lastUpdateCheckMs)) / 1000);
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
      res.end(JSON.stringify({ error: "Rate limit: update check allowed once per 60 seconds", retryAfterSeconds: retryAfter }));
      return true;
    }
    ctx.setLastUpdateCheckMs(now);
    void ctx.autoUpdater.requestImmediateCheck().then((result) => {
      if (result.error) {
        sendJson(res, {
          status: "check_failed",
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          error: result.error,
        }, 502);
        return;
      }
      sendJson(res, {
        status: result.available ? "update_pending" : "up_to_date",
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
      });
    }).catch((err) => {
      sendJsonError(res, 500, (err as Error).message);
    });
    return true;
  }

  // POST /api/webhook -- Accept webhook events with dual auth and rate limiting
  if (method === "POST" && (url === "/api/webhook" || url.startsWith("/api/webhook?"))) {
    // Auth check (headers only, no body needed)
    const headers: Record<string, string | undefined> = {
      "x-webhook-secret": req.headers["x-webhook-secret"] as string | undefined,
      "authorization": req.headers["authorization"] as string | undefined,
    };
    const authResult = validateWebhookAuth(headers, ctx.webhookSecret, ctx.dashboardToken);
    if (!authResult.valid) {
      sendJsonError(res, authResult.status ?? 401, authResult.message ?? "Unauthorized");
      return true;
    }

    // Rate limit check (per-source by IP)
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    ctx.webhookRateLimiter?.cleanup(now);
    if (ctx.webhookRateLimiter && !ctx.webhookRateLimiter.isAllowed(now, sourceIp)) {
      sendJsonError(res, 429, "Rate limit exceeded");
      return true;
    }

    void ctx.readJsonBody<{ action?: string; trigger?: string; context?: Record<string, unknown> }>(req, res, 65_536).then((parsed) => {
      if (!parsed) return;
      if (!parsed.action) {
        sendJsonError(res, 400, "Missing required field: action");
        return;
      }

      if (!ctx.webhookTriggers || ctx.webhookTriggers.size === 0) {
        sendJsonError(res, 503, "No webhook triggers registered");
        return;
      }

      let target: import("../daemon/triggers/webhook-trigger.js").WebhookTrigger | undefined;
      if (parsed.trigger) {
        target = ctx.webhookTriggers.get(parsed.trigger);
        if (!target) {
          sendJsonError(res, 404, `Webhook trigger '${parsed.trigger}' not found`);
          return;
        }
      } else {
        target = ctx.webhookTriggers.values().next().value as import("../daemon/triggers/webhook-trigger.js").WebhookTrigger | undefined;
      }

      if (!target) {
        sendJsonError(res, 503, "No webhook triggers available");
        return;
      }

      const source = req.headers["x-webhook-source"] as string | undefined;
      target.pushEvent(parsed.action, source, parsed.context);

      sendJson(res, { status: "accepted", triggerId: target.metadata.name });
    });
    return true;
  }

  // GET /api/triggers -- List all registered triggers
  if (method === "GET" && (url === "/api/triggers" || url.startsWith("/api/triggers?"))) {
    const triggers = ctx.daemonRegistry?.getAll() ?? [];

    const triggerList = triggers.map((t) => {
      const nextRun = t.getNextRun();
      const state = t.getState();
      return {
        id: t.metadata.name,
        name: t.metadata.name,
        type: t.metadata.type,
        state,
        enabled: state !== "disabled",
        nextRun: nextRun ? nextRun.toISOString() : null,
        fireCount: 0,
      };
    });

    sendJson(res, triggerList);
    return true;
  }

  return false;
}

/**
 * Build trigger history from registered triggers using DaemonStorage fire history.
 */
export function buildTriggerHistory(
  triggers: Array<import("../daemon/daemon-types.js").ITrigger>,
  ctx: Pick<RouteContext, "daemonStorage" | "historyDepth">,
): Array<{ triggerName: string; type: string; fires: Array<{ timestamp: string | null; result: string; durationMs: number | null }> }> {
  return triggers.map((t) => {
    if (ctx.daemonStorage) {
      try {
        const history = ctx.daemonStorage.getTriggerFireHistory(t.metadata.name, ctx.historyDepth);
        return {
          triggerName: t.metadata.name,
          type: t.metadata.type,
          fires: history.map((h) => ({
            timestamp: new Date(h.timestamp).toISOString(),
            result: h.result,
            durationMs: h.durationMs ?? null,
          })),
        };
      } catch {
        // Fall through to empty history
      }
    }

    return {
      triggerName: t.metadata.name,
      type: t.metadata.type,
      fires: [],
    };
  });
}
