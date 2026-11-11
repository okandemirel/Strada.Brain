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
import { ControlLoopTracker } from "../../agents/autonomy/control-loop-tracker.js";
import { portExecuteToolTurn, isPlainLoop, summarizePlainLoopBatch, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState, type AgentState } from "../../agents/agent-state.js";
import { phaseWriteRefusalResult, splitCallsByPhase, type PhaseRefuses } from "./phase-write-access.js";
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
      // …and how the batch this one supersedes ended, so the board does not
      // show a failed build as a finished step (Codex 2026-09-13 AG#16).
      priorBatchFailed: false,
    });
    // The per-run counter advanced so the NEXT batch would be step-1 (id alignment source).
    expect(runCtx.plainLoopStepIndex).toBe(1);
  });

  it("says when EVERY call in the batch failed, so a failed build is not a finished step (AG#16)", async () => {
    const failing = makeDeps({
      executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
        toolCalls.map((tc) => ({ toolCallId: tc.id, content: "error CS0103", isError: true }) as unknown as ToolResult),
    } as Partial<ToolTurnDeps>);
    await portExecuteToolTurn(failing, makeArgs(), makeRunCtx());
    expect(failing.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ priorBatchFailed: true }));

    // A batch where something succeeded is not a failed batch.
    const mixed = makeDeps({
      executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
        toolCalls.map((tc, i) => ({ toolCallId: tc.id, content: "ok", isError: i === 0 }) as unknown as ToolResult),
    } as Partial<ToolTurnDeps>);
    await portExecuteToolTurn(mixed, makeArgs(), makeRunCtx());
    expect(mixed.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ priorBatchFailed: false }));
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

