/**
 * The dashboard routes `strada daemon …` uses from a shell (COR-13).
 *
 * The CLI runs in its own process; the daemon lives in the runtime. These
 * routes do what the in-process commands do, on the same DaemonContext, so a
 * command means the same thing wherever it runs.
 *
 * Reads (GET, gated like every other dashboard read):
 *   GET  /api/daemon/audit?limit=N
 *   GET  /api/daemon/notifications?limit=N&level=L
 *   GET  /api/daemon/digest/preview
 *   GET  /api/consolidation/preview
 *
 * Changes (POST, owner-only in `ownerOnlyProxySurface`, JSON bodies only):
 *   POST /api/daemon/trigger              { name }      fires it as a tick would
 *   POST /api/daemon/circuit/reset        { name }
 *   POST /api/daemon/budget/reset         {}
 *   POST /api/daemon/digest/send          {}
 *   POST /api/daemon/notify               { level, message }
 *   POST /api/agents/:id/stop             { force? }
 *   POST /api/agents/:id/start            {}
 *   POST /api/agents/:id/budget           { usd }
 *   POST /api/delegations/tier            { type, tier }
 *   POST /api/consolidation/run           {}
 *   POST /api/consolidation/undo          { logId }
 * plus the existing POST /api/deployment/check (server-system-routes.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { DaemonContext } from "../daemon/daemon-cli.js";
import type { AgentId } from "../agents/multi/agent-types.js";
import type { UrgencyLevel } from "../daemon/reporting/notification-types.js";
import { sendJson, sendJsonError, type RouteContext } from "./server-types.js";

const AGENT_ID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const AGENT_ACTION_RE = new RegExp(`^/api/agents/(${AGENT_ID})/(stop|start|budget)$`);

/**
 * The only requests the local operator credential is accepted on: the method
 * and the exact URL (no query string) of each change `strada daemon` makes. The
 * credential never opens any other route — the rest of the API keeps its own
 * gates for every caller.
 */
export const LOCAL_OPERATOR_ROUTES: readonly { readonly method: "POST"; readonly pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/daemon\/trigger$/ },
  { method: "POST", pattern: /^\/api\/daemon\/circuit\/reset$/ },
  { method: "POST", pattern: /^\/api\/daemon\/budget\/reset$/ },
  { method: "POST", pattern: /^\/api\/daemon\/digest\/send$/ },
  { method: "POST", pattern: /^\/api\/daemon\/notify$/ },
  { method: "POST", pattern: AGENT_ACTION_RE },
  { method: "POST", pattern: /^\/api\/delegations\/tier$/ },
  { method: "POST", pattern: /^\/api\/consolidation\/run$/ },
  { method: "POST", pattern: /^\/api\/consolidation\/undo$/ },
  { method: "POST", pattern: /^\/api\/deployment\/check$/ },
];

/** True when `method url` is one of {@link LOCAL_OPERATOR_ROUTES}; the URL is matched whole. */
export function isLocalOperatorRoute(method: string, url: string): boolean {
  return LOCAL_OPERATOR_ROUTES.some((route) => route.method === method && route.pattern.test(url));
}

export const URGENCY_LEVELS = ["silent", "low", "medium", "high", "critical"] as const satisfies readonly UrgencyLevel[];
export const DELEGATION_TIERS = ["local", "cheap", "standard", "premium"] as const;

const NO_ARGUMENTS = z.object({}).strict();
const TRIGGER_BODY = z.object({ name: z.string().min(1).max(200) }).strict();
// A test notification: short enough to fit the reader's 4 KiB bound as JSON.
const NOTIFY_BODY = z.object({ level: z.enum(URGENCY_LEVELS), message: z.string().min(1).max(1000) }).strict();
const AGENT_STOP_BODY = z.object({ force: z.boolean().optional() }).strict();
const AGENT_BUDGET_BODY = z.object({ usd: z.number().finite().positive() }).strict();
const TIER_BODY = z.object({ type: z.string().min(1).max(100), tier: z.enum(DELEGATION_TIERS) }).strict();
const UNDO_BODY = z.object({ logId: z.string().min(1).max(200) }).strict();
export const DEPLOYMENT_CHECK_BODY = z.object({ propose: z.boolean().optional() }).strict();

function isUrgencyLevel(value: string): value is UrgencyLevel {
  return (URGENCY_LEVELS as readonly string[]).includes(value);
}

