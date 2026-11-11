/**
 * The phase's write restriction has to hold at the gate, not only at the offer.
 *
 * `buildWorkerToolDefinitions` removes write tools from what the model is shown
 * while the agent is PLANNING, REPLANNING or REFLECTING. That is where the rule
 * lived and the only place it was enforced. A write named in a response anyway —
 * a remembered tool name, a replayed call, a name the model simply produced —
 * went straight to the tool, because the restriction was a property of the menu
 * rather than of the kitchen.
 *
 * This is the same shape as the batch_execute hole fixed in c34c50c9: a rule
 * enforced on one path, and everything that arrives by another path exempt by
 * construction. It is worth stating plainly, because it is the pattern rather
 * than either instance that keeps producing these.
 *
 * The restriction only applies where the phase is known: a call with no agent
 * state attached is left exactly as it was, so this is a tightening of a known
 * case and not a new refusal of unknown ones.
 *
 * Since 2026-11-11 the menu no longer varies by phase (it broke the provider's
 * prefix cache), so this gate is the only place the rule lives.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { AgentPhase, createInitialState, type AgentState } from "./agent-state.js";
import type { ToolCall, ToolResult } from "./providers/provider-core.interface.js";
import { recordStepResultsAndCheckReflection } from "./orchestrator-loop-utils.js";
import { executeAndTrackTools } from "./orchestrator-loop-shared.js";
import { validateReflectionDecision } from "./orchestrator-runtime-utils.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./autonomy/verifier-pipeline.js";
import {
  isPhaseWriteRefusal,
  phaseWriteRefusal,
  splitCallsByPhase,
  type PhaseRefuses,
} from "../agent-core/engine/phase-write-access.js";
import { portExecuteToolTurn, type ToolTurnDeps } from "../agent-core/engine/tool-turn.js";
import type { EngineRunContext } from "../agent-core/engine/engine-deps.js";
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "./iteration-health-tracker.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function tool(name: string, mutates: boolean) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: !mutates },
    execute: vi.fn().mockResolvedValue({ content: "ran" }),
  };
}

let orch: Orchestrator;
let writeTool: ReturnType<typeof tool>;
let readTool: ReturnType<typeof tool>;

beforeEach(() => {
  writeTool = tool("file_write", true);
  readTool = tool("file_read", false);
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [writeTool, readTool] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  });
});

const run = (toolName: string, phase?: AgentPhase) =>
  (
    orch as unknown as {
      executeToolCalls: (
        chatId: string,
        calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
        options: Record<string, unknown>,
      ) => Promise<Array<{ content: string; isError?: boolean }>>;
    }
  ).executeToolCalls(
    "chat1",
    [{ id: "tc1", name: toolName, input: { path: "Assets/Modules/AModule/A.cs", content: "// x" } }],
    phase === undefined
      ? { mode: "background" }
      : { mode: "background", agentState: { ...createInitialState("t"), phase } },
  );

describe("a write named while the agent is not executing", () => {
  for (const phase of [AgentPhase.PLANNING, AgentPhase.REPLANNING, AgentPhase.REFLECTING]) {
    it(`is refused in ${phase}`, async () => {
      const [result] = await run("file_write", phase);

      expect(writeTool.execute, `the write ran during ${phase}`).not.toHaveBeenCalled();
      expect(result?.isError).toBe(true);
      expect(result?.content).toMatch(/plan|reflect/i);
    });
  }

  it("still runs while executing", async () => {
    await run("file_write", AgentPhase.EXECUTING);
    expect(writeTool.execute).toHaveBeenCalledTimes(1);
  });

  it("leaves reads alone in every phase", async () => {
    await run("file_read", AgentPhase.PLANNING);
    expect(readTool.execute).toHaveBeenCalledTimes(1);
  });

  it("does not refuse when no phase is known", async () => {
    // Callers that attach no agent state keep their previous behaviour; this
    // rule tightens a known case rather than guessing at unknown ones.
    await run("file_write", undefined);
    expect(writeTool.execute).toHaveBeenCalledTimes(1);
  });
});

// ─── A refusal is not a step the run took ───────────────────────────────────
//
// Since the tool list stopped hiding writes while planning (phase-write-access.ts), a write named
// while planning is routine. Recorded as a failed write it was, measured by QA on 2026-11-11: an
// open failing path the verifier asked to re-run in a project with nothing to verify with (the
// shape of a-refused-target-closes-on-the-next-success), a forced reflection after every later
// batch once three of them stood, and a DONE turned into CONTINUE. Each turn here goes through
// the real tool turn, its calls split by the real gate's predicate as the spine splits them; a
// refused call is handed the answer it would have got had it run, so a split that let it run
// records that answer. A write that ran and failed is pinned to still wait for a verification.

const sandbox = mkdtempSync(join(tmpdir(), "phase-refusal-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

type Call = { id: string; name: string; input: Record<string, unknown> };
type Recorded = readonly [phase: AgentPhase, call: Call, result: ToolResult];

/** The orchestrator's own phase rule, the one the spine splits a model turn's calls with. */
const phaseRefuses: PhaseRefuses = (name, phase) =>
  (orch as unknown as { phaseRefuses: PhaseRefuses }).phaseRefuses(name, phase);

