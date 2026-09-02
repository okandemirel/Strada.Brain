import { describe, expect, it, vi } from "vitest";
import { createSupervisorExecuteNodeBridge, initializeWorkspaceRuntime } from "./bootstrap.js";
import { estimateCostWithCache } from "../budget/cost-model.js";

describe("createSupervisorExecuteNodeBridge", () => {
  it("carries the worker's tool evidence into NodeResult.toolResults (red run → red verdict)", async () => {
    // Audited 2026-09-02: every production NodeResult had `toolResults: []`,
    // so deriveTestVerdict read empty evidence and a supervised sprint whose
    // Unity node printed a failing suite produced NO mechanical verdict.
    const runWorkerEnvelope = vi.fn().mockResolvedValue({
      output: "sprint complete",
      workerResult: {
        status: "completed",
        toolTrace: [
          { toolName: "unity_playmode_verify", success: true, summary: "PlayMode verification FAILED — 3 of 40 tests failed", timestamp: 0 },
        ],
      },
    });
    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      workspaceBus: { emit: vi.fn() } as any,
      defaultChannelType: "cli",
    });

    const result = await bridge(
      { id: "node-1", task: "Run the suite", assignedProvider: "claude", assignedModel: "sonnet" } as any,
      { chatId: "chat-1", taskRunId: "taskrun_parent" } as any,
      new AbortController().signal,
    );

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.content).toContain("3 of 40 tests failed");
    const { deriveTestVerdict } = await import("../tasks/test-verdict.js");
    expect(deriveTestVerdict(result.toolResults.map((tr) => ({ content: String(tr.content), isError: tr.isError }))).testsGreen).toBe(false);
  });

  it("derives child workspace context and remaps blocked workers", async () => {
    const runWorkerEnvelope = vi.fn().mockResolvedValue({
      output: "Need user input",
      workerResult: {
        status: "blocked",
        reason: "Need user input",
      },
    });

    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: {
        runWorkerEnvelope,
      } as any,
      orchestrator: {} as any,
      workspaceBus: {
        emit: vi.fn(),
      } as any,
      defaultChannelType: "cli",
    });

    const result = await bridge(
      {
        id: "node-1",
        task: "Inspect screenshot",
        assignedProvider: "claude",
        assignedModel: "sonnet",
      } as any,
      {
        chatId: "chat-1",
        taskRunId: "taskrun_parent",
        userContent: [
          { type: "text", text: "Inspect screenshot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "cG5n" },
          },
        ],
        workspaceLease: {
          id: "lease-parent",
          path: "/tmp/parent-workspace",
        },
      } as any,
      new AbortController().signal,
    );

    expect(runWorkerEnvelope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "delegated",
        prompt: "Inspect screenshot",
        chatId: "chat-1",
        channelType: "cli",
        taskRunId: "taskrun_parent:node-1",
        assignedProvider: "claude",
        assignedModel: "sonnet",
        userContent: expect.any(Array),
        workspaceLease: expect.objectContaining({
          id: "lease-parent",
          path: "/tmp/parent-workspace",
        }),
        signal: expect.any(AbortSignal),
        supervisorMode: "off",
      }),
    );
    expect(result).toMatchObject({
      nodeId: "node-1",
      status: "failed",
      output: "Need user input",
      blockedReason: "Need user input",
    });
  });

  it("stamps the parent goal's monitorScope onto the worker envelope (the run's whole-goal rollup scope)", async () => {
    // Producer-side proof that monitorScope is wired (no longer a write-only sink): the supervisor
    // bridge stamps the ORIGINATING request's resolveConversationScope onto the worker envelope —
    // the SAME scope the supervisor uses for its own dag_init/task_update. The downstream consumer
    // lives in Orchestrator.runBackgroundTask (joinEpisode/joinEpisodeEnd), gated exactly like
    // executeTask/processMessage on `monitorScope !== own conversationScope`.
    const runWorkerEnvelope = vi.fn().mockResolvedValue({
      output: "done",
      workerResult: { status: "completed", finalSummary: "done", touchedFiles: [] },
    });

    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      workspaceBus: { emit: vi.fn() } as any,
      defaultChannelType: "cli",
    });

    // Parent request carries a distinct conversationId so the parent scope is that conversationId
    // (resolveConversationScope prefers conversationId over chatId) — proving the stamp is the
    // ORIGINATING request's scope, never a coarser/shared value or the worker's bare chatId.
    await bridge(
      { id: "node-9", task: "Sub-goal A" } as any,
      {
        chatId: "parent-chat",
        conversationId: "parent-conversation",
        taskRunId: "taskrun_parent",
      } as any,
      new AbortController().signal,
    );

    const envelope = runWorkerEnvelope.mock.calls[0]?.[1];
    // The parent scope (the conversationId) is stamped — NOT undefined (dormant) and NOT the
    // worker's bare chatId.
    expect(envelope.monitorScope).toBe("parent-conversation");
    // The bridge forwards the parent's identity verbatim, so the worker runs UNDER the parent's
    // own scope. The consumer therefore sees `monitorScope === own conversationScope` and
    // correctly SUPPRESSES a simple-card join — the supervisor already represents this sub-goal
    // as a DAG node, so the whole goal stays ONE monitor conversation without a stray card.
    expect(envelope.chatId).toBe("parent-chat");
    expect(envelope.conversationId).toBe("parent-conversation");
  });

  // audited 2026-09-02: every return path hardcoded cost: 0 while usage went only
  // to context.onUsage, so the supervisor's verification budget (a pct of node
  // cost) was always 0 -> POSITIVE_INFINITY, the cap the config names never
  // applied, and supervisor:complete told the dashboard the run cost $0.0000.
  it("stamps the node's real cost from the usage it forwarded", async () => {
    const usageA = { provider: "claude", inputTokens: 1000, outputTokens: 500 };
    const usageB = { provider: "claude", inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 100 };
    const runWorkerEnvelope = vi.fn().mockImplementation(async (_orch: unknown, params: any) => {
      params.onUsage?.(usageA);
      params.onUsage?.(usageB);
      return {
        output: "done",
        workerResult: { status: "completed", finalSummary: "done", touchedFiles: [] },
      };
    });
    const parentOnUsage = vi.fn();

    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      workspaceBus: { emit: vi.fn() } as any,
      defaultChannelType: "cli",
    });

    const result = await bridge(
      { id: "node-3", task: "Sub-goal C", assignedProvider: "claude" } as any,
      { chatId: "chat-1", taskRunId: "taskrun_parent", onUsage: parentOnUsage } as any,
      new AbortController().signal,
    );

    const expected = estimateCostWithCache(usageA, "claude") + estimateCostWithCache(usageB, "claude");
    expect(expected).toBeGreaterThan(0);
    expect(result.status).toBe("ok");
    expect(result.cost).toBeCloseTo(expected, 10);
    // The parent's ledger still sees every usage event.
    expect(parentOnUsage).toHaveBeenCalledTimes(2);
    expect(parentOnUsage).toHaveBeenNthCalledWith(1, usageA);
  });

  it("stamps the cost on a failed node too", async () => {
    const usage = { provider: "deepseek", inputTokens: 5000, outputTokens: 1000 };
    const runWorkerEnvelope = vi.fn().mockImplementation(async (_orch: unknown, params: any) => {
      params.onUsage?.(usage);
      return { output: "boom", workerResult: { status: "failed", reason: "boom" } };
    });
    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      defaultChannelType: "cli",
    });

    const result = await bridge(
      { id: "node-4", task: "Sub-goal D" } as any,
      { chatId: "chat-1", taskRunId: "taskrun_parent" } as any,
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.cost).toBeCloseTo(estimateCostWithCache(usage, "deepseek"), 10);
  });

  it("hands a wave-2 node what wave 1 produced, on the fresh-decomposition path (audited 2026-09-02)", async () => {
    // The bridge's dep-carry block was gated on `context.goalTree`, which the
    // brain never set on the fresh path (it decomposed into a LOCAL tree), and
    // no node result was ever written back into any tree — so "implement the
    // enemy state machine" received its one-line task and nothing of the design
    // the previous wave returned as prose.
    const { SupervisorBrain } = await import("../supervisor/supervisor-brain.js");
    const { CapabilityMatcher } = await import("../supervisor/capability-matcher.js");
    const { ProviderAssigner } = await import("../supervisor/provider-assigner.js");

    const now = Date.now();
    const nodes = new Map<string, any>([
      ["root", { id: "root", parentId: null, task: "Build the enemy", dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now }],
      ["s1", { id: "s1", parentId: "root", task: "design the enemy state machine", dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now }],
      ["s2", { id: "s2", parentId: "root", task: "implement the enemy state machine", dependsOn: ["s1"], depth: 1, status: "pending", createdAt: now, updatedAt: now }],
    ]);
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue({
        rootId: "root", sessionId: "s", taskDescription: "Build the enemy", nodes, createdAt: now,
      }),
    };

    const runWorkerEnvelope = vi.fn().mockImplementation(async (_orch: unknown, envelope: { prompt: string }) => ({
      output: envelope.prompt.startsWith("design")
        ? "DESIGN: states Idle→Patrol→Chase→Attack; transitions on player distance"
        : "implemented",
      workerResult: { status: "completed", toolTrace: [] },
    }));
    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      workspaceBus: { emit: vi.fn() } as any,
      defaultChannelType: "cli",
    });

    const brain = new SupervisorBrain({
      config: {
        enabled: true, complexityThreshold: "complex", maxParallelNodes: 4, nodeTimeoutMs: 5000,
        verificationMode: "disabled", verificationBudgetPct: 15, triageProvider: "groq",
        maxFailureBudget: 3, diversityCap: 0.6,
      },
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner([
        { name: "claude", model: "sonnet", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
      ]),
    });
    brain.setExecuteNode(bridge);

    const result = await brain.execute("Build the enemy", { chatId: "chat-1" } as any);
    expect(result?.succeeded).toBe(2);

    const prompts = runWorkerEnvelope.mock.calls.map((c) => c[1].prompt as string);
    const wave2 = prompts.find((p) => p.startsWith("implement the enemy state machine"));
    expect(wave2).toBeDefined();
    expect(wave2).toContain("Completed dependencies");
    expect(wave2).toContain("Idle→Patrol→Chase→Attack");
    // The tree-linkage stamp follows the same input: every node names its root.
    const envelopes = runWorkerEnvelope.mock.calls.map((c) => c[1]);
    expect(envelopes.every((e) => e.goalContext?.rootId === "root")).toBe(true);
  });

  it("wires supervisor execution before channel startup completes", () => {
    const setWorkspaceBus = vi.fn();
    const setMonitorLifecycle = vi.fn();
    const setExecuteNode = vi.fn();
    const setEventEmitter = vi.fn();
    const setDashboardWorkspaceBus = vi.fn();
    const setAgentWorkspaceRuntime = vi.fn();

    const workspaceBus = initializeWorkspaceRuntime({
      channel: {},
      orchestrator: {
        setWorkspaceBus,
        setMonitorLifecycle,
      } as any,
      backgroundExecutor: {
        setWorkspaceBus,
        setMonitorLifecycle,
        runWorkerEnvelope: vi.fn(),
      } as any,
      supervisorBrain: {
        setExecuteNode,
        setEventEmitter,
      },
      dashboard: {
        setWorkspaceBus: setDashboardWorkspaceBus,
      },
      agentManager: {
        setWorkspaceRuntime: setAgentWorkspaceRuntime,
      },
      orchestratorForSupervisorBridge: {} as any,
      channelType: "cli",
      stoppableServers: [],
    });

    expect(setWorkspaceBus).toHaveBeenCalledTimes(2);
    expect(setMonitorLifecycle).toHaveBeenCalledTimes(2);
    expect(setExecuteNode).toHaveBeenCalledTimes(1);
    expect(setEventEmitter).toHaveBeenCalledWith(workspaceBus);
    expect(setDashboardWorkspaceBus).toHaveBeenCalledWith(workspaceBus);
    expect(setAgentWorkspaceRuntime).toHaveBeenCalledWith(workspaceBus, expect.anything());
  });
});
