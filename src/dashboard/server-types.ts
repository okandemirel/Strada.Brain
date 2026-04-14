/**
 * Shared type definitions for dashboard route modules.
 *
 * These interfaces define the structural contracts that the DashboardServer
 * uses to interact with various subsystems. Extracted from server.ts to enable
 * route module decomposition.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillEntry } from "../skills/types.js";

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
import type { ProviderOfficialSnapshot } from "../agents/providers/provider-source-registry.js";
import type { BootReport } from "../common/capability-contract.js";
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
import { WebhookRateLimiter } from "../daemon/triggers/webhook-trigger.js";
import type { IdentityStateManager, IdentityState } from "../identity/identity-state.js";
import type { DaemonStorage } from "../daemon/daemon-storage.js";
import type { ChainResilienceConfig } from "../learning/chains/chain-types.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import type { AutoUpdater } from "../core/auto-updater.js";
import type { CanvasStorage } from "./canvas-storage.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import type { WebSocketDashboardServer } from "./websocket-server.js";
import type { MetricsCollector } from "./metrics.js";

export type { IdentityState, MemoryHealth, WebhookTrigger };
export { WebhookRateLimiter };

/** Structural interface for AgentManager methods used by the dashboard */
export interface DashboardAgentManager {
  getAllAgents(): Array<{
    id: string; key: string; channelType: string; chatId: string;
    status: string; createdAt: number; lastActivity: number;
    budgetCapUsd: number; memoryEntryCount: number;
  }>;
  getActiveCount(): number;
}

/** Structural interface for AgentBudgetTracker methods used by the dashboard */
export interface DashboardAgentBudgetTracker {
  getGlobalUsage(cap?: number): { usedUsd: number; limitUsd?: number; pct: number };
  getAllAgentUsages(): Map<string, number>;
}

/** Structural interface for DelegationLog methods used by dashboard (Plan 24-03) */
export interface DashboardDelegationLog {
  getHistory(limit?: number): Array<{
    id: number; parentAgentId: string; subAgentId: string; type: string;
    model: string; tier: string; depth: number; durationMs: number | undefined;
    costUsd: number | undefined; status: string; resultSummary: string | undefined;
    escalatedFrom: string | undefined; startedAt: number; completedAt: number | undefined;
  }>;
  getStats(): Array<{
    type: string; count: number; avgDurationMs: number; avgCostUsd: number;
    successRate: number; tierBreakdown: Record<string, number>;
  }>;
}

/** Structural interface for DelegationManager methods used by dashboard (Plan 24-03) */
export interface DashboardDelegationManager {
  getActiveDelegations(parentAgentId?: string): Array<{ subAgentId: string; type: string; startedAt: number }>;
}

/** Structural interface for MemoryConsolidationEngine methods used by dashboard (Plan 25-03) */
export interface DashboardConsolidationEngine {
  getStats(): {
    perTier: Record<string, { clustered: number; pending: number; total: number }>;
    lifetimeSavings: number;
    totalRuns: number;
    totalCostUsd: number;
  };
}

/** Structural interface for DeploymentExecutor methods used by dashboard (Plan 25-03) */
export interface DashboardDeploymentExecutor {
  getHistory(limit?: number): Array<{
    id: string; proposedAt: number; approvedAt?: number; approvedBy?: string;
    agentId?: string; status: string; scriptOutput?: string; duration?: number; error?: string;
  }>;
  getStats(): {
    totalDeployments: number; successful: number; failed: number;
    lastDeployment?: unknown; circuitBreakerState: string;
  };
}

/** Structural interface for ReadinessChecker used by dashboard (Plan 25-03) */
export interface DashboardReadinessChecker {
  checkReadiness(force?: boolean): Promise<{
    ready: boolean; reason?: string; testPassed: boolean;
    gitClean: boolean; branchMatch: boolean; timestamp: number; cached: boolean;
  }>;
}

/** Structural interface for SkillManager used by dashboard /api/skills endpoints */
export interface DashboardSkillManager {
  getEntries(): readonly SkillEntry[];
}

/** Structural interface for tool registry used by dashboard /api/tools endpoint */
export interface DashboardToolRegistry {
  getAllTools(): Array<{
    name: string;
    description: string;
    type?: string;
    category?: string;
    installed?: boolean;
    available?: boolean;
    requiresBridge?: boolean;
    readOnly?: boolean;
    availabilityReason?: string;
    dependencies?: string[];
    parameters?: unknown;
  }>;
}

/** Structural interface for orchestrator sessions used by dashboard /api/sessions endpoint */
export interface DashboardOrchestratorSessions {
  getSessions(): Map<string, { lastActivity: Date; messageCount: number }>;
}

/** Structural interface for SoulLoader used by dashboard /api/personality endpoint */
export interface DashboardSoulLoader {
  getContent(): string;
  getActiveProfile(): string;
  getProfiles(): string[];
  getChannelOverrides(): Record<string, string>;
  switchProfile(name: string): Promise<boolean>;
  saveProfile(name: string, content: string): Promise<boolean>;
  deleteProfile(name: string): Promise<boolean>;
}

