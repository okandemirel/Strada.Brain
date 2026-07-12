/**
 * BUG#1 P2 — engine seam tests for the live plain-loop step DAG.
 *
 * These prove the SUPPRESSION GUARD at portExecuteToolTurn's STEP E.5: the plain
 * interactive/background loop emits a per-tool-batch monitor step (dag_init + aligned
 * task_update flow via MonitorLifecycle.stepBatch), while a supervisor-node run
 * (goalContext set) or a decomposed run (goalsDecomposed true) or a re-scoped worker
 * (joinsParentEpisode true) emits NOTHING — so the plain-loop step DAG can never
 * collide with the supervisor dispatcher's node-id stream.
 */

import { describe, it, expect, vi } from "vitest";
import { portExecuteToolTurn, isPlainLoop, summarizePlainLoopBatch, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { createInitialState } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { ToolCall, ToolResult } from "../../agents/providers/provider.interface.js";

// ---------------------------------------------------------------------------
// Minimal real-ish deps + runCtx. The autonomy bundle + health tracker are REAL
// (cheap to construct); executeToolCalls is stubbed to a success result so the turn
// completes deterministically. Consensus managers are omitted (STEP D skipped) and
// memoryRefresher is null (STEP G is a no-op) so the turn stays hermetic.
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ToolTurnDeps>): ToolTurnDeps {
  const emitPlainLoopStep = vi.fn();
  const deps = {
    sessionManager: {
      extractLastUserMessage: () => "do the thing",
    },
    // STEP A: return one successful result per tool call.
    executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
      toolCalls.map((tc) => ({ toolCallId: tc.id, content: "ok", isError: false }) as unknown as ToolResult),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep,
    // STEP D consensus managers intentionally undefined → skipped.
    consensusManager: undefined,
    confidenceEstimator: undefined,
    providerRouter: undefined,
    providerManager: {} as never,
    taskClassifier: {} as never,
    getSupervisorRoutingContext: () => ({}) as never,
    currentSessionInstinctIds: new Map(),
    propagateInstinctIdsToChannel: vi.fn(),
    ...overrides,
  } as unknown as ToolTurnDeps;
  return deps;
}

function makeRunCtx(overrides?: Partial<EngineRunContext>): EngineRunContext {
  const bundle = createAutonomyBundle({ prompt: "do the thing", iterationBudget: 20 });
  const iterationHealth = new IterationHealthTracker(Date.now());
  return {
    onUsage: undefined,
    iterationHealth,
    healthAdapter: {} as never,
    session: { messages: [], conversationScope: "conv-1" } as never,
    chatId: "chat-1",
    metricId: undefined,
    toolExecMode: "interactive",
    workspaceLease: undefined,
    goalContext: undefined,
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: bundle.errorRecovery,
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: bundle.controlLoopTracker ?? undefined,
    systemPrompt: "sys",
    goalsDecomposed: false,
    identityKey: "id-1",
    userId: "user-1",
    conversationScope: "conv-1",
    executionStrategy: undefined,
    lastAssignment: { providerName: "p", modelId: "m" } as never,
    lastToolNames: [],
    lastProviderCapabilities: undefined,
    cumulativeOutputTokens: 0,
    taskStartedAtMs: Date.now(),
    progressLanguage: "en" as never,
    progressTitle: "Task",
    emitProgress: () => {},
    workerCollector: undefined,
    profileLanguage: undefined,
    joinsParentEpisode: false,
    workerMonitorScope: undefined,
    memoryRefresher: null,
    fixedExecutionStrategy: undefined,
    plainLoopStepIndex: 0,
    ...overrides,
  } as unknown as EngineRunContext;
}

const TOOL_CALLS: ToolCall[] = [
  { id: "tc-1", name: "read_file", input: {} } as unknown as ToolCall,
  { id: "tc-2", name: "edit_file", input: {} } as unknown as ToolCall,
];

// args tuple portExecuteToolTurn decodes: [toolCalls, _, agentState, responseText]
function makeArgs(): unknown[] {
  return [TOOL_CALLS, undefined, createInitialState("do the thing"), "the plan text"];
}

// ---------------------------------------------------------------------------

