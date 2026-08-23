import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import { isAllowedOrigin } from "../security/origin-validation.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
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
// DASHBOARD_HTML and its CSP hash are built from dashboard/templates/ at module load
import { handleDaemonRoutes } from "./server-daemon-routes.js";
import { handleMcpRoutes } from "./server-mcp-routes.js";
import { handleProviderRoutes } from "./server-provider-routes.js";
import { handlePersonalityRoutes } from "./server-personality-routes.js";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import { handleSkillsRoutes } from "./server-skills-routes.js";
import { handleSystemRoutes } from "./server-system-routes.js";
import { handleVaultRoutes, wireVaultUpdatesToWs } from "./server-vault-routes.js";


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

/** Vault search is embedding-backed and comparatively expensive; cap bursts per source IP. */
const VAULT_SEARCH_RATE_LIMIT_MAX = 30;
const VAULT_SEARCH_RATE_LIMIT_WINDOW_MS = 10_000;

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
  // Note: the dashboard binds to 127.0.0.1, so per-IP keying mostly yields one
  // loopback key — effectively a global throttle for local deployments, which
  // is the intended protection (runaway client / CSRF flood), not multi-tenant
  // fairness.
  private readonly vaultSearchRateLimiter = new WebhookRateLimiter(
    VAULT_SEARCH_RATE_LIMIT_MAX,
    VAULT_SEARCH_RATE_LIMIT_WINDOW_MS,
  );
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
  private llmProvider?: IAIProvider;
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
  private vaultFactory?: import("./server-vault-routes.js").VaultFactory;
  private vaultWsUnsubscribe?: () => void;

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
    llmProvider?: IAIProvider;
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
    this.llmProvider = services.llmProvider ?? this.llmProvider;
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
    // Guarded (merge-only) like every other field below: setDaemonContext is
    // called more than once (e.g. a later non-daemon call wires only the
    // identity manager), and an unconditional assignment here would null out
    // the daemon heartbeat loop / registry / approval queue set by the first call.
    if (ctx.heartbeatLoop) {
      this.daemonHeartbeatLoop = ctx.heartbeatLoop;
    }
    if (ctx.registry) {
      this.daemonRegistry = ctx.registry;
    }
    if (ctx.approvalQueue) {
      this.daemonApprovalQueue = ctx.approvalQueue;
    }

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
    this.wireVaultWsUpdates();
  }

  /**
   * Register the vault factory used by POST /api/vaults. Without this the
   * endpoint responds 503; the factory carries the embedding + vector-store
   * deps that are only available once bootstrap has initialized the vault
   * subsystem.
   */
  registerVaultFactory(factory: import("./server-vault-routes.js").VaultFactory): void {
    this.vaultFactory = factory;
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
    this.wireVaultWsUpdates();
  }

  private wireVaultWsUpdates(): void {
    this.vaultWsUnsubscribe?.();
    this.vaultWsUnsubscribe = undefined;
    if (!this.vaultRegistry || !this.wsServer) return;
    this.vaultWsUnsubscribe = wireVaultUpdatesToWs(this.vaultRegistry, {
      broadcast: (raw) => {
        const msg = JSON.parse(raw) as { type: "vault:update"; payload: unknown };
        this.wsServer?.broadcastAuthenticated({ type: msg.type, payload: msg.payload });
      },
    });
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
    const self = this;
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
      vaultSearchRateLimiter: this.vaultSearchRateLimiter,
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
      llmProvider: this.llmProvider,

      // Workspace
      workspaceBus: this.workspaceBus,
      monitorActivityLog: this.monitorActivityLog,
      canvasStorage: this.canvasStorage,
      projectRoot: this.projectRoot,

      // Skills
      skillManager: this.skillManager,
      vaultRegistry: this.vaultRegistry,
      vaultFactory: this.vaultFactory,

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
            clients: this.metrics.getActiveSessions(),
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

      // MCP bridge routes: mcp/status, mcp/reconnect
      if (handleMcpRoutes(url, method, req, res, ctx)) return;

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
        if (!this.dashboardToken) {
          logger.warn(
            "Dashboard started WITHOUT an auth token: mutable /api/* routes are protected only by same-origin checks. " +
            "Set WEBSOCKET_DASHBOARD_AUTH_TOKEN to require bearer authentication.",
          );
        }
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
    this.vaultWsUnsubscribe?.();
    this.vaultWsUnsubscribe = undefined;
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }
}

// --- Embedded Dashboard page (templates/, copied to dist by build-package) ---
// Extracted from a ~1,100-line inline literal so the page is lintable/diffable.
// The CSP hash must keep hashing EXACTLY the served script bytes.
const DASHBOARD_SCRIPT = readFileSync(new URL("./templates/dashboard.js", import.meta.url), "utf-8");
const SCRIPT_HASH = createHash("sha256").update(DASHBOARD_SCRIPT).digest("base64");
const DASHBOARD_HTML = readFileSync(new URL("./templates/dashboard.html", import.meta.url), "utf-8")
  .replace("__DASHBOARD_SCRIPT__", () => DASHBOARD_SCRIPT);