/**
 * A tool turn's run context: the autonomy trackers are real, nothing else is wired. Error recovery
 * gives no advice, so a step's summary is the tool's own words, as the verifier reads them.
 */
function turnRunCtx(overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  const bundle = createAutonomyBundle({ prompt: "write a note", iterationBudget: 20 });
  return {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session: { messages: [] },
    chatId: "chat1",
    toolExecMode: "background",
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: { analyze: () => null },
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: undefined,
    identityKey: "id-1",
    lastAssignment: { providerName: "mock", modelId: "m" },
    lastToolNames: [],
    joinsParentEpisode: false,
    conversationScope: undefined,
    memoryRefresher: null,
    plainLoopStepIndex: 0,
    progressTitle: "Task",
    requestText: "write a note",
    ...overrides,
  } as unknown as EngineRunContext;
}

/** One model turn through the real tool turn: a call that runs returns `answer(call)`. */
async function turnThroughToolTurn(
  agentState: AgentState,
  phase: AgentPhase,
  made: readonly Call[],
  answer: (call: ToolCall) => ToolResult,
): Promise<AgentState> {
  const calls = splitCallsByPhase(made as ToolCall[], phase, phaseRefuses);
  const deps = {
    executeToolCalls: async (_chatId: string, ran: ToolCall[]) => ran.map(answer),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined,
    emitPlainLoopStep: vi.fn(),
    sessionManager: { extractLastUserMessage: () => "write a note" },
    currentSessionInstinctIds: new Map(),
  } as unknown as ToolTurnDeps;
  const turn = await portExecuteToolTurn(deps, [calls.runnable, undefined, { ...agentState, phase }, "", undefined, calls], turnRunCtx());
  return turn.advancedState;
}

/** Each call made in its own turn, in order, through the tool turn. */
async function record(calls: readonly Recorded[], start: AgentState = createInitialState("write a note")): Promise<AgentState> {
  let agentState = start;
  for (const [phase, call, result] of calls) {
    agentState = await turnThroughToolTurn(agentState, phase, [call], (tc) => ({ ...result, toolCallId: tc.id }));
  }
  return agentState;
}

const writeOf = (id: string) => ({ id, name: "file_write", input: { path: "notes/a.txt", content: "A" } });
const readOf = (id: string) => ({ id, name: "file_read", input: { path: "notes/a.txt" } });
const written = (id: string): ToolResult => ({ toolCallId: id, content: "File written: notes/a.txt (1 lines, 1 bytes)" });
/** What a write that RAN and failed reports: the tool's own error, no refusal mark. */
const failedAtRunTime = (id: string): ToolResult => ({ toolCallId: id, content: "Error: could not write file (EISDIR)", isError: true });

/** The real gate's answer to a write called while planning. */
async function refusedWhilePlanning(id: string): Promise<ToolResult> {
  const results = await (
    orch as unknown as {
      executeToolCalls: (chatId: string, calls: unknown[], options: Record<string, unknown>) => Promise<ToolResult[]>;
    }
  ).executeToolCalls("chat1", [writeOf(id)], {
    mode: "background",
    agentState: { ...createInitialState("t"), phase: AgentPhase.PLANNING },
  });
  return { ...results[0]!, toolCallId: id };
}