describe("portExecuteToolTurn — a read-only streak is told to the model", () => {
  // The gate rides as a text block AFTER the tool results of the turn that raised it — a
  // separate user message between tool_use and tool_result broke provider pairing (ORC-5).
  type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
  const texts = (messages: Msg[]): string[] =>
    messages.flatMap((m) =>
      m.role !== "user"
        ? []
        : typeof m.content === "string"
          ? [m.content]
          : m.content.filter((b) => b.type === "text").map((b) => b.text ?? ""),
    );

  it("adds the READ-ONLY STREAK gate after the turn's tool results when the tracker reports a stall", async () => {
    const deps = makeDeps();
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const runCtx = makeRunCtx({ controlLoopTracker: tracker });
    for (let i = 0; i < ControlLoopTracker.READ_ONLY_STREAK_LIMIT - 2; i++) {
      tracker.markToolExecution("vault_search", `vault_search:{"query":"q${i}"}`);
    }
    // The turn's two calls (read_file, edit_file — neither a known mutation tool) complete the streak.
    await portExecuteToolTurn(deps, makeArgs(), runCtx);
    const messages = (runCtx.session as unknown as { messages: Msg[] }).messages;
    const gate = texts(messages).find((t) => t.startsWith("[READ-ONLY STREAK]"));
    expect(gate).toBeDefined();
    expect(gate).toContain("Do not read more first");
    const answer = messages[messages.length - 1]!.content as Array<{ type: string }>;
    expect(answer.slice(0, 2).map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
  });

  it("the SECOND streak escalates: a ×2 gate and a write-only tool list for the next turn", async () => {
    const deps = makeDeps();
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const runCtx = makeRunCtx({ controlLoopTracker: tracker });
    const messages = (runCtx.session as unknown as { messages: Msg[] }).messages;
    for (let i = 0; i < ControlLoopTracker.READ_ONLY_STREAK_LIMIT - 2; i++) tracker.markToolExecution("vault_search", `vault_search:{"query":"a${i}"}`);
    await portExecuteToolTurn(deps, makeArgs(), runCtx); // first streak
    expect(runCtx.restrictToProgressTools).not.toBe(true);
    expect(texts(messages).some((t) => t.startsWith("[READ-ONLY STREAK]"))).toBe(true);
    for (let i = 0; i < ControlLoopTracker.READ_ONLY_STREAK_LIMIT - 2; i++) tracker.markToolExecution("vault_search", `vault_search:{"query":"b${i}"}`);
    await portExecuteToolTurn(deps, makeArgs(), runCtx); // second streak
    expect(runCtx.restrictToProgressTools).toBe(true);
    expect(texts(messages).some((t) => t.startsWith("[READ-ONLY STREAK ×2]"))).toBe(true);
  });

  it("a clean verification of the run's change restarts the stall level (AUT-21)", async () => {
    // markVerificationClean was only called at epoch rollover, so a run that had
    // stalled twice stayed at level 2 — tools taken away — after it wrote a fix
    // and built it clean.
    const deps = makeDeps({
      executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
        toolCalls.map((tc) => ({
          toolCallId: tc.id,
          content: tc.name === "dotnet_build" ? "Build succeeded.\n    0 Warning(s)\n    0 Error(s)" : "ok",
          isError: false,
        }) as unknown as ToolResult),
    } as Partial<ToolTurnDeps>);
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const runCtx = makeRunCtx({ controlLoopTracker: tracker });
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < ControlLoopTracker.READ_ONLY_STREAK_LIMIT; i++) tracker.markToolExecution("file_read", `file_read:{"path":"r${round}-${i}"}`);
      expect(tracker.takeUnreportedReadOnlyStall()).not.toBeNull();
    }
    expect(tracker.getReadOnlyStreakReports()).toBe(2);

    const fixAndBuild = [
      { id: "tc-w", name: "file_write", input: { path: "Assets/Scripts/Player.cs", content: "class Player {}" } },
      { id: "tc-b", name: "dotnet_build", input: {} },
    ] as unknown as ToolCall[];
    await portExecuteToolTurn(deps, [fixAndBuild, undefined, createInitialState("fix it"), ""], runCtx);

    expect(runCtx.selfVerification.getCleanVerdictCount()).toBe(1);
    expect(tracker.getStallEpisodes()).toBe(0);
    expect(tracker.getReadOnlyStreakReports()).toBe(0);
  });

  it("a clean check with no change since the last reset earns nothing", async () => {
    const deps = makeDeps({
      executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
        toolCalls.map((tc) => ({ toolCallId: tc.id, content: "Build succeeded.\n    0 Error(s)", isError: false }) as unknown as ToolResult),
    } as Partial<ToolTurnDeps>);
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const runCtx = makeRunCtx({ controlLoopTracker: tracker });
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < ControlLoopTracker.READ_ONLY_STREAK_LIMIT; i++) tracker.markToolExecution("file_read", `file_read:{"path":"q${round}-${i}"}`);
      tracker.takeUnreportedReadOnlyStall();
    }
    expect(tracker.hadMutationsSinceLastReset()).toBe(false);
    const buildOnly = [{ id: "tc-b", name: "dotnet_build", input: {} }] as unknown as ToolCall[];
    await portExecuteToolTurn(deps, [buildOnly, undefined, createInitialState("check"), ""], runCtx);
    expect(runCtx.selfVerification.getCleanVerdictCount()).toBe(1); // the build passed…
    expect(tracker.getStallEpisodes()).toBe(2); // …but verified no change, so the level stands
  });

  it("adds nothing while the streak is short", async () => {
    const deps = makeDeps();
    const runCtx = makeRunCtx({ controlLoopTracker: new ControlLoopTracker({ staleAnalysisThreshold: 100 }) });
    await portExecuteToolTurn(deps, makeArgs(), runCtx);
    const messages = (runCtx.session as unknown as { messages: Msg[] }).messages;
    expect(texts(messages).some((t) => t.startsWith("[READ-ONLY STREAK]"))).toBe(false);
  });
});

describe("portExecuteToolTurn — a check polled with the same answer is a stall (AUT-21 follow-up)", () => {
  const poll = [{ id: "tc-p", name: "unity_compile_status", input: {} }] as unknown as ToolCall[];
  const gateOf = (runCtx: EngineRunContext): string | undefined =>
    (runCtx.session as unknown as { messages: Array<{ role: string; content: unknown }> }).messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : []))
      .find((b) => b.type === "text" && (b.text ?? "").startsWith("[READ-ONLY STREAK]"))?.text;
  const answering = (content: () => string): Partial<ToolTurnDeps> => ({
    executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
      toolCalls.map((tc) => ({ toolCallId: tc.id, content: content(), isError: false }) as unknown as ToolResult),
  } as Partial<ToolTurnDeps>);

  it("the tool result reaches the tracker: identical polls raise the gate", async () => {
    const deps = makeDeps(answering(() => "Compilation idle."));
    const runCtx = makeRunCtx({ controlLoopTracker: new ControlLoopTracker({ staleAnalysisThreshold: 100 }) });
    for (let i = 0; i < ControlLoopTracker.READ_ONLY_STALL_THRESHOLD; i++) {
      await portExecuteToolTurn(deps, [poll, undefined, createInitialState("wait for compile"), ""], runCtx);
    }
    expect(gateOf(runCtx)).toContain("same check");
  });

  it("polls whose answer changes raise nothing", async () => {
    let n = 0;
    const deps = makeDeps(answering(() => `Compiling, ${++n}% done`));
    const runCtx = makeRunCtx({ controlLoopTracker: new ControlLoopTracker({ staleAnalysisThreshold: 100 }) });
    for (let i = 0; i < ControlLoopTracker.READ_ONLY_STALL_THRESHOLD * 2; i++) {
      await portExecuteToolTurn(deps, [poll, undefined, createInitialState("wait for compile"), ""], runCtx);
    }
    expect(gateOf(runCtx)).toBeUndefined();
  });
});

