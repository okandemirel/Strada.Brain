/**
 * Characterization tests for stage-agents.ts
 *
 * Tests focus on the injectable `deps` seam — each stage function accepts a
 * factory-injection object so real sub-systems never have to boot.
 */
import { describe, it, expect, vi } from "vitest";
import type { Config } from "../../config/config.js";
import type * as winston from "winston";
import {
  initializeMultiAgentDelegationStage,
  initializeMemoryConsolidationStage,
  initializeDeploymentStage,
} from "./stage-agents.js";

// =============================================================================
// SHARED HELPERS
// =============================================================================

function createMockLogger(): winston.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger;
}

/**
 * Minimal config that has agent disabled so tests that want to exercise the
 * early-return path don't need to spin up any real sub-system.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    agent: { enabled: false, defaultBudgetUsd: 5, maxConcurrent: 3, idleTimeoutMs: 60000, maxMemoryEntries: 1000 },
    delegation: { enabled: false, maxDepth: 2, maxConcurrentPerParent: 2, tiers: { local: "o:l3", cheap: "d:d-chat", standard: "g:g-pro", premium: "c:sonnet" }, types: [], verbosity: "normal" },
    deployment: { enabled: false, testCommand: "npm test", targetBranch: "main", requireCleanGit: true, testTimeoutMs: 60000, executionTimeoutMs: 600000, cooldownMinutes: 30, notificationUrgency: "medium" },
    memory: { consolidation: { enabled: false, threshold: 0.85, idleMinutes: 30 }, decay: { exemptDomains: [] }, unified: { dimensions: 384 }, dbPath: "/tmp/test-mem" } as Config["memory"],
    unityProjectPath: "/tmp/game",
    security: { readOnlyMode: false, requireEditConfirmation: true, systemAuth: { requireMfa: false } },
    streamingEnabled: true,
    llmStreamInitialTimeoutMs: 30000,
    llmStreamStallTimeoutMs: 120000,
    language: "en",
    tasks: { concurrencyLimit: 2, messageBurstWindowMs: 5000, messageBurstMaxMessages: 4 },
    strada: { coreRepoUrl: "https://x.invalid/core.git", modulesRepoUrl: "https://x.invalid/modules.git" },
    ...overrides,
  } as Config;
}

// =============================================================================
// MODULE: initializeMultiAgentDelegationStage
// =============================================================================

describe("initializeMultiAgentDelegationStage — agent disabled", () => {
  it("returns an empty object (no agentManager) when config.agent.enabled is false", async () => {
    const result = await initializeMultiAgentDelegationStage({
      config: makeConfig({ agent: { enabled: false } as Config["agent"] }),
      logger: createMockLogger(),
      daemonMode: false,
      // All remaining required params are not reached when agent.enabled is false.
      // Cast to satisfy the TS signature without providing real instances.
    } as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]);

    expect(result).toEqual({});
    expect(result.agentManager).toBeUndefined();
    expect(result.agentBudgetTracker).toBeUndefined();
    expect(result.delegationManager).toBeUndefined();
  });
});

describe("initializeMultiAgentDelegationStage — agent enabled, fully injected via deps", () => {
  it("returns agentManager and agentBudgetTracker from the deps factories", async () => {
    const fakeAgentManager = { setBackgroundTaskSubmitter: vi.fn(), setTaskManager: vi.fn(), setDelegationFactory: vi.fn() };
    const fakeAgentBudgetTracker = { initialize: vi.fn() };
    const fakeAgentRegistry = { initialize: vi.fn() };
    const fakeDaemonStorage = { getDatabase: vi.fn(() => ({})) };
    const fakeOrchestrator = { addTool: vi.fn() };
    const fakeChannel = {};
    const fakeToolRegistry = { getAllTools: vi.fn(() => []) };
    const fakeProviderManager = { isAvailable: vi.fn(() => false) };
    const fakeSoulLoader = {};
    const fakeDmPolicy = {};
    const fakeDaemonContext = {} as Record<string, unknown>;
    const fakeStradaDeps = { coreInstalled: false, modulesInstalled: false, mcpInstalled: false, coreSource: "local", modulesSource: "local", mcpSource: "local" };

    const deps = {
      createAgentRegistry: vi.fn(() => fakeAgentRegistry),
      createAgentBudgetTracker: vi.fn(() => fakeAgentBudgetTracker),
      createAgentManager: vi.fn(() => fakeAgentManager),
    };

    const result = await initializeMultiAgentDelegationStage(
      {
        config: makeConfig({ agent: { enabled: true, defaultBudgetUsd: 5, maxConcurrent: 3, idleTimeoutMs: 60000, maxMemoryEntries: 1000 } as Config["agent"] }),
        logger: createMockLogger(),
        daemonMode: false,
        daemonStorage: fakeDaemonStorage as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["daemonStorage"],
        daemonContext: fakeDaemonContext as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["daemonContext"],
        taskManager: { submit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["taskManager"],
        orchestrator: fakeOrchestrator as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["orchestrator"],
        providerManager: fakeProviderManager as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["providerManager"],
        toolRegistry: fakeToolRegistry as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["toolRegistry"],
        channel: fakeChannel as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["channel"],
        metrics: { getSnapshot: vi.fn(() => ({})) } as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["metrics"],
        soulLoader: fakeSoulLoader as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["soulLoader"],
        dmPolicy: fakeDmPolicy as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["dmPolicy"],
        stradaDeps: fakeStradaDeps as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["stradaDeps"],
      },
      deps as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[1],
    );

    expect(result.agentManager).toBe(fakeAgentManager);
    expect(result.agentBudgetTracker).toBe(fakeAgentBudgetTracker);
    // delegation disabled → no delegationManager
    expect(result.delegationManager).toBeUndefined();
  });

  it("calls agentRegistry.initialize() during stage boot", async () => {
    const fakeAgentManager = { setBackgroundTaskSubmitter: vi.fn(), setTaskManager: vi.fn(), setDelegationFactory: vi.fn() };
    const fakeAgentBudgetTracker = { initialize: vi.fn() };
    const fakeAgentRegistry = { initialize: vi.fn() };
    const fakeDaemonStorage = { getDatabase: vi.fn(() => ({})) };
    const fakeOrchestrator = { addTool: vi.fn() };
    const fakeToolRegistry = { getAllTools: vi.fn(() => []) };
    const fakeProviderManager = { isAvailable: vi.fn(() => false) };
    const fakeDaemonContext = {} as Record<string, unknown>;
    const fakeStradaDeps = { coreInstalled: false, modulesInstalled: false, mcpInstalled: false, coreSource: "local", modulesSource: "local", mcpSource: "local" };

    const deps = {
      createAgentRegistry: vi.fn(() => fakeAgentRegistry),
      createAgentBudgetTracker: vi.fn(() => fakeAgentBudgetTracker),
      createAgentManager: vi.fn(() => fakeAgentManager),
    };

    await initializeMultiAgentDelegationStage(
      {
        config: makeConfig({ agent: { enabled: true, defaultBudgetUsd: 5, maxConcurrent: 3, idleTimeoutMs: 60000, maxMemoryEntries: 1000 } as Config["agent"] }),
        logger: createMockLogger(),
        daemonMode: false,
        daemonStorage: fakeDaemonStorage as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["daemonStorage"],
        daemonContext: fakeDaemonContext as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["daemonContext"],
        taskManager: { submit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["taskManager"],
        orchestrator: fakeOrchestrator as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["orchestrator"],
        providerManager: fakeProviderManager as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["providerManager"],
        toolRegistry: fakeToolRegistry as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["toolRegistry"],
        channel: {} as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["channel"],
        metrics: { getSnapshot: vi.fn(() => ({})) } as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["metrics"],
        soulLoader: {} as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["soulLoader"],
        dmPolicy: {} as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["dmPolicy"],
        stradaDeps: fakeStradaDeps as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[0]["stradaDeps"],
      },
      deps as unknown as Parameters<typeof initializeMultiAgentDelegationStage>[1],
    );

    expect(fakeAgentRegistry.initialize).toHaveBeenCalledTimes(1);
    expect(fakeAgentBudgetTracker.initialize).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// MODULE: initializeMemoryConsolidationStage
// =============================================================================

describe("initializeMemoryConsolidationStage — consolidation disabled", () => {
  it("returns empty object when consolidation is disabled in config", async () => {
    const result = await initializeMemoryConsolidationStage({
      config: makeConfig({ memory: { consolidation: { enabled: false } } as Config["memory"] }),
      logger: createMockLogger(),
      memoryManager: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["memoryManager"],
      providerManager: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["providerManager"],
      heartbeatLoop: { setConsolidationEngine: vi.fn() },
      daemonContext: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["daemonContext"],
    });
    expect(result).toEqual({});
    expect(result.consolidationEngine).toBeUndefined();
  });

  it("returns empty object when no memoryManager", async () => {
    const result = await initializeMemoryConsolidationStage({
      config: makeConfig({ memory: { consolidation: { enabled: true, threshold: 0.85, idleMinutes: 30 } } as Config["memory"] }),
      logger: createMockLogger(),
      memoryManager: undefined,
      providerManager: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["providerManager"],
      heartbeatLoop: { setConsolidationEngine: vi.fn() },
      daemonContext: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["daemonContext"],
    });
    expect(result).toEqual({});
  });

  it("returns empty object when memoryManager is not an AgentDBAdapter", async () => {
    const result = await initializeMemoryConsolidationStage(
      {
        config: makeConfig({ memory: { consolidation: { enabled: true, threshold: 0.85, idleMinutes: 30 } } as Config["memory"] }),
        logger: createMockLogger(),
        memoryManager: { store: vi.fn() } as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["memoryManager"],
        providerManager: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["providerManager"],
        heartbeatLoop: { setConsolidationEngine: vi.fn() },
        daemonContext: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["daemonContext"],
      },
      {
        // Not an AgentDBAdapter
        isAgentDbAdapter: async () => false,
      },
    );
    expect(result).toEqual({});
  });

  it("uses the factory from deps.createMemoryConsolidationEngine when provided", async () => {
    const fakeEngine = { getStats: vi.fn() };
    const heartbeatLoop = { setConsolidationEngine: vi.fn() };

    const result = await initializeMemoryConsolidationStage(
      {
        config: makeConfig({
          memory: {
            consolidation: { enabled: true, threshold: 0.85, idleMinutes: 30 },
            unified: { dimensions: 384 },
            dbPath: "/tmp/test-mem",
            decay: { exemptDomains: [] },
          } as Config["memory"],
        }),
        logger: createMockLogger(),
        memoryManager: {
          getAgentDBMemory: vi.fn(() => ({
            getConsolidationInternals: vi.fn(() => ({ sqliteDb: {}, entries: [], hnswStore: {} })),
          })),
        } as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["memoryManager"],
        providerManager: { getProvider: vi.fn(() => ({ chat: vi.fn(), name: "test" })) } as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["providerManager"],
        heartbeatLoop,
        daemonContext: {} as unknown as Parameters<typeof initializeMemoryConsolidationStage>[0]["daemonContext"],
      },
      {
        isAgentDbAdapter: async () => true,
        getConsolidationInternals: () => ({ sqliteDb: {}, entries: [], hnswStore: {} }),
        createMemoryConsolidationEngine: () => Promise.resolve(fakeEngine) as Promise<typeof fakeEngine>,
      } as unknown as Parameters<typeof initializeMemoryConsolidationStage>[1],
    );

    expect(result.consolidationEngine).toBe(fakeEngine);
    expect(heartbeatLoop.setConsolidationEngine).toHaveBeenCalledWith(fakeEngine, expect.objectContaining({ idleMinutes: 30 }));
  });
});

// =============================================================================
// MODULE: initializeDeploymentStage
// =============================================================================

describe("initializeDeploymentStage — deployment disabled", () => {
  it("returns empty object when deployment.enabled is false", async () => {
    const result = await initializeDeploymentStage({
      config: makeConfig({ deployment: { enabled: false } as Config["deployment"] }),
      logger: createMockLogger(),
      daemonConfig: { backoff: { failureThreshold: 3, baseCooldownMs: 10000, maxCooldownMs: 300000 } } as Config["daemon"],
      daemonStorage: { getDatabase: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonStorage"],
      approvalQueue: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["approvalQueue"],
      triggerRegistry: { register: vi.fn() },
      heartbeatLoop: { setDeployTrigger: vi.fn(), onTaskSettled: vi.fn() },
      daemonEventBus: { emit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonEventBus"],
      taskManager: { on: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["taskManager"],
      daemonContext: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonContext"],
    });
    expect(result).toEqual({});
    expect(result.deploymentExecutor).toBeUndefined();
    expect(result.readinessChecker).toBeUndefined();
    expect(result.deployTrigger).toBeUndefined();
  });
});

describe("initializeDeploymentStage — fully injected via deps", () => {
  it("returns deploymentExecutor and readinessChecker from deps factories", async () => {
    const fakeReadinessChecker = { validateScriptPath: vi.fn() };
    const fakeDeploymentExecutor = { getStats: vi.fn(() => ({})), getHistory: vi.fn(() => []) };
    const fakeCircuitBreaker = {};
    const fakeDeployTrigger = {};
    const fakeHeartbeatLoop = { setDeployTrigger: vi.fn(), onTaskSettled: vi.fn() };
    const fakeDaemonContext = {} as Record<string, unknown>;
    const fakeApprovalQueue = {};
    const fakeTriggerRegistry = { register: vi.fn() };
    const fakeTaskManager = { on: vi.fn() };
    const fakeEventBus = { emit: vi.fn(), on: vi.fn() };

    const result = await initializeDeploymentStage(
      {
        config: makeConfig({ deployment: { enabled: true, testCommand: "npm test", targetBranch: "main", requireCleanGit: true, testTimeoutMs: 60000, executionTimeoutMs: 600000, cooldownMinutes: 30, notificationUrgency: "medium" } as Config["deployment"] }),
        logger: createMockLogger(),
        daemonConfig: { backoff: { failureThreshold: 3, baseCooldownMs: 10000, maxCooldownMs: 300000 } } as Config["daemon"],
        daemonStorage: { getDatabase: vi.fn(() => ({})) } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonStorage"],
        approvalQueue: fakeApprovalQueue as unknown as Parameters<typeof initializeDeploymentStage>[0]["approvalQueue"],
        triggerRegistry: fakeTriggerRegistry,
        heartbeatLoop: fakeHeartbeatLoop,
        daemonEventBus: fakeEventBus as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonEventBus"],
        taskManager: fakeTaskManager as unknown as Parameters<typeof initializeDeploymentStage>[0]["taskManager"],
        daemonContext: fakeDaemonContext as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonContext"],
      },
      {
        createReadinessChecker: vi.fn(() => fakeReadinessChecker),
        createDeploymentExecutor: vi.fn(() => fakeDeploymentExecutor),
        createDeployCircuitBreaker: vi.fn(() => fakeCircuitBreaker),
        createDeployTrigger: vi.fn(() => fakeDeployTrigger),
        registerDeployApprovalBridge: vi.fn(),
      } as unknown as Parameters<typeof initializeDeploymentStage>[1],
    );

    expect(result.deploymentExecutor).toBe(fakeDeploymentExecutor);
    expect(result.readinessChecker).toBe(fakeReadinessChecker);
    expect(result.deployTrigger).toBe(fakeDeployTrigger);
  });

  it("registers the deploy trigger and wires heartbeat hooks", async () => {
    const fakeTrigger = {};
    const fakeHeartbeatLoop = { setDeployTrigger: vi.fn(), onTaskSettled: vi.fn() };
    const fakeTriggerRegistry = { register: vi.fn() };
    const fakeTaskManager = { on: vi.fn() };

    await initializeDeploymentStage(
      {
        config: makeConfig({ deployment: { enabled: true, testCommand: "npm test", targetBranch: "main", requireCleanGit: true, testTimeoutMs: 60000, executionTimeoutMs: 600000, cooldownMinutes: 30, notificationUrgency: "medium" } as Config["deployment"] }),
        logger: createMockLogger(),
        daemonConfig: { backoff: { failureThreshold: 3, baseCooldownMs: 10000, maxCooldownMs: 300000 } } as Config["daemon"],
        daemonStorage: { getDatabase: vi.fn(() => ({})) } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonStorage"],
        approvalQueue: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["approvalQueue"],
        triggerRegistry: fakeTriggerRegistry,
        heartbeatLoop: fakeHeartbeatLoop,
        daemonEventBus: { emit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonEventBus"],
        taskManager: fakeTaskManager as unknown as Parameters<typeof initializeDeploymentStage>[0]["taskManager"],
        daemonContext: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonContext"],
      },
      {
        createReadinessChecker: vi.fn(() => ({ validateScriptPath: vi.fn() })),
        createDeploymentExecutor: vi.fn(() => ({})),
        createDeployCircuitBreaker: vi.fn(() => ({})),
        createDeployTrigger: vi.fn(() => fakeTrigger),
        registerDeployApprovalBridge: vi.fn(),
      } as unknown as Parameters<typeof initializeDeploymentStage>[1],
    );

    expect(fakeTriggerRegistry.register).toHaveBeenCalledTimes(1);
    expect(fakeHeartbeatLoop.setDeployTrigger).toHaveBeenCalledWith(fakeTrigger);
    // task:completed and task:failed hooks wired
    expect(fakeTaskManager.on).toHaveBeenCalledWith("task:completed", expect.any(Function));
    expect(fakeTaskManager.on).toHaveBeenCalledWith("task:failed", expect.any(Function));
  });

  it("returns empty object gracefully when factory throws", async () => {
    const result = await initializeDeploymentStage(
      {
        config: makeConfig({ deployment: { enabled: true, testCommand: "npm test", targetBranch: "main", requireCleanGit: true, testTimeoutMs: 60000, executionTimeoutMs: 600000, cooldownMinutes: 30, notificationUrgency: "medium" } as Config["deployment"] }),
        logger: createMockLogger(),
        daemonConfig: { backoff: { failureThreshold: 3, baseCooldownMs: 10000, maxCooldownMs: 300000 } } as Config["daemon"],
        daemonStorage: { getDatabase: vi.fn(() => ({})) } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonStorage"],
        approvalQueue: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["approvalQueue"],
        triggerRegistry: { register: vi.fn() },
        heartbeatLoop: { setDeployTrigger: vi.fn(), onTaskSettled: vi.fn() },
        daemonEventBus: { emit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonEventBus"],
        taskManager: { on: vi.fn() } as unknown as Parameters<typeof initializeDeploymentStage>[0]["taskManager"],
        daemonContext: {} as unknown as Parameters<typeof initializeDeploymentStage>[0]["daemonContext"],
      },
      {
        createReadinessChecker: vi.fn(() => { throw new Error("disk full"); }),
      } as unknown as Parameters<typeof initializeDeploymentStage>[1],
    );
    // The stage catches errors and returns {}
    expect(result).toEqual({});
  });
});
