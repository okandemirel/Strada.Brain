import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { IMemoryManager, MemoryHealth } from "../memory/memory.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { MetricsStorage } from "../metrics/metrics-storage.js";
import type { MetricsFilter, LifecycleData } from "../metrics/metrics-types.js";
import { VALID_TASK_TYPES, VALID_COMPLETION_STATUSES } from "../metrics/metrics-types.js";
import type { TaskType, CompletionStatus } from "../metrics/metrics-types.js";
import { parseDurationToTimestamp } from "../metrics/parse-duration.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { GoalStorage } from "../goals/index.js";
import type { GoalTree } from "../goals/types.js";
import { calculateProgress } from "../goals/goal-progress.js";
import type { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import type { TriggerRegistry } from "../daemon/trigger-registry.js";
import type { ApprovalQueue } from "../daemon/security/approval-queue.js";
import type { WebhookTrigger } from "../daemon/triggers/webhook-trigger.js";
import {
  WebhookRateLimiter,
  parseRateLimit,
  validateWebhookAuth,
} from "../daemon/triggers/webhook-trigger.js";
import type { IdentityStateManager, IdentityState } from "../identity/identity-state.js";
import type { DaemonStorage } from "../daemon/daemon-storage.js";
import {
  ChainMetadataV2Schema,
  ChainMetadataSchema,
  DEFAULT_RESILIENCE_CONFIG,
} from "../learning/chains/chain-types.js";
import type { ChainResilienceConfig } from "../learning/chains/chain-types.js";

/**
 * Readiness check result for the /ready endpoint.
 */
export interface ReadinessCheck {
  status: "ok" | "degraded" | "error";
  detail?: string;
}

export interface ReadinessResponse {
  status: "ready" | "degraded" | "not_ready";
  checks: {
    memory: ReadinessCheck;
    channel: ReadinessCheck;
    uptime: number;
  };
  timestamp: string;
}

/**
 * Lightweight HTTP dashboard server.
 * No external dependencies — uses Node.js built-in http module.
 *
 * Endpoints:
 *   GET /           — Dashboard HTML page (auto-refreshing)
 *   GET /api/metrics — JSON metrics snapshot
 *   GET /health     — Health check (liveness)
 *   GET /ready      — Readiness check (deep health)
 */
export class DashboardServer {
  private readonly port: number;
  private readonly metrics: MetricsCollector;
  private readonly getMemoryStats: () =>
    | { totalEntries: number; hasAnalysisCache: boolean }
    | undefined;
  // @ts-ignore - Reserved for future read-only mode indicator in dashboard
  private readonly _isReadOnly: () => boolean;
  private server: Server | null = null;

  private memoryManager?: IMemoryManager;
  private channel?: IChannelAdapter;
  private metricsStorage?: MetricsStorage;
  private learningStorage?: LearningStorage;
  private goalStorage?: GoalStorage;

  // Daemon context (set when daemon mode is active)
  private daemonHeartbeatLoop?: HeartbeatLoop;
  private daemonRegistry?: TriggerRegistry;
  private daemonApprovalQueue?: ApprovalQueue;

  // Webhook context (set when webhook triggers are registered)
  private webhookTriggers?: Map<string, WebhookTrigger>;
  private webhookSecret?: string;
  private webhookRateLimiter?: WebhookRateLimiter;
  private dashboardToken?: string;

  // Identity and enrichment context (Plan 18-03)
  private identityManager?: IdentityStateManager;
  private capabilityManifest?: string;
  private daemonStorage?: DaemonStorage;
  private historyDepth: number = 10;
  private triggerFireRetentionDays: number = 30;

  // Chain resilience context (Plan 22-04)
  private chainResilienceConfig?: ChainResilienceConfig;

  // Multi-agent context (Plan 23-03) -- fields read in /api/agents endpoint handler below
  // @ts-ignore - Reserved for multi-agent endpoint (Plan 23-03 Task 2)
  private agentManager?: { getAllAgents(): Array<{ id: string; key: string; channelType: string; chatId: string; status: string; createdAt: number; lastActivity: number; budgetCapUsd: number; memoryEntryCount: number }>; getActiveCount(): number };
  // @ts-ignore - Reserved for multi-agent endpoint (Plan 23-03 Task 2)
  private agentBudgetTracker?: { getGlobalUsage(cap?: number): { usedUsd: number; limitUsd?: number; pct: number }; getAllAgentUsages(): Map<string, number> };

  constructor(
    port: number,
    metrics: MetricsCollector,
    getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined,
    isReadOnly: () => boolean = () => false,
  ) {
    this.port = port;
    this.metrics = metrics;
    this.getMemoryStats = getMemoryStats;
    this._isReadOnly = isReadOnly;
  }

  /**
   * Register optional services for deep readiness checks.
   * Call this after constructing but before or after start().
   */
  registerServices(services: {
    memoryManager?: IMemoryManager;
    channel?: IChannelAdapter;
    metricsStorage?: MetricsStorage;
    learningStorage?: LearningStorage;
    goalStorage?: GoalStorage;
    chainResilienceConfig?: ChainResilienceConfig;
  }): void {
    this.memoryManager = services.memoryManager;
    this.channel = services.channel;
    if (services.metricsStorage) {
      this.metricsStorage = services.metricsStorage;
    }
    if (services.learningStorage) {
      this.learningStorage = services.learningStorage;
    }
    if (services.goalStorage) {
      this.goalStorage = services.goalStorage;
    }
    if (services.chainResilienceConfig) {
      this.chainResilienceConfig = services.chainResilienceConfig;
    }
  }

  /**
   * Register multi-agent services for /api/agents endpoint and dashboard Agents section.
   * Call after AgentManager is initialized (Plan 23-03).
   */
  registerAgentServices(services: {
    agentManager?: { getAllAgents(): Array<{ id: string; key: string; channelType: string; chatId: string; status: string; createdAt: number; lastActivity: number; budgetCapUsd: number; memoryEntryCount: number }>; getActiveCount(): number };
    agentBudgetTracker?: { getGlobalUsage(cap?: number): { usedUsd: number; limitUsd?: number; pct: number }; getAllAgentUsages(): Map<string, number> };
  }): void {
    if (services.agentManager) {
      this.agentManager = services.agentManager;
    }
    if (services.agentBudgetTracker) {
      this.agentBudgetTracker = services.agentBudgetTracker;
    }
  }

  /**
   * Register daemon context for /api/daemon endpoints.
   * Call after heartbeat loop is started.
   */
  setDaemonContext(ctx: {
    heartbeatLoop?: HeartbeatLoop;
    registry?: TriggerRegistry;
    approvalQueue?: ApprovalQueue;
    webhookTriggers?: Map<string, WebhookTrigger>;
    webhookSecret?: string;
    webhookRateLimit?: string;
    dashboardToken?: string;
    identityManager?: IdentityStateManager;
    capabilityManifest?: string;
    daemonStorage?: DaemonStorage;
    historyDepth?: number;
    triggerFireRetentionDays?: number;
  }): void {
    this.daemonHeartbeatLoop = ctx.heartbeatLoop;
    this.daemonRegistry = ctx.registry;
    this.daemonApprovalQueue = ctx.approvalQueue;

    if (ctx.webhookTriggers) {
      this.webhookTriggers = ctx.webhookTriggers;
    }
    if (ctx.webhookSecret) {
      this.webhookSecret = ctx.webhookSecret;
    }
    if (ctx.dashboardToken) {
      this.dashboardToken = ctx.dashboardToken;
    }
    if (ctx.webhookRateLimit) {
      const { maxRequests, windowMs } = parseRateLimit(ctx.webhookRateLimit);
      this.webhookRateLimiter = new WebhookRateLimiter(maxRequests, windowMs);
    }
    if (ctx.identityManager) {
      this.identityManager = ctx.identityManager;
    }
    if (ctx.capabilityManifest !== undefined) {
      this.capabilityManifest = ctx.capabilityManifest;
    }
    if (ctx.daemonStorage) {
      this.daemonStorage = ctx.daemonStorage;
    }
    if (ctx.historyDepth !== undefined) {
      this.historyDepth = ctx.historyDepth;
    }
    if (ctx.triggerFireRetentionDays !== undefined) {
      this.triggerFireRetentionDays = ctx.triggerFireRetentionDays;
    }
  }

  async start(): Promise<void> {
    const logger = getLogger();

    this.server = createServer((req, res) => {
      const url = req.url ?? "/";

      // Security headers for XSS protection (defense-in-depth)
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-XSS-Protection", "1; mode=block");
      res.setHeader("Referrer-Policy", "no-referrer");

      if (url.startsWith("/api/goals")) {
        // Goal tree data endpoint -- graceful degradation when goalStorage is not available
        if (!this.goalStorage) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ trees: [] }));
          return;
        }
        try {
          const params = new URL(url, "http://localhost").searchParams;
          const sessionFilter = params.get("session");
          const rootIdFilter = params.get("rootId");

          let trees: Record<string, unknown>[];
          if (rootIdFilter) {
            // Get specific tree by rootId
            const tree = this.goalStorage.getTree(rootIdFilter as import("../goals/types.js").GoalNodeId);
            trees = tree ? [this.serializeGoalTree(tree)] : [];
          } else if (sessionFilter) {
            // Get trees for a specific session
            const rawTrees = this.goalStorage.getTreesBySession(sessionFilter);
            trees = rawTrees.map((t) => this.serializeGoalTree(t));
          } else {
            // No filter -- return empty (no "get all" to avoid scanning entire DB)
            trees = [];
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ trees }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ trees: [] }));
        }
        return;
      }

      if (url.startsWith("/api/agent-metrics")) {
        if (!this.metricsStorage) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Metrics not available" }));
          return;
        }
        const params = new URL(url, "http://localhost").searchParams;
        const type = params.get("type");
        const status = params.get("status");
        if (type && !VALID_TASK_TYPES.has(type)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid type parameter" }));
          return;
        }
        if (status && !VALID_COMPLETION_STATUSES.has(status)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid status parameter" }));
          return;
        }
        const filter: MetricsFilter = {
          ...(params.get("session") && { sessionId: params.get("session")! }),
          ...(type && { taskType: type as TaskType }),
          ...(status && { completionStatus: status as CompletionStatus }),
          ...(params.get("since") && { since: parseDurationToTimestamp(params.get("since")!) || undefined }),
        };
        const aggregation = this.metricsStorage.getAggregation(filter);

        // Enrich with lifecycle data if LearningStorage is available
        let responseData: Record<string, unknown> = { ...aggregation };
        if (this.learningStorage) {
          try {
            const lifecycle = this.getLifecycleData();
            if (lifecycle) {
              responseData = { ...aggregation, lifecycle };
            }
          } catch {
            // Lifecycle data is non-critical; omit on error
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseData));
        return;
      }

      // Daemon approval management endpoints (POST) — requires dashboard auth
      if (url.startsWith("/api/daemon/approvals/") && req.method === "POST") {
        // Auth check: require dashboard token
        if (!this.dashboardToken) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Dashboard authentication not configured" }));
          return;
        }
        const authHeader = req.headers["authorization"] as string | undefined;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
        if (!token || token !== this.dashboardToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Authentication required" }));
          return;
        }

        const match = url.match(/^\/api\/daemon\/approvals\/([^/]+)\/(approve|deny)$/);
        if (!match) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        const approvalId = match[1]!;
        const action = match[2]!;

        if (!this.daemonApprovalQueue) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Daemon not active" }));
          return;
        }

        const entry = this.daemonApprovalQueue.getById(approvalId);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Approval not found" }));
          return;
        }

        try {
          if (action === "approve") {
            this.daemonApprovalQueue.approve(approvalId, "dashboard");
          } else {
            this.daemonApprovalQueue.deny(approvalId, "dashboard");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: action === "approve" ? "approved" : "denied" }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Failed to ${action} approval` }));
        }
        return;
      }

      // Daemon status endpoint (GET)
      if (url === "/api/daemon" || url.startsWith("/api/daemon?")) {
        if (!this.daemonHeartbeatLoop) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            running: false,
            triggers: [],
            budget: { usedUsd: 0, limitUsd: 0, pct: 0 },
            approvalQueue: [],
            identity: null,
            capabilityManifest: null,
            triggerHistory: [],
          }));
          return;
        }

        const status = this.daemonHeartbeatLoop.getDaemonStatus();
        const triggers = this.daemonRegistry?.getAll() ?? [];
        const pending = this.daemonApprovalQueue?.getPending() ?? [];

        const triggerList = triggers.map((t) => {
          const cb = this.daemonHeartbeatLoop!.getCircuitBreaker(t.metadata.name);
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
        if (this.identityManager) {
          try {
            identity = this.identityManager.getState();
          } catch {
            identity = null;
          }
        }

        // Trigger history from registry metadata (fallback: no persistent history yet)
        const triggerHistory = this.buildTriggerHistory(triggers);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          running: status.running,
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
          capabilityManifest: this.capabilityManifest ?? null,
          triggerHistory,
        }));
        return;
      }

      // POST /api/webhook -- Accept webhook events with dual auth and rate limiting
      if (req.method === "POST" && (url === "/api/webhook" || url.startsWith("/api/webhook?"))) {
        const MAX_BODY_BYTES = 65_536;
        let body = "";
        let bodyBytes = 0;
        let aborted = false;
        req.on("data", (chunk: Buffer) => {
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES) {
            aborted = true;
            req.destroy();
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large" }));
            return;
          }
          body += chunk.toString();
        });
        req.on("end", () => {
          if (aborted) return;
          try {
            // Auth check
            const headers: Record<string, string | undefined> = {
              "x-webhook-secret": req.headers["x-webhook-secret"] as string | undefined,
              "authorization": req.headers["authorization"] as string | undefined,
            };
            const authResult = validateWebhookAuth(
              headers,
              this.webhookSecret,
              this.dashboardToken,
            );
            if (!authResult.valid) {
              res.writeHead(authResult.status ?? 401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: authResult.message }));
              return;
            }

            // Rate limit check (per-source by IP)
            const sourceIp = (req.socket.remoteAddress ?? "unknown");
            if (this.webhookRateLimiter && !this.webhookRateLimiter.isAllowed(Date.now(), sourceIp)) {
              res.writeHead(429, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Rate limit exceeded" }));
              return;
            }

            // Parse body
            const parsed = JSON.parse(body || "{}") as {
              action?: string;
              trigger?: string;
              context?: Record<string, unknown>;
            };
            if (!parsed.action) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required field: action" }));
              return;
            }

            // Find webhook trigger
            if (!this.webhookTriggers || this.webhookTriggers.size === 0) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No webhook triggers registered" }));
              return;
            }

            let target: WebhookTrigger | undefined;
            if (parsed.trigger) {
              target = this.webhookTriggers.get(parsed.trigger);
              if (!target) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Webhook trigger '${parsed.trigger}' not found` }));
                return;
              }
            } else {
              // Use first registered webhook trigger
              target = this.webhookTriggers.values().next().value as WebhookTrigger | undefined;
            }

            if (!target) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No webhook triggers available" }));
              return;
            }

            const source = req.headers["x-webhook-source"] as string | undefined;
            target.pushEvent(parsed.action, source, parsed.context);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              status: "accepted",
              triggerId: target.metadata.name,
            }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
          }
        });
        return;
      }

      // GET /api/triggers -- List all registered triggers
      if (req.method === "GET" && (url === "/api/triggers" || url.startsWith("/api/triggers?"))) {
        const triggers = this.daemonRegistry?.getAll() ?? [];

        const triggerList = triggers.map((t) => {
          const nextRun = t.getNextRun();
          return {
            name: t.metadata.name,
            type: t.metadata.type,
            state: t.getState(),
            nextRun: nextRun ? nextRun.toISOString() : null,
          };
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(triggerList));
        return;
      }

      // GET /api/maintenance -- Maintenance stats (decay + pruning)
      if (url === "/api/maintenance") {
        const maintenance = this.getMaintenanceData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(maintenance));
        return;
      }

      // GET /api/chain-resilience -- Chain resilience data (Plan 22-04)
      if (url === "/api/chain-resilience") {
        const chainResilience = this.getChainResilienceData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chainResilience));
        return;
      }

      if (url === "/api/metrics") {
        const snapshot = this.metrics.getSnapshot(this.getMemoryStats());
        res.writeHead(200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(snapshot));
        return;
      }

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url === "/ready") {
        const readiness = this.checkReadiness();
        const httpStatus =
          readiness.status === "not_ready" ? 503 : readiness.status === "degraded" ? 207 : 200;
        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(readiness));
        return;
      }

      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        logger.info(`Dashboard running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Perform deep readiness checks against registered services.
   */
  private checkReadiness(): ReadinessResponse {
    const uptime = Date.now() - this.metrics.getStartTime();

    // Memory check
    const memoryCheck = this.checkMemory();

    // Channel check
    const channelCheck = this.checkChannel();

    // Overall status: if any check is "error", we are not ready.
    // If any check is "degraded", we are degraded.
    const allChecks = [memoryCheck, channelCheck];
    let overallStatus: ReadinessResponse["status"] = "ready";

    if (allChecks.some((c) => c.status === "error")) {
      overallStatus = "not_ready";
    } else if (allChecks.some((c) => c.status === "degraded")) {
      overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      checks: {
        memory: memoryCheck,
        channel: channelCheck,
        uptime,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private checkMemory(): ReadinessCheck {
    if (!this.memoryManager) {
      // Memory is optional; not having it is fine
      return { status: "ok", detail: "Memory system not configured" };
    }

    try {
      const health: MemoryHealth = this.memoryManager.getHealth();
      if (!health.healthy) {
        return {
          status: "error",
          detail: `Memory unhealthy: ${health.issues.join(", ")}`,
        };
      }
      if (health.indexHealth === "critical") {
        return { status: "error", detail: "Memory index in critical state" };
      }
      if (health.indexHealth === "degraded") {
        return { status: "degraded", detail: "Memory index degraded" };
      }
      return { status: "ok" };
    } catch {
      return { status: "error", detail: "Failed to query memory health" };
    }
  }

  private checkChannel(): ReadinessCheck {
    if (!this.channel) {
      return { status: "ok", detail: "No channel registered" };
    }

    try {
      const healthy = this.channel.isHealthy();
      if (!healthy) {
        return { status: "error", detail: `Channel '${this.channel.name}' is not healthy` };
      }
      return { status: "ok", detail: `Channel '${this.channel.name}' connected` };
    } catch {
      return { status: "error", detail: "Failed to query channel health" };
    }
  }

  /**
   * Query lifecycle data from LearningStorage for instinct library health.
   */
  private getLifecycleData(): LifecycleData | null {
    if (!this.learningStorage) return null;

    try {
      const allInstincts = this.learningStorage.getInstincts();
      const permanent = allInstincts.filter(i => i.status === "permanent").length;
      const active = allInstincts.filter(i => i.status === "active" && i.coolingStartedAt == null).length;
      const proposed = allInstincts.filter(i => i.status === "proposed").length;
      const deprecated = allInstincts.filter(i => i.status === "deprecated").length;
      const cooling = allInstincts.filter(i => i.coolingStartedAt != null).length;

      const weeklyCounters = this.learningStorage.getWeeklyCounters(1);
      const weeklyTrends = this.aggregateWeeklyCounters(weeklyCounters);

      return {
        statusCounts: { permanent, active, cooling, proposed, deprecated },
        weeklyTrends,
      };
    } catch {
      return null;
    }
  }

  /**
   * Aggregate weekly counter rows into trend entries.
   */
  private aggregateWeeklyCounters(
    counters: Array<{ weekStart: number; eventType: string; count: number }>
  ): Array<{ weekStart: number; promoted: number; deprecated: number; coolingStarted: number; coolingRecovered: number }> {
    const byWeek = new Map<number, { promoted: number; deprecated: number; coolingStarted: number; coolingRecovered: number }>();

    for (const c of counters) {
      if (!byWeek.has(c.weekStart)) {
        byWeek.set(c.weekStart, { promoted: 0, deprecated: 0, coolingStarted: 0, coolingRecovered: 0 });
      }
      const entry = byWeek.get(c.weekStart)!;
      switch (c.eventType) {
        case "promoted": entry.promoted = c.count; break;
        case "deprecated": entry.deprecated = c.count; break;
        case "cooling_started": entry.coolingStarted = c.count; break;
        case "cooling_recovered": entry.coolingRecovered = c.count; break;
      }
    }

    return Array.from(byWeek.entries())
      .map(([weekStart, data]) => ({ weekStart, ...data }))
      .sort((a, b) => b.weekStart - a.weekStart);
  }

  /**
   * Build trigger history from registered triggers using DaemonStorage fire history.
   */
  private buildTriggerHistory(
    triggers: Array<import("../daemon/daemon-types.js").ITrigger>,
  ): Array<{ triggerName: string; type: string; fires: Array<{ timestamp: string | null; result: string; durationMs: number | null }> }> {
    return triggers.map((t) => {
      if (this.daemonStorage) {
        try {
          const history = this.daemonStorage.getTriggerFireHistory(t.metadata.name, this.historyDepth);
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

  /**
   * Build maintenance data for the /api/maintenance endpoint.
   * Combines memory decay stats with trigger pruning info.
   */
  private getMaintenanceData(): Record<string, unknown> {
    const DEFAULT_DECAY = { enabled: false, tiers: {}, exemptDomains: [], totalExempt: 0 };
    const DEFAULT_PRUNING = { retentionDays: this.triggerFireRetentionDays, lastPrunedCount: 0 };

    let decay: unknown = DEFAULT_DECAY;
    if (this.memoryManager?.getDecayStats) {
      try {
        decay = this.memoryManager.getDecayStats();
      } catch {
        // Fall through to defaults
      }
    }

    return { decay, pruning: DEFAULT_PRUNING };
  }

  /**
   * Build chain resilience data for the /api/chain-resilience endpoint.
   * Reads tool_chain instincts, parses V2/V1 metadata, and computes resilience indicators.
   */
  private getChainResilienceData(): Record<string, unknown> {
    const chains: Array<Record<string, unknown>> = [];

    if (this.learningStorage) {
      try {
        const instincts = this.learningStorage.getInstincts({ type: "tool_chain" });
        const activeInstincts = instincts.filter(
          (i) => i.status === "active" || i.status === "permanent",
        );

        for (const instinct of activeInstincts) {
          try {
            const parsed = JSON.parse(instinct.action);

            // Try V2 first, then V1 with migration
            const v2Result = ChainMetadataV2Schema.safeParse(parsed);
            const v1Result = !v2Result.success ? ChainMetadataSchema.safeParse(parsed) : null;

            let isFullyReversible = false;
            let hasParallelBranches = false;
            let stepCount = 0;
            let successRate = 0;
            let occurrences = 0;

            if (v2Result.success) {
              const meta = v2Result.data;
              isFullyReversible = meta.isFullyReversible;
              stepCount = meta.steps.length;
              successRate = meta.successRate;
              occurrences = meta.occurrences;
              // Detect parallel branches: steps with empty dependsOn (after step 0) or multiple roots
              const rootSteps = meta.steps.filter(
                (s, i) => i > 0 && s.dependsOn.length === 0,
              );
              hasParallelBranches = rootSteps.length > 0;
            } else if (v1Result?.success) {
              const meta = v1Result.data;
              stepCount = meta.toolSequence.length;
              successRate = meta.successRate;
              occurrences = meta.occurrences;
              // V1 is always sequential, not reversible
            } else {
              continue; // Skip unparseable chains
            }

            chains.push({
              name: instinct.name,
              steps: stepCount,
              rollbackCapable: isFullyReversible,
              parallelCapable: hasParallelBranches,
              successRate,
              occurrences,
              lastRun: instinct.updatedAt ?? null,
            });
          } catch {
            // Skip individual chain parse errors
          }
        }
      } catch {
        // Fall through to empty chains
      }
    }

    const config = this.chainResilienceConfig ?? DEFAULT_RESILIENCE_CONFIG;

    return {
      chains,
      config: {
        rollbackEnabled: config.rollbackEnabled,
        parallelEnabled: config.parallelEnabled,
        maxParallelBranches: config.maxParallelBranches,
        compensationTimeoutMs: config.compensationTimeoutMs,
      },
    };
  }

  /**
   * Serialize a GoalTree into JSON-safe format for the /api/goals endpoint.
   */
  private serializeGoalTree(tree: GoalTree): Record<string, unknown> {
    const nodes: Array<Record<string, unknown>> = [];
    let rootStatus: string = "pending";

    for (const [, node] of tree.nodes) {
      nodes.push({
        id: node.id,
        task: node.task,
        status: node.status,
        depth: node.depth,
        dependsOn: [...node.dependsOn],
        parentId: node.parentId,
        result: node.result,
        error: node.error,
        startedAt: node.startedAt ?? null,
        completedAt: node.completedAt ?? null,
        retryCount: node.retryCount ?? 0,
      });
      if (node.id === tree.rootId) rootStatus = node.status;
    }

    const progress = calculateProgress(tree);

    return {
      rootId: tree.rootId,
      sessionId: tree.sessionId,
      taskDescription: tree.taskDescription,
      status: rootStatus,
      nodeCount: nodes.length,
      completedCount: progress.completed,
      createdAt: tree.createdAt,
      nodes,
      progress: {
        completed: progress.completed,
        total: progress.total,
        percentage: progress.percentage,
      },
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }
}

// --- Inline script content (used for both HTML embedding and CSP hash) ---
const SCRIPT_CONTENT = `
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

async function refresh() {
  try {
    const [metricsRes, daemonRes, maintenanceRes, chainResilienceRes] = await Promise.all([
      fetch('/api/metrics'),
      fetch('/api/daemon').catch(function() { return null; }),
      fetch('/api/maintenance').catch(function() { return null; }),
      fetch('/api/chain-resilience').catch(function() { return null; })
    ]);
    const data = await metricsRes.json();

    // Read-only mode indicator
    const banner = document.getElementById('readonly-banner');
    const statusDot = document.getElementById('status-dot');
    if (data.readOnlyMode) {
      banner.classList.add('active');
      statusDot.classList.add('readonly');
    } else {
      banner.classList.remove('active');
      statusDot.classList.remove('readonly');
    }

    // Cards
    const cards = [
      card('Uptime', fmtDuration(data.uptime)),
      card('Messages', fmt(data.totalMessages)),
      card('Input Tokens', fmt(data.totalTokens.input)),
      card('Output Tokens', fmt(data.totalTokens.output)),
      card('Active Sessions', data.activeSessions),
      card('Provider', data.providerName, data.memoryStats ? 'Memory: ' + data.memoryStats.totalEntries + ' entries' : ''),
    ];

    // Add security stats if available
    if (data.securityStats && (data.securityStats.secretsSanitized > 0 || data.securityStats.toolsBlocked > 0)) {
      cards.push(card('Secrets Redacted', fmt(data.securityStats.secretsSanitized), data.securityStats.toolsBlocked > 0 ? data.securityStats.toolsBlocked + ' tools blocked' : ''));
    }

    // Add read-only indicator card
    if (data.readOnlyMode) {
      cards.push(card('Mode', '\\u{1F512} Read-Only', 'Write operations disabled'));
    }

    document.getElementById('cards').textContent = '';
    var cardsEl = document.getElementById('cards');
    cardsEl.textContent = '';
    var tmp = document.createElement('div');
    tmp.innerHTML = cards.join('');
    while (tmp.firstChild) cardsEl.appendChild(tmp.firstChild);

    // Tool table
    const tbody = document.querySelector('#tool-table tbody');
    const tools = Object.entries(data.toolCallCounts).sort((a,b) => b[1] - a[1]);
    const maxCalls = Math.max(...tools.map(t => t[1]), 1);
    var toolRows = tools.map(([name, calls]) => {
      const errors = data.toolErrorCounts[name] || 0;
      const pct = (calls / maxCalls * 100).toFixed(0);
      return '<tr><td>' + esc(name) + '</td><td>' + esc(calls) + '</td>'
        + '<td>' + (errors > 0 ? '<span class="badge badge-err">' + errors + '</span>' : '<span class="badge badge-ok">0</span>') + '</td>'
        + '<td><div class="bar-container"><div class="bar bar-input" style="width:' + pct + '%"></div></div></td></tr>';
    }).join('');
    tbody.textContent = '';
    var toolTmp = document.createElement('tbody');
    toolTmp.innerHTML = toolRows;
    while (toolTmp.firstChild) tbody.appendChild(toolTmp.firstChild);

    // Token chart (sparkline)
    const chart = document.getElementById('token-chart');
    const recent = data.recentTokenUsage.slice(-50);
    const maxTokens = Math.max(...recent.map(t => t.inputTokens + t.outputTokens), 1);
    var chartHtml = recent.map(t => {
      const total = t.inputTokens + t.outputTokens;
      const h = Math.max(4, (total / maxTokens) * 100);
      const inPct = t.inputTokens / (total || 1) * 100;
      return '<div style="flex:1;height:' + h + '%;display:flex;flex-direction:column;justify-content:flex-end">'
        + '<div class="bar-input" style="height:' + inPct + '%;border-radius:2px 2px 0 0"></div>'
        + '<div class="bar-output" style="height:' + (100-inPct) + '%;border-radius:0 0 2px 2px"></div>'
        + '</div>';
    }).join('');
    chart.textContent = '';
    var chartTmp = document.createElement('div');
    chartTmp.innerHTML = chartHtml;
    while (chartTmp.firstChild) chart.appendChild(chartTmp.firstChild);

    // Identity panel and trigger history (Plan 18-03)
    if (daemonRes) {
      var daemon = await daemonRes.json();
      renderIdentityPanel(daemon);
      renderTriggerHistory(daemon);
    }

    // Maintenance panel (Plan 21-03)
    if (maintenanceRes) {
      var maint = await maintenanceRes.json();
      renderMaintenance(maint);
    }

    // Chain Resilience panel (Plan 22-04)
    if (chainResilienceRes) {
      var chainData = await chainResilienceRes.json();
      renderChainResilience(chainData);
    }

    document.getElementById('last-update').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('last-update').textContent = 'Error: ' + e.message;
  }
}

function renderIdentityPanel(daemon) {
  var panel = document.getElementById('identity-panel');
  if (!panel) return;
  if (!daemon.identity) {
    panel.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Identity not available';
    panel.appendChild(p);
    return;
  }
  var id = daemon.identity;
  var crashStatus = id.cleanShutdown ? 'Clean' : 'Crash Detected';
  var crashColor = id.cleanShutdown ? '#3fb950' : '#f0883e';
  var html =
    '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">'
    + card('Agent', esc(id.agentName), esc(id.agentUuid.substring(0, 8)) + '...')
    + card('Boot Count', id.bootCount)
    + card('Cumulative Uptime', fmtDuration(id.cumulativeUptimeMs))
    + card('Last Activity', id.lastActivityTs ? new Date(id.lastActivityTs).toLocaleString() : 'N/A')
    + card('Messages / Tasks', id.totalMessages + ' / ' + id.totalTasks)
    + '<div class="card"><div class="label">Shutdown Status</div><div class="value" style="font-size:1rem;color:' + crashColor + '">' + esc(crashStatus) + '</div></div>'
    + '</div>';
  panel.textContent = '';
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  while (tmp.firstChild) panel.appendChild(tmp.firstChild);
}

function renderTriggerHistory(daemon) {
  var container = document.getElementById('trigger-history');
  if (!container) return;
  var history = daemon.triggerHistory;
  if (!history || history.length === 0) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No triggers registered';
    container.appendChild(p);
    return;
  }
  var rows = '';
  for (var i = 0; i < history.length; i++) {
    var t = history[i];
    if (t.fires.length === 0) {
      rows += '<tr><td>' + esc(t.triggerName) + '</td><td>' + esc(t.type) + '</td><td colspan="3" style="color:#8b949e">No fire history</td></tr>';
    } else {
      for (var j = 0; j < t.fires.length; j++) {
        var f = t.fires[j];
        var badge = 'badge-info';
        if (f.result === 'success') badge = 'badge-ok';
        else if (f.result === 'failure') badge = 'badge-err';
        else if (f.result === 'deduplicated') badge = 'badge-warn';
        rows += '<tr><td>' + (j === 0 ? esc(t.triggerName) : '') + '</td>'
          + '<td>' + (j === 0 ? esc(t.type) : '') + '</td>'
          + '<td>' + (f.timestamp ? new Date(f.timestamp).toLocaleString() : 'N/A') + '</td>'
          + '<td><span class="badge ' + badge + '">' + esc(f.result) + '</span></td>'
          + '<td>' + (f.durationMs != null ? f.durationMs + 'ms' : 'N/A') + '</td></tr>';
      }
    }
  }
  container.textContent = '';
  var tbl = document.createElement('div');
  tbl.innerHTML = '<table><thead><tr><th>Trigger</th><th>Type</th><th>Time</th><th>Result</th><th>Duration</th></tr></thead><tbody>' + rows + '</tbody></table>';
  while (tbl.firstChild) container.appendChild(tbl.firstChild);
}

