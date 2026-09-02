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
import { ProviderHealthRegistry } from "../../providers/provider-health.js";
import { setLiveChainMemberNames } from "../../providers/provider-outage.js";
import { estimateCostWithCache } from "../../../budget/cost-model.js";
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
// Step 5 retarget: runWorkerTask was DELETED with the v1 engine. The production probe is now
// `typeof orchestrator.createAgentCorePort === "function"` → selectAgentRunner (V2 spine).
// Tests that want the runner-seam path opt in via `orchestratorHasAgentCore = true` and script
// the fake runner through `scriptedRunnerRun` (selectAgentRunner is factory-mocked below —
// these tests exercise DELEGATION logic, not the engine).
let orchestratorHasAgentCore: boolean;
let scriptedRunnerRun: ReturnType<typeof vi.fn> | undefined;
let orchestratorOpts: Record<string, unknown>;
let seededAuthorizations: Array<[string, string[]]> = [];

vi.mock("../../orchestrator.js", () => {
  return {
    Orchestrator: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
      orchestratorOpts = opts;
      this._opts = opts;
      this.handleMessage = orchestratorHandleMessage;
      // Only expose the Agent Core wiring hook when the test opts in — absent hook ⇒ the
      // delegation falls back to the handleMessage path (the other tests' original behavior).
      this.createAgentCorePort = orchestratorHasAgentCore ? vi.fn() : undefined;
      this.getAgentCoreClock = orchestratorHasAgentCore ? vi.fn() : undefined;
      // The real Orchestrator carries the user's authorization across the
      // instance boundary; the mock has to offer the same seam.
      this.seedUserAuthorizedPaths = vi.fn((chatId: string, paths: readonly string[]) => {
        seededAuthorizations.push([chatId, [...paths]]);
      });
      this.addTool = vi.fn();
      this.removeTool = vi.fn();
    }),
  };
});