describe("isPlainLoop (engine-half suppression guard predicate)", () => {
  it("is TRUE for a plain loop (no goalContext, not a joined worker)", () => {
    expect(isPlainLoop(makeRunCtx())).toBe(true);
  });

  it("is FALSE for a supervisor-node run (goalContext set)", () => {
    expect(isPlainLoop(makeRunCtx({ goalContext: { rootId: "r", nodeId: "n" } }))).toBe(false);
  });

  it("is FALSE for a re-scoped worker that joined a parent episode", () => {
    expect(isPlainLoop(makeRunCtx({ joinsParentEpisode: true }))).toBe(false);
  });

  it("does NOT depend on goalsDecomposed (it flips true in PLANNING for EVERY run — the old bug)", () => {
    // The decomposition suppression is authoritatively applied by MonitorLifecycle.stepBatch,
    // NOT here. A plain interactive run has goalsDecomposed=true at tool-turn time (spine set it),
    // so the engine gate MUST still admit it — otherwise the feature is dead.
    expect(isPlainLoop(makeRunCtx({ goalsDecomposed: true }))).toBe(true);
  });
});

describe("summarizePlainLoopBatch", () => {
  it("dedupes + joins tool names", () => {
    expect(summarizePlainLoopBatch(TOOL_CALLS)).toBe("read_file, edit_file");
  });
  it("caps at 3 with a +N overflow", () => {
    const many = ["a", "b", "c", "d", "e"].map((n, i) => ({ id: `t${i}`, name: n, input: {} }) as unknown as ToolCall);
    expect(summarizePlainLoopBatch(many)).toBe("a, b, c +2");
  });
  it("falls back to a label when there are no names", () => {
    expect(summarizePlainLoopBatch([])).toBe("Working…");
  });
});

describe("portExecuteToolTurn — plain-loop step DAG emission", () => {
  it("emits one plain-loop step per batch with batchIndex 0 and an aligned tool label", async () => {
    const deps = makeDeps();
    const runCtx = makeRunCtx();

    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).toHaveBeenCalledTimes(1);
    expect(deps.emitPlainLoopStep).toHaveBeenCalledWith({
      conversationScope: "conv-1",
      monitorScope: undefined,
      batchIndex: 0,
      toolLabel: "read_file, edit_file",
    });
    // The per-run counter advanced so the NEXT batch would be step-1 (id alignment source).
    expect(runCtx.plainLoopStepIndex).toBe(1);
  });

  it("advances batchIndex monotonically across batches (single id source)", async () => {
    const deps = makeDeps();
    const runCtx = makeRunCtx();

    await portExecuteToolTurn(deps, makeArgs(), runCtx);
    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).toHaveBeenNthCalledWith(1, expect.objectContaining({ batchIndex: 0 }));
    expect(deps.emitPlainLoopStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ batchIndex: 1 }));
    expect(runCtx.plainLoopStepIndex).toBe(2);
  });

  it("threads the worker monitorScope through when present (rollup routing)", async () => {
    const deps = makeDeps();
    // A plain background run can still carry a workerMonitorScope only if it does NOT join a parent —
    // but if it joined, the guard suppresses. Here we exercise a plain loop whose scope override is set
    // but equal to its own scope (joinsParentEpisode false), proving the scope is forwarded verbatim.
    const runCtx = makeRunCtx({ workerMonitorScope: "conv-1", joinsParentEpisode: false });

    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ monitorScope: "conv-1" }));
  });
});

describe("portExecuteToolTurn — SUPPRESSION on supervisor/decomposed/joined runs", () => {
  it("emits NOTHING for a supervisor-node run (goalContext set) — never collides with the dispatcher node-id stream", async () => {
    const deps = makeDeps();
    const runCtx = makeRunCtx({ goalContext: { rootId: "goal-root", nodeId: "node-3" } });

    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).not.toHaveBeenCalled();
    expect(runCtx.plainLoopStepIndex).toBe(0); // counter untouched
  });

  it("STILL calls emitPlainLoopStep when goalsDecomposed=true (engine gate is decomposition-agnostic; MonitorLifecycle.stepBatch applies the authoritative no-op)", async () => {
    // Regression guard for the DEAD-FEATURE bug: goalsDecomposed is true on EVERY real run by the
    // time a tool turn fires (the spine flips it in PLANNING). If the engine gated on it, a plain
    // interactive run would NEVER emit. The engine must emit; the goal-tree suppression is stepBatch's.
    const deps = makeDeps();
    const runCtx = makeRunCtx({ goalsDecomposed: true });

    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).toHaveBeenCalledTimes(1);
    expect(deps.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ batchIndex: 0 }));
    expect(runCtx.plainLoopStepIndex).toBe(1);
  });

  it("emits NOTHING for a re-scoped worker that joined a parent episode", async () => {
    const deps = makeDeps();
    const runCtx = makeRunCtx({ joinsParentEpisode: true, workerMonitorScope: "parent-scope" });

    await portExecuteToolTurn(deps, makeArgs(), runCtx);

    expect(deps.emitPlainLoopStep).not.toHaveBeenCalled();
    expect(runCtx.plainLoopStepIndex).toBe(0);
  });
});