/**
 * A write the phase refused ran nothing (phase-write-access.ts). Marked as an execution it
 * counted as progress: a write ends a read-only streak and says the run changed something, and a
 * batch of nothing but refusals told the monitor the step before it had failed. The turn gets its
 * calls split as the spine splits them; a refused write that reached the executor would be
 * answered with the refusal, and counted.
 */
describe("portExecuteToolTurn — a write refused while planning is not an execution", () => {
  const refuses: PhaseRefuses = (name, phase) => name === "file_write" && phase !== AgentPhase.EXECUTING;
  /** The tool turn's args as the spine passes them: the turn's calls, split by its phase. */
  const turnArgs = (made: ToolCall[], state: AgentState): unknown[] => {
    const split = splitCallsByPhase(made, state.phase, refuses);
    return [split.runnable, undefined, state, "", undefined, split];
  };
  const reads = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `tc-r${i}`, name: "file_read", input: { path: `f${i}.txt` } })) as unknown as ToolCall[];
  const write = { id: "tc-w", name: "file_write", input: { path: "notes/a.txt", content: "A" } } as unknown as ToolCall;
  const answering = (writeResult: (tc: ToolCall) => ToolResult): Partial<ToolTurnDeps> => ({
    executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
      toolCalls.map((tc) => (tc.name === "file_write" ? writeResult(tc) : ({ toolCallId: tc.id, content: "read", isError: false } as ToolResult))),
  } as Partial<ToolTurnDeps>);
  const planning = { ...createInitialState("write a note"), phase: AgentPhase.PLANNING };

  it("a refused write neither ends the read-only streak nor counts as a change", async () => {
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const deps = makeDeps(answering((tc) => phaseWriteRefusalResult(tc.id, AgentPhase.PLANNING)));
    await portExecuteToolTurn(deps, turnArgs([...reads(2), write], planning), makeRunCtx({ controlLoopTracker: tracker }));

    expect(tracker.getConsecutiveReadOnlyToolCalls()).toBe(2);
    expect(tracker.hadMutationsSinceLastReset()).toBe(false);
  });

  it("a write that ran still does both", async () => {
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const deps = makeDeps(answering((tc) => ({ toolCallId: tc.id, content: "File written: notes/a.txt", isError: false })));
    await portExecuteToolTurn(deps, turnArgs([...reads(2), write], { ...planning, phase: AgentPhase.EXECUTING }), makeRunCtx({ controlLoopTracker: tracker }));

    expect(tracker.getConsecutiveReadOnlyToolCalls()).toBe(0);
    expect(tracker.hadMutationsSinceLastReset()).toBe(true);
  });

  it("the progress line names the calls that ran, and a batch in which nothing ran reports none", async () => {
    const refuse = answering((tc) => phaseWriteRefusalResult(tc.id, AgentPhase.PLANNING));
    const refusedOnly = makeDeps({ ...refuse, buildToolBatchProgressSignal: vi.fn(() => ({ kind: "analysis" })) as never });
    const onlyRefused = await portExecuteToolTurn(refusedOnly, turnArgs([write], planning), makeRunCtx());
    expect(refusedOnly.buildToolBatchProgressSignal).not.toHaveBeenCalled();
    expect((onlyRefused as { progressSignal?: unknown }).progressSignal).toBeUndefined();

    const mixed = makeDeps({ ...refuse, buildToolBatchProgressSignal: vi.fn(() => ({ kind: "analysis" })) as never });
    await portExecuteToolTurn(mixed, turnArgs([...reads(1), write], planning), makeRunCtx());
    expect(mixed.buildToolBatchProgressSignal).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: reads(1) }));
  });

  it("the consensus review is not consulted for a batch in which nothing ran; it is for one in which a call ran", async () => {
    const consensus = (writeResult: (tc: ToolCall) => ToolResult) => {
      const classify = vi.fn(() => ({ type: "implementation", complexity: "simple", criticality: "critical" }));
      const deps = makeDeps({
        ...answering(writeResult),
        consensusManager: { shouldConsult: vi.fn(() => "skip") },
        confidenceEstimator: { estimate: vi.fn(() => 0.1) },
        providerRouter: {},
        taskClassifier: { classify },
      } as never);
      return { deps, classify };
    };
    const refused = consensus((tc) => phaseWriteRefusalResult(tc.id, AgentPhase.PLANNING));
    await portExecuteToolTurn(refused.deps, turnArgs([write], planning), makeRunCtx());
    expect(refused.classify).not.toHaveBeenCalled();

    const ran = consensus((tc) => ({ toolCallId: tc.id, content: "File written: notes/a.txt", isError: false }));
    await portExecuteToolTurn(ran.deps, turnArgs([write], { ...planning, phase: AgentPhase.EXECUTING }), makeRunCtx());
    expect(ran.classify).toHaveBeenCalled();
  });

  it("the session keeps every call the model made and answers each in its order, a refused one with its refusal", async () => {
    const executed: string[] = [];
    const deps = makeDeps({
      executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> => {
        executed.push(...toolCalls.map((tc) => tc.id));
        return toolCalls.map((tc) => ({ toolCallId: tc.id, content: `read ${tc.id}`, isError: false }) as ToolResult);
      },
    } as Partial<ToolTurnDeps>);
    const runCtx = makeRunCtx();
    const [first, second] = reads(2);
    const turn = await portExecuteToolTurn(deps, turnArgs([first!, write, second!], planning), runCtx);

    expect(executed).toEqual(["tc-r0", "tc-r1"]);
    expect(turn.trace.map((t) => t.toolCallId)).toEqual(["tc-r0", "tc-r1"]);
    expect(turn.advancedState.stepResults.map((s) => s.toolName)).toEqual(["file_read", "file_read"]);
    const messages = (runCtx.session as { messages: { role: string; content: unknown; tool_calls?: ToolCall[] }[] }).messages;
    expect(messages[0]!.tool_calls!.map((tc) => tc.id)).toEqual(["tc-r0", "tc-w", "tc-r1"]);
    const answers = (messages[1]!.content as { type: string; tool_use_id?: string; content?: string; is_error?: boolean }[])
      .filter((b) => b.type === "tool_result");
    expect(answers.map((b) => [b.tool_use_id, b.is_error === true])).toEqual([["tc-r0", false], ["tc-w", true], ["tc-r1", false]]);
    expect(answers[1]!.content).toBe(phaseWriteRefusalResult("tc-w", AgentPhase.PLANNING).content);
  });

  it("a turn in which nothing ran takes no step and runs nothing", async () => {
    const executeToolCalls = vi.fn(async () => [] as ToolResult[]);
    const deps = makeDeps({ executeToolCalls } as Partial<ToolTurnDeps>);
    const turn = await portExecuteToolTurn(deps, turnArgs([write], planning), makeRunCtx());

    expect(executeToolCalls).not.toHaveBeenCalled();
    expect(turn.trace).toEqual([]);
    expect(turn.advancedState.stepResults).toEqual([]);
    expect(turn.advancedState.iteration).toBe(planning.iteration);
  });

  it("a batch of nothing but refusals does not mark the step before it failed; a write that ran and failed does", async () => {
    const refusedOnly = makeDeps(answering((tc) => phaseWriteRefusalResult(tc.id, AgentPhase.PLANNING)));
    await portExecuteToolTurn(refusedOnly, turnArgs([write], planning), makeRunCtx());
    expect(refusedOnly.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ priorBatchFailed: false }));

    const failed = makeDeps(answering((tc) => ({ toolCallId: tc.id, content: "Error: could not write file (EISDIR)", isError: true })));
    await portExecuteToolTurn(failed, turnArgs([write], { ...planning, phase: AgentPhase.EXECUTING }), makeRunCtx());
    expect(failed.emitPlainLoopStep).toHaveBeenCalledWith(expect.objectContaining({ priorBatchFailed: true }));
  });
});
