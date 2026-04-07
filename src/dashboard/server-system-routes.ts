/**
 * System information API routes for the dashboard server.
 *
 * Handles:
 *   GET /api/goals
 *   GET /api/agent-metrics
 *   GET /api/maintenance
 *   GET /api/chain-resilience
 *   GET /api/agents
 *   GET /api/delegations
 *   GET /api/consolidation
 *   GET /api/deployment
 *   GET /api/learning/decisions
 *   GET /api/learning/health
 *   POST /api/deployment/check
 *   GET /api/config
 *   GET /api/system/boot
 *   GET /api/tools
 *   GET /api/channels
 *   GET /api/sessions
 *   GET /api/logs
 *   GET /api/identity
 *   GET /api/memory
 *   GET /api/metrics
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import { getLogRingBuffer } from "../utils/logger.js";
import type { MetricsFilter, LifecycleData } from "../metrics/metrics-types.js";
import { VALID_TASK_TYPES, VALID_COMPLETION_STATUSES } from "../metrics/metrics-types.js";
import type { TaskType, CompletionStatus } from "../metrics/metrics-types.js";
import { parseDurationToTimestamp } from "../metrics/parse-duration.js";
import type { GoalTree } from "../goals/types.js";
import { calculateProgress } from "../goals/goal-progress.js";
import {
  ChainMetadataV2Schema,
  ChainMetadataSchema,
  DEFAULT_RESILIENCE_CONFIG,
} from "../learning/chains/chain-types.js";
import { buildConfigCatalogEntries, summarizeConfigCatalog } from "../config/config-catalog.js";
import type { IdentityState } from "../identity/identity-state.js";
import type { MemoryHealth } from "../memory/memory.interface.js";
import { sendJson, sendJsonError } from "./server-types.js";
import type { RouteContext } from "./server-types.js";

/**
 * Try to handle system information routes. Returns true if the route was handled.
 */
