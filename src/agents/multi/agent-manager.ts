/**
 * Agent Manager -- Core Multi-Agent Routing, Isolation & Lifecycle
 *
 * The AgentManager sits between message handlers and per-agent Orchestrators.
 * It provides:
 * - Session isolation: each channelType:chatId pair gets its own agent with
 *   separate Orchestrator and AgentDBMemory (AGENT-06)
 * - Budget enforcement: agents exceeding their cap are stopped (AGENT-01, AGENT-02)
 * - Lifecycle management: lazy creation, idle eviction, max concurrent limits
 * - Event emission: agent:created, agent:stopped, agent:budget_exceeded, agent:evicted
 *
 * Requirements: AGENT-01, AGENT-02, AGENT-06
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { IEventBus, LearningEventMap } from "../../core/event-bus.js";
import type { IncomingMessage } from "../../channels/channel-messages.interface.js";
import { detectCommand } from "../../tasks/command-detector.js";
import type { CommandHandler } from "../../tasks/command-handler.js";
import { buildBatchedPrompt, buildBurstOrQueueNotice } from "../../tasks/message-bursting.js";
import { getTaskConversationKey } from "../../tasks/types.js";
import type { TaskManager } from "../../tasks/task-manager.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import type { IRAGPipeline } from "../../rag/rag.interface.js";
import type { RateLimiter } from "../../security/rate-limiter.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { InstinctRetriever } from "../../agents/instinct-retriever.js";
import type { MetricsRecorder } from "../../metrics/metrics-recorder.js";
import type { GoalDecomposer } from "../../goals/goal-decomposer.js";
import type { IdentityState } from "../../identity/identity-state.js";
import type { ReRetrievalConfig, StradaDependencyConfig } from "../../config/config.js";
import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import type { DMPolicy } from "../../security/dm-policy.js";
import type { UserProfileStore } from "../../memory/unified/user-profile-store.js";
import type { MonitorLifecycle } from "../../dashboard/monitor-lifecycle.js";
import type { WorkspaceBus } from "../../dashboard/workspace-bus.js";
import type { SupervisorBrain } from "../../supervisor/supervisor-brain.js";
import { estimateCostWithCache } from "../../budget/cost-model.js";
import type { UnifiedBudgetManager } from "../../budget/unified-budget-manager.js";
import { getLogger, getLoggerSafe } from "../../utils/logger.js";
import { Orchestrator } from "../orchestrator.js";
import { AgentDBMemory } from "../../memory/unified/agentdb-memory.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import { AgentDBAdapter } from "../../memory/unified/agentdb-adapter.js";
import {
  createAgentId,
  resolveAgentKey,
  type AgentConfig,
  type AgentId,
  type AgentInstance,
  type AgentLifecycleEvent,
} from "./agent-types.js";

// =============================================================================
// TYPES
// =============================================================================

/** Tool registry interface -- only the method we need */
interface ToolRegistryLike {
  getAllTools(): ITool[];
}

/** Configuration for per-agent memory creation */
export interface MemoryConfig {
  readonly dimensions: number;
  readonly dbBasePath: string;
}

/** Options for constructing an AgentManager */
export interface AgentManagerOptions {
  /**
   * One authorization store shared with the root Orchestrator.
   *
   * A sub-agent's message is the sub-goal, not the user's request, and goal
   * decomposition drops absolute paths from it — measured, "read
   * /Users/okan/Downloads/PixelFlow_GDD.docx" became "read
   * PixelFlow_GDD.docx", leaving the sub-agent unable to derive the
   * authorization and refusing the document its task was about.
   */
  readonly authorizedPathsStore?: Map<string, readonly string[]>;
  /**
   * Live framework knowledge for sub-agent orchestrators.
   *
   * Only bootstrap's Orchestrator was given one, so every sub-agent and
   * delegated agent fell back to the static STRADA_SYSTEM_PROMPT — no Core
   * namespaces, no base classes, no MCP tool list, no generator guidance. In a
   * multi-agent run that is most of the work being done by an agent that
   * cannot see the framework it is supposed to conform to.
   */
  readonly frameworkPromptGenerator?: () => import("../../intelligence/framework/framework-prompt-generator.js").FrameworkPromptGenerator | undefined;
  readonly config: AgentConfig;
  readonly registry: AgentRegistry;
  readonly budgetTracker: AgentBudgetTracker;
  readonly eventBus: IEventBus<LearningEventMap>;
  // Shared resources passed to all agent Orchestrators
  readonly providerManager: ProviderManager;
  readonly toolRegistry: ToolRegistryLike;
  readonly channel: IChannelAdapter;
  readonly projectPath: string;
  readonly readOnly: boolean;
  readonly requireConfirmation: boolean;
  readonly metrics?: MetricsCollector;
  readonly ragPipeline?: IRAGPipeline;
  readonly rateLimiter?: RateLimiter;
  readonly defaultLanguage?: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
  readonly streamInitialTimeoutMs?: number;
  readonly streamStallTimeoutMs?: number;
  readonly stradaDeps: StradaDepsStatus;
  readonly stradaConfig?: Partial<StradaDependencyConfig>;
  readonly instinctRetriever?: InstinctRetriever;
  readonly metricsRecorder?: MetricsRecorder;
  readonly goalDecomposer?: GoalDecomposer;
  readonly getIdentityState?: () => IdentityState;
  readonly reRetrievalConfig?: ReRetrievalConfig;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly memoryConfig: MemoryConfig;
  readonly soulLoader?: import("../../agents/soul/index.js").SoulLoader;
  readonly dmPolicy?: DMPolicy;
  readonly userProfileStore?: UserProfileStore;
  readonly messageBurstWindowMs?: number;
  readonly maxBurstMessages?: number;
  readonly supervisorBrain?: SupervisorBrain;
  readonly goalStorage?: import("../../goals/goal-storage.js").GoalStorage;
  readonly vaultRegistry?: import("../../vault/vault-registry.js").VaultRegistry;
  readonly vaultWriteHookBudgetMs?: number;
}

