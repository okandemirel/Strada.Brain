/**
 * Tests for AgentManager -- core routing, isolation, budget enforcement, lifecycle
 *
 * Uses mocks for Orchestrator, AgentDBMemory, ProviderManager, channel, etc.
 * Uses real in-memory SQLite for AgentRegistry (via better-sqlite3 :memory:).
 * Uses real DaemonStorage for AgentBudgetTracker (via temp dir).
 *
 * Requirements: AGENT-01, AGENT-02, AGENT-06
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import { createAgentId, resolveAgentKey } from "./agent-types.js";
import type { AgentConfig, AgentId, AgentInstance } from "./agent-types.js";
import { TypedEventBus } from "../../core/event-bus.js";
import type { LearningEventMap } from "../../core/event-bus.js";
import type { IncomingMessage } from "../../channels/channel-messages.interface.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import type { TaskUsageEvent } from "../../tasks/types.js";

let mockUsageEvent: TaskUsageEvent | null = null;
let mockMemoryTotalEntries = 0;

// =============================================================================
// MOCKS
// =============================================================================

// Mock Orchestrator: avoid the real constructor's heavy deps
// handleMessage returns void in the real Orchestrator (sends response via channel)
// We mock it to return a string for test verification of correct routing
vi.mock("../orchestrator.js", () => {
  return {
    Orchestrator: vi.fn().mockImplementation((opts?: { onUsage?: (usage: TaskUsageEvent) => void }) => ({
      handleMessage: vi.fn().mockImplementation(async () => {
        if (mockUsageEvent) {
          opts?.onUsage?.(mockUsageEvent);
        }
        return "mock response";
      }),
      cleanupSessions: vi.fn(),
      setTaskManager: vi.fn(),
      setWorkspaceBus: vi.fn(),
      setMonitorLifecycle: vi.fn(),
    })),
  };
});

// Mock AgentDBMemory: avoid real SQLite + HNSW
vi.mock("../../memory/unified/agentdb-memory.js", () => {
  return {
    AgentDBMemory: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      shutdown: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      close: vi.fn().mockResolvedValue(undefined),
      getUserProfileStore: vi.fn().mockReturnValue(null),
      getStats: vi.fn(() => ({ totalEntries: mockMemoryTotalEntries })),
    })),
  };
});

// Mock MessageRouter
vi.mock("../../tasks/message-router.js", () => {
  return {
    MessageRouter: vi.fn().mockImplementation(() => ({
      route: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock CommandHandler
vi.mock("../../tasks/command-handler.js", () => {
  return {
    CommandHandler: vi.fn().mockImplementation(() => ({})),
  };
});

// Mock TaskManager
vi.mock("../../tasks/task-manager.js", () => {
  return {
    TaskManager: vi.fn().mockImplementation(() => ({
      submit: vi.fn(),
    })),
  };
});

// Mock mkdirSync to avoid filesystem side effects
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    enabled: true,
    defaultBudgetUsd: 5.0,
    maxConcurrent: 10,
    idleTimeoutMs: 60_000,
    maxMemoryEntries: 1000,
    ...overrides,
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: "web",
    chatId: "chat-1",
    userId: "user-1",
    text: "Hello",
    timestamp: new Date(),
    ...overrides,
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe("AgentManager", () => {
  let db: Database.Database;
  let registry: AgentRegistry;
  let budgetTracker: AgentBudgetTracker;
  let eventBus: TypedEventBus<LearningEventMap>;
  let manager: AgentManager;
  let tmpDir: string;
  let daemonStorage: DaemonStorage;

  beforeEach(() => {
    mockUsageEvent = null;
    mockMemoryTotalEntries = 0;
    // Real in-memory SQLite for registry
    db = new Database(":memory:");
    registry = new AgentRegistry(db);
    registry.initialize();

    // Real DaemonStorage for budget tracker
    tmpDir = mkdtempSync(join(tmpdir(), "agent-mgr-test-"));
    const daemonDbPath = join(tmpDir, "daemon.db");
    daemonStorage = new DaemonStorage(daemonDbPath);
    daemonStorage.initialize();
    budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();

    eventBus = new TypedEventBus<LearningEventMap>();

    manager = new AgentManager({
      config: makeConfig(),
      registry,
      budgetTracker,
      eventBus,
      // Shared resources (mocked)
      providerManager: {} as never,
      toolRegistry: { getAllTools: () => [] } as never,
      channel: { sendMessage: vi.fn() } as never,
      projectPath: "/fake/project",
      readOnly: false,
      requireConfirmation: false,
      metrics: undefined,
      streamingEnabled: false,
      stradaDeps: { installed: false, version: undefined },
      memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    await eventBus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Routing & Isolation
  // ===========================================================================

  describe("routing & isolation", () => {
    it("routes first message to a lazily created agent", async () => {
      const response = await manager.routeMessage(makeMsg());
      expect(response).toBe("mock response");
      expect(manager.getActiveCount()).toBe(1);
    });

    it("routes same channelType:chatId to the same agent", async () => {
      const msg1 = makeMsg({ text: "Hello 1" });
      const msg2 = makeMsg({ text: "Hello 2" });

      await manager.routeMessage(msg1);
      await manager.routeMessage(msg2);

      // Only 1 agent should exist
      expect(manager.getActiveCount()).toBe(1);
    });

    it("reuses the same agent when a stable conversation id survives chat session changes", async () => {
      await manager.routeMessage(makeMsg({
        chatId: "chat-1",
        conversationId: "stable-web-profile",
      }));
      await manager.routeMessage(makeMsg({
        chatId: "chat-2",
        conversationId: "stable-web-profile",
      }));

      expect(manager.getActiveCount()).toBe(1);
      expect(manager.getAllAgents()[0]?.chatId).toBe("chat-2");
    });

    it("creates different agents for different channelType:chatId", async () => {
      const msg1 = makeMsg({ channelType: "web", chatId: "chat-1" });
      const msg2 = makeMsg({ channelType: "telegram", chatId: "chat-2" });

      await manager.routeMessage(msg1);
      await manager.routeMessage(msg2);

      expect(manager.getActiveCount()).toBe(2);
    });

    it("creates different agents for same chatId but different channelType", async () => {
      const msg1 = makeMsg({ channelType: "web", chatId: "chat-1" });
      const msg2 = makeMsg({ channelType: "telegram", chatId: "chat-1" });

      await manager.routeMessage(msg1);
      await manager.routeMessage(msg2);

      expect(manager.getActiveCount()).toBe(2);
    });

    it("each agent has its own Orchestrator", async () => {
      const msg1 = makeMsg({ channelType: "web", chatId: "chat-1" });
      const msg2 = makeMsg({ channelType: "web", chatId: "chat-2" });

      await manager.routeMessage(msg1);
      await manager.routeMessage(msg2);

      const agents = manager.getAllAgents();
      expect(agents).toHaveLength(2);
    });

    it("each agent has isolated memory path under agents/{agentId}/", async () => {
      await manager.routeMessage(makeMsg());

      const agents = manager.getAllAgents();
      expect(agents).toHaveLength(1);
      // Memory path is set during creation -- verified via mock call
      const { AgentDBMemory } = await import("../../memory/unified/agentdb-memory.js");
      const mockConstructor = AgentDBMemory as unknown as Mock;
      expect(mockConstructor).toHaveBeenCalledTimes(1);
      const callArgs = mockConstructor.mock.calls[0][0];
      expect(callArgs.dbPath).toContain("agents/");
    });

    it("submits plain messages to the background task system when configured", async () => {
      const submitter = vi.fn();
      manager.setBackgroundTaskSubmitter(submitter);

      const response = await manager.routeMessage(makeMsg({ text: "Handle this in background" }));

      expect(response).toBeUndefined();
      expect(submitter).toHaveBeenCalledOnce();
      const { Orchestrator } = await import("../orchestrator.js");
      const mockConstructor = Orchestrator as unknown as Mock;
      const orchestratorInstance = mockConstructor.mock.results[0]?.value;
      expect(submitter).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "chat-1", text: "Handle this in background" }),
        expect.objectContaining({ key: resolveAgentKey("web", "chat-1") }),
        orchestratorInstance,
      );

      expect(orchestratorInstance.handleMessage).not.toHaveBeenCalled();
    });

    it("batches consecutive background messages for the same conversation when burst mode is enabled", async () => {
      vi.useFakeTimers();
      const burstManager = new AgentManager({
        config: makeConfig(),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
        messageBurstWindowMs: 25,
        maxBurstMessages: 8,
      });
      const submitter = vi.fn();
      burstManager.setBackgroundTaskSubmitter(submitter);

      try {
        await burstManager.routeMessage(makeMsg({ text: "part one" }));
        await burstManager.routeMessage(makeMsg({ text: "part two" }));

        expect(submitter).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(25);
        await Promise.resolve();

        expect(submitter).toHaveBeenCalledOnce();
        expect(submitter.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            text: expect.stringContaining("part one"),
          }),
        );
        expect(submitter.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            text: expect.stringContaining("part two"),
          }),
        );
        const { Orchestrator } = await import("../orchestrator.js");
        const mockConstructor = Orchestrator as unknown as Mock;
        const orchestratorInstance = mockConstructor.mock.results[0]?.value;
        expect(submitter.mock.calls[0]?.[2]).toBe(orchestratorInstance);
      } finally {
        await burstManager.shutdown();
        vi.useRealTimers();
      }
    });

    it("passes the shared user profile store into per-agent orchestrators", async () => {
      const sharedProfileStore = { getProfile: vi.fn() } as never;
      const sharedManager = new AgentManager({
        config: makeConfig(),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
        userProfileStore: sharedProfileStore,
      });

      try {
        await sharedManager.routeMessage(makeMsg());
        const { Orchestrator } = await import("../orchestrator.js");
        const mockConstructor = Orchestrator as unknown as Mock;
        const opts = mockConstructor.mock.calls.at(-1)?.[0];
        expect(opts?.userProfileStore).toBe(sharedProfileStore);
      } finally {
        await sharedManager.shutdown();
      }
    });

    it("wires the shared workspace runtime into existing and future per-agent orchestrators", async () => {
      await manager.routeMessage(makeMsg());

      const { Orchestrator } = await import("../orchestrator.js");
      const mockConstructor = Orchestrator as unknown as Mock;
      const firstOrchestrator = mockConstructor.mock.results.at(-1)?.value;
      const workspaceBus = { emit: vi.fn() } as any;
      const monitorLifecycle = {
        requestStart: vi.fn(),
        requestEnd: vi.fn(),
      } as any;

      manager.setWorkspaceRuntime(workspaceBus, monitorLifecycle);

      expect(firstOrchestrator.setWorkspaceBus).toHaveBeenCalledWith(workspaceBus);
      expect(firstOrchestrator.setMonitorLifecycle).toHaveBeenCalledWith(monitorLifecycle);

      await manager.routeMessage(makeMsg({ chatId: "chat-2" }));
      const secondOrchestrator = mockConstructor.mock.results.at(-1)?.value;
      expect(secondOrchestrator.setWorkspaceBus).toHaveBeenCalledWith(workspaceBus);
      expect(secondOrchestrator.setMonitorLifecycle).toHaveBeenCalledWith(monitorLifecycle);
    });
  });

  // ===========================================================================
  // Budget Enforcement
  // ===========================================================================

  describe("budget enforcement", () => {
    it("records per-agent usage from orchestrator token callbacks", async () => {
      mockUsageEvent = { provider: "claude", inputTokens: 100_000, outputTokens: 50_000 };

      await manager.routeMessage(makeMsg());

      const agents = manager.getAllAgents();
      const usage = budgetTracker.getAgentUsage(agents[0].id, agents[0].budgetCapUsd);
      expect(usage.usedUsd).toBeGreaterThan(0);
    });

    it("rejects message when agent budget is exceeded", async () => {
      // First message creates the agent
      await manager.routeMessage(makeMsg());

      // Record cost that exceeds the default $5 budget
      const agents = manager.getAllAgents();
      budgetTracker.recordCost(agents[0].id, 6.0);

      // Second message should be rejected
      const response = await manager.routeMessage(makeMsg());
      expect(response).toContain("budget");
    });

    it("emits agent:budget_exceeded event when budget hit", async () => {
      const budgetEvents: unknown[] = [];
      eventBus.on("agent:budget_exceeded", (evt) => budgetEvents.push(evt));

      // Create agent and exceed budget
      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();
      budgetTracker.recordCost(agents[0].id, 6.0);

      // Trigger budget check
      await manager.routeMessage(makeMsg());

      expect(budgetEvents).toHaveLength(1);
    });

    it("other agents are unaffected when one exceeds budget", async () => {
      const msg1 = makeMsg({ channelType: "web", chatId: "chat-1" });
      const msg2 = makeMsg({ channelType: "web", chatId: "chat-2" });

      await manager.routeMessage(msg1);
      await manager.routeMessage(msg2);

      // Exceed budget for agent 1 only
      const allAgents = manager.getAllAgents();
      const agent1 = allAgents.find((a) => a.chatId === "chat-1")!;
      budgetTracker.recordCost(agent1.id, 6.0);

      // Agent 1 should be rejected
      const resp1 = await manager.routeMessage(msg1);
      expect(resp1).toContain("budget");

      // Agent 2 should still work
      const resp2 = await manager.routeMessage(msg2);
      expect(resp2).toBe("mock response");
    });
  });

  // ===========================================================================
  // Stopped Agent
  // ===========================================================================

  describe("stopped agent", () => {
    it("rejects messages for stopped agents", async () => {
      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();

      await manager.stopAgent(agents[0].id);

      const response = await manager.routeMessage(makeMsg());
      expect(response).toContain("stopped");
    });

    it("emits agent:stopped event", async () => {
      const events: unknown[] = [];
      eventBus.on("agent:stopped", (evt) => events.push(evt));

      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();
      await manager.stopAgent(agents[0].id);

      expect(events).toHaveLength(1);
    });

    it("startAgent resumes a stopped agent", async () => {
      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();

      await manager.stopAgent(agents[0].id);
      await manager.startAgent(agents[0].id);

      const response = await manager.routeMessage(makeMsg());
      expect(response).toBe("mock response");
    });

    it("force stop releases live resources so startAgent reloads cleanly", async () => {
      await manager.routeMessage(makeMsg());
      const agent = manager.getAllAgents()[0]!;

      expect(manager.getActiveCount()).toBe(1);
      expect(manager.getLiveOrchestrator(agent.id)).toBeDefined();

      await manager.stopAgent(agent.id, true);

      expect(manager.getActiveCount()).toBe(0);
      expect(manager.getLiveOrchestrator(agent.id)).toBeUndefined();

      await manager.startAgent(agent.id);

      expect(manager.getActiveCount()).toBe(1);
      const response = await manager.routeMessage(makeMsg());
      expect(response).toBe("mock response");
    });
  });

  // ===========================================================================
  // Lifecycle Events
  // ===========================================================================

  describe("lifecycle events", () => {
    it("emits agent:created on first message for a new key", async () => {
      const events: unknown[] = [];
      eventBus.on("agent:created", (evt) => events.push(evt));

      await manager.routeMessage(makeMsg());

      expect(events).toHaveLength(1);
    });

    it("does not emit agent:created on subsequent messages for same key", async () => {
      const events: unknown[] = [];
      eventBus.on("agent:created", (evt) => events.push(evt));

      await manager.routeMessage(makeMsg());
      await manager.routeMessage(makeMsg());

      expect(events).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Max Concurrent Enforcement
  // ===========================================================================

  describe("max concurrent enforcement", () => {
    it("evicts oldest idle agent when at maxConcurrent limit", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Create manager with maxConcurrent=2, idleTimeoutMs=10_000
      const limitedManager = new AgentManager({
        config: makeConfig({ maxConcurrent: 2, idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      // Create 2 agents (at limit)
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-1" }));
      vi.setSystemTime(now + 1000);
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-2" }));
      expect(limitedManager.getActiveCount()).toBe(2);

      // Advance past idle timeout so agents become idle
      vi.setSystemTime(now + 15_000);

      // Third agent should evict the oldest idle
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-3" }));
      expect(limitedManager.getActiveCount()).toBe(2);

      await limitedManager.shutdown();
      vi.useRealTimers();
    });

    it("emits agent:evicted when evicting for max concurrent", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const events: unknown[] = [];
      eventBus.on("agent:evicted", (evt) => events.push(evt));

      const limitedManager = new AgentManager({
        config: makeConfig({ maxConcurrent: 1, idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      await limitedManager.routeMessage(makeMsg({ chatId: "chat-1" }));

      // Advance past idle timeout so agent becomes idle
      vi.setSystemTime(now + 15_000);

      await limitedManager.routeMessage(makeMsg({ chatId: "chat-2" }));

      expect(events).toHaveLength(1);

      await limitedManager.shutdown();
      vi.useRealTimers();
    });

    it("does not evict active agents when all are within idle timeout (C4)", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const evictEvents: unknown[] = [];
      eventBus.on("agent:evicted", (evt) => evictEvents.push(evt));

      const limitedManager = new AgentManager({
        config: makeConfig({ maxConcurrent: 2, idleTimeoutMs: 60_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      // Create 2 agents (at limit) -- both within idle timeout
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-1" }));
      vi.setSystemTime(now + 1000);
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-2" }));
      vi.setSystemTime(now + 2000);

      // Third agent: all existing agents are active (within timeout), none should be evicted
      await limitedManager.routeMessage(makeMsg({ chatId: "chat-3" }));

      // All 3 agents should be live (temporarily exceeds maxConcurrent)
      expect(limitedManager.getActiveCount()).toBe(3);
      expect(evictEvents).toHaveLength(0);

      await limitedManager.shutdown();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Idle Eviction
  // ===========================================================================

  describe("idle eviction", () => {
    it("evicts agents inactive longer than idleTimeoutMs", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const idleManager = new AgentManager({
        config: makeConfig({ idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      await idleManager.routeMessage(makeMsg({ chatId: "chat-1" }));
      expect(idleManager.getActiveCount()).toBe(1);

      // Advance past idle timeout
      vi.setSystemTime(now + 15_000);

      // Trigger eviction check
      idleManager.evictIdleAgents();

      expect(idleManager.getActiveCount()).toBe(0);

      await idleManager.shutdown();
      vi.useRealTimers();
    });

    it("emits agent:evicted for each evicted idle agent", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const events: unknown[] = [];
      eventBus.on("agent:evicted", (evt) => events.push(evt));

      const idleManager = new AgentManager({
        config: makeConfig({ idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      await idleManager.routeMessage(makeMsg({ chatId: "chat-1" }));
      await idleManager.routeMessage(makeMsg({ chatId: "chat-2" }));

      vi.setSystemTime(now + 15_000);
      idleManager.evictIdleAgents();

      expect(events).toHaveLength(2);

      await idleManager.shutdown();
      vi.useRealTimers();
    });

    it("does not evict agents that are still within timeout", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const idleManager = new AgentManager({
        config: makeConfig({ idleTimeoutMs: 60_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      await idleManager.routeMessage(makeMsg({ chatId: "chat-1" }));

      // Only 5s later (well within 60s timeout)
      vi.setSystemTime(now + 5_000);
      idleManager.evictIdleAgents();

      expect(idleManager.getActiveCount()).toBe(1);

      await idleManager.shutdown();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // getAgent / getAllAgents
  // ===========================================================================

  describe("getAgent / getAllAgents", () => {
    it("getAgent returns agent info by id", async () => {
      await manager.routeMessage(makeMsg());
      const all = manager.getAllAgents();
      expect(all).toHaveLength(1);

      const found = manager.getAgent(all[0].id);
      expect(found).toBeDefined();
      expect(found!.key).toBe(resolveAgentKey("web", "chat-1"));
    });

    it("getAllAgents returns all agent instances", async () => {
      await manager.routeMessage(makeMsg({ chatId: "chat-1" }));
      await manager.routeMessage(makeMsg({ chatId: "chat-2" }));

      const all = manager.getAllAgents();
      expect(all).toHaveLength(2);
    });

    it("getAgent returns undefined for unknown id", () => {
      expect(manager.getAgent("unknown" as AgentId)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Shutdown
  // ===========================================================================

  describe("shutdown", () => {
    it("closes all agent memory connections", async () => {
      await manager.routeMessage(makeMsg({ chatId: "chat-1" }));
      await manager.routeMessage(makeMsg({ chatId: "chat-2" }));
      expect(manager.getActiveCount()).toBe(2);

      await manager.shutdown();

      // After shutdown, active count should be 0
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  // ===========================================================================
  // setBudgetCap
  // ===========================================================================

  describe("setBudgetCap", () => {
    it("updates budget cap for an agent", async () => {
      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();

      manager.setBudgetCap(agents[0].id, 20.0);

      const updated = manager.getAgent(agents[0].id);
      expect(updated!.budgetCapUsd).toBe(20.0);
    });
  });

  // ===========================================================================
  // lastActivity updates
  // ===========================================================================

  describe("lastActivity tracking", () => {
    it("updates lastActivity on each routed message", async () => {
      vi.useFakeTimers();
      const t1 = 1000000;
      vi.setSystemTime(t1);

      await manager.routeMessage(makeMsg());
      const agents1 = manager.getAllAgents();
      const firstActivity = agents1[0].lastActivity;

      vi.setSystemTime(t1 + 5000);
      await manager.routeMessage(makeMsg());
      const agents2 = manager.getAllAgents();

      expect(agents2[0].lastActivity).toBeGreaterThan(firstActivity);

      vi.useRealTimers();
    });
  });

  describe("memory count tracking", () => {
    it("syncs memoryEntryCount back into the registry after message handling", async () => {
      mockMemoryTotalEntries = 12;

      await manager.routeMessage(makeMsg());

      const agent = manager.getAllAgents()[0];
      expect(agent.memoryEntryCount).toBe(12);
      expect(manager.getAgent(agent.id)?.memoryEntryCount).toBe(12);
    });
  });

  // ===========================================================================
  // C1: startAgent emits agent:started (not agent:created)
  // ===========================================================================

  describe("startAgent event (C1)", () => {
    it("emits agent:started when resuming a stopped agent", async () => {
      const startedEvents: unknown[] = [];
      const createdEvents: unknown[] = [];
      eventBus.on("agent:started", (evt) => startedEvents.push(evt));
      eventBus.on("agent:created", (evt) => createdEvents.push(evt));

      // Create agent (emits agent:created)
      await manager.routeMessage(makeMsg());
      const agents = manager.getAllAgents();
      expect(createdEvents).toHaveLength(1);

      // Stop and restart
      await manager.stopAgent(agents[0].id);
      await manager.startAgent(agents[0].id);

      // Should have emitted agent:started, NOT another agent:created
      expect(startedEvents).toHaveLength(1);
      expect(createdEvents).toHaveLength(1); // still 1, no second created event
    });
  });

  // ===========================================================================
  // C2: Concurrent message race prevention
  // ===========================================================================

  describe("concurrent creation race guard (C2)", () => {
    it("creates only one agent when two concurrent messages arrive for same new key", async () => {
      const msg = makeMsg({ chatId: "race-test" });

      // Fire two concurrent routeMessage calls for the same key
      const [r1, r2] = await Promise.all([
        manager.routeMessage(msg),
        manager.routeMessage(msg),
      ]);

      // Both should succeed
      expect(r1).toBe("mock response");
      expect(r2).toBe("mock response");

      // Only 1 agent should have been created
      expect(manager.getActiveCount()).toBe(1);
      expect(manager.getAllAgents()).toHaveLength(1);
    });
  });

  // ===========================================================================
  // C3: budget_exceeded agents are evicted when idle
  // ===========================================================================

  describe("budget_exceeded idle eviction (C3)", () => {
    it("evicts budget_exceeded agents past idle timeout", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const idleManager = new AgentManager({
        config: makeConfig({ idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      // Create agent and exceed its budget
      await idleManager.routeMessage(makeMsg({ chatId: "budget-chat" }));
      const agents = idleManager.getAllAgents();
      budgetTracker.recordCost(agents[0].id, 6.0);

      // Trigger budget exceeded status
      await idleManager.routeMessage(makeMsg({ chatId: "budget-chat" }));
      expect(idleManager.getActiveCount()).toBe(1);

      // Advance past idle timeout
      vi.setSystemTime(now + 15_000);
      idleManager.evictIdleAgents();

      // Budget_exceeded agent should now be evicted
      expect(idleManager.getActiveCount()).toBe(0);

      await idleManager.shutdown();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // I1: Evicted agents reloaded with status reset
  // ===========================================================================

  describe("evicted agent reload status reset (I1)", () => {
    it("resets evicted agent status to active on reload via routeMessage", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const idleManager = new AgentManager({
        config: makeConfig({ idleTimeoutMs: 10_000 }),
        registry,
        budgetTracker,
        eventBus,
        providerManager: {} as never,
        toolRegistry: { getAllTools: () => [] } as never,
        channel: { sendMessage: vi.fn() } as never,
        projectPath: "/fake/project",
        readOnly: false,
        requireConfirmation: false,
        metrics: undefined,
        streamingEnabled: false,
        stradaDeps: { installed: false, version: undefined },
        memoryConfig: { dimensions: 768, dbBasePath: tmpDir },
      });

      // Create agent
      await idleManager.routeMessage(makeMsg({ chatId: "evict-test" }));
      const agents = idleManager.getAllAgents();
      const agentId = agents[0].id;
      expect(agents[0].status).toBe("active");

      // Evict by advancing past idle timeout
      vi.setSystemTime(now + 15_000);
      idleManager.evictIdleAgents();
      expect(idleManager.getActiveCount()).toBe(0);

      // Registry still has the agent but with evicted status
      const evicted = registry.getById(agentId);
      expect(evicted).toBeDefined();
      expect(evicted!.status).toBe("evicted");

      // Re-route a message for the same key -- should reload and reset to active
      vi.setSystemTime(now + 20_000);
      const response = await idleManager.routeMessage(makeMsg({ chatId: "evict-test" }));
      expect(response).toBe("mock response");

      // Agent should be active again
      const reloaded = registry.getById(agentId);
      expect(reloaded!.status).toBe("active");
      expect(idleManager.getActiveCount()).toBe(1);

      await idleManager.shutdown();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // L2: UUID format guard on agent ID
  // ===========================================================================

  describe("UUID format guard (L2)", () => {
    it("rejects invalid agent ID format in buildAgentResources", async () => {
      // We test this indirectly: if we manually insert a bad ID into registry
      // and then try to load it, it should throw
      const badInstance: AgentInstance = {
        id: "../../../etc/passwd" as AgentId,
        key: "web:hack-attempt",
        channelType: "web",
        chatId: "hack-attempt",
        status: "active",
        createdAt: Date.now(),
        lastActivity: Date.now(),
        budgetCapUsd: 5.0,
        memoryEntryCount: 0,
      };
      registry.upsert(badInstance);

      // Routing to this key should fail with UUID validation error
      await expect(
        manager.routeMessage(makeMsg({ chatId: "hack-attempt" })),
      ).rejects.toThrow("Invalid agent ID format");
    });
  });
});
