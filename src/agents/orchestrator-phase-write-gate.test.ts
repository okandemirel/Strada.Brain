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
import type { ToolResult } from "./providers/provider-core.interface.js";
import { recordStepResultsAndCheckReflection } from "./orchestrator-loop-utils.js";
import { trackAndRecordToolResults } from "./orchestrator-tool-execution.js";
import { validateReflectionDecision } from "./orchestrator-runtime-utils.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./autonomy/verifier-pipeline.js";
import { isPhaseWriteRefusal, phaseWriteRefusal } from "../agent-core/engine/phase-write-access.js";
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
// Since the tool list stopped hiding writes while planning (phase-write-access.ts), the gate's
// refusal is reached routinely. Recorded as a failed write it was, measured by QA on
// 2026-11-11: an open failing path the verifier asked to re-run in a project with nothing to
// verify with (the shape of a-refused-target-closes-on-the-next-success), a forced reflection
// after every later batch once three of them stood, and a DONE turned into CONTINUE. The
// refusals here come from the real gate, the steps are recorded the way the loop records them,
// and a write that ran and failed is pinned to still wait for a verification.

const sandbox = mkdtempSync(join(tmpdir(), "phase-refusal-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

type Recorded = readonly [phase: AgentPhase, call: { id: string; name: string; input: Record<string, unknown> }, result: ToolResult];

/** Each call recorded, in order, as recordStepResultsAndCheckReflection records it. */
function record(calls: readonly Recorded[], start: AgentState = createInitialState("write a note")): AgentState {
  let agentState = start;
  for (const [phase, call, result] of calls) {
    ({ agentState } = recordStepResultsAndCheckReflection({
      agentState: { ...agentState, phase },
      toolCalls: [call],
      toolResults: [result],
      reflectInterval: 3,
    }));
  }
  return agentState;
}

const writeOf = (id: string) => ({ id, name: "file_write", input: { path: "notes/a.txt", content: "A" } });
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
  });

  it("refused while planning, then written while executing: the verifier approves in a project with nothing to verify with", async () => {
    const state = record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    const plan = verdictFor(state);

    expect(state.stepResults.map((s) => [s.toolName, s.success])).toEqual([["file_write", true]]);
    expect(plan.evidence.recentFailures).toEqual([]);
    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });

  it("a write that ran and failed still waits for a verification, even when the next write succeeds", () => {
    const state = record([
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
    const refused = record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.PLANNING, writeOf("p2"), await refusedWhilePlanning("p2")],
      [AgentPhase.PLANNING, writeOf("p3"), await refusedWhilePlanning("p3")],
    ]);

    const baseline = cadence(createInitialState("write a note"));
    expect(baseline).toEqual([false, false, true, false, false, true, false, false, true, false]);
    expect(cadence(refused)).toEqual(baseline);
  });

  it("a refusal does not turn the model's DONE into CONTINUE; a write that ran and failed still does", async () => {
    const afterRefusal = record([
      [AgentPhase.PLANNING, writeOf("p1"), await refusedWhilePlanning("p1")],
      [AgentPhase.EXECUTING, writeOf("w1"), written("w1")],
    ]);
    expect(validateReflectionDecision("DONE", { ...afterRefusal, phase: AgentPhase.REFLECTING })).toEqual({ decision: "DONE" });

    const afterRealFailure = record([
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
      errorRecovery: { analyze: vi.fn(() => ({ summary: "s", recoveryInjection: "\n[ERROR RECOVERY: file_write]\nFix: try an alternative approach." })) },
      executionJournal: { recordToolBatch: vi.fn() },
      emitToolResult: vi.fn(),
      workerCollector: { childWorkerResults: [], toolTrace: [] as unknown[] },
    };
  }
  const track = (t: ReturnType<typeof trackers>, calls: ReturnType<typeof writeOf>[], results: ToolResult[]) =>
    trackAndRecordToolResults({
      chatId: "chat1",
      toolCalls: calls,
      toolResults: results,
      ...t,
      executionJournal: t.executionJournal as never,
      workerCollector: t.workerCollector as never,
      agentPhase: AgentPhase.PLANNING,
      providerName: "mock",
    });

  it("no planner, verification, conformance, worker trace, error-recovery advice, learning signal or journal entry", async () => {
    const t = trackers();
    const results = [await refusedWhilePlanning("p1")];
    track(t, [writeOf("p1")], results);

    expect(t.taskPlanner.trackToolCall).not.toHaveBeenCalled();
    expect(t.taskPlanner.recordError).not.toHaveBeenCalled();
    expect(t.selfVerification.track).not.toHaveBeenCalled();
    expect(t.stradaConformance.trackToolCall).not.toHaveBeenCalled();
    expect(t.workerCollector.toolTrace).toEqual([]);
    expect(t.errorRecovery.analyze).not.toHaveBeenCalled();
    expect(t.emitToolResult).not.toHaveBeenCalled();
    expect(t.executionJournal.recordToolBatch).not.toHaveBeenCalled();
    // The model reads the refusal as the gate wrote it.
    expect(results[0]!.content).toBe(phaseWriteRefusal(AgentPhase.PLANNING));
  });

  it("a write that ran and failed beside it is tracked as before", async () => {
    const t = trackers();
    const results = [await refusedWhilePlanning("p1"), failedAtRunTime("f1")];
    track(t, [writeOf("p1"), writeOf("f1")], results);

    expect(t.taskPlanner.trackToolCall).toHaveBeenCalledTimes(1);
    expect(t.errorRecovery.analyze).toHaveBeenCalledTimes(1);
    expect(t.emitToolResult).toHaveBeenCalledTimes(1);
    expect(t.workerCollector.toolTrace).toHaveLength(1);
    expect(results[1]!.content).toContain("[ERROR RECOVERY: file_write]");
    expect(t.executionJournal.recordToolBatch).toHaveBeenCalledWith(
      expect.objectContaining({ toolCalls: [writeOf("f1")], toolResults: [results[1]] }),
    );
  });
});