function renderMaintenance(maint) {
  var container = document.getElementById('maintenance-panel');
  if (!container) return;

  var decay = maint.decay;
  var pruning = maint.pruning;

  if (!decay || !decay.enabled) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Memory decay is disabled';
    container.appendChild(p);
    return;
  }

  var tiers = decay.tiers || {};
  var tierNames = ['working', 'ephemeral', 'persistent'];
  container.textContent = '';

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Tier', 'Entries', 'Avg Score', 'At Floor', 'Lambda'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < tierNames.length; i++) {
    var name = tierNames[i];
    var t = tiers[name];
    if (!t) continue;
    var avg = t.avgScore;
    var barColor = avg > 0.5 ? '#3fb950' : avg >= 0.2 ? '#f0883e' : '#da3633';
    var pct = Math.round(avg * 100);

    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.style.textTransform = 'capitalize';
    tdName.textContent = name;
    row.appendChild(tdName);

    var tdEntries = document.createElement('td');
    tdEntries.style.textAlign = 'right';
    tdEntries.textContent = String(t.entries);
    row.appendChild(tdEntries);

    var tdScore = document.createElement('td');
    var barOuter = document.createElement('div');
    barOuter.className = 'bar-container';
    barOuter.style.position = 'relative';
    var barInner = document.createElement('div');
    barInner.style.background = barColor;
    barInner.style.height = '100%';
    barInner.style.width = pct + '%';
    barInner.style.borderRadius = '4px';
    barOuter.appendChild(barInner);
    var scoreLabel = document.createElement('span');
    scoreLabel.style.position = 'absolute';
    scoreLabel.style.right = '4px';
    scoreLabel.style.top = '0';
    scoreLabel.style.fontSize = '0.75rem';
    scoreLabel.style.color = '#e1e4e8';
    scoreLabel.textContent = avg.toFixed(2);
    barOuter.appendChild(scoreLabel);
    tdScore.appendChild(barOuter);
    row.appendChild(tdScore);

    var tdFloor = document.createElement('td');
    tdFloor.style.textAlign = 'right';
    tdFloor.textContent = String(t.atFloor);
    row.appendChild(tdFloor);

    var tdLambda = document.createElement('td');
    tdLambda.style.textAlign = 'right';
    tdLambda.textContent = t.lambda.toFixed(2);
    row.appendChild(tdLambda);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  if (decay.exemptDomains && decay.exemptDomains.length > 0) {
    var exemptP = document.createElement('p');
    exemptP.style.color = '#8b949e';
    exemptP.style.fontSize = '0.8rem';
    exemptP.style.marginTop = '8px';
    exemptP.textContent = 'Exempt domains: ' + decay.exemptDomains.join(', ') + ' (' + decay.totalExempt + ' entries)';
    container.appendChild(exemptP);
  }

  var pruneP = document.createElement('p');
  pruneP.style.color = '#8b949e';
  pruneP.style.fontSize = '0.8rem';
  pruneP.style.marginTop = '4px';
  var pruneText = 'Pruning: ' + pruning.retentionDays + ' day retention';
  if (pruning.lastPrunedCount > 0) pruneText += ', last pruned ' + pruning.lastPrunedCount + ' records';
  pruneP.textContent = pruneText;
  container.appendChild(pruneP);
}