/** In-memory representation of a running agent with its resources */
interface LiveAgent {
  instance: AgentInstance;
  orchestrator: Orchestrator;
  memory: AgentDBMemory;
}

interface PendingBackgroundBatch {
  liveAgent: LiveAgent;
  messages: IncomingMessage[];
  timer: ReturnType<typeof setTimeout> | null;
}

type BackgroundTaskSubmitter = (
  msg: IncomingMessage,
  agent: AgentInstance,
  orchestrator: Orchestrator,
) => Promise<void> | void;

const QUEUE_NOTICE_COOLDOWN_MS = 15_000;

// =============================================================================
// AGENT MANAGER
// =============================================================================

export class AgentManager {
  private readonly config: AgentConfig;
  private readonly registry: AgentRegistry;
  private readonly budgetTracker: AgentBudgetTracker;
  private readonly eventBus: IEventBus<LearningEventMap>;
  private readonly opts: AgentManagerOptions;

  /** Live agents keyed by channelType:chatId */
  private readonly agents = new Map<string, LiveAgent>();

  /** In-flight agent creation promises to prevent duplicate creation races */
  private readonly creating = new Map<string, Promise<LiveAgent>>();

  /**
   * In-flight request counts keyed by agent key. An agent with active requests
   * must not be evicted (its memory would be shut down mid-request, causing a
   * use-after-shutdown of getStats()/handleMessage).
   */
  private readonly inFlightRequests = new Map<string, number>();

  /** Idle check interval handle */
  private idleCheckInterval: ReturnType<typeof setInterval> | undefined;

  /** Optional factory for injecting delegation tools per-agent (Phase 24) */
  private delegationToolFactory?: (parentAgentId: AgentId, depth: number) => ITool[];

  /** Optional unified budget manager for cross-source cost tracking */
  private _unifiedBudgetManager?: UnifiedBudgetManager;

  /** Optional command handler for intercepting prefix commands before LLM routing */
  private commandHandler?: CommandHandler;

  /** Optional submitter for routing plain messages into background task execution */
  private backgroundTaskSubmitter?: BackgroundTaskSubmitter;
  private readonly pendingBackgroundBatches = new Map<string, PendingBackgroundBatch>();
  private readonly queueNoticeCooldowns = new Map<string, number>();
  private readonly messageBurstWindowMs: number;
  private readonly maxBurstMessages: number;
  private taskManager?: Pick<TaskManager, "listActiveTasks">;
  private workspaceBus?: WorkspaceBus;
  private monitorLifecycle?: MonitorLifecycle;

  constructor(opts: AgentManagerOptions) {
    this.config = opts.config;
    this.registry = opts.registry;
    this.budgetTracker = opts.budgetTracker;
    this.eventBus = opts.eventBus;
    this.opts = opts;
    this.messageBurstWindowMs = opts.messageBurstWindowMs ?? 0;
    this.maxBurstMessages = opts.maxBurstMessages ?? 1;

    // Start periodic idle eviction check (half the timeout interval)
    if (this.config.idleTimeoutMs > 0) {
      this.idleCheckInterval = setInterval(
        () => this.evictIdleAgents(),
        Math.max(this.config.idleTimeoutMs / 2, 1000),
      );
      // Unref so it doesn't keep the process alive
      if (this.idleCheckInterval && typeof this.idleCheckInterval === "object" && "unref" in this.idleCheckInterval) {
        (this.idleCheckInterval as NodeJS.Timeout).unref();
      }
    }
  }

