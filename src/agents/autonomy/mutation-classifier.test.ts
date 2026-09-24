/**
 * One mutation classifier (audited 2026-09-24).
 *
 * AUT-6: completion review kept a private seven-tool mutation list, so work
 *   done through file_create, unity_generate_sprite + unity_bind_sprite or
 *   unity_scene_build was NO WORK EVIDENCE, then a forced replan.
 * AUT-13: progress assessment counted every shell_exec as an edit, so a loop
 *   of shell reads could never be judged stuck.
 * AUT-16: a rename, a deleted script folder or a shell edit of a .cs never
 *   armed the compile gate, and the planner never saw a batch's writes.
 */
import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";
import { buildBehavioralSnapshot, stuckVerdictContradictedBy } from "./progress-assessment.js";
import { SelfVerification } from "./self-verification.js";
import { TaskPlanner } from "./task-planner.js";
import type { ExecutionJournal } from "./execution-journal.js";
import { trackAndRecordToolResults } from "../orchestrator-tool-execution.js";

function state(steps: ReadonlyArray<{ toolName: string; success?: boolean }>): AgentState {
  const now = Date.now();
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Generate the pig sprite and bind it",
    iteration: 2,
    plan: null,
    stepResults: steps.map((s, i) => ({
      toolName: s.toolName,
      success: s.success ?? true,
      summary: `${s.toolName} ok`,
      timestamp: now - 1000 + i,
    })),
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
  };
}

describe("work done through any writer is work evidence (AUT-6)", () => {
  it.each([
    [["unity_generate_sprite", "unity_bind_sprite"]],
    [["file_create"]],
    [["unity_scene_build"]],
    [["file_delete_directory"]],
  ])("%j", (tools) => {
    resetNoWorkEvidenceGates();
    const plan = planVerifierPipeline({
      prompt: "Generate the pig sprite and bind it to the pig prefab",
      draft: "Generated the pig sprite and bound it.\nDONE",
      state: state(tools.map((toolName) => ({ toolName }))),
      task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
      verificationState: { pendingFiles: new Set(), touchedFiles: new Set(), hasCompilableChanges: false, lastBuildOk: null, lastVerificationAt: null },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: `chat-${tools.join("-")}`,
      taskStartedAtMs: Date.now() - 5000,
    });
    expect(plan.gate ?? "").not.toContain("NO WORK EVIDENCE");
    expect(plan.evidence.mutationStepCount).toBe(tools.length);
  });
});

describe("shell reads are not edits (AUT-13)", () => {
  const snapshotOf = (s: AgentState) => buildBehavioralSnapshot({
    prompt: "Fix the board", state: s, touchedFileCount: 0, consecutiveTextOnlyGates: 0,
    taskStartedAtMs: Date.now() - 60 * 60_000, draftExcerpt: "",
  });

  it("six successful shell_exec reads do not veto a stuck verdict", () => {
    const shellLoop = state(Array.from({ length: 6 }, () => ({ toolName: "shell_exec" })));
    const snapshot = snapshotOf(shellLoop);
    expect(snapshot.mutationStepCount).toBe(0);
    expect(stuckVerdictContradictedBy(snapshot, shellLoop.stepResults)).toBeUndefined();
  });

  it("guard: a real edit still vetoes it", () => {
    const edited = state([{ toolName: "shell_exec" }, { toolName: "file_edit" }]);
    const snapshot = snapshotOf(edited);
    expect(stuckVerdictContradictedBy(snapshot, edited.stepResults)).toContain("file_edit");
  });
});

describe("every way a script changes arms the compile gate (AUT-16)", () => {
  const ok = { toolCallId: "t", content: "done", isError: false };

  it("a rename of A.cs to B.cs", () => {
    const verifier = new SelfVerification();
    verifier.track("file_rename", { old_path: "Assets/Scripts/A.cs", new_path: "Assets/Scripts/B.cs" }, ok);
    expect(verifier.needsVerification()).toBe(true);
    expect([...verifier.getState().pendingFiles]).toEqual(["Assets/Scripts/A.cs", "Assets/Scripts/B.cs"]);
  });

  it("a deleted folder of scripts under Assets/", () => {
    const verifier = new SelfVerification();
    verifier.track("file_delete_directory", { path: "Assets/Scripts/Legacy" }, ok);
    expect(verifier.needsVerification()).toBe(true);
    // …but clearing a build-output folder compiles nothing.
    const output = new SelfVerification();
    output.track("file_delete_directory", { path: "Temp/Bee" }, ok);
    expect(output.needsVerification()).toBe(false);
  });

  it.each([
    "sed -i 's/Foo/Bar/' Assets/Scripts/Player.cs",
    "mv Assets/Scripts/A.cs Assets/Scripts/B.cs",
    "printf 'x' > Assets/Scripts/Gen.cs",
  ])("a shell edit: %s", (command) => {
    const verifier = new SelfVerification();
    verifier.track("shell_exec", { command }, ok);
    expect(verifier.needsVerification()).toBe(true);
  });

  it.each([
    "cat Assets/Scripts/Player.cs",
    "sed -n '1,20p' Assets/Scripts/Player.cs",
    "git status",
  ])("not a shell read: %s", (command) => {
    const verifier = new SelfVerification();
    verifier.track("shell_exec", { command }, ok);
    expect(verifier.needsVerification()).toBe(false);
  });

  it("the planner counts a batch's writes as mutations", () => {
    const planner = new TaskPlanner({ iterationBudget: 50 });
    const input = { operations: [{ tool: "file_write", input: { path: "Assets/A.cs", content: "x" } }] };
    const content = JSON.stringify({ results: [{ success: true, content: "written" }] });
    trackAndRecordToolResults({
      chatId: "c",
      toolCalls: [{ id: "b", name: "batch_execute", input }],
      toolResults: [{ toolCallId: "b", content, isError: false }],
      taskPlanner: planner,
      selfVerification: { track: () => {}, ingestWorkerResult: () => {} },
      stradaConformance: { trackToolCall: () => {} },
      errorRecovery: { analyze: () => null },
      executionJournal: { recordToolBatch: () => {} } as unknown as ExecutionJournal,
      agentPhase: AgentPhase.EXECUTING,
      providerName: "test",
      emitToolResult: () => {},
    });
    expect(planner.getState().mutationsSinceVerify).toBe(1);
  });
});