vi.mock("../../../agent-core/runner/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agent-core/runner/index.js")>();
  return {
    ...actual,
    // Fake AgentRunner: delegation-manager tests isolate EXECUTOR/DELEGATION logic from the
    // V2 engine; the scripted run returns a canned AgentRunResult per-test.
    selectAgentRunner: vi.fn(() => ({
      run: (request: unknown, io: unknown) => scriptedRunnerRun!(request, io),
    })),
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
    seededAuthorizations = [];

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
    orchestratorHasAgentCore = false;
    scriptedRunnerRun = undefined;

    db = new Database(":memory:");
    delegationLog = new DelegationLog(db);
    opts = buildManagerOpts({ delegationLog });
    manager = new DelegationManager(opts);
  });

  afterEach(() => {
    db.close();
  });

  describe("delegate() sync", () => {
    // Measured 2026-08-20: the run decomposed into multi-agent work and the
    // worker's first read of the design document the task was about came back
    // "Path resolves outside the project directory". Authorization lives in
    // per-Orchestrator state, and delegation builds a new Orchestrator — so
    // the evidence of what the user typed never crossed the boundary.
    it("hands the parent's authorized paths down to the sub-agent", async () => {
      await manager.delegate({
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: {
          ...TEST_TOOL_CONTEXT,
          userAuthorizedPaths: ["/Users/okan/Downloads/PixelFlow_GDD.docx"],
        },
      });

      expect(seededAuthorizations, "the worker was handed nothing").toHaveLength(1);
      expect(seededAuthorizations[0]![0]).toMatch(/^delegation-/);
      expect(seededAuthorizations[0]![1]).toEqual(["/Users/okan/Downloads/PixelFlow_GDD.docx"]);
    });

    it("hands down nothing when the parent held nothing", async () => {
      await manager.delegate({
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      });

      expect(seededAuthorizations[0]?.[1] ?? []).toEqual([]);
    });

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

    // Regression: the sub-agent provider MUST receive the configured base URL
    // (e.g. OpenCode Go), not silently fall back to the provider's preset default
    // (Zen) — that leak routed delegated calls to the wrong, uncredited endpoint.
    it("threads providerBaseUrls into the delegated sub-agent provider", async () => {
      opts = buildManagerOpts({ delegationLog, providerBaseUrls: { deepseek: "https://test.example/go/v1" } });
      manager = new DelegationManager(opts);

      await manager.delegate({
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      });

      expect(vi.mocked(createProvider)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "deepseek", baseUrl: "https://test.example/go/v1" }),
      );
    });

    it("returns blocked delegated worker results without throwing", async () => {
      // Runner-seam path: the scripted V2 runner returns an AgentRunResult (finalText ↔
      // WorkerRunResult.visibleResponse via the real toWorkerRunResult projection).
      orchestratorHasAgentCore = true;
      scriptedRunnerRun = vi.fn().mockResolvedValueOnce({
        status: "blocked",
        finalText: "Checkpoint from delegated worker",
        finalSummary: "Need a different diagnosis path",
        provider: "mock-provider",
        catalogVersion: "mock-provider:mock-model",
        assignmentVersion: 0,
        touchedFiles: ["src/runtime/reviewer.ts"],
        toolTrace: [],
        verificationResults: [],
        reviewFindings: [],
        artifacts: [],
        reason: "Need a different diagnosis path",
      });

      const request: DelegationRequest = {
        type: "analysis",
        task: "Analyze the repeated verifier loop",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await manager.delegate(request);

      expect(result.workerResult?.status).toBe("blocked");
      expect(result.content).toBe("Checkpoint from delegated worker");
    });

    it("round-trips a COMPLETED delegated worker result through the runner seam (Step 2 success path)", async () => {
      orchestratorHasAgentCore = true;
      scriptedRunnerRun = vi.fn().mockResolvedValueOnce({
        status: "completed",
        finalText: "The verifier loop is caused by a stale fingerprint",
        finalSummary: "Analysis complete",
        provider: "mock-provider",
        catalogVersion: "mock-provider:mock-model",
        assignmentVersion: 0,
        touchedFiles: [],
        toolTrace: [],
        verificationResults: [],
        reviewFindings: [],
        artifacts: [],
      });

      const request: DelegationRequest = {
        type: "analysis",
        task: "Analyze the repeated verifier loop",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await manager.delegate(request);

      // Step 5 reroute: the SUCCESS path round-trips the runner seam (V2 spine) →
      // AgentRunResult → toWorkerRunResult with visibleResponse(↔finalText) preserved into content.
      expect(result.workerResult?.status).toBe("completed");
      expect(result.content).toBe("The verifier loop is caused by a stale fingerprint");
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

    it("bills the parent for the sub-agent's MEASURED token usage, not a wall-clock guess", async () => {
      // Audited 2026-09-02: the delegated Orchestrator/runner got no usage
      // sink, so the only charge was tier x seconds with tokensIn/Out = 0. A
      // premium sub-agent burning 800k input tokens in 25s was billed $0.05
      // against a real cost of ~$2.70 by the repo's own rate table; on a
      // flat-fee chain the same guess charged imaginary money instead.
      orchestratorHasAgentCore = true;
      scriptedRunnerRun = vi.fn().mockImplementation(async (request: { onUsage?: (u: unknown) => void }) => {
        request.onUsage?.({
          provider: "claude",
          model: "claude-opus-4-6-20250514",
          inputTokens: 800_000,
          outputTokens: 20_000,
        });
        return {
          status: "completed",
          finalText: "done",
          finalSummary: "done",
          provider: "claude",
          catalogVersion: "claude:opus",
          assignmentVersion: 0,
          touchedFiles: [],
          toolTrace: [],
          verificationResults: [],
          reviewFindings: [],
          artifacts: [],
        };
      });

      const request: DelegationRequest = {
        type: "premium_task",
        task: "Design the module",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await manager.delegate(request);

      const budgetTracker = opts.budgetTracker as unknown as ReturnType<typeof createMockBudgetTracker>;
      expect(budgetTracker.recordCost).toHaveBeenCalledOnce();
      const [agentId, costUsd, meta] = budgetTracker.recordCost.mock.calls[0]! as [
        string,
        number,
        { model: string; tokensIn: number; tokensOut: number },
      ];
      expect(agentId).toBe(PARENT_AGENT_ID);
      expect(meta.tokensIn).toBe(800_000);
      expect(meta.tokensOut).toBe(20_000);
      expect(meta.model).toBe("claude-opus-4-6-20250514");
      const measured = estimateCostWithCache({ inputTokens: 800_000, outputTokens: 20_000 }, "claude");
      expect(costUsd).toBeCloseTo(measured, 6);
      expect(costUsd).toBeGreaterThan(1); // the wall-clock guess for a sub-second run is ~$0
      // The figure the parent sees is the one that was measured.
      expect(result.metadata.costUsd).toBeCloseTo(measured, 6);
      // Both engine paths carry the sink: the handleMessage path reads it from
      // the Orchestrator options, the V2 runner from the run request.
      expect(orchestratorOpts["onUsage"]).toBeTypeOf("function");
    });
  });

  describe("budget gate", () => {
    it("rejects delegation before spawn when the parent has exceeded its cap", async () => {
      const budgetTracker = createMockBudgetTracker();
      budgetTracker.isAgentExceeded.mockReturnValue(true);
      budgetTracker.getAgentUsage.mockReturnValue({ usedUsd: 12, limitUsd: 10, pct: 1.2 });

      const gatedManager = new DelegationManager(
        buildManagerOpts({
          delegationLog,
          budgetTracker: budgetTracker as never,
          getAgentBudgetCap: () => 10,
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

      await expect(gatedManager.delegate(request)).rejects.toThrow(
        /budget exceeded/i,
      );
      // Cap checked against the parent agent; sub-agent never spawned (no cost recorded).
      expect(budgetTracker.isAgentExceeded).toHaveBeenCalledWith(PARENT_AGENT_ID, 10);
      expect(budgetTracker.recordCost).not.toHaveBeenCalled();
      expect(orchestratorHandleMessage).not.toHaveBeenCalled();
    });

    it("allows delegation when the parent is under its cap", async () => {
      const budgetTracker = createMockBudgetTracker();
      budgetTracker.isAgentExceeded.mockReturnValue(false);

      const gatedManager = new DelegationManager(
        buildManagerOpts({
          delegationLog,
          budgetTracker: budgetTracker as never,
          getAgentBudgetCap: () => 10,
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

      const result = await gatedManager.delegate(request);
      expect(result.content).toBe("Sub-agent completed the task successfully.");
      expect(budgetTracker.isAgentExceeded).toHaveBeenCalledWith(PARENT_AGENT_ID, 10);
    });

    it("skips the budget gate (no-op) when no cap resolver is wired", async () => {
      const budgetTracker = createMockBudgetTracker();
      // Even if the tracker would report exceeded, no resolver => gate must not run.
      budgetTracker.isAgentExceeded.mockReturnValue(true);

      const ungatedManager = new DelegationManager(
        buildManagerOpts({ delegationLog, budgetTracker: budgetTracker as never }),
      );

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      const result = await ungatedManager.delegate(request);
      expect(result.content).toBe("Sub-agent completed the task successfully.");
      expect(budgetTracker.isAgentExceeded).not.toHaveBeenCalled();
    });

    it("skips the budget gate when the resolver returns undefined (unknown agent)", async () => {
      const budgetTracker = createMockBudgetTracker();
      budgetTracker.isAgentExceeded.mockReturnValue(true);

      const gatedManager = new DelegationManager(
        buildManagerOpts({
          delegationLog,
          budgetTracker: budgetTracker as never,
          getAgentBudgetCap: () => undefined,
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

      const result = await gatedManager.delegate(request);
      expect(result.content).toBe("Sub-agent completed the task successfully.");
      expect(budgetTracker.isAgentExceeded).not.toHaveBeenCalled();
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

  // Regression: per-attempt concurrency-slot ownership. Slots are reserved in
  // prepareRequest / re-acquired for escalation and released by
  // executeWithEscalation's per-attempt finally — exactly once, regardless of
  // setup throws, sibling delegations, or cancellation. A leaked or
  // double-released slot eventually wedges (or over-admits) a parent's delegation.
  describe("concurrency slot accounting (Series 3 H13/H14/M17)", () => {
    const slots = (): Map<string, number> =>
      (manager as unknown as { parentConcurrency: Map<string, number> }).parentConcurrency;
    const active = (): Map<string, { parentAgentId: string }> =>
      (manager as unknown as { activeDelegations: Map<string, { parentAgentId: string }> }).activeDelegations;
    const addSibling = (id: string): void => {
      slots().set(PARENT_AGENT_ID, (slots().get(PARENT_AGENT_ID) ?? 0) + 1);
      active().set(id, {
        abortController: new AbortController(),
        logId: 0,
        parentAgentId: PARENT_AGENT_ID,
        type: "code_review",
        startedAt: Date.now(),
      } as never);
    };
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const request = (mode: "sync" | "async"): DelegationRequest => ({
      type: "code_review",
      task: "x",
      parentAgentId: PARENT_AGENT_ID,
      depth: 0,
      mode,
      toolContext: TEST_TOOL_CONTEXT,
    });

    // H13: delegateAsync swallows the rejection; without per-attempt release the
    // slot reserved before the setup throw leaks.
    it("releases the slot when delegateAsync setup throws (H13)", async () => {
      vi.mocked(createProvider).mockImplementation(() => {
        throw new Error("missing provider credentials");
      });

      await manager.delegateAsync(request("async"));
      await flush();

      expect(slots().get(PARENT_AGENT_ID) ?? 0).toBe(0);
    });

    // H14: a parent-wide existence guard would see the live sibling and skip the
    // failed delegation's release, leaking its slot.
    it("releases only its own slot when a setup-throwing delegate has a live sibling (H14)", async () => {
      addSibling("sibling-1");
      vi.mocked(createProvider).mockImplementation(() => {
        throw new Error("missing provider credentials");
      });

      await expect(manager.delegate(request("sync"))).rejects.toThrow();

      expect(slots().get(PARENT_AGENT_ID)).toBe(1); // sibling slot preserved, no leak
      expect(active().has("sibling-1")).toBe(true);
    });

    // M17: cancelDelegation + the unwinding executeSingleDelegation must not both
    // decrement. With a live sibling, a double release would drop below 1.
    it("releases a cancelled delegation's slot exactly once, even with a sibling (M17)", async () => {
      addSibling("sibling-1");

      let rejectExec: (e: Error) => void = () => {};
      orchestratorHandleMessage.mockImplementation(
        () => new Promise<void>((_resolve, reject) => {
          rejectExec = reject;
        }),
      );

      await manager.delegateAsync(request("async"));
      await flush(); // register + reach the hung execution

      const subId = [...active().keys()].find((k) => k !== "sibling-1");
      expect(subId).toBeDefined();
      expect(slots().get(PARENT_AGENT_ID)).toBe(2);

      manager.cancelDelegation(subId as string);
      rejectExec(new Error("aborted")); // the hung execution unwinds on abort
      await flush();

      expect(slots().get(PARENT_AGENT_ID)).toBe(1); // exactly one release
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

  describe("configured model overrides", () => {
    it("a tier without an explicit model uses the deployment's configured model, not the paid preset", async () => {
      // Measured 2026-08-31: opencode aliases fell back to PROVIDER_PRESETS'
      // qwen3.6-plus (paid) while the deployment was pinned to a free tier —
      // six CreditsErrors before the fallback chain absorbed it.
      const cfg: DelegationConfig = {
        ...TEST_CONFIG,
        tiers: { ...TEST_TIER_MAP, cheap: "opencode" },
      };
      const mgr = new DelegationManager(
        buildManagerOpts({
          delegationLog,
          config: cfg,
          providerModels: { opencode: "nemotron-3.5-lightning-free" },
          apiKeys: { opencode: "sk-test" },
        }) as never,
      );
      const resolved = (
        mgr as unknown as { getDefaultModelForProvider(name: string): string }
      ).getDefaultModelForProvider("opencode");
      expect(resolved).toBe("nemotron-3.5-lightning-free");
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

  describe("cancellation is persisted as cancellation, not as a timeout", () => {
    // Measured 2026-09-02: cancelDelegation wrote status 'cancelled', then the
    // aborted run unwound into the catch where signal.aborted was true, so it
    // took the TIMEOUT branch: the row became 'timeout' and delegation:failed
    // said "Delegation timed out". Every daemon shutdown with an in-flight
    // sub-agent was recorded as a provider timeout.
    it("leaves the log row 'cancelled' and names the cancellation in the event", async () => {
      let rejectExec: (e: Error) => void = () => {};
      orchestratorHandleMessage = vi.fn().mockImplementation(
        () => new Promise<void>((_resolve, reject) => {
          rejectExec = reject;
        }),
      );

      const delegatePromise = manager.delegate({
        type: "code_review",
        task: "Cancellable task",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      }).catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      const [active] = manager.getActiveDelegations(PARENT_AGENT_ID);
      expect(active).toBeDefined();
      manager.cancelDelegation(active!.subAgentId);
      rejectExec(new Error("aborted"));
      await delegatePromise;

      const [row] = delegationLog.getHistory(1);
      expect(row!.status).toBe("cancelled");

      const emit = vi.mocked(opts.eventBus.emit);
      const failed = emit.mock.calls.filter(([name]) => name === "delegation:failed");
      expect(failed).toHaveLength(1);
      const payload = failed[0]![1] as { reason: string };
      expect(payload.reason).toMatch(/cancel/i);
      expect(payload.reason).not.toMatch(/timed out/i);
    });
  });

  describe("workspace commit verdict reaches the caller", () => {
    // Measured 2026-09-02: the lease commit ran in the `finally` AFTER
    // delegationLog.complete / delegation:completed / the return literal, and
    // its result went to one info log line. A sub-agent whose Board.cs was
    // quarantined as a conflict (project copy changed while it ran) reported
    // "I created Board.cs" to the parent with success:true — the project never
    // got the file and every consumer said it did.
    function leaseManagerWith(commit: () => Promise<unknown>) {
      const release = vi.fn().mockResolvedValue(undefined);
      const acquireLease = vi.fn().mockResolvedValue({
        id: "lease-1",
        kind: "temp-copy",
        sourceRoot: "/test/project",
        leaseRoot: "/tmp/leases",
        path: "/tmp/leases/lease-1",
        createdAt: Date.now(),
        commit,
        release,
      });
      return { manager: { acquireLease } as never, acquireLease, release };
    }

    const request = (): DelegationRequest => ({
      type: "code_review",
      task: "Create Board.cs",
      parentAgentId: PARENT_AGENT_ID,
      depth: 0,
      mode: "sync",
      toolContext: TEST_TOOL_CONTEXT,
    });

    it("tells the parent which files were NOT applied and carries the commit in metadata", async () => {
      const commit = vi.fn().mockResolvedValue({
        written: ["Assets/Scripts/Tile.cs"],
        conflicts: ["Assets/Scripts/Board.cs"],
        removed: ["Assets/Old.asmdef"],
        failed: ["Assets/Locked.meta"],
        conflictsQuarantinedUnder: "/test/project/.strada/lease-conflicts/lease-1",
      });
      const lease = leaseManagerWith(commit);
      manager = new DelegationManager(buildManagerOpts({ delegationLog, workspaceLeaseManager: lease.manager }));

      const result = await manager.delegate(request());

      expect(commit).toHaveBeenCalledTimes(1);
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(result.content).toContain("Sub-agent completed the task successfully.");
      expect(result.content).toContain("NOT applied to the project");
      expect(result.content).toContain("Assets/Scripts/Board.cs");
      expect(result.content).toContain(".strada/lease-conflicts/lease-1");
      expect(result.content).toContain("Assets/Locked.meta");
      expect(result.content).toContain("Assets/Old.asmdef");
      expect(result.metadata.commit).toEqual({
        written: 1,
        conflicts: ["Assets/Scripts/Board.cs"],
        failed: ["Assets/Locked.meta"],
        removed: ["Assets/Old.asmdef"],
        quarantinedUnder: "/test/project/.strada/lease-conflicts/lease-1",
      });
    });

    it("adds nothing to a clean commit beyond the applied count", async () => {
      const commit = vi.fn().mockResolvedValue({
        written: ["Assets/Scripts/Board.cs"],
        conflicts: [],
        removed: [],
        failed: [],
        conflictsQuarantinedUnder: null,
      });
      const lease = leaseManagerWith(commit);
      manager = new DelegationManager(buildManagerOpts({ delegationLog, workspaceLeaseManager: lease.manager }));

      const result = await manager.delegate(request());

      expect(result.content).not.toContain("NOT applied");
      expect(result.metadata.commit?.written).toBe(1);
      expect(result.metadata.commit?.conflicts).toEqual([]);
    });

    it("fails the delegation when the commit itself throws — the work was discarded", async () => {
      const commit = vi.fn().mockRejectedValue(new Error("EACCES: project root not writable"));
      const lease = leaseManagerWith(commit);
      const localOpts = buildManagerOpts({ delegationLog, workspaceLeaseManager: lease.manager });
      manager = new DelegationManager(localOpts);

      await expect(manager.delegate(request())).rejects.toThrow(/discarded.*EACCES/);

      expect(lease.release).toHaveBeenCalledTimes(1);
      const [row] = delegationLog.getHistory(1);
      expect(row!.status).toBe("failed");
      const emit = vi.mocked(localOpts.eventBus.emit);
      expect(emit.mock.calls.some(([name]) => name === "delegation:completed")).toBe(false);
    });
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

  describe("provider health gate", () => {
    let healthRegistry: InstanceType<typeof ProviderHealthRegistry>;

    beforeEach(() => {
      ProviderHealthRegistry.resetInstance();
      healthRegistry = ProviderHealthRegistry.getInstance();
    });

    afterEach(() => {
      ProviderHealthRegistry.resetInstance();
    });

    it("rejects delegation when all tracked providers are down", async () => {
      // Mark two providers as down — requires 5 consecutive failures (default downThreshold)
      for (let i = 0; i < 5; i++) {
        healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
        healthRegistry.recordFailure("claude", "HTTP 529 overloaded");
      }

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).rejects.toThrow(
        "All providers are in cooldown",
      );
    });

    it("does NOT hard-abort when all providers are DOWN but recovery is imminent", async () => {
      // Drive BOTH providers fully "down" (5 failures) so the allDown gate branch is actually
      // entered, then pull their cooldown into the 60s recovery window so recoveryImminent=true.
      // The thundering-herd gate must NOT fire — the sub-agent's FallbackChain owns the single
      // bounded wait-for-recovery. Any other mock-driven rejection is fine; only the cooldown
      // gate error is forbidden.
      for (let i = 0; i < 5; i++) {
        healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
        healthRegistry.recordFailure("claude", "HTTP 529 overloaded");
      }
      const near = Date.now() + 5_000; // within the 60s window → imminent
      Object.assign(healthRegistry.getEntry("deepseek")!, { cooldownUntil: near });
      Object.assign(healthRegistry.getEntry("claude")!, { cooldownUntil: near });
      expect(healthRegistry.areAllUnavailable()).toBe(true);
      expect(healthRegistry.suggestRecoveryWaitMs()).not.toBeNull();

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await manager.delegate(request).then(
        () => {},
        (err: unknown) => {
          expect(String((err as Error)?.message ?? err)).not.toContain(
            "All providers are in cooldown",
          );
        },
      );
    });

    it("hard-aborts when all providers are DOWN and recovery is NOT imminent", async () => {
      // Both down with cooldowns far beyond the recovery window → recoveryImminent=false → the
      // gate must still throw (pins the other side of the softening).
      for (let i = 0; i < 5; i++) {
        healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
        healthRegistry.recordFailure("claude", "HTTP 529 overloaded");
      }
      const far = Date.now() + 10 * 60_000; // beyond the 60s window
      Object.assign(healthRegistry.getEntry("deepseek")!, { cooldownUntil: far });
      Object.assign(healthRegistry.getEntry("claude")!, { cooldownUntil: far });
      expect(healthRegistry.suggestRecoveryWaitMs()).toBeNull();

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).rejects.toThrow(
        "All providers are in cooldown",
      );
    });

    it("scopes the recovery probe to live chain members, not every tracked entry", async () => {
      // Audited 2026-09-02: the allDown reduction was scoped to chain members
      // (879e1e6b) but the recovery probe two lines later still asked the
      // registry about EVERY tracked entry. A de-configured provider cooling
      // for 30s made "recovery imminent" true while the only real member was
      // quota-dead for 8h, so the herd guard waved every delegation through.
      setLiveChainMemberNames(["deepseek"]);
      try {
        for (let i = 0; i < 5; i++) {
          healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
          healthRegistry.recordFailure("kimi", "HTTP 529 overloaded");
        }
        const now = Date.now();
        Object.assign(healthRegistry.getEntry("deepseek")!, { cooldownUntil: now + 8 * 3_600_000 });
        Object.assign(healthRegistry.getEntry("kimi")!, { cooldownUntil: now + 30_000 });
        // What the gate used to ask vs what it means to ask.
        expect(healthRegistry.suggestRecoveryWaitMs(now)).not.toBeNull();
        expect(healthRegistry.suggestRecoveryWaitMs(now, ["deepseek"])).toBeNull();

        const request: DelegationRequest = {
          type: "code_review",
          task: "Review this code",
          parentAgentId: PARENT_AGENT_ID,
          depth: 0,
          mode: "sync",
          toolContext: TEST_TOOL_CONTEXT,
        };

        await expect(manager.delegate(request)).rejects.toThrow(
          "All providers are in cooldown",
        );
      } finally {
        setLiveChainMemberNames([]);
      }
    });

    it("allows delegation when at least one provider is healthy", async () => {
      // Mark one provider as down (5 failures)
      for (let i = 0; i < 5; i++) {
        healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
      }
      // Give claude a failure then recover it — ensures it has an entry with healthy status
      healthRegistry.recordFailure("claude", "transient error");
      healthRegistry.recordSuccess("claude");

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // Should NOT throw the health gate error (may throw other errors since it's a test mock, that's fine)
      await expect(manager.delegate(request)).resolves.toBeDefined();
    });

    it("allows delegation when no providers are tracked yet", async () => {
      // Fresh registry with zero entries — should not block
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      await expect(manager.delegate(request)).resolves.toBeDefined();
    });

    it("isDelegationProviderAvailable returns false for down providers", async () => {
      // Mark deepseek as down — requires 5 consecutive failures (default downThreshold)
      for (let i = 0; i < 5; i++) {
        healthRegistry.recordFailure("deepseek", "HTTP 529 overloaded");
      }

      // Build a manager with only deepseek key — deepseek should be unavailable
      const healthOpts = buildManagerOpts({
        delegationLog,
        apiKeys: { deepseek: "test-key" },
      });
      const healthManager = new DelegationManager(healthOpts);

      const request: DelegationRequest = {
        type: "code_review",
        task: "Review this code",
        parentAgentId: PARENT_AGENT_ID,
        depth: 0,
        mode: "sync",
        toolContext: TEST_TOOL_CONTEXT,
      };

      // The provider resolution should fail because deepseek is down and no other provider has a key
      await expect(healthManager.delegate(request)).rejects.toThrow();
    });
  });
});