  // ===========================================================================
  // Public API -- Delegation Factory (Phase 24)
  // ===========================================================================

  /**
   * Set a factory function that creates delegation tools for each agent.
   * Called by bootstrap when task delegation is enabled (AGENT-03, AGENT-04, AGENT-05).
   */
  setDelegationFactory(factory: (parentAgentId: AgentId, depth: number) => ITool[]): void {
    this.delegationToolFactory = factory;
  }

  setUnifiedBudgetManager(mgr: UnifiedBudgetManager): void {
    this._unifiedBudgetManager = mgr;
  }

  /** Set the command handler so prefix commands bypass the LLM pipeline */
  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /** Route non-command messages into the background task system instead of interactive LLM turns. */
  setBackgroundTaskSubmitter(submitter: BackgroundTaskSubmitter): void {
    this.backgroundTaskSubmitter = submitter;
  }

  setTaskManager(taskManager: Pick<TaskManager, "listActiveTasks">): void {
    this.taskManager = taskManager;
  }

  setWorkspaceRuntime(workspaceBus: WorkspaceBus, monitorLifecycle: MonitorLifecycle): void {
    this.workspaceBus = workspaceBus;
    this.monitorLifecycle = monitorLifecycle;
    for (const liveAgent of this.agents.values()) {
      liveAgent.orchestrator.setWorkspaceBus(workspaceBus);
      liveAgent.orchestrator.setMonitorLifecycle(monitorLifecycle);
    }
  }

  // ===========================================================================
  // Public API -- Routing
  // ===========================================================================

  /**
   * Route an incoming message to the appropriate agent.
   * Creates agent lazily on first message. Enforces budget and status checks.
   */
  async routeMessage(msg: IncomingMessage): Promise<string | void> {
    // Intercept prefix commands before routing to agent/LLM (instant response)
    if (this.commandHandler && msg.text.trim()) {
      const classification = detectCommand(msg.text);
      if (classification.type === "command") {
        await this.commandHandler.handle(msg.chatId, classification.command, classification.args, msg.userId);
        return;
      }
    }

    const liveAgent = await this.resolveAgent(msg);

    // Budget check before processing
    if (this.budgetTracker.isAgentExceeded(liveAgent.instance.id, liveAgent.instance.budgetCapUsd)) {
      // Update status to budget_exceeded
      this.registry.updateStatus(liveAgent.instance.id, "budget_exceeded");
      liveAgent.instance = { ...liveAgent.instance, status: "budget_exceeded" };

      // Emit budget exceeded event
      const usage = this.budgetTracker.getAgentUsage(liveAgent.instance.id, liveAgent.instance.budgetCapUsd);
      this.eventBus.emit("agent:budget_exceeded", {
        ...this.buildLifecycleEvent(liveAgent.instance),
        usedUsd: usage.usedUsd,
        capUsd: liveAgent.instance.budgetCapUsd,
        pct: usage.pct,
      });

      return `Agent budget exceeded ($${usage.usedUsd.toFixed(2)} / $${liveAgent.instance.budgetCapUsd.toFixed(2)}). Please increase the budget or wait for the rolling window to reset.`;
    }

    // Check if agent is stopped
    if (liveAgent.instance.status === "stopped") {
      return "Agent is stopped. Use startAgent to resume.";
    }

    // Update lastActivity
    const now = Date.now();
    this.registry.updateLastActivity(liveAgent.instance.id, now);
    liveAgent.instance = { ...liveAgent.instance, lastActivity: now };

    if (this.backgroundTaskSubmitter) {
      if (this.messageBurstWindowMs > 0 && this.maxBurstMessages > 1) {
        this.bufferBackgroundMessage(msg, liveAgent);
      } else {
        const queuedBehindActiveTask = this.hasActiveTaskForConversation(msg);
        await this.backgroundTaskSubmitter(msg, liveAgent.instance, liveAgent.orchestrator);
        await this.sendBurstOrQueueNotice(
          [msg],
          queuedBehindActiveTask,
          getTaskConversationKey(msg.chatId, msg.channelType, msg.conversationId),
          msg.chatId,
        );
        this.syncMemoryCount(liveAgent);
      }
      return;
    }

    // Route through agent's orchestrator. Mark the agent busy so a concurrent
    // idle-eviction sweep cannot shut down its memory mid-request.
    const requestKey = liveAgent.instance.key;
    this.beginRequest(requestKey);
    try {
      return await liveAgent.orchestrator.handleMessage(msg);
    } finally {
      this.endRequest(requestKey);
      this.syncMemoryCount(liveAgent);
    }
  }