function renderChainResilience(data) {
  var container = document.getElementById('chain-resilience-panel');
  if (!container) return;

  var chains = data.chains || [];
  var cfg = data.config || {};

  if (chains.length === 0) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No active chains';
    container.appendChild(p);

    // Still show config summary
    var cfgP = document.createElement('p');
    cfgP.style.color = '#8b949e';
    cfgP.style.fontSize = '0.8rem';
    cfgP.style.marginTop = '8px';
    cfgP.textContent = 'Rollback: ' + (cfg.rollbackEnabled ? 'enabled' : 'disabled')
      + ' | Parallel: ' + (cfg.parallelEnabled ? 'enabled' : 'disabled')
      + ' | Max Branches: ' + (cfg.maxParallelBranches || 4)
      + ' | Timeout: ' + (cfg.compensationTimeoutMs || 5000) + 'ms';
    container.appendChild(cfgP);
    return;
  }

  container.textContent = '';

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Name', 'Steps', 'Rollback', 'Parallel', 'Success Rate', 'Executions', 'Last Run'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < chains.length; i++) {
    var c = chains[i];
    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.textContent = c.name;
    row.appendChild(tdName);

    var tdSteps = document.createElement('td');
    tdSteps.style.textAlign = 'right';
    tdSteps.textContent = String(c.steps);
    row.appendChild(tdSteps);

    var tdRollback = document.createElement('td');
    var rbBadge = document.createElement('span');
    rbBadge.className = 'badge ' + (c.rollbackCapable ? 'badge-ok' : 'badge-warn');
    rbBadge.textContent = c.rollbackCapable ? '<- Rollback-capable' : '-> Forward-recovery';
    tdRollback.appendChild(rbBadge);
    row.appendChild(tdRollback);

    var tdParallel = document.createElement('td');
    var parBadge = document.createElement('span');
    parBadge.className = 'badge ' + (c.parallelCapable ? 'badge-ok' : 'badge-warn');
    parBadge.textContent = c.parallelCapable ? 'Parallel' : 'Sequential';
    tdParallel.appendChild(parBadge);
    row.appendChild(tdParallel);

    var tdRate = document.createElement('td');
    tdRate.style.textAlign = 'right';
    tdRate.textContent = (c.successRate * 100).toFixed(1) + '%';
    row.appendChild(tdRate);

    var tdOcc = document.createElement('td');
    tdOcc.style.textAlign = 'right';
    tdOcc.textContent = String(c.occurrences);
    row.appendChild(tdOcc);

    var tdLast = document.createElement('td');
    tdLast.textContent = c.lastRun ? new Date(c.lastRun).toLocaleString() : '-';
    row.appendChild(tdLast);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  // Config summary row
  var cfgP = document.createElement('p');
  cfgP.style.color = '#8b949e';
  cfgP.style.fontSize = '0.8rem';
  cfgP.style.marginTop = '8px';
  cfgP.textContent = 'Rollback: ' + (cfg.rollbackEnabled ? 'enabled' : 'disabled')
    + ' | Parallel: ' + (cfg.parallelEnabled ? 'enabled' : 'disabled')
    + ' | Max Branches: ' + (cfg.maxParallelBranches || 4)
    + ' | Timeout: ' + (cfg.compensationTimeoutMs || 5000) + 'ms';
  container.appendChild(cfgP);
}

