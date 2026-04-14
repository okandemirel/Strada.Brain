import { createServer, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import { isAllowedOrigin } from "../security/origin-validation.js";
import type { MetricsCollector } from "./metrics.js";
import type { IMemoryManager, MemoryHealth } from "../memory/memory.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { MetricsStorage } from "../metrics/metrics-storage.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { RuntimeArtifactManager } from "../learning/runtime-artifact-manager.js";
import type { GoalStorage } from "../goals/index.js";
import type { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import type { TriggerRegistry } from "../daemon/trigger-registry.js";
import type { ApprovalQueue } from "../daemon/security/approval-queue.js";
import type { WebhookTrigger } from "../daemon/triggers/webhook-trigger.js";
import {
  WebhookRateLimiter,
  parseRateLimit,
} from "../daemon/triggers/webhook-trigger.js";
import type { IdentityStateManager } from "../identity/identity-state.js";
import type { DaemonStorage } from "../daemon/daemon-storage.js";
import type { ChainResilienceConfig } from "../learning/chains/chain-types.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import type { BootReport } from "../common/capability-contract.js";
import type { AutoUpdater } from "../core/auto-updater.js";
import { MonitorActivityLog, handleMonitorRoute } from "./monitor-routes.js";
import { handleCanvasRoute } from "./canvas-routes.js";
import { handleWorkspaceRoute } from "./workspace-routes.js";
import type { CanvasStorage } from "./canvas-storage.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import type { WebSocketDashboardServer } from "./websocket-server.js";
import {
  NO_CACHE_HEADERS,
  type DashboardAgentManager,
  type DashboardAgentBudgetTracker,
  type DashboardDelegationLog,
  type DashboardDelegationManager,
  type DashboardConsolidationEngine,
  type DashboardDeploymentExecutor,
  type DashboardReadinessChecker,
  type DashboardSkillManager,
  type DashboardToolRegistry,
  type DashboardOrchestratorSessions,
  type DashboardSoulLoader,
  type DashboardProviderManager,
  type DashboardUserProfileStore,
  type DashboardEmbeddingStatusProvider,
  type DashboardTaskManager,
  type DashboardProviderRouter,
  type RouteContext,
} from "./server-types.js";
// SCRIPT_HASH and DASHBOARD_HTML are defined at the bottom of this file
import { handleDaemonRoutes } from "./server-daemon-routes.js";
import { handleProviderRoutes } from "./server-provider-routes.js";
import { handlePersonalityRoutes } from "./server-personality-routes.js";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import { handleSkillsRoutes } from "./server-skills-routes.js";
import { handleSystemRoutes } from "./server-system-routes.js";
import { handleVaultRoutes } from "./server-vault-routes.js";


// Re-export types that external consumers depend on
export type { ReadinessCheck, ReadinessResponse } from "./server-types.js";
import type { ReadinessCheck, ReadinessResponse } from "./server-types.js";

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

/**
 * Timing-safe string comparison to prevent timing attacks on token validation.
 * Handles different-length strings by comparing against a dummy buffer to avoid
 * leaking length information.
 */
function timingSafeTokenCompare(a: string, b: string): boolean {
  if (!a || !b) return false;

  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  if (bufA.length !== bufB.length) {
    // Compare against a same-length dummy to avoid timing leak on length
    const dummy = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, dummy);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

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
  private runtimeArtifactManager?: Pick<RuntimeArtifactManager, "getRecentArtifactsForIdentity">;
  private projectScopeFingerprint?: string;
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

  // Multi-agent context (Plan 23-03)
  private agentManager?: DashboardAgentManager;
  private agentBudgetTracker?: DashboardAgentBudgetTracker;

  // Delegation context (Plan 24-03)
  private delegationLog?: DashboardDelegationLog;
  private delegationManager?: DashboardDelegationManager;

  // Consolidation & Deployment context (Plan 25-03)
  private consolidationEngine?: DashboardConsolidationEngine;
  private deploymentExecutor?: DashboardDeploymentExecutor;
  private readinessChecker?: DashboardReadinessChecker;

  // Strada dependency status
  private stradaDeps?: StradaDepsStatus;

  // Extended dashboard services (new endpoints)
  private toolRegistry?: DashboardToolRegistry;
  private orchestratorSessions?: DashboardOrchestratorSessions;
  private soulLoader?: DashboardSoulLoader;
  private configSnapshot?: () => Record<string, unknown>;

  // Provider and user profile services (autonomous mode + provider switching)
  private providerManager?: DashboardProviderManager;
  private userProfileStore?: DashboardUserProfileStore;
  private embeddingStatusProvider?: DashboardEmbeddingStatusProvider;
  private taskManager?: DashboardTaskManager;

  // Provider router for agent activity / routing decisions
  private providerRouter?: DashboardProviderRouter;
  private startupNotices: string[] = [];
  private bootReport?: BootReport;
  private autoUpdater?: AutoUpdater;

  // Workspace monitor context (Phase 3)
  private workspaceBus?: WorkspaceBus;
  private monitorActivityLog: MonitorActivityLog = new MonitorActivityLog();

  // Canvas storage context (Phase 4)
  private canvasStorage?: CanvasStorage;

  // Workspace file explorer context (Phase 5)
  private projectRoot?: string;

  // Skill management context
  private skillManager?: DashboardSkillManager;
  private vaultRegistry?: import("../vault/vault-registry.js").VaultRegistry;

  // Budget management context
  private unifiedBudgetManager?: UnifiedBudgetManager;

  // WebSocket server reference for budget event push
  private wsServer?: WebSocketDashboardServer;

  /** Timestamp of last /api/models/refresh call (rate limiting). */
  private _lastModelRefreshMs = 0;

  /** Timestamp of last /api/update call (rate limiting, 60s debounce). */
  private _lastUpdateCheckMs = 0;

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
    runtimeArtifactManager?: Pick<RuntimeArtifactManager, "getRecentArtifactsForIdentity">;
    projectScopeFingerprint?: string;
    goalStorage?: GoalStorage;
    chainResilienceConfig?: ChainResilienceConfig;
  }): void {
    this.memoryManager = services.memoryManager ?? this.memoryManager;
    this.channel = services.channel ?? this.channel;
    this.metricsStorage = services.metricsStorage ?? this.metricsStorage;
    this.learningStorage = services.learningStorage ?? this.learningStorage;
    this.runtimeArtifactManager = services.runtimeArtifactManager ?? this.runtimeArtifactManager;
    this.projectScopeFingerprint = services.projectScopeFingerprint ?? this.projectScopeFingerprint;
    this.goalStorage = services.goalStorage ?? this.goalStorage;
    this.chainResilienceConfig = services.chainResilienceConfig ?? this.chainResilienceConfig;
  }

  /**
   * Register multi-agent services for /api/agents endpoint and dashboard Agents section.
   * Call after AgentManager is initialized (Plan 23-03).
   */
  registerAgentServices(services: {
    agentManager?: DashboardAgentManager;
    agentBudgetTracker?: DashboardAgentBudgetTracker;
  }): void {
    this.agentManager = services.agentManager ?? this.agentManager;
    this.agentBudgetTracker = services.agentBudgetTracker ?? this.agentBudgetTracker;
  }

  /**
   * Register delegation services for /api/delegations endpoint and dashboard Delegations panel.
   * Call after DelegationManager is initialized (Plan 24-03).
   */
  registerDelegationServices(delegationLog: DashboardDelegationLog, delegationManager: DashboardDelegationManager): void {
    this.delegationLog = delegationLog;
    this.delegationManager = delegationManager;
  }

  /**
   * Register consolidation and deployment services for dashboard (Plan 25-03).
   * Call after consolidation engine and deployment executor are initialized.
   */
  registerConsolidationDeploymentServices(services: {
    consolidationEngine?: DashboardConsolidationEngine;
    deploymentExecutor?: DashboardDeploymentExecutor;
    readinessChecker?: DashboardReadinessChecker;
  }): void {
    this.consolidationEngine = services.consolidationEngine ?? this.consolidationEngine;
    this.deploymentExecutor = services.deploymentExecutor ?? this.deploymentExecutor;
    this.readinessChecker = services.readinessChecker ?? this.readinessChecker;
  }

  /**
   * Register extended dashboard services for new API endpoints.
   * Call after relevant services are initialized.
   */
  registerExtendedServices(services: {
    toolRegistry?: DashboardToolRegistry;
    orchestratorSessions?: DashboardOrchestratorSessions;
    soulLoader?: DashboardSoulLoader;
    configSnapshot?: () => Record<string, unknown>;
    providerManager?: DashboardProviderManager;
    userProfileStore?: DashboardUserProfileStore;
    embeddingStatusProvider?: DashboardEmbeddingStatusProvider;
    taskManager?: DashboardTaskManager;
    stradaDeps?: StradaDepsStatus;
    bootReport?: BootReport;
  }): void {
    this.toolRegistry = services.toolRegistry ?? this.toolRegistry;
    this.orchestratorSessions = services.orchestratorSessions ?? this.orchestratorSessions;
    this.soulLoader = services.soulLoader ?? this.soulLoader;
    this.configSnapshot = services.configSnapshot ?? this.configSnapshot;
    this.providerManager = services.providerManager ?? this.providerManager;
    this.userProfileStore = services.userProfileStore ?? this.userProfileStore;
    this.embeddingStatusProvider = services.embeddingStatusProvider ?? this.embeddingStatusProvider;
    this.taskManager = services.taskManager ?? this.taskManager;
    this.stradaDeps = services.stradaDeps ?? this.stradaDeps;
    this.bootReport = services.bootReport ?? this.bootReport;
  }

  /**
   * Register provider router for /api/agent-activity and /api/routing/preset endpoints.
   * Call after ProviderRouter is initialized.
   */
  setProviderRouter(router: DashboardProviderRouter): void {
    this.providerRouter = router;
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
    startupNotices?: string[];
    daemonStorage?: DaemonStorage;
    historyDepth?: number;
    triggerFireRetentionDays?: number;
    bootReport?: BootReport;
    autoUpdater?: AutoUpdater;
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
    if (ctx.startupNotices) {
      this.startupNotices = [...new Set(ctx.startupNotices.filter(Boolean))];
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
    if (ctx.bootReport) {
      this.bootReport = ctx.bootReport;
    }
    if (ctx.autoUpdater) {
      this.autoUpdater = ctx.autoUpdater;
    }
  }

  /**
   * Register workspace bus for monitor endpoints (Phase 3).
   * Subscribes to agent_activity events to populate the activity log.
   */
  setWorkspaceBus(bus: WorkspaceBus): void {
    this.workspaceBus = bus;
    bus.on('monitor:agent_activity', (payload) => {
      this.monitorActivityLog.push(payload as {
        taskId?: string; action: string; tool?: string; detail: string; timestamp: number;
      });
    });
  }

  /**
   * Register canvas storage for canvas REST endpoints (Phase 4).
   */
  setCanvasStorage(storage: CanvasStorage): void {
    this.canvasStorage = storage;
  }

  /**
   * Register the Unity project root for workspace file endpoints (Phase 5).
   */
  setProjectRoot(path: string): void {
    this.projectRoot = path;
  }

  /**
   * Register skill manager for /api/skills endpoints.
   * Call after SkillManager.loadAll() has completed during bootstrap.
   */
  registerSkillManager(skillManager: DashboardSkillManager): void {
    this.skillManager = skillManager;
  }

  /**
   * Register the vault registry for /api/vaults/* endpoints.
   * Call from bootstrap after VaultRegistry is constructed (vault.enabled gate).
   */
  registerVaultRegistry(registry: import("../vault/vault-registry.js").VaultRegistry): void {
    this.vaultRegistry = registry;
  }

  /**
   * Register the WebSocket dashboard server for real-time event push.
   * Call after WebSocketDashboardServer is initialized to enable budget event forwarding.
   */
  setWsServer(ws: WebSocketDashboardServer): void {
    this.wsServer = ws;
    if (this.unifiedBudgetManager) {
      this.wsServer.setGetBudgetSnapshot(() => this.unifiedBudgetManager!.getSnapshot());
    }
  }

  /**
   * Register unified budget manager for /api/budget endpoints.
   * Call after UnifiedBudgetManager is initialized.
   */
  setUnifiedBudgetManager(mgr: UnifiedBudgetManager): void {
    this.unifiedBudgetManager = mgr;
    if (this.wsServer) {
      this.wsServer.setGetBudgetSnapshot(() => mgr.getSnapshot());
    }
  }

  private getAutonomousDefaults(): { enabled: boolean; hours: number } {
    const config = this.configSnapshot ? this.configSnapshot() : {};
    const rawEnabled = config["autonomousDefaultEnabled"];
    const rawHours = config["autonomousDefaultHours"];
    const hours = typeof rawHours === "number" && Number.isFinite(rawHours)
      ? Math.min(168, Math.max(1, Math.trunc(rawHours)))
      : 24;

    return {
      enabled: rawEnabled === true,
      hours,
    };
  }

  /**
   * Build the RouteContext object that route handlers need.
   * This provides a snapshot of the current server state and utility methods.
   */
  private buildRouteContext(): RouteContext {
    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
    return {
      // Core services
      memoryManager: this.memoryManager,
      channel: this.channel,
      metricsStorage: this.metricsStorage,
      learningStorage: this.learningStorage,
      runtimeArtifactManager: this.runtimeArtifactManager,
      projectScopeFingerprint: this.projectScopeFingerprint,
      goalStorage: this.goalStorage,
      metrics: this.metrics,
      getMemoryStats: this.getMemoryStats,

      // Daemon context
      daemonHeartbeatLoop: this.daemonHeartbeatLoop,
      daemonRegistry: this.daemonRegistry,
      daemonApprovalQueue: this.daemonApprovalQueue,
      webhookTriggers: this.webhookTriggers,
      webhookSecret: this.webhookSecret,
      webhookRateLimiter: this.webhookRateLimiter,
      dashboardToken: this.dashboardToken,
      identityManager: this.identityManager,
      capabilityManifest: this.capabilityManifest,
      daemonStorage: this.daemonStorage,
      historyDepth: this.historyDepth,
      triggerFireRetentionDays: this.triggerFireRetentionDays,
      startupNotices: this.startupNotices,
      bootReport: this.bootReport,
      autoUpdater: this.autoUpdater,

      // Chain resilience
      chainResilienceConfig: this.chainResilienceConfig,

      // Multi-agent
      agentManager: this.agentManager,
      agentBudgetTracker: this.agentBudgetTracker,

      // Delegation
      delegationLog: this.delegationLog,
      delegationManager: this.delegationManager,

      // Consolidation & Deployment
      consolidationEngine: this.consolidationEngine,
      deploymentExecutor: this.deploymentExecutor,
      readinessChecker: this.readinessChecker,

      // Strada deps
      stradaDeps: this.stradaDeps,

      // Extended services
      toolRegistry: this.toolRegistry,
      orchestratorSessions: this.orchestratorSessions,
      soulLoader: this.soulLoader,
      configSnapshot: this.configSnapshot,

      // Provider and user profile
      providerManager: this.providerManager,
      userProfileStore: this.userProfileStore,
      embeddingStatusProvider: this.embeddingStatusProvider,
      taskManager: this.taskManager,
      providerRouter: this.providerRouter,

      // Workspace
      workspaceBus: this.workspaceBus,
      monitorActivityLog: this.monitorActivityLog,
      canvasStorage: this.canvasStorage,
      projectRoot: this.projectRoot,

      // Skills
      skillManager: this.skillManager,
      vaultRegistry: this.vaultRegistry,

      // Budget
      unifiedBudgetManager: this.unifiedBudgetManager,
      wsServer: this.wsServer,

      // Rate limiting state — use getters to avoid stale snapshots on concurrent requests
      get lastModelRefreshMs() { return self._lastModelRefreshMs; },
      setLastModelRefreshMs: (ms: number) => { self._lastModelRefreshMs = ms; },
      get lastUpdateCheckMs() { return self._lastUpdateCheckMs; },
      setLastUpdateCheckMs: (ms: number) => { self._lastUpdateCheckMs = ms; },

      // Utility methods
      readJsonBody: <T>(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, maxBytes?: number) =>
        this.readJsonBody<T>(req, res, maxBytes),
      getAutonomousDefaults: () => this.getAutonomousDefaults(),
    };
  }

  async start(): Promise<void> {
    const logger = getLogger();

    this.server = createServer((req, res) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      // Security headers for XSS protection (defense-in-depth)
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-XSS-Protection", "1; mode=block");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (url.startsWith("/api/") || url === "/health" || url === "/ready") {
        for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) {
          res.setHeader(key, value);
        }
      }

      const isDashboardApi = url.startsWith("/api/");
      const isMutableDashboardApi =
        isDashboardApi &&
        method !== "GET" &&
        method !== "HEAD" &&
        method !== "OPTIONS" &&
        !url.startsWith("/api/webhook");

      // Token-enabled dashboard APIs always require bearer auth.
      if (isDashboardApi && this.dashboardToken) {
        if (!this.requireDashboardAuth(req, res)) return;
      }

      // Without a dashboard token, mutating dashboard APIs still require a trusted
      // same-origin browser request so local CSRF cannot drive daemon actions.
      if (isMutableDashboardApi && !this.dashboardToken) {
        if (!this.requireTrustedDashboardMutation(req, res)) return;
      }

      // --- Non-API routes (before building heavy route context) ---

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            timestamp: new Date().toISOString(),
            channel: "dashboard",
            uptime: process.uptime(),
            clients: 0,
          }),
        );
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

      if (!isDashboardApi && url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      // Build the route context for delegated API route handlers
      const ctx = this.buildRouteContext();

      // --- Delegated route handlers (largest groups first) ---

      // System info routes: goals, agent-metrics, maintenance, chain-resilience,
      // agents, delegations, consolidation, deployment, learning, config, tools,
      // channels, sessions, logs, identity, memory, metrics
      if (handleSystemRoutes(url, method, req, res, ctx, DashboardServer.maskSensitiveConfig)) return;

      // Daemon routes: approvals, start/stop, status, update, webhook, triggers
      if (handleDaemonRoutes(url, method, req, res, ctx)) return;

      // Provider routes: available, active, switch, intelligence, capabilities,
      // models/refresh, agent-activity, routing/preset, rag/status
      if (handleProviderRoutes(url, method, req, res, ctx)) return;

      // Personality and user routes: personality, personality/profiles, personality/switch,
      // user/autonomous
      if (handlePersonalityRoutes(url, method, req, res, ctx)) return;

      // Vault routes (Phase 1): /api/vaults/* — no-op when registry not in ctx.
      if (handleVaultRoutes(url, method, req, res, ctx)) return;

      // Skills routes: skills, skills/registry, skills/install, skills/:name/enable|disable
      if (handleSkillsRoutes(url, method, req, res, ctx)) return;

      // Settings and budget routes: budget, budget/history, budget/config,
      // settings/rate-limits, settings/voice
      if (handleSettingsRoutes(url, method, req, res, ctx)) return;

      // Monitor endpoints (Phase 3 — workspace monitor panel)
      if (url.startsWith("/api/monitor")) {
        const handled = handleMonitorRoute(
          url, method, req, res,
          this.goalStorage, this.taskManager, this.workspaceBus, this.monitorActivityLog,
        );
        if (handled) return;
      }

      // Canvas endpoints (Phase 4 — workspace canvas panel)
      if (url.startsWith("/api/canvas")) {
        const handled = handleCanvasRoute(
          url, method, req, res,
          this.canvasStorage,
        );
        if (handled) return;
      }

      // Workspace file endpoints (Phase 5 — file explorer)
      if (url.startsWith("/api/workspace")) {
        const handled = handleWorkspaceRoute(
          url, method, req, res,
          this.projectRoot,
        );
        if (handled) return;
      }

      // SPA fallback (non-API, non-root paths that weren't handled above)
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
   * Validate dashboard token from request headers.
   * Returns true if auth succeeds, false if it sent an error response.
   */
  private requireDashboardAuth(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): boolean {
    if (!this.dashboardToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dashboard authentication not configured" }));
      return false;
    }
    const authHeader = req.headers["authorization"] as string | undefined;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token || !timingSafeTokenCompare(token, this.dashboardToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication required" }));
      return false;
    }
    return true;
  }

  private getSingleHeader(
    header: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(header) ? header[0] : header;
  }

  private requireTrustedDashboardMutation(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): boolean {
    const origin = this.getSingleHeader(req.headers.origin);
    if (origin !== undefined) {
      if (isAllowedOrigin(origin)) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return false;
    }

    const referer = this.getSingleHeader(req.headers.referer);
    if (referer !== undefined) {
      if (isAllowedOrigin(referer)) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return false;
    }

    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Trusted same-origin request required" }));
    return false;
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
   * Read and parse a JSON request body with size limits.
   * Returns the parsed body or sends an error response and returns null.
   */
  private readJsonBody<T>(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    maxBytes = 4096,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      let body = "";
      let bodyBytes = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > maxBytes) {
          aborted = true;
          req.destroy();
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          resolve(null);
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => {
        if (aborted) return;
        try {
          resolve(JSON.parse(body || "{}") as T);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          resolve(null);
        }
      });
    });
  }

  /** Sensitive key name patterns for config masking. */
  private static readonly SENSITIVE_KEY_RE = /key|token|secret|password|credential|auth|uri|dsn/i;

  /**
   * Recursively mask sensitive values in a config snapshot.
   * Matches key names that may contain secrets and redacts their values.
   */
  static maskSensitiveConfig(obj: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (DashboardServer.SENSITIVE_KEY_RE.test(key)) {
        const val = String(value ?? "");
        masked[key] = val.length > 8 ? val.slice(0, 4) + "***" + val.slice(-4) : "***";
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        masked[key] = DashboardServer.maskSensitiveConfig(value as Record<string, unknown>);
      } else {
        // Additionally sanitize string values that look like they contain secrets
        masked[key] = typeof value === "string" ? sanitizeSecrets(value) : value;
      }
    }
    return masked;
  }

  // Data-building helpers have been extracted to server-system-routes.ts and
  // server-daemon-routes.ts as standalone functions.

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
    const [metricsRes, daemonRes, maintenanceRes, chainResilienceRes, agentsRes, delegationsRes, consolidationRes, deploymentRes] = await Promise.all([
      fetch('/api/metrics'),
      fetch('/api/daemon').catch(function() { return null; }),
      fetch('/api/maintenance').catch(function() { return null; }),
      fetch('/api/chain-resilience').catch(function() { return null; }),
      fetch('/api/agents').catch(function() { return null; }),
      fetch('/api/delegations').catch(function() { return null; }),
      fetch('/api/consolidation').catch(function() { return null; }),
      fetch('/api/deployment').catch(function() { return null; })
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

    // Agents panel (Plan 23-03)
    if (agentsRes) {
      var agentsData = await agentsRes.json();
      renderAgents(agentsData);
    }

    // Delegations panel (Plan 24-03)
    if (delegationsRes) {
      var delegationsData = await delegationsRes.json();
      renderDelegations(delegationsData);
    }

    // Consolidation subsection in Maintenance (Plan 25-03)
    if (consolidationRes) {
      var consolidationData = await consolidationRes.json();
      renderConsolidation(consolidationData);
    }

    // Deployment panel (Plan 25-03)
    if (deploymentRes) {
      var deploymentData = await deploymentRes.json();
      renderDeployment(deploymentData);
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

function renderAgents(data) {
  var section = document.getElementById('agents-section');
  var container = document.getElementById('agents-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  var agents = data.agents || [];
  container.textContent = '';

  // Global budget bar
  var globalBudget = data.globalBudget || {};
  if (globalBudget.usedUsd !== undefined) {
    var budgetDiv = document.createElement('div');
    budgetDiv.style.marginBottom = '12px';
    var budgetLabel = document.createElement('div');
    budgetLabel.style.fontSize = '0.85rem';
    budgetLabel.style.color = '#8b949e';
    budgetLabel.style.marginBottom = '4px';
    var limitStr = globalBudget.limitUsd ? '$' + globalBudget.limitUsd.toFixed(2) : 'unlimited';
    budgetLabel.textContent = 'Global Budget: $' + globalBudget.usedUsd.toFixed(2) + ' / ' + limitStr;
    budgetDiv.appendChild(budgetLabel);

    if (globalBudget.limitUsd) {
      var barOuter = document.createElement('div');
      barOuter.className = 'bar-container';
      var pct = Math.min(globalBudget.pct * 100, 100);
      var barColor = pct > 90 ? '#da3633' : pct > 70 ? '#f0883e' : '#3fb950';
      var barInner = document.createElement('div');
      barInner.style.background = barColor;
      barInner.style.height = '100%';
      barInner.style.width = pct.toFixed(0) + '%';
      barInner.style.borderRadius = '4px';
      barOuter.appendChild(barInner);
      budgetDiv.appendChild(barOuter);
    }
    container.appendChild(budgetDiv);
  }

  if (agents.length === 0) {
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No agents active (' + (data.activeCount || 0) + ' in memory)';
    container.appendChild(p);
    return;
  }

  // Agent table
  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['ID', 'Channel', 'Status', 'Budget Used/Cap', 'Memory', 'Uptime'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  var now = Date.now();
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var row = document.createElement('tr');

    var tdId = document.createElement('td');
    tdId.textContent = a.id.substring(0, 12) + '..';
    tdId.title = a.id;
    row.appendChild(tdId);

    var tdChan = document.createElement('td');
    tdChan.textContent = a.channelType + ':' + a.chatId.substring(0, 8);
    row.appendChild(tdChan);

    var tdStatus = document.createElement('td');
    var statusBadge = document.createElement('span');
    var statusClass = 'badge-info';
    if (a.status === 'active') statusClass = 'badge-ok';
    else if (a.status === 'stopped') statusClass = 'badge-warn';
    else if (a.status === 'budget_exceeded') statusClass = 'badge-err';
    statusBadge.className = 'badge ' + statusClass;
    statusBadge.textContent = a.status;
    tdStatus.appendChild(statusBadge);
    row.appendChild(tdStatus);

    var tdBudget = document.createElement('td');
    var used = a.budgetUsed || 0;
    tdBudget.textContent = '$' + used.toFixed(2) + ' / $' + a.budgetCapUsd.toFixed(2);
    row.appendChild(tdBudget);

    var tdMem = document.createElement('td');
    tdMem.style.textAlign = 'right';
    tdMem.textContent = String(a.memoryEntryCount);
    row.appendChild(tdMem);

    var tdUptime = document.createElement('td');
    tdUptime.textContent = fmtDuration(now - a.createdAt);
    row.appendChild(tdUptime);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  // Active count summary
  var summaryP = document.createElement('p');
  summaryP.style.color = '#8b949e';
  summaryP.style.fontSize = '0.8rem';
  summaryP.style.marginTop = '8px';
  summaryP.textContent = data.activeCount + ' live agent(s) in memory, ' + agents.length + ' total registered';
  container.appendChild(summaryP);
}

function renderDelegations(data) {
  var section = document.getElementById('delegations-section');
  var container = document.getElementById('delegations-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  container.textContent = '';

  var active = data.active || [];
  var stats = data.stats || [];
  var history = data.history || [];

  // Active delegations table
  if (active.length > 0) {
    var activeH = document.createElement('h3');
    activeH.textContent = 'Active Delegations';
    activeH.style.color = '#c9d1d9';
    activeH.style.fontSize = '0.95rem';
    activeH.style.marginBottom = '8px';
    container.appendChild(activeH);

    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Sub-Agent', 'Type', 'Elapsed'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    tbl.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < active.length; i++) {
      var d = active[i];
      var row = document.createElement('tr');

      var tdId = document.createElement('td');
      tdId.textContent = d.subAgentId.substring(0, 12) + '..';
      tdId.title = d.subAgentId;
      row.appendChild(tdId);

      var tdType = document.createElement('td');
      tdType.textContent = d.type;
      row.appendChild(tdType);

      var tdElapsed = document.createElement('td');
      tdElapsed.textContent = fmtDuration(d.elapsedMs || 0);
      row.appendChild(tdElapsed);

      tbody.appendChild(row);
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);
  } else {
    var noActive = document.createElement('p');
    noActive.style.color = '#8b949e';
    noActive.style.fontSize = '0.85rem';
    noActive.style.marginBottom = '12px';
    noActive.textContent = 'No active delegations';
    container.appendChild(noActive);
  }

  // Stats summary table
  if (stats.length > 0) {
    var statsH = document.createElement('h3');
    statsH.textContent = 'Delegation Statistics';
    statsH.style.color = '#c9d1d9';
    statsH.style.fontSize = '0.95rem';
    statsH.style.margin = '16px 0 8px 0';
    container.appendChild(statsH);

    var sTbl = document.createElement('table');
    var sThead = document.createElement('thead');
    var sHeadRow = document.createElement('tr');
    ['Type', 'Total', 'Success Rate', 'Avg Duration', 'Avg Cost'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      sHeadRow.appendChild(th);
    });
    sThead.appendChild(sHeadRow);
    sTbl.appendChild(sThead);

    var sTbody = document.createElement('tbody');
    for (var j = 0; j < stats.length; j++) {
      var s = stats[j];
      var sRow = document.createElement('tr');

      var tdSType = document.createElement('td');
      tdSType.textContent = s.type;
      sRow.appendChild(tdSType);

      var tdCount = document.createElement('td');
      tdCount.style.textAlign = 'right';
      tdCount.textContent = String(s.count);
      sRow.appendChild(tdCount);

      var tdRate = document.createElement('td');
      var rateBadge = document.createElement('span');
      var rateVal = s.successRate * 100;
      rateBadge.className = 'badge ' + (rateVal >= 90 ? 'badge-ok' : rateVal >= 50 ? 'badge-warn' : 'badge-err');
      rateBadge.textContent = rateVal.toFixed(1) + '%';
      tdRate.appendChild(rateBadge);
      sRow.appendChild(tdRate);

      var tdDur = document.createElement('td');
      tdDur.style.textAlign = 'right';
      tdDur.textContent = Math.round(s.avgDurationMs) + 'ms';
      sRow.appendChild(tdDur);

      var tdCost = document.createElement('td');
      tdCost.style.textAlign = 'right';
      tdCost.textContent = '$' + s.avgCostUsd.toFixed(4);
      sRow.appendChild(tdCost);

      sTbody.appendChild(sRow);
    }
    sTbl.appendChild(sTbody);
    container.appendChild(sTbl);
  }

  // Recent history table (last 10)
  if (history.length > 0) {
    var histH = document.createElement('h3');
    histH.textContent = 'Recent History';
    histH.style.color = '#c9d1d9';
    histH.style.fontSize = '0.95rem';
    histH.style.margin = '16px 0 8px 0';
    container.appendChild(histH);

    var hTbl = document.createElement('table');
    var hThead = document.createElement('thead');
    var hHeadRow = document.createElement('tr');
    ['Type', 'Model', 'Duration', 'Cost', 'Status'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      hHeadRow.appendChild(th);
    });
    hThead.appendChild(hHeadRow);
    hTbl.appendChild(hThead);

    var hTbody = document.createElement('tbody');
    var showCount = Math.min(history.length, 10);
    for (var k = 0; k < showCount; k++) {
      var e = history[k];
      var hRow = document.createElement('tr');

      var tdHType = document.createElement('td');
      tdHType.textContent = e.type;
      hRow.appendChild(tdHType);

      var tdModel = document.createElement('td');
      var modelStr = e.model || '-';
      tdModel.textContent = modelStr.length > 28 ? modelStr.substring(0, 26) + '..' : modelStr;
      tdModel.title = modelStr;
      hRow.appendChild(tdModel);

      var tdHDur = document.createElement('td');
      tdHDur.style.textAlign = 'right';
      tdHDur.textContent = e.durationMs != null ? e.durationMs + 'ms' : '-';
      hRow.appendChild(tdHDur);

      var tdHCost = document.createElement('td');
      tdHCost.style.textAlign = 'right';
      tdHCost.textContent = e.costUsd != null ? '$' + e.costUsd.toFixed(4) : '-';
      hRow.appendChild(tdHCost);

      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      var statusClass = 'badge-info';
      if (e.status === 'completed') statusClass = 'badge-ok';
      else if (e.status === 'failed') statusClass = 'badge-err';
      else if (e.status === 'timeout') statusClass = 'badge-warn';
      else if (e.status === 'running') statusClass = 'badge-info';
      statusBadge.className = 'badge ' + statusClass;
      statusBadge.textContent = e.status;
      tdStatus.appendChild(statusBadge);
      hRow.appendChild(tdStatus);

      hTbody.appendChild(hRow);
    }
    hTbl.appendChild(hTbody);
    container.appendChild(hTbl);
  }
}

function renderConsolidation(data) {
  var container = document.getElementById('consolidation-panel');
  if (!container) return;

  if (!data || !data.enabled) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Memory consolidation is disabled';
    container.appendChild(p);
    return;
  }

  container.textContent = '';

  // Per-tier breakdown table
  var perTier = data.perTier || {};
  var tierNames = ['working', 'ephemeral', 'persistent'];
  var hasTierData = false;

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Tier', 'Total', 'Clustered', 'Pending'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < tierNames.length; i++) {
    var name = tierNames[i];
    var t = perTier[name];
    if (!t) continue;
    hasTierData = true;

    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.style.textTransform = 'capitalize';
    tdName.textContent = name;
    row.appendChild(tdName);

    var tdTotal = document.createElement('td');
    tdTotal.style.textAlign = 'right';
    tdTotal.textContent = String(t.total);
    row.appendChild(tdTotal);

    var tdClustered = document.createElement('td');
    tdClustered.style.textAlign = 'right';
    tdClustered.textContent = String(t.clustered);
    row.appendChild(tdClustered);

    var tdPending = document.createElement('td');
    tdPending.style.textAlign = 'right';
    tdPending.textContent = String(t.pending);
    row.appendChild(tdPending);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);

  if (hasTierData) {
    container.appendChild(tbl);
  }

  // Lifetime stats summary
  var summary = document.createElement('p');
  summary.style.color = '#8b949e';
  summary.style.fontSize = '0.8rem';
  summary.style.marginTop = '8px';
  summary.textContent = data.totalRuns + ' run(s), ' + data.lifetimeSavings + ' entries saved, $' + (data.totalCostUsd || 0).toFixed(4) + ' total cost';
  container.appendChild(summary);
}

function renderDeployment(data) {
  var section = document.getElementById('deployment-section');
  var container = document.getElementById('deployment-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  container.textContent = '';

  var stats = data.stats || {};

  // Status indicators
  var statusDiv = document.createElement('div');
  statusDiv.style.marginBottom = '12px';

  var cbState = stats.circuitBreakerState || 'CLOSED';
  var cbColor = cbState === 'CLOSED' ? '#3fb950' : cbState === 'HALF_OPEN' ? '#f0883e' : '#da3633';

  var statusP = document.createElement('p');
  statusP.style.margin = '4px 0';
  var cbDot = document.createElement('span');
  cbDot.style.display = 'inline-block';
  cbDot.style.width = '8px';
  cbDot.style.height = '8px';
  cbDot.style.borderRadius = '50%';
  cbDot.style.backgroundColor = cbColor;
  cbDot.style.marginRight = '6px';
  statusP.appendChild(cbDot);
  statusP.appendChild(document.createTextNode('Circuit breaker: ' + cbState));
  statusDiv.appendChild(statusP);

  var statsP = document.createElement('p');
  statsP.style.color = '#8b949e';
  statsP.style.fontSize = '0.8rem';
  statsP.style.margin = '4px 0';
  statsP.textContent = 'Total: ' + (stats.totalDeployments || 0) + ' | Success: ' + (stats.successful || 0) + ' | Failed: ' + (stats.failed || 0);
  statusDiv.appendChild(statsP);

  container.appendChild(statusDiv);

  // Check button
  var checkBtn = document.createElement('button');
  checkBtn.textContent = 'Run Readiness Check';
  checkBtn.style.padding = '6px 12px';
  checkBtn.style.background = '#238636';
  checkBtn.style.color = '#fff';
  checkBtn.style.border = 'none';
  checkBtn.style.borderRadius = '4px';
  checkBtn.style.cursor = 'pointer';
  checkBtn.style.marginBottom = '12px';
  checkBtn.style.fontSize = '0.85rem';
  checkBtn.onclick = function() {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking...';
    fetch('/api/deployment/check', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        checkBtn.textContent = result.ready ? 'Ready' : 'Not Ready';
        checkBtn.style.background = result.ready ? '#238636' : '#6e7681';
        setTimeout(function() {
          checkBtn.disabled = false;
          checkBtn.textContent = 'Run Readiness Check';
          checkBtn.style.background = '#238636';
        }, 3000);
      })
      .catch(function() {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Run Readiness Check';
      });
  };
  container.appendChild(checkBtn);

  // Deployment history table
  var history = data.history || [];
  if (history.length > 0) {
    var histH = document.createElement('h3');
    histH.textContent = 'Recent Deployments';
    histH.style.color = '#c9d1d9';
    histH.style.fontSize = '0.95rem';
    histH.style.margin = '8px 0';
    container.appendChild(histH);

    var hTbl = document.createElement('table');
    var hThead = document.createElement('thead');
    var hHeadRow = document.createElement('tr');
    ['Timestamp', 'Status', 'Duration', 'Approved By'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      hHeadRow.appendChild(th);
    });
    hThead.appendChild(hHeadRow);
    hTbl.appendChild(hThead);

    var hTbody = document.createElement('tbody');
    for (var i = 0; i < history.length; i++) {
      var e = history[i];
      var hRow = document.createElement('tr');

      var tdTime = document.createElement('td');
      tdTime.textContent = new Date(e.proposedAt).toLocaleString();
      tdTime.style.fontSize = '0.8rem';
      hRow.appendChild(tdTime);

      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      var statusClass = 'badge-ok';
      if (e.status === 'failed' || e.status === 'post_verify_failed') statusClass = 'badge-err';
      else if (e.status === 'proposed' || e.status === 'executing') statusClass = 'badge-info';
      else if (e.status === 'cancelled') statusClass = 'badge-warn';
      statusBadge.className = 'badge ' + statusClass;
      statusBadge.textContent = e.status;
      tdStatus.appendChild(statusBadge);
      hRow.appendChild(tdStatus);

      var tdDuration = document.createElement('td');
      tdDuration.style.textAlign = 'right';
      tdDuration.textContent = e.duration != null ? e.duration + 'ms' : '-';
      hRow.appendChild(tdDuration);

      var tdApproved = document.createElement('td');
      tdApproved.textContent = e.approvedBy || '-';
      hRow.appendChild(tdApproved);

      hTbody.appendChild(hRow);
    }
    hTbl.appendChild(hTbody);
    container.appendChild(hTbl);
  } else {
    var noHist = document.createElement('p');
    noHist.style.color = '#8b949e';
    noHist.style.fontSize = '0.85rem';
    noHist.textContent = 'No deployment history';
    container.appendChild(noHist);
  }
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
<title>Strada Brain Dashboard</title>
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
<h1><span id="status-dot" class="status-dot"></span>Strada Brain Dashboard</h1>
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
  <h3 style="color:#c9d1d9;font-size:0.95rem;margin:16px 0 8px 0">Memory Consolidation</h3>
  <div id="consolidation-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="chain-resilience-section">
  <h2>Chain Resilience</h2>
  <div id="chain-resilience-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="agents-section" style="display:none">
  <h2>Agents</h2>
  <div id="agents-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="delegations-section" style="display:none">
  <h2>Delegations</h2>
  <div id="delegations-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<div class="section" id="deployment-section" style="display:none">
  <h2>Deployment</h2>
  <div id="deployment-panel"><p style="color:#8b949e">Loading...</p></div>
</div>

<p id="last-update"></p>

<script>${SCRIPT_CONTENT}</script>
</body>
</html>`;