  /** Mark an agent as having an in-flight request (eviction guard). */
  private beginRequest(key: string): void {
    this.inFlightRequests.set(key, (this.inFlightRequests.get(key) ?? 0) + 1);
  }

  /** Release an in-flight request marker for an agent. */
  private endRequest(key: string): void {
    const next = (this.inFlightRequests.get(key) ?? 0) - 1;
    if (next <= 0) {
      this.inFlightRequests.delete(key);
    } else {
      this.inFlightRequests.set(key, next);
    }
  }

  /** True when the agent has at least one in-flight request and must not be evicted. */
  private isAgentBusy(key: string): boolean {
    return (this.inFlightRequests.get(key) ?? 0) > 0;
  }

  // ===========================================================================
  // Public API -- Lifecycle
  // ===========================================================================

  /** Stop an agent (prevents message routing) */
  async stopAgent(id: AgentId, force?: boolean): Promise<void> {
    const liveAgent = this.findLiveAgentById(id);
    if (!liveAgent) return;

    // Clean up pending background batches for this agent. The buffered
    // messages were never submitted and never acknowledged; the process and
    // channel are still alive here, so the user is told which ones were not
    // started instead of hearing nothing (audited 2026-09-02).
    const batch = this.pendingBackgroundBatches.get(liveAgent.instance.key);
    if (batch) {
      if (batch.timer) clearTimeout(batch.timer);
      this.pendingBackgroundBatches.delete(liveAgent.instance.key);
      this.reportDroppedBurst("stopAgent", [batch]);
      if (batch.messages.length > 0) {
        const chatId = batch.messages[0]!.chatId;
        const listed = batch.messages.map((m) => `- ${m.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
        const count = batch.messages.length;
        try {
          await this.opts.channel.sendText(
            chatId,
            `Agent stopped: ${count} message${count === 1 ? "" : "s"} you sent ${count === 1 ? "was" : "were"} not started. Resend after restarting the agent:\n${listed}`,
          );
        } catch (err) {
          getLoggerSafe().warn("Failed to send the dropped-message notice", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    this.registry.updateStatus(id, "stopped");
    liveAgent.instance = { ...liveAgent.instance, status: "stopped" };

    if (force) {
      liveAgent.orchestrator.cleanupSessions();
      await liveAgent.memory.shutdown();
      this.agents.delete(liveAgent.instance.key);
    }

    this.eventBus.emit("agent:stopped", this.buildLifecycleEvent(liveAgent.instance));
  }

  /** Restart a stopped agent */
  async startAgent(id: AgentId): Promise<void> {
    // Check if already in memory
    let liveAgent = this.findLiveAgentById(id);

    if (!liveAgent) {
      // Reload from registry
      const persisted = this.registry.getById(id);
      if (!persisted) return;

      liveAgent = await this.loadAgent(persisted);
    }

    this.registry.updateStatus(id, "active");
    liveAgent.instance = { ...liveAgent.instance, status: "active" };

    this.eventBus.emit("agent:started", this.buildLifecycleEvent(liveAgent.instance));
  }

  /** Evict agents that have been idle longer than idleTimeoutMs */
  evictIdleAgents(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [key, liveAgent] of this.agents) {
      if (
        (liveAgent.instance.status === "active" || liveAgent.instance.status === "budget_exceeded") &&
        now - liveAgent.instance.lastActivity > this.config.idleTimeoutMs &&
        // Never evict an agent with an in-flight request: shutting down its
        // memory mid-request would cause a use-after-shutdown in handleMessage
        // / syncMemoryCount.
        !this.isAgentBusy(key)
      ) {
        toEvict.push(key);
      }
    }

    for (const key of toEvict) {
      const liveAgent = this.agents.get(key)!;
      void this.evictAgent(key, liveAgent);
    }
  }

  /** Gracefully shut down all agents */
  async shutdown(): Promise<void> {
    // Stop idle check interval
    if (this.idleCheckInterval !== undefined) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

    // Buffered (un-flushed) burst messages are deliberately dropped here, as
    // in MessageRouter.dispose(): submitting during teardown would create a
    // task the same shutdown immediately fails, and nothing has been promised
    // to the user yet. Dropping SILENTLY was the defect — no row, no notice,
    // no log line; the request left no trace (audited 2026-09-02).
    const dropped = [...this.pendingBackgroundBatches.values()];
    for (const batch of dropped) {
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
    }
    this.pendingBackgroundBatches.clear();
    this.reportDroppedBurst("shutdown", dropped);

    // Close all agent resources
    const closePromises: Promise<unknown>[] = [];
    for (const [, liveAgent] of this.agents) {
      liveAgent.orchestrator.cleanupSessions();
      closePromises.push(liveAgent.memory.shutdown());
    }

    await Promise.allSettled(closePromises);
    this.agents.clear();
  }

  // ===========================================================================
  // Public API -- Query
  // ===========================================================================

  /** Get agent instance by id (from registry) */
  getAgent(id: AgentId): AgentInstance | undefined {
    return this.registry.getById(id);
  }

  /** Get the live orchestrator for an in-memory agent. */
  getLiveOrchestrator(id: AgentId): Orchestrator | undefined {
    return this.findLiveAgentById(id)?.orchestrator;
  }

  /** Get all agent instances (from registry) */
  getAllAgents(): AgentInstance[] {
    return this.registry.getAll();
  }

  /** Get count of currently live (in-memory) agents */
  getActiveCount(): number {
    return this.agents.size;
  }

  /** Update budget cap for an agent */
  setBudgetCap(id: AgentId, capUsd: number): void {
    // Update in registry
    const persisted = this.registry.getById(id);
    if (!persisted) return;

    const updated: AgentInstance = { ...persisted, budgetCapUsd: capUsd };
    this.registry.upsert(updated);

    // Update in-memory if live
    const liveAgent = this.findLiveAgentById(id);
    if (liveAgent) {
      liveAgent.instance = { ...liveAgent.instance, budgetCapUsd: capUsd };
    }
  }

  // ===========================================================================
  // Private -- Agent Resolution
  // ===========================================================================

  /**
   * Resolve a live agent for a message. Checks in-memory Map first,
   * then registry (persisted from previous run), then creates new.
   * Uses a creation lock to prevent duplicate agents from concurrent calls.
   */
  private async resolveAgent(msg: IncomingMessage): Promise<LiveAgent> {
    const stableConversationId = msg.conversationId?.trim() || msg.chatId;
    const key = resolveAgentKey(msg.channelType, stableConversationId);

    // 1. Check in-memory Map
    const existing = this.agents.get(key);
    if (existing) return this.syncLiveAgentChatId(existing, msg.chatId);

    // 2. Check if creation is already in-flight for this key (race guard)
    const inflight = this.creating.get(key);
    if (inflight) return inflight;

    // 3. Check registry (may have been persisted from a previous run)
    const persisted = this.registry.getByKey(key);
    if (persisted) {
      const loadPromise = this.loadAgent(persisted).then((liveAgent) => {
        // I1: Reset status to active if agent was previously evicted
        if (liveAgent.instance.status === "evicted") {
          this.registry.updateStatus(liveAgent.instance.id, "active");
          liveAgent.instance = { ...liveAgent.instance, status: "active" };
        }
        return this.syncLiveAgentChatId(liveAgent, msg.chatId);
      });
      this.creating.set(key, loadPromise);
      try {
        return await loadPromise;
      } finally {
        this.creating.delete(key);
      }
    }

    // 4. Create new agent (with race guard)
    const createPromise = this.createAgent(key, msg.channelType, msg.chatId);
    this.creating.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      this.creating.delete(key);
    }
  }

  /** Create a new agent for a channelType:chatId key */
  private async createAgent(
    key: string,
    channelType: IncomingMessage["channelType"],
    chatId: string,
  ): Promise<LiveAgent> {
    // Enforce maxConcurrent: evict oldest idle if at capacity
    if (this.agents.size >= this.config.maxConcurrent) {
      this.evictOldestIdle();
    }

    const id = createAgentId();
    const now = Date.now();

    const { memory, orchestrator } = await this.buildAgentResources(id);

    // Build instance
    const instance: AgentInstance = {
      id,
      key,
      channelType,
      chatId,
      status: "active",
      createdAt: now,
      lastActivity: now,
      budgetCapUsd: this.config.defaultBudgetUsd,
      memoryEntryCount: 0,
    };

    // Persist to registry
    this.registry.upsert(instance);

    // Build live agent
    const liveAgent: LiveAgent = { instance, orchestrator, memory };
    this.agents.set(key, liveAgent);
    this.syncMemoryCount(liveAgent);

    this.eventBus.emit("agent:created", this.buildLifecycleEvent(instance));

    return liveAgent;
  }

  /** Reload a persisted agent from disk (re-create Orchestrator + open memory) */
  private async loadAgent(persisted: AgentInstance): Promise<LiveAgent> {
    const { memory, orchestrator } = await this.buildAgentResources(persisted.id);

    const liveAgent: LiveAgent = { instance: persisted, orchestrator, memory };
    this.agents.set(persisted.key, liveAgent);
    this.syncMemoryCount(liveAgent);

    return liveAgent;
  }

  /** Create per-agent memory and orchestrator for a given agent id */
  private async buildAgentResources(agentId: AgentId): Promise<{ memory: AgentDBMemory; orchestrator: Orchestrator }> {
    // L2: Validate agent ID format before using in path construction
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(agentId)) {
      throw new Error(`Invalid agent ID format: ${agentId}`);
    }

    const agentMemoryDir = join(this.opts.memoryConfig.dbBasePath, "agents", agentId);
    try {
      mkdirSync(agentMemoryDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    // The per-agent maxMemoryEntries cap is enforced at the routing boundary via
    // enforceMemoryCap() (AgentDBMemory itself bounds growth per-tier).
    const memory = new AgentDBMemory({
      dbPath: agentMemoryDir,
      dimensions: this.opts.memoryConfig.dimensions,
    });
    await memory.initialize();

    const adapter = new AgentDBAdapter(memory);
    const profileStore = this.opts.userProfileStore ?? adapter.getUserProfileStore() ?? undefined;

    const orchestrator = new Orchestrator({
      providerManager: this.opts.providerManager,
      tools: this.opts.toolRegistry.getAllTools(),
      channel: this.opts.channel,
      projectPath: this.opts.projectPath,
      readOnly: this.opts.readOnly,
      requireConfirmation: this.opts.requireConfirmation,
      memoryManager: adapter,
      metrics: this.opts.metrics,
      ragPipeline: this.opts.ragPipeline,
      rateLimiter: this.opts.rateLimiter,
      defaultLanguage: this.opts.defaultLanguage,
      streamInitialTimeoutMs: this.opts.streamInitialTimeoutMs,
      streamStallTimeoutMs: this.opts.streamStallTimeoutMs,
      stradaDeps: this.opts.stradaDeps,
      stradaConfig: this.opts.stradaConfig,
      instinctRetriever: this.opts.instinctRetriever,
      eventEmitter: this.eventBus,
      metricsRecorder: this.opts.metricsRecorder,
      goalDecomposer: this.opts.goalDecomposer,
      getIdentityState: this.opts.getIdentityState,
      reRetrievalConfig: this.opts.reRetrievalConfig,
      embeddingProvider: this.opts.embeddingProvider,
      userProfileStore: profileStore,
      authorizedPathsStore: this.opts.authorizedPathsStore,
      soulLoader: this.opts.soulLoader,
      dmPolicy: this.opts.dmPolicy,
      supervisorBrain: this.opts.supervisorBrain,
      vaultRegistry: this.opts.vaultRegistry,
      vaultWriteHookBudgetMs: this.opts.vaultWriteHookBudgetMs,
      onUsage: (usage) => {
        // Cache-aware pricing + concrete model attribution (see buildUsageRecorder
        // in background-executor for the full rationale).
        const costUsd = estimateCostWithCache(usage, usage.provider);
        if (costUsd <= 0) {
          return;
        }
        const model = usage.model ?? usage.provider;
        if (this._unifiedBudgetManager) {
          this._unifiedBudgetManager.recordCost(costUsd, "agent", {
            model,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            agentId,
          });
        }
        this.budgetTracker.recordCost(agentId, costUsd, {
          model,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
        });
      },
    });

    // Without this a sub-agent runs on the static STRADA_SYSTEM_PROMPT and
    // cannot see the installed framework at all.
    // A getter, not the instance: bootstrap builds the generator in a deferred
    // async step that may finish after these managers are constructed.
    const frameworkGenerator = this.opts.frameworkPromptGenerator?.();
    if (frameworkGenerator) {
      orchestrator.setFrameworkPromptGenerator(frameworkGenerator);
    }
    if (this.workspaceBus) {
      orchestrator.setWorkspaceBus(this.workspaceBus);
    }
    if (this.monitorLifecycle) {
      orchestrator.setMonitorLifecycle(this.monitorLifecycle);
    }
    if (this.opts.goalStorage) {
      orchestrator.setGoalStorage(this.opts.goalStorage);
    }

    // Inject delegation tools if factory is available (Phase 24)
    if (this.delegationToolFactory) {
      const delegationTools = this.delegationToolFactory(agentId, 0);
      for (const tool of delegationTools) {
        orchestrator.addTool(tool);
      }
    }

    return { memory, orchestrator };
  }

  private syncLiveAgentChatId(liveAgent: LiveAgent, chatId: string): LiveAgent {
    if (liveAgent.instance.chatId === chatId) {
      return liveAgent;
    }

    liveAgent.instance = {
      ...liveAgent.instance,
      chatId,
    };
    this.registry.upsert(liveAgent.instance);
    return liveAgent;
  }

  /** Name every buffered message a teardown throws away — count, chats and a
   *  text sample — so an operator can see what the user is still waiting on. */
  private reportDroppedBurst(site: "shutdown" | "stopAgent", batches: readonly PendingBackgroundBatch[]): void {
    const messages = batches.flatMap((b) => b.messages);
    if (messages.length === 0) return;
    getLoggerSafe().warn("Buffered burst messages dropped without being submitted", {
      site,
      messages: messages.length,
      chatIds: [...new Set(messages.map((m) => m.chatId))],
      sample: messages.slice(0, 5).map((m) => m.text.replace(/\s+/g, " ").slice(0, 120)),
    });
  }

  private bufferBackgroundMessage(msg: IncomingMessage, liveAgent: LiveAgent): void {
    const existing = this.pendingBackgroundBatches.get(liveAgent.instance.key);
    if (existing) {
      existing.liveAgent = liveAgent;
      existing.messages.push(msg);
      if (existing.messages.length >= this.maxBurstMessages) {
        void this.flushBackgroundBatch(liveAgent.instance.key);
        return;
      }
      this.scheduleBackgroundBatchFlush(liveAgent.instance.key, existing);
      return;
    }

    const batch: PendingBackgroundBatch = {
      liveAgent,
      messages: [msg],
      timer: null,
    };
    this.pendingBackgroundBatches.set(liveAgent.instance.key, batch);
    this.scheduleBackgroundBatchFlush(liveAgent.instance.key, batch);
  }

  private scheduleBackgroundBatchFlush(key: string, batch: PendingBackgroundBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    batch.timer = setTimeout(() => {
      void this.flushBackgroundBatch(key);
    }, this.messageBurstWindowMs);
  }

  private async flushBackgroundBatch(key: string): Promise<void> {
    const batch = this.pendingBackgroundBatches.get(key);
    if (!batch || !this.backgroundTaskSubmitter) {
      return;
    }

    this.pendingBackgroundBatches.delete(key);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }

    const latest = batch.messages[batch.messages.length - 1];
    if (!latest) {
      return;
    }

    const attachments = batch.messages.flatMap((message) => message.attachments ?? []);
    const conversationKey = getTaskConversationKey(
      latest.chatId,
      latest.channelType,
      latest.conversationId,
    );
    const queuedBehindActiveTask = this.hasActiveTaskForConversation(latest);
    const merged: IncomingMessage = {
      ...latest,
      attachments: attachments.length > 0 ? attachments : undefined,
      text: this.buildBatchedPrompt(batch.messages),
    };

    try {
      getLogger().info("AgentManager submitted batched background work", {
        key,
        burstCount: batch.messages.length,
        promptLength: merged.text.length,
      });
    } catch {
      // Logger may be intentionally absent in isolated tests.
    }

    await this.backgroundTaskSubmitter(merged, batch.liveAgent.instance, batch.liveAgent.orchestrator);
    await this.sendBurstOrQueueNotice(
      batch.messages,
      queuedBehindActiveTask,
      conversationKey,
      latest.chatId,
    );
    this.syncMemoryCount(batch.liveAgent);
  }

  private buildBatchedPrompt(messages: IncomingMessage[]): string {
    return buildBatchedPrompt(messages);
  }

  private hasActiveTaskForConversation(msg: Pick<IncomingMessage, "chatId" | "channelType" | "conversationId">): boolean {
    if (!this.taskManager) {
      return false;
    }
    const conversationKey = getTaskConversationKey(msg.chatId, msg.channelType, msg.conversationId);
    return this.taskManager.listActiveTasks(msg.chatId).some((task) =>
      getTaskConversationKey(task.chatId, task.channelType, task.conversationId) === conversationKey,
    );
  }

  private async sendBurstOrQueueNotice(
    messages: readonly IncomingMessage[],
    queuedBehindActiveTask: boolean,
    conversationKey: string,
    chatId: string,
  ): Promise<void> {
    const notice = buildBurstOrQueueNotice(messages, queuedBehindActiveTask);
    if (!notice || typeof this.opts.channel.sendText !== "function") {
      return;
    }

    if (queuedBehindActiveTask) {
      const cooldownUntil = this.queueNoticeCooldowns.get(conversationKey) ?? 0;
      if (Date.now() < cooldownUntil) {
        return;
      }
      this.queueNoticeCooldowns.set(conversationKey, Date.now() + QUEUE_NOTICE_COOLDOWN_MS);
    }

    try {
      await this.opts.channel.sendText(chatId, notice);
    } catch (error) {
      getLogger().warn("Failed to send multi-agent queue/burst notice", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ===========================================================================
  // Private -- Eviction
  // ===========================================================================

  /** Evict the oldest idle agent to make room for a new one */
  private evictOldestIdle(): void {
    const now = Date.now();
    let oldestKey: string | undefined;
    let oldestActivity = Infinity;

    for (const [key, liveAgent] of this.agents) {
      // Only consider agents that are actually idle (past the timeout threshold)
      // and have no in-flight request (eviction would shut down memory mid-request).
      if (now - liveAgent.instance.lastActivity > this.config.idleTimeoutMs &&
          liveAgent.instance.lastActivity < oldestActivity &&
          !this.isAgentBusy(key)) {
        oldestActivity = liveAgent.instance.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const liveAgent = this.agents.get(oldestKey)!;
      void this.evictAgent(oldestKey, liveAgent);
    }
    // If no truly idle agent exists, do NOT evict an active agent.
    // The new agent will temporarily exceed maxConcurrent, which is safer
    // than evicting an agent that is actively processing requests.
  }

  /** Evict a specific agent: close memory, remove from map, update registry, emit event */
  private async evictAgent(key: string, liveAgent: LiveAgent): Promise<void> {
    // Clean up orchestrator sessions
    liveAgent.orchestrator.cleanupSessions();

    // Remove from in-memory map (synchronous — visible to callers immediately)
    this.agents.delete(key);

    // Update registry status
    this.registry.updateStatus(liveAgent.instance.id, "evicted");

    this.eventBus.emit("agent:evicted", this.buildLifecycleEvent(liveAgent.instance));

    // Close memory last (awaited so SQLite flushes properly)
    await liveAgent.memory.shutdown();
  }

  // ===========================================================================
  // Private -- Lookup
  // ===========================================================================

  /** Find a live agent by its id (iterates the map) */
  private findLiveAgentById(id: AgentId): LiveAgent | undefined {
    for (const liveAgent of this.agents.values()) {
      if (liveAgent.instance.id === id) {
        return liveAgent;
      }
    }
    return undefined;
  }

  /** Build lifecycle event payload from an agent instance */
  private buildLifecycleEvent(instance: AgentInstance): AgentLifecycleEvent {
    return {
      agentId: instance.id,
      key: instance.key,
      channelType: instance.channelType,
      chatId: instance.chatId,
      timestamp: Date.now(),
    };
  }

  private syncMemoryCount(liveAgent: LiveAgent): void {
    // The agent may have been evicted (memory shut down + removed from the map)
    // between capturing liveAgent and reaching here. Reading getStats() on a
    // shut-down memory is a use-after-shutdown; skip silently if it is no longer live.
    if (this.agents.get(liveAgent.instance.key) !== liveAgent) {
      return;
    }

    let totalEntries: number;
    try {
      totalEntries = liveAgent.memory.getStats().totalEntries;
    } catch (error) {
      try {
        getLogger().debug("Skipping memory-count sync for inactive agent", {
          agentId: liveAgent.instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Logger may be intentionally absent in isolated tests.
      }
      return;
    }

    this.enforceMemoryCap(liveAgent, totalEntries);

    if (liveAgent.instance.memoryEntryCount === totalEntries) {
      return;
    }

    this.registry.updateMemoryCount(liveAgent.instance.id, totalEntries);
    liveAgent.instance = { ...liveAgent.instance, memoryEntryCount: totalEntries };
  }

  /**
   * Enforce the per-agent memory cap (maxMemoryEntries). The underlying
   * AgentDBMemory already evicts per-tier, so this bounds total growth and
   * surfaces a warning when an agent's persisted memory exceeds its configured
   * cap. A non-positive cap disables enforcement.
   */
  private enforceMemoryCap(liveAgent: LiveAgent, totalEntries: number): void {
    const cap = this.config.maxMemoryEntries;
    if (!cap || cap <= 0 || totalEntries <= cap) {
      return;
    }
    try {
      getLogger().warn("Agent memory exceeds configured cap", {
        agentId: liveAgent.instance.id,
        key: liveAgent.instance.key,
        totalEntries,
        maxMemoryEntries: cap,
      });
    } catch {
      // Logger may be intentionally absent in isolated tests.
    }
  }
}