function verdictFor(state: AgentState) {
  const project = mkdtempSync(join(sandbox, "project-"));
  writeFileSync(join(project, "README.md"), "# a project with no build and no tests\n");
  return planVerifierPipeline({
    prompt: "Write notes/a.txt",
    draft: "Wrote notes/a.txt.",
    state: { ...state, phase: AgentPhase.EXECUTING },
    task: { type: "implementation", complexity: "simple", criticality: "low" },
    verificationState: {
      pendingFiles: new Set(),
      touchedFiles: new Set(["notes/a.txt"]),
      hasCompilableChanges: false,
      lastBuildOk: null,
      lastVerificationAt: null,
    },
    buildVerificationGate: null,
    conformanceGate: null,
    logEntries: [],
    chatId: "chat-phase-refusal",
    taskStartedAtMs: Date.now() - 60_000,
    buildToolsAvailable: true,
  });
}

describe("a write refused while planning is not a step the run took", () => {
  beforeEach(() => resetNoWorkEvidenceGates());

  it("the gate marks its refusal, and only its refusal", async () => {
    const refusal = await refusedWhilePlanning("p1");
    expect(refusal.content).toBe(phaseWriteRefusal(AgentPhase.PLANNING));
    expect(isPhaseWriteRefusal(refusal)).toBe(true);
    expect(isPhaseWriteRefusal(failedAtRunTime("x"))).toBe(false);
    expect(isPhaseWriteRefusal({ toolCallId: "y", content: phaseWriteRefusal(AgentPhase.PLANNING), isError: true })).toBe(false);
    // The spine's split answers a refused call with the same result the gate gives.
    const split = splitCallsByPhase([writeOf("p1"), readOf("r1")], AgentPhase.PLANNING, phaseRefuses);
    expect(split.refusals.get("p1")).toEqual(refusal);
    expect(split.runnable).toEqual([readOf("r1")]);
  });

  it("refused while planning, then written while executing: the verifier approves in a project with nothing to verify with", async () => {
    const state = await record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    const plan = verdictFor(state);

    expect(state.stepResults.map((s) => [s.toolName, s.success])).toEqual([["file_write", true]]);
    expect(plan.evidence.recentFailures).toEqual([]);
    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });

  it("a write that ran and failed still waits for a verification, even when the next write succeeds", async () => {
    const state = await record([
      [AgentPhase.EXECUTING, writeOf("f1"), failedAtRunTime("f1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    const plan = verdictFor(state);

    expect(plan.evidence.recentFailures).toEqual(["file_write: Error: could not write file (EISDIR)"]);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("three refusals while planning leave the reflection cadence of the executing batches after them as it was", async () => {
    const cadence = (start: AgentState): boolean[] => {
      let agentState = start;
      const reflected: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        const step = recordStepResultsAndCheckReflection({
          agentState: { ...agentState, phase: AgentPhase.EXECUTING },
          toolCalls: [writeOf(`w${i}`)],
          toolResults: [written(`w${i}`)],
          reflectInterval: 3,
        });
        reflected.push(step.shouldReflect);
        agentState = step.agentState;
      }
      return reflected;
    };
    const refused = await record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.PLANNING, writeOf("p2"), await refusedWhilePlanning("p2")],
      [AgentPhase.PLANNING, writeOf("p3"), await refusedWhilePlanning("p3")],
    ]);

    const baseline = cadence(createInitialState("write a note"));
    expect(baseline).toEqual([false, false, true, false, false, true, false, false, true, false]);
    expect(cadence(refused)).toEqual(baseline);
  });

  it("a refusal does not turn the model's DONE into CONTINUE; a write that ran and failed still does", async () => {
    const afterRefusal = await record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    expect(validateReflectionDecision("DONE", { ...afterRefusal, phase: AgentPhase.REFLECTING })).toEqual({ decision: "DONE" });

    const afterRealFailure = await record([
      [AgentPhase.EXECUTING, writeOf("f1"), failedAtRunTime("f1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    expect(validateReflectionDecision("DONE", { ...afterRealFailure, phase: AgentPhase.REFLECTING }).decision).toBe("CONTINUE");
  });
});

describe("a write refused while planning reaches no tracker", () => {
  function trackers() {
    return {
      taskPlanner: { trackToolCall: vi.fn(), recordError: vi.fn() },
      selfVerification: { track: vi.fn(), ingestWorkerResult: vi.fn() },
      stradaConformance: { trackToolCall: vi.fn() },
      errorRecovery: { analyze: vi.fn(() => ({ summary: "s", recoveryInjection: "\n[ERROR RECOVERY: file_read]\nFix: try an alternative approach." })) },
      executionJournal: { recordToolBatch: vi.fn() },
      emitToolResult: vi.fn(),
      workerCollector: { childWorkerResults: [], toolTrace: [] as unknown[] },
    };
  }
  /**
   * One planning turn through the tool execution and tracking the tool turn runs, its calls split
   * by the real gate's predicate as the spine splits them. A call that runs returns `answer(call)`.
   * The answers the session gets come back in the model's order.
   */
  const track = async (t: ReturnType<typeof trackers>, made: Call[], answer: (call: ToolCall) => ToolResult) => {
    const calls = splitCallsByPhase(made as ToolCall[], AgentPhase.PLANNING, phaseRefuses);
    const session = { messages: [] as { role: string; content: unknown }[] };
    const { toolResults } = await executeAndTrackTools({
      chatId: "chat1",
      responseText: "",
      toolCalls: [...calls.runnable],
      split: calls,
      session: session as never,
      executeToolCalls: async (_chatId, ran) => ran.map(answer),
      executeOptions: {},
      trackingParams: {
        ...t,
        taskPlanner: t.taskPlanner as never,
        selfVerification: t.selfVerification as never,
        stradaConformance: t.stradaConformance as never,
        errorRecovery: t.errorRecovery as never,
        executionJournal: t.executionJournal as never,
        workerCollector: t.workerCollector as never,
        agentPhase: AgentPhase.PLANNING,
        providerName: "mock",
      },
    });
    let ran = 0;
    return made.map((tc) => calls.refusals.get(tc.id) ?? toolResults[ran++]!);
  };

  it("no planner, verification, conformance, worker trace, error-recovery advice, learning signal or journal entry", async () => {
    const t = trackers();
    const results = await track(t, [writeOf("p1")], () => written("p1"));

    expect(t.taskPlanner.trackToolCall).not.toHaveBeenCalled();
    expect(t.taskPlanner.recordError).not.toHaveBeenCalled();
    expect(t.selfVerification.track).not.toHaveBeenCalled();
    expect(t.stradaConformance.trackToolCall).not.toHaveBeenCalled();
    expect(t.workerCollector.toolTrace).toEqual([]);
    expect(t.errorRecovery.analyze).not.toHaveBeenCalled();
    expect(t.emitToolResult).not.toHaveBeenCalled();
    expect(t.executionJournal.recordToolBatch).not.toHaveBeenCalled();
    // The model reads the refusal as the gate writes it.
    expect(results[0]!.content).toBe(phaseWriteRefusal(AgentPhase.PLANNING));
  });

  it("a read that ran and failed beside it is tracked as before", async () => {
    // A write cannot run while planning, so the call that runs and fails beside the refusal is a read.
    const t = trackers();
    const results = await track(t, [writeOf("p1"), readOf("f1")], (tc) => failedAtRunTime(tc.id));

    expect(t.taskPlanner.trackToolCall).toHaveBeenCalledTimes(1);
    expect(t.errorRecovery.analyze).toHaveBeenCalledTimes(1);
    expect(t.emitToolResult).toHaveBeenCalledTimes(1);
    expect(t.workerCollector.toolTrace).toHaveLength(1);
    expect(results[1]!.content).toContain("[ERROR RECOVERY: file_read]");
    expect(t.executionJournal.recordToolBatch).toHaveBeenCalledWith(
      expect.objectContaining({ toolCalls: [readOf("f1")], toolResults: [results[1]] }),
    );
  });
});