/** Structural interface for ProviderRouter methods used by dashboard /api/agent-activity endpoint */
export interface DashboardProviderRouter {
  getRecentDecisions(n: number, identityKey?: string): Array<{
    provider: string;
    reason: string;
    task: { type: string; complexity: string; criticality: string };
    timestamp: number;
    catalogSignal?: {
      freshnessScore: number;
      alignmentScore: number;
      stale: boolean;
      updatedAt?: number;
    };
  }>;
  getRecentExecutionTraces?(n: number, identityKey?: string): Array<{
    provider: string;
    model?: string;
    role: string;
    phase: string;
    source: string;
    reason: string;
    task: { type: string; complexity: string; criticality: string };
    timestamp: number;
  }>;
  getRecentPhaseOutcomes?(n: number, identityKey?: string): Array<{
    provider: string;
    model?: string;
    role: string;
    phase: string;
    source: string;
    status: string;
    reason: string;
    task: { type: string; complexity: string; criticality: string };
    timestamp: number;
  }>;
  getPhaseScoreboard?(n: number, identityKey?: string): Array<{
    provider: string;
    role: string;
    phase: string;
    sampleSize: number;
    score: number;
    approvedCount: number;
    continuedCount: number;
    replannedCount: number;
    blockedCount: number;
    failedCount: number;
    verifierSampleSize: number;
    verifierCleanRate: number;
    rollbackRate: number;
    avgRetryCount: number;
    avgTokenCost: number;
    repeatedFailureCount: number;
    latestTimestamp: number;
    latestReason: string;
  }>;
  getPreset(): string;
  setPreset(preset: "budget" | "balanced" | "performance"): void;
}

/** Structural interface for provider management used by dashboard /api/providers endpoints */
export interface DashboardProviderManager {
  listAvailable(): Array<{
    name: string;
    configured: boolean;
    label?: string;
    defaultModel?: string;
    models?: string[];
    contextWindow?: number;
    thinkingSupported?: boolean;
    specialFeatures?: string[];
    officialSignals?: ProviderOfficialSnapshot["signals"];
    officialSourceUrls?: string[];
    catalogUpdatedAt?: number;
  }>;
  listExecutionCandidates?(identityKey?: string): Array<{
    name: string;
    configured: boolean;
    label?: string;
    defaultModel?: string;
    models?: string[];
    contextWindow?: number;
    thinkingSupported?: boolean;
    specialFeatures?: string[];
    officialSignals?: ProviderOfficialSnapshot["signals"];
    officialSourceUrls?: string[];
    catalogUpdatedAt?: number;
  }>;
  listAvailableWithModels?(): Promise<Array<{
    name: string;
    configured: boolean;
    label?: string;
    defaultModel?: string;
    models: string[];
    activeModel?: string;
    contextWindow?: number;
    thinkingSupported?: boolean;
    specialFeatures?: string[];
    officialSignals?: ProviderOfficialSnapshot["signals"];
    officialSourceUrls?: string[];
    catalogUpdatedAt?: number;
  }>>;
  describeAvailable?(): Array<{
    name: string;
    label: string;
    defaultModel: string;
    capabilities: {
      contextWindow?: number;
      vision?: boolean;
      thinkingSupported?: boolean;
      toolCalling?: boolean;
      streaming?: boolean;
      specialFeatures?: string[];
    } | null;
    officialSnapshot?: ProviderOfficialSnapshot | null;
  }>;
  getProviderCapabilities?(name: string, model?: string): {
    contextWindow?: number;
    vision?: boolean;
    thinkingSupported?: boolean;
    toolCalling?: boolean;
    streaming?: boolean;
    specialFeatures?: string[];
  } | undefined;
  refreshCatalog?(): Promise<{
    modelsUpdated: number;
    source: string;
    errors: string[];
  } | null>;
  getActiveInfo(chatId: string): {
    provider?: string;
    providerName?: string;
    model?: string;
    isDefault?: boolean;
    selectionMode?: "strada-preference-bias" | "strada-hard-pin";
    executionPolicyNote?: string;
  } | null;
  setPreference(
    chatId: string,
    provider: string,
    model?: string,
    selectionMode?: "strada-preference-bias" | "strada-hard-pin",
  ): Promise<void>;
}

/** Structural interface for task manager methods used by dashboard task/session endpoints. */
export interface DashboardTaskManager {
  listAllActiveTasks(): Array<{
    id: string;
    chatId: string;
    channelType: string;
    conversationId?: string;
    userId?: string;
    title: string;
    status: string;
    result?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
  }>;
  countActiveForegroundTasks(excludedChatIds?: readonly string[]): number;
}

/** Structural interface for user profile store used by dashboard /api/user endpoints */
export interface DashboardUserProfileStore {
  getProfile?(chatId: string): { preferences: Record<string, unknown>; activePersona?: string } | null;
  setActivePersona?(chatId: string, persona: string): void;
  setAutonomousMode(chatId: string, enabled: boolean, expiresAt?: number): Promise<void>;
  isAutonomousMode(chatId: string): Promise<{ enabled: boolean; expiresAt?: number; remainingMs?: number }>;
}