export function handleSystemRoutes(
  url: string,
  method: string,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  maskSensitiveConfig: (obj: Record<string, unknown>) => Record<string, unknown>,
): boolean {
  // GET /api/goals -- Goal tree data
  if (url.startsWith("/api/goals")) {
    if (!ctx.goalStorage) {
      sendJson(res, { trees: [] });
      return true;
    }
    try {
      const params = new URL(url, "http://localhost").searchParams;
      const sessionFilter = params.get("session");
      const rootIdFilter = params.get("rootId");

      let trees: Record<string, unknown>[];
      if (rootIdFilter) {
        const tree = ctx.goalStorage.getTree(rootIdFilter as import("../goals/types.js").GoalNodeId);
        trees = tree ? [serializeGoalTree(tree)] : [];
      } else if (sessionFilter) {
        const rawTrees = ctx.goalStorage.getTreesBySession(sessionFilter);
        trees = rawTrees.map((t) => serializeGoalTree(t));
      } else {
        trees = [];
      }
      sendJson(res, { trees });
    } catch {
      sendJson(res, { trees: [] });
    }
    return true;
  }

  // GET /api/agent-metrics -- Metrics aggregation with optional lifecycle data
  if (url.startsWith("/api/agent-metrics")) {
    if (!ctx.metricsStorage) {
      sendJsonError(res, 503, "Metrics not available");
      return true;
    }
    const params = new URL(url, "http://localhost").searchParams;
    const type = params.get("type");
    const status = params.get("status");
    if (type && !VALID_TASK_TYPES.has(type)) {
      sendJsonError(res, 400, "Invalid type parameter");
      return true;
    }
    if (status && !VALID_COMPLETION_STATUSES.has(status)) {
      sendJsonError(res, 400, "Invalid status parameter");
      return true;
    }
    const filter: MetricsFilter = {
      ...(params.get("session") && { sessionId: params.get("session")! }),
      ...(type && { taskType: type as TaskType }),
      ...(status && { completionStatus: status as CompletionStatus }),
      ...(params.get("since") && { since: parseDurationToTimestamp(params.get("since")!) || undefined }),
    };
    const aggregation = ctx.metricsStorage.getAggregation(filter);

    let responseData: Record<string, unknown> = { ...aggregation };
    if (ctx.learningStorage) {
      try {
        const lifecycle = getLifecycleData(ctx);
        if (lifecycle) {
          responseData = { ...aggregation, lifecycle };
        }
      } catch {
        // Lifecycle data is non-critical; omit on error
      }
    }

    sendJson(res, responseData);
    return true;
  }

  // GET /api/maintenance -- Maintenance stats (decay + pruning)
  if (url === "/api/maintenance") {
    const maintenance = getMaintenanceData(ctx);
    sendJson(res, maintenance);
    return true;
  }

  // GET /api/chain-resilience -- Chain resilience data (Plan 22-04)
  if (url === "/api/chain-resilience") {
    const chainResilience = getChainResilienceData(ctx);
    sendJson(res, chainResilience);
    return true;
  }

  // GET /api/agents -- Multi-agent data (Plan 23-03)
  if (url === "/api/agents") {
    const agentsData = getAgentsData(ctx);
    sendJson(res, agentsData);
    return true;
  }

  // GET /api/delegations -- Delegation data (Plan 24-03)
  if (url === "/api/delegations") {
    const delegationsData = getDelegationsData(ctx);
    sendJson(res, delegationsData);
    return true;
  }

  // GET /api/consolidation -- Consolidation stats (Plan 25-03)
  if (url === "/api/consolidation") {
    const consolidationData = getConsolidationData(ctx);
    sendJson(res, consolidationData);
    return true;
  }

  // GET /api/deployment -- Deployment stats and history (Plan 25-03)
  if (url === "/api/deployment" && method === "GET") {
    const deploymentData = getDeploymentData(ctx);
    sendJson(res, deploymentData);
    return true;
  }

  // GET /api/learning/decisions -- Learning intervention decision log (Pipeline v2)
  if (method === "GET" && (url === "/api/learning/decisions" || url.startsWith("/api/learning/decisions?"))) {
    try {
      const params = new URL(url, "http://localhost").searchParams;
      const limit = Math.min(parseInt(params.get("limit") ?? "100", 10) || 100, 500);
      const decisions = ctx.learningStorage?.getInterventionLogs?.(undefined, limit) ?? [];
      sendJson(res, { decisions });
    } catch (_err) {
      sendJsonError(res, 500, "Failed to fetch learning decisions");
    }
    return true;
  }

  // GET /api/learning/health -- Learning system observability (instincts + runtime counters)
  if (method === "GET" && url === "/api/learning/health") {
    void import("../learning/learning-metrics.js").then(({ LearningMetrics }) => {
      try {
        const aggregates = ctx.learningStorage?.getHealthAggregates?.() ?? null;
        const m = LearningMetrics.getInstance();
        const runtime = { reflection: m.getReflectionStats(), consensus: m.getConsensusStats(), outcome: m.getOutcomeStats() };
        sendJson(res, { aggregates, runtime });
      } catch (_err) {
        sendJsonError(res, 500, "Failed to fetch learning health");
      }
    }).catch(() => {
      // LearningMetrics module unavailable — return aggregates only
      try {
        const aggregates = ctx.learningStorage?.getHealthAggregates?.() ?? null;
        const runtime = {
          reflection: { totalDone: 0, totalOverrides: 0, overrideRate: 0 },
          consensus: { totalVerifications: 0, agreementRate: 0, disagreements: [] },
          outcome: { totalTracked: 0, successRate: 0, instinctsUpdated: 0 },
        };
        sendJson(res, { aggregates, runtime });
      } catch {
        sendJsonError(res, 500, "Failed to fetch learning health");
      }
    });
    return true;
  }

  // POST /api/deployment/check -- Trigger readiness check (Plan 25-03)
  if (url === "/api/deployment/check" && method === "POST") {
    if (!ctx.readinessChecker) {
      sendJson(res, { enabled: false });
      return true;
    }
    const checker = ctx.readinessChecker;
    void checker.checkReadiness(true).then((result) => {
      sendJson(res, result);
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  // GET /api/config -- Masked configuration snapshot
  if (url === "/api/config") {
    const config = ctx.configSnapshot ? ctx.configSnapshot() : {};
    const masked = maskSensitiveConfig(config);
    const entries = buildConfigCatalogEntries(masked);
    sendJson(res, {
      config: masked,
      entries,
      summary: summarizeConfigCatalog(entries),
    });
    return true;
  }

  // GET /api/system/boot -- Boot report
  if (url === "/api/system/boot") {
    sendJson(res, { bootReport: ctx.bootReport ?? null });
    return true;
  }

  // GET /api/tools -- Registered tools list
  if (url === "/api/tools") {
    const tools = ctx.toolRegistry?.getAllTools() ?? [];
    sendJson(res, { tools, count: tools.length });
    return true;
  }

  // GET /api/channels -- Channel status
  if (url === "/api/channels") {
    const ch = ctx.channel as unknown as Record<string, unknown> | undefined;
    const name = ch ? String(ch.name ?? "unknown") : "none";
    const clientCount = (ch?.clients as Map<string, unknown> | undefined)?.size ?? 0;
    const channelInfo = {
      name,
      type: name,
      enabled: !!ctx.channel,
      healthy: ctx.channel?.isHealthy() ?? false,
      clients: clientCount,
      detail: `${clientCount} client${clientCount !== 1 ? "s" : ""} connected`,
    };
    sendJson(res, { channels: [channelInfo] });
    return true;
  }

  // GET /api/sessions -- Active orchestrator sessions
  if (url === "/api/sessions") {
    const sessions = ctx.orchestratorSessions?.getSessions() ?? new Map();
    const channelName = ctx.channel?.name ?? "unknown";
    const merged = new Map<string, {
      id: string;
      channel: string;
      startedAt: number;
      lastActivity: number;
      messageCount: number;
      activeTaskCount?: number;
    }>();

    for (const [chatId, s] of sessions.entries()) {
      const lastActivity = s.lastActivity instanceof Date ? s.lastActivity.getTime() : Number(s.lastActivity);
      merged.set(chatId, {
        id: chatId,
        channel: channelName,
        startedAt: lastActivity,
        lastActivity,
        messageCount: s.messageCount,
      });
    }

    for (const task of ctx.taskManager?.listAllActiveTasks() ?? []) {
      if (task.channelType === "daemon") continue;
      const existing = merged.get(task.chatId);
      if (existing) {
        existing.startedAt = Math.min(existing.startedAt, task.createdAt);
        existing.lastActivity = Math.max(existing.lastActivity, task.updatedAt);
        existing.messageCount = Math.max(existing.messageCount, 1);
        existing.activeTaskCount = (existing.activeTaskCount ?? 0) + 1;
        continue;
      }

      merged.set(task.chatId, {
        id: task.chatId,
        channel: task.channelType || channelName,
        startedAt: task.createdAt,
        lastActivity: task.updatedAt,
        messageCount: 1,
        activeTaskCount: 1,
      });
    }

    const list = Array.from(merged.values()).sort((left, right) => right.lastActivity - left.lastActivity);
    sendJson(res, { sessions: list, count: list.length });
    return true;
  }

  // GET /api/logs -- Recent log entries from ring buffer
  if (url === "/api/logs") {
    const rawLogs = getLogRingBuffer();
    const logs = rawLogs.map((entry) => ({
      ...entry,
      message: sanitizeSecrets(entry.message),
      meta: entry.meta
        ? JSON.parse(sanitizeSecrets(JSON.stringify(entry.meta))) as Record<string, unknown>
        : undefined,
    }));
    sendJson(res, { logs, count: logs.length });
    return true;
  }

  // GET /api/identity -- Identity state
  if (url === "/api/identity") {
    let identity: IdentityState | Record<string, unknown> | null = null;
    if (ctx.identityManager) {
      try { identity = ctx.identityManager.getState(); } catch { /* non-fatal */ }
    }
    if (!identity) {
      identity = {
        agentName: process.env["STRADA_AGENT_NAME"] ?? "Strada Brain",
        bootCount: 1,
        cumulativeUptimeMs: process.uptime() * 1000,
        firstBootTs: Date.now() - process.uptime() * 1000,
        lastActivityTs: Date.now(),
      };
    }
    const deps = ctx.stradaDeps ? {
      coreInstalled: ctx.stradaDeps.coreInstalled,
      corePath: ctx.stradaDeps.corePath,
      coreVersion: ctx.stradaDeps.coreVersion,
      coreSource: ctx.stradaDeps.coreSource,
      modulesInstalled: ctx.stradaDeps.modulesInstalled,
      modulesPath: ctx.stradaDeps.modulesPath,
      modulesVersion: ctx.stradaDeps.modulesVersion,
      modulesSource: ctx.stradaDeps.modulesSource,
      mcpInstalled: ctx.stradaDeps.mcpInstalled,
      mcpPath: ctx.stradaDeps.mcpPath,
      mcpVersion: ctx.stradaDeps.mcpVersion,
      mcpSource: ctx.stradaDeps.mcpSource,
    } : null;
    sendJson(res, { identity, deps });
    return true;
  }

  // GET /api/memory -- Memory tier stats and health
  if (url === "/api/memory") {
    const stats = ctx.getMemoryStats();
    let memoryHealth: MemoryHealth | undefined;
    if (ctx.memoryManager) {
      try {
        memoryHealth = (ctx.memoryManager as unknown as { getHealth?: () => MemoryHealth }).getHealth?.();
      } catch { /* non-fatal */ }
    }
    sendJson(res, {
      memory: {
        ...stats,
        health: memoryHealth ?? null,
      },
    });
    return true;
  }

  // GET /api/metrics -- Core metrics snapshot
  if (url === "/api/metrics") {
    const snapshot = ctx.metrics.getSnapshot(ctx.getMemoryStats());
    const activeForegroundTasks = ctx.taskManager?.countActiveForegroundTasks() ?? 0;
    const response =
      activeForegroundTasks > snapshot.activeSessions
        ? { ...snapshot, activeSessions: activeForegroundTasks }
        : snapshot;
    sendJson(res, response);
    return true;
  }

  return false;
}

// --- Helper functions extracted from DashboardServer private methods ---

/**
 * Serialize a GoalTree into JSON-safe format for the /api/goals endpoint.
 */
export function serializeGoalTree(tree: GoalTree): Record<string, unknown> {
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

/**
 * Query lifecycle data from LearningStorage for instinct library health.
 */
export function getLifecycleData(ctx: Pick<RouteContext, "learningStorage">): LifecycleData | null {
  if (!ctx.learningStorage) return null;

  try {
    const allInstincts = ctx.learningStorage.getInstincts();
    const permanent = allInstincts.filter(i => i.status === "permanent").length;
    const active = allInstincts.filter(i => i.status === "active" && i.coolingStartedAt == null).length;
    const proposed = allInstincts.filter(i => i.status === "proposed").length;
    const deprecated = allInstincts.filter(i => i.status === "deprecated").length;
    const cooling = allInstincts.filter(i => i.coolingStartedAt != null).length;

    const weeklyCounters = ctx.learningStorage.getWeeklyCounters(1);
    const weeklyTrends = aggregateWeeklyCounters(weeklyCounters);

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
export function aggregateWeeklyCounters(
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
 * Build maintenance data for the /api/maintenance endpoint.
 */
function getMaintenanceData(ctx: Pick<RouteContext, "memoryManager" | "triggerFireRetentionDays">): Record<string, unknown> {
  const DEFAULT_DECAY = { enabled: false, tiers: {}, exemptDomains: [], totalExempt: 0 };
  const DEFAULT_PRUNING = { retentionDays: ctx.triggerFireRetentionDays, lastPrunedCount: 0 };

  let decay: unknown = DEFAULT_DECAY;
  if (ctx.memoryManager?.getDecayStats) {
    try {
      decay = ctx.memoryManager.getDecayStats();
    } catch {
      // Fall through to defaults
    }
  }

  return { decay, pruning: DEFAULT_PRUNING };
}

/**
 * Build chain resilience data for the /api/chain-resilience endpoint.
 */
function getChainResilienceData(ctx: Pick<RouteContext, "learningStorage" | "chainResilienceConfig">): Record<string, unknown> {
  const chains: Array<Record<string, unknown>> = [];

  if (ctx.learningStorage) {
    try {
      const instincts = ctx.learningStorage.getInstincts({ type: "tool_chain" });
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
            const rootSteps = meta.steps.filter(
              (s, i) => i > 0 && s.dependsOn.length === 0,
            );
            hasParallelBranches = rootSteps.length > 0;
          } else if (v1Result?.success) {
            const meta = v1Result.data;
            stepCount = meta.toolSequence.length;
            successRate = meta.successRate;
            occurrences = meta.occurrences;
          } else {
            continue;
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

  const config = ctx.chainResilienceConfig ?? DEFAULT_RESILIENCE_CONFIG;

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
 * Build agents data for the /api/agents endpoint (Plan 23-03).
 */
function getAgentsData(ctx: Pick<RouteContext, "agentManager" | "agentBudgetTracker">): Record<string, unknown> {
  if (!ctx.agentManager) {
    return { enabled: false };
  }

  const agents = ctx.agentManager.getAllAgents();
  const agentUsages = ctx.agentBudgetTracker?.getAllAgentUsages();
  const globalUsage = ctx.agentBudgetTracker?.getGlobalUsage();

  return {
    enabled: true,
    activeCount: ctx.agentManager.getActiveCount(),
    agents: agents.map((a) => ({
      ...a,
      budgetUsed: agentUsages?.get(a.id) ?? 0,
    })),
    globalBudget: globalUsage ?? { usedUsd: 0, pct: 0 },
  };
}

/**
 * Build delegations data for the /api/delegations endpoint (Plan 24-03).
 */
function getDelegationsData(ctx: Pick<RouteContext, "delegationLog" | "delegationManager">): Record<string, unknown> {
  if (!ctx.delegationLog) {
    return { enabled: false };
  }

  const now = Date.now();
  const active = ctx.delegationManager?.getActiveDelegations() ?? [];
  const activeWithElapsed = active.map((d) => ({
    ...d,
    elapsedMs: now - d.startedAt,
  }));

  return {
    enabled: true,
    active: activeWithElapsed,
    history: ctx.delegationLog.getHistory(20),
    stats: ctx.delegationLog.getStats(),
  };
}

/**
 * Build consolidation data for the /api/consolidation endpoint (Plan 25-03).
 */
function getConsolidationData(ctx: Pick<RouteContext, "consolidationEngine">): Record<string, unknown> {
  if (!ctx.consolidationEngine) {
    return { enabled: false };
  }

  try {
    const stats = ctx.consolidationEngine.getStats();
    return {
      enabled: true,
      ...stats,
    };
  } catch {
    return { enabled: true, perTier: {}, lifetimeSavings: 0, totalRuns: 0, totalCostUsd: 0 };
  }
}

/**
 * Build deployment data for the /api/deployment endpoint (Plan 25-03).
 */
function getDeploymentData(ctx: Pick<RouteContext, "deploymentExecutor">): Record<string, unknown> {
  if (!ctx.deploymentExecutor) {
    return { enabled: false };
  }

  try {
    const stats = ctx.deploymentExecutor.getStats();
    const history = ctx.deploymentExecutor.getHistory(10);
    return {
      enabled: true,
      stats,
      history,
    };
  } catch {
    return { enabled: true, stats: {}, history: [] };
  }
}
