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
import type { ReRetrievalConfig } from "../../config/config.js";
import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import { Orchestrator } from "../orchestrator.js";
import { AgentDBMemory } from "../../memory/unified/agentdb-memory.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import {
  createAgentId,
  resolveAgentKey,
  type AgentConfig,
  type AgentId,
  type AgentInstance,
  type AgentLifecycleEvent,
  type AgentBudgetEvent,
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
  readonly streamingEnabled: boolean;
  readonly stradaDeps: StradaDepsStatus;
  readonly instinctRetriever?: InstinctRetriever;
  readonly metricsRecorder?: MetricsRecorder;
  readonly goalDecomposer?: GoalDecomposer;
  readonly getIdentityState?: () => IdentityState;
  readonly reRetrievalConfig?: ReRetrievalConfig;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly memoryConfig: MemoryConfig;
}

/** In-memory representation of a running agent with its resources */
interface LiveAgent {
  instance: AgentInstance;
  orchestrator: Orchestrator;
  memory: AgentDBMemory;
}

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

  /** Idle check interval handle */
  private idleCheckInterval: ReturnType<typeof setInterval> | undefined;

  constructor(opts: AgentManagerOptions) {
    this.config = opts.config;
    this.registry = opts.registry;
    this.budgetTracker = opts.budgetTracker;
    this.eventBus = opts.eventBus;
    this.opts = opts;

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
  // Public API -- Routing
  // ===========================================================================

  /**
   * Route an incoming message to the appropriate agent.
   * Creates agent lazily on first message. Enforces budget and status checks.
   */
  async routeMessage(msg: IncomingMessage): Promise<string | void> {
    const liveAgent = await this.resolveAgent(msg);

    // Budget check before processing
    if (this.budgetTracker.isAgentExceeded(liveAgent.instance.id, liveAgent.instance.budgetCapUsd)) {
      // Update status to budget_exceeded
      this.registry.updateStatus(liveAgent.instance.id, "budget_exceeded");
      liveAgent.instance = { ...liveAgent.instance, status: "budget_exceeded" };

      // Emit budget exceeded event
      const usage = this.budgetTracker.getAgentUsage(liveAgent.instance.id, liveAgent.instance.budgetCapUsd);
      const budgetEvent: AgentBudgetEvent = {
        agentId: liveAgent.instance.id,
        key: liveAgent.instance.key,
        channelType: liveAgent.instance.channelType,
        chatId: liveAgent.instance.chatId,
        timestamp: Date.now(),
        usedUsd: usage.usedUsd,
        capUsd: liveAgent.instance.budgetCapUsd,
        pct: usage.pct,
      };
      this.eventBus.emit("agent:budget_exceeded", budgetEvent);

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

    // Route through agent's orchestrator
    return liveAgent.orchestrator.handleMessage(msg);
  }

  // ===========================================================================
  // Public API -- Lifecycle
  // ===========================================================================

  /** Stop an agent (prevents message routing) */
  async stopAgent(id: AgentId, force?: boolean): Promise<void> {
    const liveAgent = this.findLiveAgentById(id);
    if (!liveAgent) return;

    this.registry.updateStatus(id, "stopped");
    liveAgent.instance = { ...liveAgent.instance, status: "stopped" };

    if (force) {
      await liveAgent.memory.shutdown();
    }

    const event: AgentLifecycleEvent = {
      agentId: id,
      key: liveAgent.instance.key,
      channelType: liveAgent.instance.channelType,
      chatId: liveAgent.instance.chatId,
      timestamp: Date.now(),
    };
    this.eventBus.emit("agent:stopped", event);
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

    const event: AgentLifecycleEvent = {
      agentId: id,
      key: liveAgent.instance.key,
      channelType: liveAgent.instance.channelType,
      chatId: liveAgent.instance.chatId,
      timestamp: Date.now(),
    };
    this.eventBus.emit("agent:created", event);
  }

  /** Evict agents that have been idle longer than idleTimeoutMs */
  evictIdleAgents(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [key, liveAgent] of this.agents) {
      if (
        liveAgent.instance.status === "active" &&
        now - liveAgent.instance.lastActivity > this.config.idleTimeoutMs
      ) {
        toEvict.push(key);
      }
    }

    for (const key of toEvict) {
      const liveAgent = this.agents.get(key)!;
      this.evictAgent(key, liveAgent);
    }
  }

  /** Gracefully shut down all agents */
  async shutdown(): Promise<void> {
    // Stop idle check interval
    if (this.idleCheckInterval !== undefined) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

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
   */
  private async resolveAgent(msg: IncomingMessage): Promise<LiveAgent> {
    const key = resolveAgentKey(msg.channelType, msg.chatId);

    // 1. Check in-memory Map
    const existing = this.agents.get(key);
    if (existing) return existing;

    // 2. Check registry (may have been persisted from a previous run)
    const persisted = this.registry.getByKey(key);
    if (persisted) {
      return this.loadAgent(persisted);
    }

    // 3. Create new agent
    return this.createAgent(key, msg.channelType, msg.chatId);
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

    // Create per-agent memory directory and initialize memory
    const agentMemoryDir = join(this.opts.memoryConfig.dbBasePath, "agents", id);
    try {
      mkdirSync(agentMemoryDir, { recursive: true });
    } catch {
      // Directory might already exist, that's fine
    }

    const memory = new AgentDBMemory({
      dbPath: join(agentMemoryDir, "memory.db"),
      dimensions: this.opts.memoryConfig.dimensions,
    });
    await memory.initialize();

    // Create per-agent Orchestrator with shared resources but agent's own memory
    const orchestrator = new Orchestrator({
      providerManager: this.opts.providerManager,
      tools: this.opts.toolRegistry.getAllTools(),
      channel: this.opts.channel,
      projectPath: this.opts.projectPath,
      readOnly: this.opts.readOnly,
      requireConfirmation: this.opts.requireConfirmation,
      memoryManager: memory as unknown as IMemoryManager,
      metrics: this.opts.metrics,
      ragPipeline: this.opts.ragPipeline,
      rateLimiter: this.opts.rateLimiter,
      streamingEnabled: this.opts.streamingEnabled,
      stradaDeps: this.opts.stradaDeps,
      instinctRetriever: this.opts.instinctRetriever,
      eventEmitter: this.eventBus,
      metricsRecorder: this.opts.metricsRecorder,
      goalDecomposer: this.opts.goalDecomposer,
      getIdentityState: this.opts.getIdentityState,
      reRetrievalConfig: this.opts.reRetrievalConfig,
      embeddingProvider: this.opts.embeddingProvider,
    });

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

    // Emit created event
    const event: AgentLifecycleEvent = {
      agentId: id,
      key,
      channelType,
      chatId,
      timestamp: now,
    };
    this.eventBus.emit("agent:created", event);

    return liveAgent;
  }

  /** Reload a persisted agent from disk (re-create Orchestrator + open memory) */
  private async loadAgent(persisted: AgentInstance): Promise<LiveAgent> {
    const agentMemoryDir = join(this.opts.memoryConfig.dbBasePath, "agents", persisted.id);
    try {
      mkdirSync(agentMemoryDir, { recursive: true });
    } catch {
      // Already exists
    }

    const memory = new AgentDBMemory({
      dbPath: join(agentMemoryDir, "memory.db"),
      dimensions: this.opts.memoryConfig.dimensions,
    });
    await memory.initialize();

    const orchestrator = new Orchestrator({
      providerManager: this.opts.providerManager,
      tools: this.opts.toolRegistry.getAllTools(),
      channel: this.opts.channel,
      projectPath: this.opts.projectPath,
      readOnly: this.opts.readOnly,
      requireConfirmation: this.opts.requireConfirmation,
      memoryManager: memory as unknown as IMemoryManager,
      metrics: this.opts.metrics,
      ragPipeline: this.opts.ragPipeline,
      rateLimiter: this.opts.rateLimiter,
      streamingEnabled: this.opts.streamingEnabled,
      stradaDeps: this.opts.stradaDeps,
      instinctRetriever: this.opts.instinctRetriever,
      eventEmitter: this.eventBus,
      metricsRecorder: this.opts.metricsRecorder,
      goalDecomposer: this.opts.goalDecomposer,
      getIdentityState: this.opts.getIdentityState,
      reRetrievalConfig: this.opts.reRetrievalConfig,
      embeddingProvider: this.opts.embeddingProvider,
    });

    const liveAgent: LiveAgent = { instance: persisted, orchestrator, memory };
    this.agents.set(persisted.key, liveAgent);

    return liveAgent;
  }

  // ===========================================================================
  // Private -- Eviction
  // ===========================================================================

  /** Evict the oldest idle agent to make room for a new one */
  private evictOldestIdle(): void {
    let oldestKey: string | undefined;
    let oldestActivity = Infinity;

    for (const [key, liveAgent] of this.agents) {
      if (liveAgent.instance.lastActivity < oldestActivity) {
        oldestActivity = liveAgent.instance.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const liveAgent = this.agents.get(oldestKey)!;
      this.evictAgent(oldestKey, liveAgent);
    }
  }

  /** Evict a specific agent: close memory, remove from map, update registry, emit event */
  private evictAgent(key: string, liveAgent: LiveAgent): void {
    // Close memory (SQLite auto-persists on close)
    void liveAgent.memory.shutdown();

    // Clean up orchestrator sessions
    liveAgent.orchestrator.cleanupSessions();

    // Remove from in-memory map
    this.agents.delete(key);

    // Update registry status
    this.registry.updateStatus(liveAgent.instance.id, "evicted");

    // Emit eviction event
    const event: AgentLifecycleEvent = {
      agentId: liveAgent.instance.id,
      key: liveAgent.instance.key,
      channelType: liveAgent.instance.channelType,
      chatId: liveAgent.instance.chatId,
      timestamp: Date.now(),
    };
    this.eventBus.emit("agent:evicted", event);
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
}