function isJsonContentType(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * The body of a mutation: declared JSON (a cross-site form post can never be
 * one), read through the bounded reader, and validated whole before anything
 * changes. Answers the error itself and resolves null when it is not usable.
 */
export async function readCommandBody<S extends z.ZodType>(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Pick<RouteContext, "readJsonBody">,
  schema: S,
): Promise<z.output<S> | null> {
  if (!isJsonContentType(req.headers["content-type"])) {
    sendJsonError(res, 415, "Content-Type must be application/json");
    return null;
  }
  const raw = await ctx.readJsonBody<unknown>(req, res);
  if (raw === null) {
    // The reader answered its own errors; a literal `null` body it did not.
    if (!res.headersSent) sendJsonError(res, 400, "body: expected a JSON object");
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendJsonError(res, 400, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body");
    return null;
  }
  return parsed.data;
}

const DAEMON_OFF = "Daemon mode is not enabled in the running Strada (start it with --daemon)";

/** The daemon's context, or a 503 naming why there is none. */
function daemonOr503(ctx: RouteContext, res: ServerResponse): DaemonContext | undefined {
  if (!ctx.daemonCliContext) sendJsonError(res, 503, DAEMON_OFF);
  return ctx.daemonCliContext;
}

function queryLimit(url: string, fallback: number): number {
  const raw = new URL(url, "http://localhost").searchParams.get("limit");
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback;
}

/** Answer `respond()` for a validated body, or a 500 with the runtime's own message. */
function withBody<S extends z.ZodType>(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  schema: S,
  respond: (body: z.output<S>) => Promise<void> | void,
): void {
  void readCommandBody(req, res, ctx, schema)
    .then(async (body) => {
      if (body !== null) await respond(body);
    })
    .catch((error: unknown) => {
      if (!res.headersSent) sendJsonError(res, 500, error instanceof Error ? error.message : String(error));
    });
}

/** Try to handle a daemon control route. Returns true if the route was handled. */
export function handleDaemonControlRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  return handleDaemonReads(url, method, res, ctx)
    || handleDaemonChanges(url, method, req, res, ctx)
    || handleAgentChanges(url, method, req, res, ctx)
    || handleMemoryAndDelegationChanges(url, method, req, res, ctx);
}

function handleDaemonReads(url: string, method: string, res: ServerResponse, ctx: RouteContext): boolean {
  const pathOnly = url.split("?")[0];

  if (method === "GET" && pathOnly === "/api/daemon/audit") {
    const daemon = ctx.daemonCliContext;
    if (!daemon) {
      sendJson(res, { enabled: false, reason: DAEMON_OFF });
      return true;
    }
    sendJson(res, { enabled: true, entries: daemon.approvalQueue.getAuditLog(queryLimit(url, 20)) });
    return true;
  }

  if (method === "GET" && pathOnly === "/api/daemon/notifications") {
    const router = ctx.daemonCliContext?.notificationRouter;
    if (!router) {
      sendJson(res, { enabled: false, reason: ctx.daemonCliContext ? "The notification router is not available in the running Strada" : DAEMON_OFF });
      return true;
    }
    const level = new URL(url, "http://localhost").searchParams.get("level") ?? undefined;
    if (level !== undefined && !isUrgencyLevel(level)) {
      sendJsonError(res, 400, `level must be one of: ${URGENCY_LEVELS.join(", ")}`);
      return true;
    }
    sendJson(res, { enabled: true, entries: router.getHistory(queryLimit(url, 20), level) });
    return true;
  }

  if (method === "GET" && pathOnly === "/api/daemon/digest/preview") {
    const reporter = ctx.daemonCliContext?.digestReporter;
    if (!reporter) {
      sendJson(res, { enabled: false, reason: ctx.daemonCliContext ? "The digest reporter is not available in the running Strada" : DAEMON_OFF });
      return true;
    }
    sendJson(res, { enabled: true, markdown: reporter.previewDigest() });
    return true;
  }

  if (method === "GET" && pathOnly === "/api/consolidation/preview") {
    const engine = ctx.daemonCliContext?.consolidationEngine;
    if (!engine) {
      sendJson(res, { enabled: false });
      return true;
    }
    void engine.preview()
      .then((preview) => sendJson(res, { enabled: true, ...preview }))
      .catch((error: unknown) => sendJsonError(res, 500, error instanceof Error ? error.message : String(error)));
    return true;
  }

  return false;
}

function handleDaemonChanges(url: string, method: string, req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (url === "/api/daemon/trigger" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    withBody(req, res, ctx, TRIGGER_BODY, ({ name }) => {
      // The path a scheduled fire takes, every gate included: onFired() alone
      // recorded a fire and ran nothing.
      const outcome = daemon.heartbeatLoop.fireNow(name);
      const answer = { trigger: name, ...outcome };
      if (outcome.status === "not_found") {
        sendJson(res, { ...answer, error: `Trigger '${name}' not found` }, 404);
      } else if (outcome.status === "refused") {
        sendJson(res, { ...answer, error: `Trigger '${name}' did not fire: ${outcome.reason}` }, 409);
      } else {
        sendJson(res, answer);
      }
    });
    return true;
  }

  if (url === "/api/daemon/circuit/reset" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    withBody(req, res, ctx, TRIGGER_BODY, ({ name }) => {
      const breaker = daemon.heartbeatLoop.getCircuitBreaker(name);
      if (!breaker) {
        sendJsonError(res, 404, `No circuit breaker found for trigger '${name}'`);
        return;
      }
      breaker.reset();
      const snap = breaker.serialize();
      daemon.storage.upsertCircuitState(name, snap.state, snap.consecutiveFailures, snap.lastFailureTime, snap.cooldownMs);
      sendJson(res, { status: "reset", trigger: name, state: breaker.getState() });
    });
    return true;
  }

  if (url === "/api/daemon/budget/reset" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    withBody(req, res, ctx, NO_ARGUMENTS, () => {
      daemon.budgetTracker.resetBudget();
      sendJson(res, { status: "reset" });
    });
    return true;
  }

  if (url === "/api/daemon/digest/send" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    const reporter = daemon.digestReporter;
    if (!reporter) {
      sendJsonError(res, 503, "The digest reporter is not available in the running Strada");
      return true;
    }
    withBody(req, res, ctx, NO_ARGUMENTS, async () => {
      await reporter.sendDigest();
      sendJson(res, { status: "sent" });
    });
    return true;
  }

  if (url === "/api/daemon/notify" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    const router = daemon.notificationRouter;
    if (!router) {
      sendJsonError(res, 503, "The notification router is not available in the running Strada");
      return true;
    }
    withBody(req, res, ctx, NOTIFY_BODY, async ({ level, message }) => {
      await router.notify({ level, title: "Manual test", message, timestamp: Date.now() });
      sendJson(res, { status: "sent", level });
    });
    return true;
  }

  return false;
}

/** The agent manager, or a 503 naming why there is none. */
function agentManagerOr503(ctx: RouteContext, res: ServerResponse): NonNullable<DaemonContext["agentManager"]> | undefined {
  const daemon = daemonOr503(ctx, res);
  if (!daemon) return undefined;
  if (!daemon.agentManager) sendJsonError(res, 503, "Multi-agent mode is not enabled in the running Strada");
  return daemon.agentManager;
}

function handleAgentChanges(url: string, method: string, req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  const agentAction = AGENT_ACTION_RE.exec(url);
  const id = agentAction?.[1] as AgentId | undefined;

  if (id && agentAction?.[2] === "stop" && method === "POST") {
    const manager = agentManagerOr503(ctx, res);
    if (!manager) return true;
    withBody(req, res, ctx, AGENT_STOP_BODY, async ({ force }) => {
      try {
        await manager.stopAgent(id, force);
      } catch (error) {
        sendJsonError(res, 409, `Failed to stop agent: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      sendJson(res, { status: "stopped", force: force === true });
    });
    return true;
  }

  if (id && agentAction?.[2] === "start" && method === "POST") {
    const manager = agentManagerOr503(ctx, res);
    if (!manager) return true;
    withBody(req, res, ctx, NO_ARGUMENTS, async () => {
      try {
        await manager.startAgent(id);
      } catch (error) {
        sendJsonError(res, 409, `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      sendJson(res, { status: "started" });
    });
    return true;
  }

  if (id && agentAction?.[2] === "budget" && method === "POST") {
    const manager = agentManagerOr503(ctx, res);
    if (!manager) return true;
    withBody(req, res, ctx, AGENT_BUDGET_BODY, ({ usd }) => {
      manager.setBudgetCap(id, usd);
      sendJson(res, { status: "set", budgetCapUsd: usd });
    });
    return true;
  }

  return false;
}

function handleMemoryAndDelegationChanges(url: string, method: string, req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (url === "/api/delegations/tier" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    const router = daemon.tierRouter;
    if (!router) {
      sendJsonError(res, 503, "Task delegation is not enabled in the running Strada");
      return true;
    }
    withBody(req, res, ctx, TIER_BODY, ({ type, tier }) => {
      router.setOverride(type, tier);
      sendJson(res, { status: "set", type, tier });
    });
    return true;
  }

  if (url === "/api/consolidation/run" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    const engine = daemon.consolidationEngine;
    if (!engine) {
      sendJsonError(res, 503, "Memory consolidation is not active in the running Strada (MEMORY_CONSOLIDATION_ENABLED=false)");
      return true;
    }
    withBody(req, res, ctx, NO_ARGUMENTS, async () => {
      // As in-process: one cycle, run to completion.
      const result = await engine.runCycle(new AbortController().signal);
      sendJson(res, result);
    });
    return true;
  }

  if (url === "/api/consolidation/undo" && method === "POST") {
    const daemon = daemonOr503(ctx, res);
    if (!daemon) return true;
    const engine = daemon.consolidationEngine;
    if (!engine) {
      sendJsonError(res, 503, "Memory consolidation is not active in the running Strada (MEMORY_CONSOLIDATION_ENABLED=false)");
      return true;
    }
    withBody(req, res, ctx, UNDO_BODY, async ({ logId }) => {
      try {
        await engine.undo(logId);
      } catch (error) {
        sendJsonError(res, 409, `Failed to undo: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      sendJson(res, { status: "undone", logId });
    });
    return true;
  }

  return false;
}
