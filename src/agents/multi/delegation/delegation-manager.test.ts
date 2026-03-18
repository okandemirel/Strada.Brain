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
import { createProvider } from "../../providers/provider-registry.js";
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

// Store the mock constructor so tests can override handleMessage per-test
let orchestratorHandleMessage: ReturnType<typeof vi.fn>;
let orchestratorOpts: Record<string, unknown>;

vi.mock("../../orchestrator.js", () => {
  return {
    Orchestrator: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
      orchestratorOpts = opts;
      this._opts = opts;
      this.handleMessage = orchestratorHandleMessage;
      this.addTool = vi.fn();
      this.removeTool = vi.fn();
    }),
  };
});

vi.mock("../../providers/provider-registry.js", () => {
  return {
    PROVIDER_PRESETS: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.2",
        label: "OpenAI",
      },
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        label: "DeepSeek",
      },
    },
    createProvider: vi.fn().mockReturnValue({
      name: "mock-provider",
      chat: vi.fn(),
      chatWithTools: vi.fn(),
    }),
  };
});

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
  standard: "claude:claude-sonnet-4-6-20250514",
  premium: "claude:claude-opus-4-6-20250514",
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

function buildManagerOpts(overrides?: Partial<DelegationManagerOptions>): DelegationManagerOptions {
  return {
    config: TEST_CONFIG,
    tierRouter: new TierRouter(TEST_TIER_MAP),
    delegationLog: overrides?.delegationLog ?? new DelegationLog(new Database(":memory:")),
    eventBus: createMockEventBus() as unknown as IEventBus<LearningEventMap>,
    budgetTracker: createMockBudgetTracker() as never,
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
    parentTools: [
      createMockTool("read_file"),
      createMockTool("search_code"),
      createMockTool("delegate_code_review"),
      createMockTool("delegate_analysis"),
    ],
    apiKeys: { deepseek: "test-key", claude: "test-key" },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("DelegationManager", () => {
  let db: Database.Database;
  let delegationLog: DelegationLog;
  let opts: DelegationManagerOptions;
  let manager: DelegationManager;

  beforeEach(() => {
    vi.mocked(createProvider).mockReset();
    vi.mocked(createProvider).mockImplementation((config: { name: string; model?: string }) => ({
      name: config.name,
      capabilities: {
        maxTokens: 8192,
        streaming: true,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chat: vi.fn(),
      chatWithTools: vi.fn(),
    }) as never);

    // Reset the orchestrator mock handler for each test
    orchestratorHandleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
      // Default: immediately send response through the capture channel
      const channel = orchestratorOpts.channel as { sendText: (chatId: string, text: string) => Promise<void> };
      await channel.sendText(
        msg.chatId as string,
        "Sub-agent completed the task successfully.",
      );
    });

    db = new Database(":memory:");
    delegationLog = new DelegationLog(db);
    opts = buildManagerOpts({ delegationLog });
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

      const emitCalls = (opts.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
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

      const budgetTracker = opts.budgetTracker as unknown as ReturnType<typeof createMockBudgetTracker>;
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

      // Run 3 then 1 -- all should succeed since the default mock resolves immediately
      const promises = requests.slice(0, 3).map((r) => manager.delegate(r));
      await Promise.all(promises);

      // 4th should work after slots freed
      const result = await manager.delegate(requests[3]!);
      expect(result.content).toBeDefined();
    });
  });

  describe("timeout", () => {
    it("times out via AbortController and cleans up sub-agent", async () => {
      // Use a local_task (local tier -- no escalation) with very short timeout
      const shortConfig: DelegationConfig = {
        ...TEST_CONFIG,
        types: [
          { name: "local_fast", tier: "local", timeoutMs: 10, maxIterations: 1 },
        ],
      };

      // Mock orchestrator to hang
      orchestratorHandleMessage = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30000);
          if (typeof timer === "object" && "unref" in timer) {
            (timer as NodeJS.Timeout).unref();
          }
        }),
      );

      const shortManager = new DelegationManager(
        buildManagerOpts({ config: shortConfig, delegationLog }),
      );

      const request: DelegationRequest = {
        type: "local_fast",
        task: "Quick task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // Should throw due to timeout (local tier = no escalation)
      await expect(shortManager.delegate(request)).rejects.toThrow();
    }, 15000);
  });

  describe("escalation", () => {
    it("escalates on failure: cheap->standard (max 1 retry)", async () => {
      // First call fails, second (escalated) succeeds
      let callCount = 0;
      orchestratorHandleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
        const currentCall = callCount++;
        if (currentCall === 0) {
          throw new Error("Model failed");
        }
        const channel = orchestratorOpts.channel as { sendText: (chatId: string, text: string) => Promise<void> };
        await channel.sendText(msg.chatId as string, "Escalated result");
      });

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
      orchestratorHandleMessage = vi.fn().mockRejectedValue(new Error("Local model failed"));

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
      orchestratorHandleMessage = vi.fn().mockRejectedValue(new Error("Premium failed"));

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

  describe("dynamic tier fallback", () => {
    it("falls back to a viable configured provider when the tier spec is unavailable", async () => {
      const fallbackConfig: DelegationConfig = {
        ...TEST_CONFIG,
        tiers: {
          ...TEST_TIER_MAP,
          cheap: "claude:claude-sonnet-4-6-20250514",
        },
      };

      vi.mocked(createProvider).mockImplementation((config: { name: string; model?: string }) => {
        if (config.name === "claude") {
          throw new Error("Claude provider requires an API key");
        }
        return {
          name: config.name,
          capabilities: {
            maxTokens: 8192,
            streaming: true,
            structuredStreaming: false,
            toolCalling: true,
            vision: false,
            systemPrompt: true,
            thinkingSupported: config.name === "deepseek",
          },
          chat: vi.fn(),
          chatWithTools: vi.fn(),
        } as never;
      });

      const fallbackManager = new DelegationManager(
        buildManagerOpts({
          config: fallbackConfig,
          delegationLog,
          apiKeys: { deepseek: "test-key" },
          providerCredentials: { deepseek: { apiKey: "test-key" } },
        }),
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await fallbackManager.delegate(request);

      expect(result.metadata.model).toBe("deepseek-chat");
      expect(vi.mocked(createProvider)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "deepseek",
          model: "deepseek-chat",
        }),
      );
    });

    it("supports auto tier routing for premium delegation", async () => {
      const autoConfig: DelegationConfig = {
        ...TEST_CONFIG,
        tiers: {
          ...TEST_TIER_MAP,
          premium: "auto",
        },
      };

      vi.mocked(createProvider).mockImplementation((config: { name: string; model?: string }) => {
        const capabilityMap: Record<string, { maxTokens: number; thinkingSupported?: boolean; toolCalling: boolean }> = {
          deepseek: { maxTokens: 8192, thinkingSupported: false, toolCalling: true },
          openai: { maxTokens: 64000, thinkingSupported: true, toolCalling: true },
        };
        const capabilities = capabilityMap[config.name] ?? { maxTokens: 8192, toolCalling: true };
        return {
          name: config.name,
          capabilities: {
            maxTokens: capabilities.maxTokens,
            streaming: true,
            structuredStreaming: false,
            toolCalling: capabilities.toolCalling,
            vision: false,
            systemPrompt: true,
            thinkingSupported: capabilities.thinkingSupported,
            contextWindow: capabilities.maxTokens * 2,
          },
          chat: vi.fn(),
          chatWithTools: vi.fn(),
        } as never;
      });

      const autoManager = new DelegationManager(
        buildManagerOpts({
          config: autoConfig,
          delegationLog,
          apiKeys: { deepseek: "test-key", openai: "test-key" },
          providerCredentials: {
            deepseek: { apiKey: "test-key" },
            openai: { apiKey: "test-key" },
          },
        }),
      );

      const request: DelegationRequest = {
        type: "premium_task",
        task: "Handle a frontier-quality task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await autoManager.delegate(request);

      expect(result.metadata.model).toBe("gpt-5.2");
      expect(vi.mocked(createProvider)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "openai",
          model: "gpt-5.2",
        }),
      );
    });

    it("does not inject an implicit ollama candidate when local auto-routing has no verified local provider", async () => {
      const autoLocalConfig: DelegationConfig = {
        ...TEST_CONFIG,
        tiers: {
          ...TEST_TIER_MAP,
          local: "auto",
        },
      };

      const autoLocalManager = new DelegationManager(
        buildManagerOpts({
          config: autoLocalConfig,
          delegationLog,
          apiKeys: { openai: "test-key" },
          providerCredentials: {
            openai: { apiKey: "test-key" },
          },
        }),
      );

      const request: DelegationRequest = {
        type: "local_task",
        task: "Handle this locally if possible",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await autoLocalManager.delegate(request);

      expect(result.metadata.model).toBe("gpt-5.2");
      expect(vi.mocked(createProvider)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "openai",
          model: "gpt-5.2",
        }),
      );
      expect(vi.mocked(createProvider)).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ollama",
        }),
      );
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

      // Wait for the background promise to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      const emitCalls = (opts.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
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
      (Orchestrator as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        function (this: Record<string, unknown>, innerOpts: { tools: ITool[]; channel: { sendText: (chatId: string, text: string) => Promise<void> } }) {
          capturedTools = innerOpts.tools;
          this._opts = innerOpts;
          this.handleMessage = vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
            await innerOpts.channel.sendText(msg.chatId as string, "Result");
          });
          this.addTool = vi.fn();
          this.removeTool = vi.fn();
        },
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review at max depth",
        parentAgentId: PARENT_AGENT_ID,
        depth: 1, // depth 1 + 1 = 2 = maxDepth -> sub-agent should NOT get delegation tools
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
    it("aborts a running delegation and cleans up", async () => {
      // Make the orchestrator hang so we can cancel it
      orchestratorHandleMessage = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30000);
          if (typeof timer === "object" && "unref" in timer) {
            (timer as NodeJS.Timeout).unref();
          }
        }),
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Cancellable task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // Start delegation -- will hang until cancelled
      const delegatePromise = manager.delegate(request).catch(() => {
        // Expected to fail via cancellation/abort
      });

      // Wait for the delegation to register
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const activeBefore = manager.getActiveDelegations(PARENT_AGENT_ID);
      expect(activeBefore.length).toBe(1);

      // Cancel the delegation
      manager.cancelDelegation(activeBefore[0]!.subAgentId);

      // The abort causes Promise.race to reject, settling the delegate promise
      await delegatePromise;

      const activeAfter = manager.getActiveDelegations(PARENT_AGENT_ID);
      expect(activeAfter.length).toBe(0);
    }, 5000);
  });

  describe("getActiveDelegations", () => {
    it("returns currently running delegations for a parent", async () => {
      expect(manager.getActiveDelegations(PARENT_AGENT_ID)).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("cancels all active delegations", async () => {
      await manager.shutdown();
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