export interface DashboardEmbeddingStatusProvider {
  getStatus(): {
    state: "disabled" | "active" | "degraded";
    ragEnabled: boolean;
    configuredProvider: string;
    configuredModel?: string;
    configuredDimensions?: number;
    resolvedProviderName?: string;
    resolutionSource?: string;
    activeDimensions?: number;
    verified: boolean;
    usingHashFallback: boolean;
    notice?: string;
  };
}

/** Profile names that cannot be created or deleted via the API. */
export const SYSTEM_PROFILES = new Set(["default", "casual", "formal", "minimal"]);

/** Regex for valid profile names: alphanumeric, dashes, underscores. */
export const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Valid routing preset names. */
export const VALID_ROUTING_PRESETS = new Set(["budget", "balanced", "performance"]);

export const NO_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

export const DASHBOARD_IDENTITY_MAX_LENGTH = 128;

export function resolveDashboardIdentityKey(chatId: string, userId?: string | null, conversationId?: string | null): string {
  const normalizedUserId = userId?.trim();
  if (normalizedUserId) {
    return normalizedUserId;
  }

  const normalizedConversationId = conversationId?.trim();
  if (normalizedConversationId) {
    return normalizedConversationId;
  }

  return chatId;
}

export function isDashboardIdentityPartTooLong(value: string | null): boolean {
  return typeof value === "string" && value.length > DASHBOARD_IDENTITY_MAX_LENGTH;
}

/** Provider name validation regex. */
export const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Context object passed to route handler registration functions.
 * Provides access to all DashboardServer dependencies needed by route handlers.
 */
export interface RouteContext {
  // Core services
  memoryManager?: IMemoryManager;
  channel?: IChannelAdapter;
  metricsStorage?: MetricsStorage;
  learningStorage?: LearningStorage;
  runtimeArtifactManager?: Pick<RuntimeArtifactManager, "getRecentArtifactsForIdentity">;
  projectScopeFingerprint?: string;
  goalStorage?: GoalStorage;
  metrics: MetricsCollector;
  getMemoryStats: () => { totalEntries: number; hasAnalysisCache: boolean } | undefined;

  // Daemon context
  daemonHeartbeatLoop?: HeartbeatLoop;
  daemonRegistry?: TriggerRegistry;
  daemonApprovalQueue?: ApprovalQueue;
  webhookTriggers?: Map<string, WebhookTrigger>;
  webhookSecret?: string;
  webhookRateLimiter?: WebhookRateLimiter;
  dashboardToken?: string;
  identityManager?: IdentityStateManager;
  capabilityManifest?: string;
  daemonStorage?: DaemonStorage;
  historyDepth: number;
  triggerFireRetentionDays: number;
  startupNotices: string[];
  bootReport?: BootReport;
  autoUpdater?: AutoUpdater;

  // Chain resilience
  chainResilienceConfig?: ChainResilienceConfig;

  // Multi-agent
  agentManager?: DashboardAgentManager;
  agentBudgetTracker?: DashboardAgentBudgetTracker;

  // Delegation
  delegationLog?: DashboardDelegationLog;
  delegationManager?: DashboardDelegationManager;

  // Consolidation & Deployment
  consolidationEngine?: DashboardConsolidationEngine;
  deploymentExecutor?: DashboardDeploymentExecutor;
  readinessChecker?: DashboardReadinessChecker;

  // Strada deps
  stradaDeps?: StradaDepsStatus;

  // Extended services
  toolRegistry?: DashboardToolRegistry;
  orchestratorSessions?: DashboardOrchestratorSessions;
  soulLoader?: DashboardSoulLoader;
  configSnapshot?: () => Record<string, unknown>;

  // Provider and user profile
  providerManager?: DashboardProviderManager;
  userProfileStore?: DashboardUserProfileStore;
  embeddingStatusProvider?: DashboardEmbeddingStatusProvider;
  taskManager?: DashboardTaskManager;
  providerRouter?: DashboardProviderRouter;

  // Workspace
  workspaceBus?: WorkspaceBus;
  monitorActivityLog: import("./monitor-routes.js").MonitorActivityLog;
  canvasStorage?: CanvasStorage;
  projectRoot?: string;

  // Skills
  skillManager?: DashboardSkillManager;

  // Vault (Phase 1)
  vaultRegistry?: import("../vault/vault-registry.js").VaultRegistry;

  // Budget
  unifiedBudgetManager?: UnifiedBudgetManager;
  wsServer?: WebSocketDashboardServer;

  // Rate limiting state
  lastModelRefreshMs: number;
  setLastModelRefreshMs: (ms: number) => void;
  lastUpdateCheckMs: number;
  setLastUpdateCheckMs: (ms: number) => void;

  // Utility methods
  readJsonBody: <T>(req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<T | null>;
  getAutonomousDefaults: () => { enabled: boolean; hours: number };
}

/** Send a JSON error response. Reduces boilerplate across route modules. */
export function sendJsonError(res: ServerResponse, statusCode: number, error: string): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

/** Send a JSON success response. */
export function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
