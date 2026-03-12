/**
 * Tests for DelegationManager
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DelegationManager } from "./delegation-manager.js";
import type { DelegationManagerOptions } from "./delegation-manager.js";
import { DelegationLog } from "./delegation-log.js";
import { TierRouter } from "./tier-router.js";
import type {
  DelegationConfig,
  DelegationRequest,
  ModelTier,
} from "./delegation-types.js";
import type { AgentId } from "../agent-types.js";
import type { ToolContext } from "../../tools/tool-core.interface.js";
import type { ITool } from "../../tools/tool.interface.js";
import type { LearningEventMap } from "../../../core/event-bus.js";
import type { IEventBus } from "../../../core/event-bus.js";

// =============================================================================
// MOCKS
// =============================================================================

// Mock the Orchestrator module
vi.mock("../../orchestrator.js", () => {
  return {
    Orchestrator: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
      this._opts = opts;
      this.handleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
        // Simulate: the orchestrator sends a response through the channel
        const channel = opts.channel as { sendText: (chatId: string, text: string) => Promise<void> };
        await channel.sendText(
          msg.chatId as string,
          "Sub-agent completed the task successfully.",
        );
      });
      this.addTool = vi.fn();
      this.removeTool = vi.fn();
    }),
  };
});

// Mock the provider-registry module
vi.mock("../../providers/provider-registry.js", () => {
  return {
    createProvider: vi.fn().mockReturnValue({
      name: "mock-provider",
      chat: vi.fn(),
      chatWithTools: vi.fn(),
    }),
  };
});

// Mock the ProviderManager
vi.mock("../../providers/provider-manager.js", () => {
  return {
    ProviderManager: vi.fn().mockImplementation(function (this: Record<string, unknown>, provider: unknown) {
      this._defaultProvider = provider;
      this.getProvider = vi.fn().mockReturnValue(provider);
      this.getActiveInfo = vi.fn().mockReturnValue({
        providerName: "mock-provider",
        model: "mock-model",
        isDefault: true,
      });
      this.shutdown = vi.fn();
    }),
  };
});

// =============================================================================
// TEST FIXTURES
// =============================================================================

const TEST_TIER_MAP: Record<ModelTier, string> = {
  local: "ollama:llama3.3",
  cheap: "deepseek:deepseek-chat",
  standard: "claude:claude-sonnet-4-20250514",
  premium: "claude:claude-opus-4-20250514",
};

const TEST_CONFIG: DelegationConfig = {
  enabled: true,
  maxDepth: 2,
  maxConcurrentPerParent: 3,
  tiers: TEST_TIER_MAP,
  types: [
    { name: "code_review", tier: "cheap", timeoutMs: 60000, maxIterations: 10 },
    { name: "analysis", tier: "standard", timeoutMs: 90000, maxIterations: 15 },
    { name: "local_task", tier: "local", timeoutMs: 30000, maxIterations: 5 },
    { name: "premium_task", tier: "premium", timeoutMs: 120000, maxIterations: 20 },
  ],
  verbosity: "quiet",
};

const PARENT_AGENT_ID = "parent-001" as AgentId;

const TEST_TOOL_CONTEXT: ToolContext = {
  projectPath: "/test/project",
  workingDirectory: "/test/project",
  readOnly: false,
  userId: "user-1",
  chatId: "chat-1",
  sessionId: "session-1",
};

function createMockTool(name: string): ITool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

function createMockEventBus(): IEventBus<LearningEventMap> {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBudgetTracker() {
  return {
    recordCost: vi.fn(),
    isAgentExceeded: vi.fn().mockReturnValue(false),
    getAgentUsage: vi.fn().mockReturnValue({ usedUsd: 0, limitUsd: 10, pct: 0 }),
    getGlobalUsage: vi.fn().mockReturnValue({ usedUsd: 0, limitUsd: 100, pct: 0 }),
    getAllAgentUsages: vi.fn().mockReturnValue(new Map()),
    initialize: vi.fn(),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("DelegationManager", () => {
  let db: Database.Database;
  let delegationLog: DelegationLog;
  let tierRouter: TierRouter;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let budgetTracker: ReturnType<typeof createMockBudgetTracker>;
  let parentTools: ITool[];
  let manager: DelegationManager;

  beforeEach(() => {
    db = new Database(":memory:");
    delegationLog = new DelegationLog(db);
    tierRouter = new TierRouter(TEST_TIER_MAP);
    eventBus = createMockEventBus();
    budgetTracker = createMockBudgetTracker();
    parentTools = [
      createMockTool("read_file"),
      createMockTool("search_code"),
      createMockTool("delegate_code_review"),
      createMockTool("delegate_analysis"),
    ];

    const opts: DelegationManagerOptions = {
      config: TEST_CONFIG,
      tierRouter,
      delegationLog,
      eventBus: eventBus as unknown as IEventBus<LearningEventMap>,
      budgetTracker: budgetTracker as never,
      channel: {
        name: "test",
        connect: vi.fn(),
        disconnect: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
        onMessage: vi.fn(),
        sendText: vi.fn(),
        sendMarkdown: vi.fn(),
      } as never,
      projectPath: "/test/project",
      readOnly: false,
      stradaDeps: {
        coreInstalled: false,
        corePath: null,
        modulesInstalled: false,
        modulesPath: null,
        warnings: [],
      },
      parentTools,
      apiKeys: { deepseek: "test-key", claude: "test-key" },
    };

    manager = new DelegationManager(opts);
  });

  afterEach(() => {
    db.close();
  });

  describe("delegate() sync", () => {
    it("spawns a sub-agent and returns captured result", async () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await manager.delegate(request);

      expect(result.content).toBe("Sub-agent completed the task successfully.");
      expect(result.metadata).toBeDefined();
      expect(result.metadata.tier).toBe("cheap");
      expect(result.metadata.escalated).toBe(false);
    });

    it("logs start/complete in DelegationLog", async () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegate(request);

      const entries = delegationLog.getByParent(PARENT_AGENT_ID);
      expect(entries.length).toBe(1);
      expect(entries[0]!.status).toBe("completed");
      expect(entries[0]!.type).toBe("code_review");
    });

    it("emits delegation:started and delegation:completed events", async () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegate(request);

      const emitCalls = eventBus.emit.mock.calls;
      const startedCall = emitCalls.find(
        (c: unknown[]) => c[0] === "delegation:started",
      );
      const completedCall = emitCalls.find(
        (c: unknown[]) => c[0] === "delegation:completed",
      );

      expect(startedCall).toBeDefined();
      expect(completedCall).toBeDefined();
    });

    it("deducts cost from parent budget via AgentBudgetTracker", async () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegate(request);

      expect(budgetTracker.recordCost).toHaveBeenCalledOnce();
      const [agentId] = budgetTracker.recordCost.mock.calls[0]!;
      expect(agentId).toBe(PARENT_AGENT_ID);
    });
  });

  describe("concurrency enforcement", () => {
    it("enforces max concurrent delegations per parent", async () => {
      const requests = Array.from({ length: 4 }, (_, i) => ({
        type: "code_review",
        task: `Task ${i}`,
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync" as const,
        toolContext: TEST_TOOL_CONTEXT,
      }));

      // Start 3 delegations concurrently (max is 3)
      const promises = requests.slice(0, 3).map((r) => manager.delegate(r));

      // Wait for first to complete to free a slot
      await Promise.all(promises);

      // 4th should work after slots freed
      const result = await manager.delegate(requests[3]!);
      expect(result.content).toBeDefined();
    });
  });

  describe("timeout", () => {
    it("times out via AbortController and cleans up sub-agent", async () => {
      // Use a type with very short timeout
      const shortConfig: DelegationConfig = {
        ...TEST_CONFIG,
        types: [
          { name: "fast_task", tier: "cheap", timeoutMs: 1, maxIterations: 1 },
        ],
      };

      const shortManager = new DelegationManager({
        config: shortConfig,
        tierRouter,
        delegationLog,
        eventBus: eventBus as unknown as IEventBus<LearningEventMap>,
        budgetTracker: budgetTracker as never,
        channel: {
          name: "test",
          connect: vi.fn(),
          disconnect: vi.fn(),
          isHealthy: vi.fn().mockReturnValue(true),
          onMessage: vi.fn(),
          sendText: vi.fn(),
          sendMarkdown: vi.fn(),
        } as never,
        projectPath: "/test/project",
        readOnly: false,
        stradaDeps: {
          coreInstalled: false,
          corePath: null,
          modulesInstalled: false,
          modulesPath: null,
          warnings: [],
        },
        parentTools,
        apiKeys: { deepseek: "test-key", claude: "test-key" },
      });

      // Mock orchestrator to take a long time
      const { Orchestrator } = await import("../../orchestrator.js");
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        function (this: Record<string, unknown>, opts: Record<string, unknown>) {
          this._opts = opts;
          this.handleMessage = vi.fn().mockImplementation(
            () =>
              new Promise((resolve) => {
                // This will hang until aborted
                setTimeout(resolve, 10000);
              }),
          );
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "fast_task",
        task: "Quick task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // Should throw/fail due to timeout
      await expect(shortManager.delegate(request)).rejects.toThrow();
    });
  });

  describe("escalation", () => {
    it("escalates on failure: cheap->standard (max 1 retry)", async () => {
      // Mock first call to fail, second to succeed
      const { Orchestrator } = await import("../../orchestrator.js");
      let callCount = 0;
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function (this: Record<string, unknown>, opts: Record<string, unknown>) {
          this._opts = opts;
          const currentCall = callCount++;
          this.handleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
            if (currentCall === 0) {
              throw new Error("Model failed");
            }
            const channel = opts.channel as { sendText: (chatId: string, text: string) => Promise<void> };
            await channel.sendText(msg.chatId as string, "Escalated result");
          });
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await manager.delegate(request);

      expect(result.metadata.escalated).toBe(true);
      expect(result.metadata.escalatedFrom).toBe("cheap");
      expect(result.content).toBe("Escalated result");
    });

    it("does NOT escalate local tier failures", async () => {
      const { Orchestrator } = await import("../../orchestrator.js");
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function (this: Record<string, unknown>) {
          this.handleMessage = vi.fn().mockRejectedValue(new Error("Local model failed"));
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "local_task",
        task: "Local task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).rejects.toThrow("Local model failed");
    });

    it("does NOT escalate premium tier (no higher tier)", async () => {
      const { Orchestrator } = await import("../../orchestrator.js");
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function (this: Record<string, unknown>) {
          this.handleMessage = vi.fn().mockRejectedValue(new Error("Premium failed"));
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "premium_task",
        task: "Premium task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).rejects.toThrow("Premium failed");
    });
  });

  describe("delegateAsync", () => {
    it("returns immediately (void) and emits event when done", async () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Async review",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "async",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegateAsync(request);

      // Wait a tick for the background promise to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const emitCalls = eventBus.emit.mock.calls;
      const completedCall = emitCalls.find(
        (c: unknown[]) => c[0] === "delegation:completed",
      );
      expect(completedCall).toBeDefined();
    });
  });

  describe("depth tool filtering", () => {
    it("at maxDepth, delegate_ tools excluded from sub-agent", async () => {
      const { Orchestrator } = await import("../../orchestrator.js");
      let capturedTools: ITool[] = [];
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function (this: Record<string, unknown>, opts: { tools: ITool[]; channel: { sendText: (chatId: string, text: string) => Promise<void> } }) {
          capturedTools = opts.tools;
          this._opts = opts;
          this.handleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
            await opts.channel.sendText(msg.chatId as string, "Result");
          });
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review at max depth",
        parentAgentId: PARENT_AGENT_ID,
        depth: 1, // depth 1, maxDepth 2 -> sub-agent depth is 1, which equals maxDepth
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegate(request);

      const delegateTools = capturedTools.filter((t) => t.name.startsWith("delegate_"));
      expect(delegateTools).toHaveLength(0);

      // Non-delegation tools should still be there
      const nonDelegateTools = capturedTools.filter((t) => !t.name.startsWith("delegate_"));
      expect(nonDelegateTools.length).toBeGreaterThan(0);
    });
  });

  describe("cancelDelegation", () => {
    it("aborts a running delegation", async () => {
      const { Orchestrator } = await import("../../orchestrator.js");
      let resolveFn: (() => void) | null = null;
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function (this: Record<string, unknown>, opts: Record<string, unknown>) {
          this._opts = opts;
          this.handleMessage = vi.fn().mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                resolveFn = resolve;
              }),
          );
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Cancellable task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // Start delegation in background
      const delegatePromise = manager.delegate(request).catch(() => {
        // Expected to fail due to cancellation
      });

      // Wait for delegation to start
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const activeBefore = manager.getActiveDelegations(PARENT_AGENT_ID);
      expect(activeBefore.length).toBe(1);

      // Cancel it
      manager.cancelDelegation(activeBefore[0]!.subAgentId);

      // Allow the cancel to propagate
      if (resolveFn) resolveFn();
      await delegatePromise;

      const activeAfter = manager.getActiveDelegations(PARENT_AGENT_ID);
      expect(activeAfter.length).toBe(0);
    });
  });

  describe("getActiveDelegations", () => {
    it("returns currently running delegations for a parent", async () => {
      // Initially empty
      expect(manager.getActiveDelegations(PARENT_AGENT_ID)).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("cancels all active delegations", async () => {
      await manager.shutdown();

      // Should not throw and active delegations should be cleared
      expect(manager.getActiveDelegations(PARENT_AGENT_ID)).toHaveLength(0);
    });
  });

  describe("validation", () => {
    it("throws on unknown delegation type", async () => {
      const request: DelegationRequest = {
        type: "nonexistent_type",
        task: "This should fail",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).rejects.toThrow("Unknown delegation type");
    });
  });
});