function card(label, value, sub) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>'
    + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
}

refresh();
setInterval(refresh, 3000);
`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT_CONTENT).digest("base64");

// --- Embedded Dashboard HTML ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strata Brain Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117; color: #e1e4e8; padding: 20px;
  }
  h1 { color: #58a6ff; margin-bottom: 20px; font-size: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; text-align: center;
  }
  .card .label { color: #8b949e; font-size: 0.85rem; margin-bottom: 4px; }
  .card .value { font-size: 1.8rem; font-weight: 700; color: #58a6ff; }
  .card .sub { color: #8b949e; font-size: 0.75rem; margin-top: 4px; }
  .section { margin-bottom: 24px; }
  .section h2 { color: #c9d1d9; font-size: 1.1rem; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; }
  td { font-size: 0.9rem; }
  .bar-container { background: #21262d; border-radius: 4px; height: 20px; overflow: hidden; }
  .bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .bar-input { background: #3fb950; }
  .bar-output { background: #f85149; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; }
  .badge-ok { background: #238636; color: #fff; }
  .badge-err { background: #da3633; color: #fff; }
  .badge-warn { background: #f0883e; color: #000; }
  .badge-info { background: #58a6ff; color: #fff; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
  .status-dot.readonly { background: #f0883e; }
  .readonly-banner {
    background: linear-gradient(90deg, #f0883e 0%, #da3633 100%);
    color: #fff;
    padding: 12px 20px;
    margin: -20px -20px 20px -20px;
    font-weight: 600;
    text-align: center;
    display: none;
  }
  .readonly-banner.active { display: block; }
  #last-update { color: #484f58; font-size: 0.75rem; }
</style>
</head>
<body>
<div id="readonly-banner" class="readonly-banner">\u{1F512} READ-ONLY MODE ACTIVE - Write operations are disabled</div>
<h1><span id="status-dot" class="status-dot"></span>Strata Brain Dashboard</h1>
<div class="grid" id="cards"></div>

<div class="section">
  <h2>Tool Usage</h2>
  <table id="tool-table">
    <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Distribution</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<div class="section">
  <h2>Recent Token Usage</h2>
  <div id="token-chart" style="height:120px;display:flex;align-items:flex-end;gap:2px;"></div>
</div>

<div class="section" id="identity-section">
  <h2>Agent Identity</h2>
  <div id="identity-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="trigger-history-section">
  <h2>Trigger History</h2>
  <div id="trigger-history"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="maintenance-section">
  <h2>Maintenance</h2>
  <div id="maintenance-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="chain-resilience-section">
  <h2>Chain Resilience</h2>
  <div id="chain-resilience-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<p id="last-update"></p>

<script>${SCRIPT_CONTENT}</script>
</body>
</html>`;
