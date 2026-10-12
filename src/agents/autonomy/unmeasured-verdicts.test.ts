/**
 * A verdict names what it measured: a red stays red, a run that measured
 * nothing says so, and neither is mistaken for the other (audit 2026-10,
 * autonomy#0/#1/#2/#3/#5). Every block tests both directions: tightening a
 * read must not hide a real failure as "not measured".
 */

import { afterEach, describe, expect, it } from "vitest";
import { AgentPhase, type AgentState, type StepResult } from "../agent-state.js";
import { collectCompletionReviewEvidence, isVerificationStep } from "./completion-review.js";
import { stallClassOf } from "./constants.js";
import { ControlLoopTracker } from "./control-loop-tracker.js";
import { SelfVerification, getLatestGlobalBuildState } from "./self-verification.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";

const created: SelfVerification[] = [];
function verifier(): SelfVerification {
  const v = new SelfVerification();
  created.push(v);
  return v;
}
afterEach(() => {
  // The published build state is process-wide; one test's red must not leak.
  for (const v of created.splice(0)) v.dispose();
});

const ok = (content: string) => ({ toolCallId: "t", content, isError: false });
const err = (content: string, metadata?: Record<string, unknown>) => ({ toolCallId: "t", content, isError: true, metadata });

function wrote(...paths: string[]): SelfVerification {
  const v = verifier();
  for (const path of paths) v.track("file_write", { path }, ok("written"));
  return v;
}

function createState(stepResults: StepResult[]): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Fix the failing PlayMode check",
    iteration: 2,
    plan: "Verify the change",
    stepResults,
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
  };
}

/** The record Strada.MCP's TestFrameworkCommands.SerializeRecord returns, as SimpleJsonBridgeTool stringifies it. */
function unityTestRecord(result: "Passed" | "Failed" | "Inconclusive", counts: { passed: number; failed: number }): string {
  const executed = counts.passed + counts.failed;
  const tests = [
    ...Array.from({ length: counts.passed }, (_, i) => ({ name: `Passes${i}`, fullName: `Game.Tests.Passes${i}`, status: "Passed", resultState: "Passed" })),
    ...Array.from({ length: counts.failed }, (_, i) => ({ name: `Fails${i}`, fullName: `Game.Tests.Fails${i}`, status: "Failed", resultState: "Failed" })),
  ];
  return JSON.stringify({
    available: true,
    runId: "3f2a",
    mode: "edit",
    status: "completed",
    result,
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    summary: { passed: counts.passed, failed: counts.failed, skipped: 0, inconclusive: 0, total: executed, executed, status: result },
    tests,
    failedTests: tests.filter((t) => t.status === "Failed"),
  }, null, 2);
}

const DEBUG_TASK = { type: "debugging", complexity: "complex", criticality: "high" } as const;

function plan(stepResults: StepResult[], draft = "Verified: the project compiles and all 12 PlayMode tests passed. Completed.") {
  return planVerifierPipeline({
    prompt: "Fix the PlayMode failure",
    draft,
    state: createState(stepResults),
    task: DEBUG_TASK,
    verificationState: {
      pendingFiles: new Set<string>(),
      touchedFiles: new Set<string>(),
      hasCompilableChanges: false,
      lastBuildOk: true,
      lastVerificationAt: null,
    },
    buildVerificationGate: null,
    conformanceGate: null,
    logEntries: [],
    chatId: "chat-unmeasured",
    taskStartedAtMs: 500,
  });
}

const step = (toolName: string, success: boolean, summary: string, timestamp: number): StepResult => ({ toolName, success, summary, timestamp });

describe("a verification step is a tool that runs a check, named the way tools are named (autonomy#0)", () => {
  it("counts the snake_case verifiers, and not the tools that only inspect", () => {
    for (const tool of ["dotnet_build", "dotnet_test", "unity_verify_change", "unity_compile_status", "unity_playmode_verify", "unity_test_run", "unity_build_player"]) {
      expect(isVerificationStep(tool, ""), tool).toBe(true);
    }
    for (const tool of ["unity_console_read", "unity_test_results", "unity_test_list", "unity_build_settings", "csharp_symbol_search", "file_read"]) {
      expect(isVerificationStep(tool, ""), tool).toBe(false);
    }
  });

  it("does not accuse a run that verified and changed nothing of NO WORK EVIDENCE", () => {
    resetNoWorkEvidenceGates();
    const steps = [step("unity_verify_change", true, "compile clean", 1_000), step("unity_playmode_verify", true, "12 of 12 tests passed", 1_100)];
    const first = plan(steps);
    expect(first.evidence.verificationStepCount).toBe(2);
    expect(first.gate ?? "").not.toContain("NO WORK EVIDENCE");
    plan(steps);
    expect(plan(steps).initialDecision).not.toBe("replan");
  });

  it("still finds no work in a run that only inspected", () => {
    resetNoWorkEvidenceGates();
    const steps = [step("unity_console_read", true, "[]", 1_000), step("unity_test_results", true, '{"status":"idle"}', 1_100)];
    const first = plan(steps);
    expect(first.evidence.verificationStepCount).toBe(0);
    expect(first.gate ?? "").toContain("NO WORK EVIDENCE");
  });

  it("ends a same-error streak at a clean compile, and not at a console read", () => {
    const failure = (n: number) => step("dotnet_build", false, "error CS0101: the namespace already contains a definition", 1_000 + n);
    const repaired = plan([failure(1), failure(2), failure(3), step("dotnet_build", true, "Build succeeded. 0 Error(s)", 2_000)], "Fixed the duplicate definition; the build is clean.");
    expect(repaired.initialDecision).not.toBe("replan");
    expect(repaired.evidence.consecutiveSameErrors).toBe(0);

    const readBetween = plan([failure(1), failure(2), step("unity_console_read", true, "[]", 1_500), failure(3)], "Fixed the duplicate definition.");
    expect(readBetween.initialDecision).toBe("replan");
    expect(readBetween.evidence.consecutiveSameErrors).toBe(3);
  });
});

describe("a red Unity Test Framework record is red (autonomy#1)", () => {
  it("keeps every gate open when unity_test_run returns a completed, failed suite with no error flag", () => {
    const v = wrote("Assets/Scripts/Player.cs", "Assets/Tests/PlayerTests.cs");
    v.track("unity_test_run", { mode: "edit" }, ok(unityTestRecord("Failed", { passed: 3, failed: 2 })));
    expect(v.needsVerification()).toBe(true);
    expect(v.getState().lastBuildOk).toBe(false);
    expect(v.getPrompt()).toContain("[TESTS FAILING]");
  });

  it("reads the verdict from the head of a record the transcript truncated", () => {
    const v = wrote("Assets/Tests/PlayerTests.cs");
    const record = unityTestRecord("Failed", { passed: 200, failed: 1 });
    v.track("unity_test_run", {}, ok(`${record.slice(0, 900)}\n... (truncated)\n${record.slice(-300)}`));
    expect(v.getPrompt()).toContain("[TESTS FAILING]");
  });

  it("keeps a red record red when it is read back with unity_test_results", () => {
    const v = wrote("Assets/Scripts/Player.cs");
    v.track("unity_verify_change", {}, ok("compile green"));
    expect(v.needsVerification()).toBe(false);
    v.track("unity_test_results", {}, ok(unityTestRecord("Failed", { passed: 3, failed: 2 })));
    expect(v.needsVerification()).toBe(true);
    expect(v.getPrompt()).toContain("[TESTS FAILING]");
  });

  it("settles on a suite that ran and passed", () => {
    const v = wrote("Assets/Scripts/Player.cs", "Assets/Tests/PlayerTests.cs");
    v.track("unity_test_run", { mode: "edit" }, ok(unityTestRecord("Passed", { passed: 5, failed: 0 })));
    expect(v.needsVerification()).toBe(false);
    expect(v.getState().lastBuildOk).toBe(true);
  });

  it("does not call a suite that executed nothing, or an inconclusive one, a pass", () => {
    for (const body of [unityTestRecord("Passed", { passed: 0, failed: 0 }), unityTestRecord("Inconclusive", { passed: 4, failed: 0 })]) {
      const v = wrote("Assets/Scripts/Player.cs", "Assets/Tests/PlayerTests.cs");
      v.track("unity_test_run", {}, ok(body));
      expect(v.needsVerification()).toBe(true);
      expect(v.getState().lastBuildOk).toBeNull();
      expect(v.getState().pendingFiles.has("Assets/Scripts/Player.cs")).toBe(true);
    }
  });
});

describe("a configuration or listing tool compiles nothing (autonomy#2)", () => {
  it("keeps the compile debt after a build-settings read, a test list or an idle results read", () => {
    for (const [tool, body] of [
      ["unity_build_settings", "Build Settings:\n  Target: StandaloneOSX\n  Scenes: 2\n{\"scenes\":[\"Assets/Scenes/Main.unity\"]}"],
      ["unity_test_list", JSON.stringify({ available: true, mode: "edit", tests: [] }, null, 2)],
      ["unity_test_results", JSON.stringify({ status: "idle", runId: null }, null, 2)],
      // A stale green record is no compile of THIS tree either.
      ["unity_test_results", unityTestRecord("Passed", { passed: 5, failed: 0 })],
    ] as const) {
      const v = wrote("Assets/Scripts/Player.cs");
      v.track(tool, { action: "get" }, ok(body));
      expect(v.needsVerification(), tool).toBe(true);
      expect(v.getState().lastBuildOk, tool).toBeNull();
      expect(v.getState().pendingFiles.has("Assets/Scripts/Player.cs"), tool).toBe(true);
    }
  });

  it("does not take an idle or an unverified compile status for a verdict", () => {
    for (const body of [
      '{"status":"idle"}',
      // Strada.MCP's "nothing could verify anything" answer (local-diagnostics.ts).
      JSON.stringify({
        source: "unavailable",
        bridgeMethod: "editor.compileStatus",
        verified: false,
        message: "Compile status is UNKNOWN — nothing could verify this project.",
        compile: { isCompiling: false, isReloading: false, lastSucceeded: null, compileIssueCount: null },
      }, null, 2),
    ]) {
      const v = wrote("Assets/Scripts/Player.cs");
      v.track("unity_compile_status", {}, ok(body));
      expect(v.needsVerification(), body).toBe(true);
      expect(v.getState().lastBuildOk, body).toBeNull();
    }
  });

  it("still takes a verified compile status for one, green or red", () => {
    const green = wrote("Assets/Scripts/Player.cs");
    green.track("unity_compile_status", {}, ok(JSON.stringify({ source: "bridge", verified: true, compile: { isCompiling: false, lastSucceeded: true, compileIssueCount: 0 } })));
    expect(green.needsVerification()).toBe(false);
    const red = wrote("Assets/Scripts/Player.cs");
    red.track("unity_compile_status", {}, ok(JSON.stringify({ source: "bridge", verified: true, compile: { isCompiling: false, lastSucceeded: false, compileIssueCount: 2 } })));
    expect(red.getState().lastBuildOk).toBe(false);
  });
});

describe("an inconclusive answer moves nothing (autonomy#3)", () => {
  it("keeps an earlier failed step in the completion review", () => {
    const v = wrote("Assets/Art/Frog.png");
    const failedAt = Date.now() - 1_000;
    v.track("unity_compile_status", {}, ok('{"status":"unknown"}'));
    expect(v.getState().lastVerificationAt).toBeNull();
    const evidence = collectCompletionReviewEvidence({
      state: createState([step("unity_generate_sprite", false, "generator refused the prompt", failedAt)]),
      verificationState: v.getState(),
      logEntries: [],
      chatId: "chat-unmeasured",
      taskStartedAtMs: failedAt - 5_000,
    });
    expect(evidence.recentFailures).toEqual(["unity_generate_sprite: generator refused the prompt"]);
  });

  it("does not turn a red build into an unknown one", () => {
    const v = wrote("Assets/Scripts/Player.cs");
    v.track("unity_verify_change", {}, err("error CS0103: The name 'Speed' does not exist"));
    expect(v.getState().lastBuildOk).toBe(false);
    v.track("unity_compile_status", {}, ok('{"compile":{"isCompiling":true}}'));
    expect(v.getState().lastBuildOk).toBe(false);
  });

  it("still moves the review window on a conclusive verification", () => {
    const v = wrote("Assets/Scripts/Player.cs");
    v.track("unity_verify_change", {}, ok("compile green"));
    expect(v.getState().lastVerificationAt).not.toBeNull();
  });
});

describe("a verifier that never ran has no verdict (autonomy#5)", () => {
  const NEVER_RAN: ReadonlyArray<readonly [string, string, Record<string, unknown>?]> = [
    ["unity_playmode_verify", "Error in unity_playmode_verify (elapsed=600004ms): StradaMCP tool 'unity_playmode_verify' timed out after 600000ms — the underlying call was NOT cancelled and may still be running; a retry before it returns would overlap it. Input received: {}"],
    ["unity_test_run", "Unity bridge unavailable. Start Unity Editor to use this tool."],
    ["unity_test_run", "Unity bridge unavailable: bridge disconnected. required=[editor.testRun]"],
    ["unity_playmode_verify", "The previous 'unity_playmode_verify' call (started 4m ago) has not returned yet; retrying now would overlap it."],
    ["unity_test_run", "Invalid argument for 'unity_test_run': input did not match expected schema. Validation issues: mode: Invalid enum value."],
    ["unity_playmode_verify", "PlayMode tests never ran: ANOTHER Unity instance has this project open (Temp/UnityLockfile is held). Close it or wait, then retry — this is not a test problem.\nLast lines of the log:\n..."],
    ["unity_playmode_verify", "PlayMode tests never ran to completion: Unity was KILLED at the tool's deadline before writing results — typically a cold Library import. Retry once. This is not evidence about the tests.\nLast lines of the log:\n..."],
    ["unity_test_rerun_failed", JSON.stringify({ status: "timeout", runId: "3f2a", lastKnown: { status: "running", result: null } }, null, 2)],
    ["dotnet_test", "Test run aborted", { timedOut: true }],
    ["shell_exec", "$ npm test\nExit code: 127", { exitCode: 127 }],
  ];

  it("records neither a failing build nor failing tests, and says the run was not measured", () => {
    for (const [tool, content, metadata] of NEVER_RAN) {
      const v = wrote("Assets/Scripts/Player.cs", "Assets/Tests/PlayerTests.cs");
      v.track("unity_verify_change", {}, ok("compile green"));
      v.track(tool, tool === "shell_exec" ? { command: "npm test" } : {}, err(content, metadata));
      expect(v.getState().lastBuildOk, content).toBe(true);
      expect(getLatestGlobalBuildState().lastBuildOk, content).not.toBe(false);
      const prompt = v.getPrompt();
      expect(prompt, content).not.toContain("[TESTS FAILING]");
      expect(prompt, content).toContain("[TESTS NOT RUN]");
      expect(prompt, content).toContain("NOT MEASURED");
      v.dispose();
    }
  });

  it("counts each attempt, so tooling that never runs still lets the gate close", () => {
    const v = wrote("Assets/Tests/PlayerTests.cs");
    for (let i = 0; i < 3; i++) v.track("unity_test_run", {}, err("Unity bridge unavailable. Start Unity Editor to use this tool."));
    expect(v.getPrompt()).not.toContain("[TESTS NOT RUN]");
  });

  it("keeps a real red red, whatever its output says about time", () => {
    const red = wrote("Assets/Tests/PlayerTests.cs");
    red.track("unity_playmode_verify", {}, err("PlayMode verification FAILED: 2 of 5 tests failed"));
    expect(red.getPrompt()).toContain("[TESTS FAILING]");
    expect(red.getState().lastBuildOk).toBe(false);

    // A test that timed out is a failing test, not a runner that never started.
    const vitest = wrote("src/thing.test.ts");
    vitest.track("shell_exec", { command: "npx vitest run src/thing.test.ts" }, err(
      "$ npx vitest run src/thing.test.ts\nExit code: 1 | Duration: 6000ms\n\n--- stdout ---\nError: Test timed out in 5000ms.\n Test Files  1 failed (1)\n      Tests  1 failed (1)",
      { exitCode: 1 },
    ));
    expect(vitest.getPrompt()).toContain("[TESTS FAILING]");

    // A runner killed at its timeout after it printed failures has failed.
    const killed = wrote("src/thing.test.ts");
    killed.track("shell_exec", { command: "npx vitest run" }, err(
      "$ npx vitest run\nExit code: 124\n\n--- stdout ---\n Test Files  1 failed (3)\n      Tests  2 failed (40)",
      { exitCode: 124, timedOut: true },
    ));
    expect(killed.getPrompt()).toContain("[TESTS FAILING]");
    expect(killed.getPrompt()).not.toContain("NOT MEASURED");

    // …and a run that could not start does not wash out an earlier red.
    red.track("unity_playmode_verify", {}, err("Unity bridge unavailable. Start Unity Editor to use this tool."));
    expect(red.getPrompt()).toContain("[TESTS FAILING]");
    expect(red.getState().lastBuildOk).toBe(false);

    // "Never ran" because the project does not compile is a compile verdict.
    const noCompile = wrote("Assets/Scripts/Player.cs", "Assets/Tests/PlayerTests.cs");
    noCompile.track("unity_playmode_verify", {}, err(
      "PlayMode tests never ran (Unity exit 1): the project does not compile, so the test runner was never reached.\nAssets/Scripts/Player.cs(3,5): error CS0103: The name 'Speed' does not exist",
    ));
    expect(noCompile.getState().lastBuildOk).toBe(false);
    expect(noCompile.getPrompt()).toContain("[TESTS FAILING]");
    expect(noCompile.getPrompt()).not.toContain("NOT MEASURED");
  });
});

describe("an unmeasured answer is named in the gate, and a verdict replaces it", () => {
  it("says NOT MEASURED after a non-answer, and stops saying it once a verifier answers", () => {
    const v = wrote("Assets/Scripts/Player.cs");
    v.track("unity_compile_status", {}, ok('{"status":"unknown"}'));
    const prompt = v.getPrompt();
    expect(prompt).toContain("[VERIFICATION REQUIRED]");
    expect(prompt).toContain("NOT MEASURED");
    expect(prompt).toContain("unity_compile_status");

    v.track("unity_verify_change", {}, err("error CS0103: The name 'Speed' does not exist"));
    expect(v.getPrompt()).not.toContain("NOT MEASURED");
    expect(v.getState().lastBuildOk).toBe(false);
  });

  it("keeps a counted compile error red even beside verified:false", () => {
    const v = wrote("Assets/Scripts/Player.cs");
    v.track("unity_compile_status", {}, ok(JSON.stringify({ verified: false, compile: { compileIssueCount: 2 } })));
    expect(v.getState().lastBuildOk).toBe(false);
  });
});

describe("unity_test_rerun_failed answers with the same record (autonomy#1, sibling)", () => {
  it("is red when the rerun fails, and nothing when it found nothing to run", () => {
    const red = wrote("Assets/Scripts/Player.cs");
    red.track("unity_test_rerun_failed", {}, ok(unityTestRecord("Failed", { passed: 0, failed: 1 })));
    expect(red.getState().lastBuildOk).toBe(false);
    expect(red.getPrompt()).toContain("[TESTS FAILING]");

    // A green rerun of the old failures is not a run of the tests just written.
    const green = wrote("Assets/Tests/PlayerTests.cs");
    green.track("unity_test_rerun_failed", {}, ok(unityTestRecord("Passed", { passed: 2, failed: 0 })));
    expect(green.getPrompt()).toContain("[TESTS NOT RUN]");

    const noop = wrote("Assets/Scripts/Player.cs");
    noop.track("unity_test_rerun_failed", {}, ok(JSON.stringify({ status: "noop", detail: "No failed tests were found to rerun.", previousRunId: null }, null, 2)));
    expect(noop.needsVerification()).toBe(true);
    expect(noop.getState().pendingFiles.has("Assets/Scripts/Player.cs")).toBe(true);
  });
});

/** Strada.MCP's compile status when nothing could verify the project (local-diagnostics.ts), as the step list keeps it. */
const UNAVAILABLE_COMPILE_STATUS = JSON.stringify({
  source: "unavailable",
  bridgeMethod: "editor.compileStatus",
  verified: false,
  message: "Compile status is UNKNOWN — nothing could verify this project.",
  compile: { isCompiling: false, isReloading: false, lastSucceeded: null, compileIssueCount: null },
}, null, 2).slice(0, 200);

describe("a verifier call that measured nothing is not work done (autonomy#0, review)", () => {
  it("finds no work in a run whose only check never answered", () => {
    for (const check of [
      step("unity_compile_status", true, UNAVAILABLE_COMPILE_STATUS, 1_100),
      step("unity_compile_status", true, '{"status":"unknown"}', 1_100),
      step("dotnet_test", true, "dotnet test (Debug)\n\nResult: NOT MEASURED\nNo test ran: dotnet test wrote no test report.", 1_100),
      step("shell_exec", false, "$ npm test\nExit code: 127 | Duration: 4ms\n\n--- stderr ---\nsh: npm: command not found", 1_100),
    ]) {
      resetNoWorkEvidenceGates();
      const p = plan([step("file_read", true, "read Assets/Scripts/Player.cs", 1_000), check], "Fixed the null reference in Player; the project compiles. Done.");
      expect(p.evidence.verificationStepCount, check.summary).toBe(0);
      expect(p.initialDecision, check.summary).not.toBe("approve");
    }
    // The ones that did not fail are asked for work; a failed call is asked to reproduce first.
    resetNoWorkEvidenceGates();
    expect(plan([step("unity_compile_status", true, UNAVAILABLE_COMPILE_STATUS, 1_100)], "Fixed it; the project compiles. Done.").gate ?? "").toContain("NO WORK EVIDENCE");
    resetNoWorkEvidenceGates();
    const bridgeDown = plan([step("unity_test_run", false, "Unity bridge unavailable. Start Unity Editor to use this tool.", 1_100)]);
    expect(bridgeDown.evidence.verificationStepCount).toBe(0);
    expect(bridgeDown.initialDecision).not.toBe("approve");
  });

  it("still counts a check that answered, red or green", () => {
    for (const check of [
      step("unity_verify_change", false, "error CS0103: The name 'Speed' does not exist", 1_100),
      step("unity_compile_status", true, '{"source":"bridge","verified":true,"compile":{"lastSucceeded":false,"compileIssueCount":2}}', 1_100),
      step("unity_test_run", true, unityTestRecord("Failed", { passed: 3, failed: 2 }).slice(0, 200), 1_100),
      // A record whose counts the step list cut off is still the run it reports.
      step("unity_test_run", true, `{\n  "available": true,\n  "runId": "4f3c2a1b9e8d4c7f8a6b5c4d3e2f1a0b",\n  "mode": "edit",\n  "status": "completed",\n  "result": "Passed",\n  "createdAt": 1760000000000,\n  "startedAt": 1760000000123,\n  "finishedAt": 17`, 1_100),
      step("dotnet_build", true, "dotnet build (Debug)\nExit code: 0\nBuild succeeded. 0 Error(s)", 1_100),
    ]) {
      resetNoWorkEvidenceGates();
      const p = plan([step("file_read", true, "read Assets/Scripts/Player.cs", 1_000), check], "Fixed the null reference in Player; the project compiles. Done.");
      expect(p.evidence.verificationStepCount, check.summary).toBe(1);
      expect(p.gate ?? "", check.summary).not.toContain("NO WORK EVIDENCE");
    }
  });

  it("does not end a same-error streak at a check that answered without a verdict, or answered red", () => {
    const failure = (n: number) => step("dotnet_build", false, "error CS0101: the namespace already contains a definition", 1_000 + n);
    for (const between of [
      step("unity_compile_status", true, '{"status":"unknown"}', 1_500),
      step("unity_compile_status", true, UNAVAILABLE_COMPILE_STATUS, 1_500),
      step("unity_compile_status", true, '{"success":false,"compileIssueCount":2}', 1_500),
    ]) {
      const p = plan([failure(1), failure(2), between, failure(3)], "Fixed the duplicate definition.");
      expect(p.evidence.consecutiveSameErrors, between.summary).toBe(3);
      expect(p.initialDecision, between.summary).toBe("replan");
    }
  });

  it("asks for targeted verification of an error logged after the last verdict, and not of one logged before it", () => {
    const verifiedAt = Date.now() - 5_000;
    const planWithLog = (loggedAt: number) => planVerifierPipeline({
      prompt: "Add the frog and its sprite",
      draft: "Added the frog controller and its sprite; the project compiles. Done.",
      state: createState([
        step("file_write", true, "wrote Assets/Scripts/FrogController.cs", verifiedAt - 1_000),
        step("unity_verify_change", true, "compile green", verifiedAt),
        step("unity_generate_sprite", true, "generated Assets/Art/Frog.png", verifiedAt + 500),
      ]),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set<string>(),
        touchedFiles: new Set(["Assets/Scripts/FrogController.cs"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: verifiedAt,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [{
        timestamp: new Date(loggedAt).toISOString(),
        level: "error",
        message: "NullReferenceException in FrogController.Update",
        meta: { chatId: "chat-unmeasured" },
      }],
      chatId: "chat-unmeasured",
      taskStartedAtMs: verifiedAt - 10_000,
    });

    const after = planWithLog(verifiedAt + 1_000);
    expect(after.initialDecision).toBe("continue");
    expect(after.gate ?? "").toContain("TARGETED VERIFICATION REQUIRED");

    const before = planWithLog(verifiedAt - 500);
    expect(before.gate ?? "").not.toContain("TARGETED VERIFICATION REQUIRED");
  });
});

describe("the build settings stay a check for the read-only stall (autonomy#2, review)", () => {
  it("is neutral whatever its registry metadata says, so reading beside it is still a streak", () => {
    expect(stallClassOf("unity_build_settings", { readOnly: false })).toBe("neutral");
    expect(stallClassOf("unity_build_settings")).toBe("neutral");
    const tracker = new ControlLoopTracker({
      staleAnalysisThreshold: 100,
      toolMetadata: (name) => (name === "unity_build_settings" ? { readOnly: false } : undefined),
    });
    for (let i = 0; i < 6; i++) {
      tracker.markToolExecution("file_read", `file_read:{"path":"a${i}"}`);
      tracker.markToolExecution("unity_build_settings", 'unity_build_settings:{"action":"get"}', "ok:StandaloneOSX");
    }
    expect(tracker.getConsecutiveReadOnlyToolCalls()).toBe(6);
    expect(tracker.hadMutationsSinceLastReset()).toBe(false);
  });

  it("keeps the inspections reading and the checks neutral", () => {
    for (const tool of ["unity_console_read", "unity_test_results", "unity_test_list", "csharp_symbol_search"]) {
      expect(stallClassOf(tool, { readOnly: true }), tool).toBe("reading");
    }
    for (const tool of ["unity_compile_status", "unity_verify_change", "dotnet_test"]) {
      expect(stallClassOf(tool, { readOnly: false }), tool).toBe("neutral");
    }
  });
});

/** A shell_exec result as the tool formats it: the echo, the footer, then stdout. */
function shellRun(command: string, stdout: string, exitCode = 0) {
  return {
    toolCallId: "t",
    content: `$ ${command}\nExit code: ${exitCode} | Duration: 2400ms\n\n--- stdout ---\n${stdout}`,
    isError: exitCode !== 0,
    metadata: { exitCode },
  };
}

// Real console output (dotnet SDK 10.0.400 with xunit, vitest 4.1.11), paths shortened.
const DOTNET_HEAD = [
  "  Determining projects to restore...",
  "  All projects are up-to-date for restore.",
  "  Game.Tests -> /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll",
  "Test run for /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll (.NETCoreApp,Version=v10.0)",
  "A total of 1 test files matched the specified pattern.",
].join("\n");
const DOTNET_NO_MATCH = `${DOTNET_HEAD}\nNo test matches the given testcase filter \`FullyQualifiedName~Nope\` in /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll\n`;
const DOTNET_NO_TESTS = `${DOTNET_HEAD}\nNo test is available in /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll. Make sure that test discoverer & executors are registered and platform & framework version settings are appropriate and try again.\n`;
const VITEST_ALL_FILTERED = "\n RUN  v4.1.11 /work\n\n\n Test Files  1 skipped (1)\n      Tests  21 skipped (21)\n   Start at  19:14:54\n   Duration  637ms (transform 275ms, setup 35ms, import 309ms, tests 0ms, environment 0ms)\n";
const VITEST_NO_FILES = "\n RUN  v4.1.11 /work\n\nNo test files found, exiting with code 0\n\nfilter: src/zzz\ninclude: src/**/*.test.ts\n";

describe("a test run that ran no test has no verdict, wherever it ran (tools#1, shell sibling)", () => {
  it("keeps the written tests and the compile owed after a shell run that executed nothing", () => {
    for (const [command, stdout] of [
      ["dotnet test --filter FullyQualifiedName~Nope", DOTNET_NO_MATCH],
      ["dotnet test --no-build --filter FullyQualifiedName~Nope", DOTNET_NO_MATCH],
      ["dotnet test Game.Tests", DOTNET_NO_TESTS],
      ["npx vitest run -t nomatch", VITEST_ALL_FILTERED],
      ["npx vitest run src/zzz --passWithNoTests", VITEST_NO_FILES],
    ] as const) {
      const v = wrote("Game.Tests/BoardTests.cs");
      v.track("shell_exec", { command }, shellRun(command, stdout));
      expect(v.needsVerification(), command).toBe(true);
      expect(v.getState().lastBuildOk, command).toBeNull();
      expect(v.getState().lastVerificationAt, command).toBeNull();
      const prompt = v.getPrompt();
      expect(prompt, command).toContain("[TESTS NOT RUN]");
      expect(prompt, command).toContain("NOT MEASURED");
      expect(prompt, command).not.toContain("[TESTS FAILING]");
    }
  });

  it("still settles on a run where some project ran tests and passed", () => {
    // A filter across a solution: one project matched it, the other did not.
    const v = wrote("Game.Tests/BoardTests.cs");
    const command = "dotnet test v2z.slnx --filter FullyQualifiedName~ClearsRow";
    v.track("shell_exec", { command }, shellRun(command, [
      DOTNET_NO_MATCH.replace(/Game\.Tests/gu, "Empty.Tests"),
      "Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 10 ms - Game.Tests.dll (net10.0)",
    ].join("\n")));
    expect(v.needsVerification()).toBe(false);
    expect(v.getState().lastBuildOk).toBe(true);

    const vitest = wrote("src/thing.test.ts");
    vitest.track("shell_exec", { command: "npx vitest run" }, shellRun("npx vitest run", " Test Files  1 passed | 1 skipped (2)\n      Tests  3 passed | 21 skipped (24)\n"));
    expect(vitest.needsVerification()).toBe(false);
  });

  it("keeps a red red beside a project that ran nothing, masked exit or not", () => {
    const failed = "Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 12 ms - Game.Tests.dll (net10.0)";
    const red = wrote("Game.Tests/BoardTests.cs");
    red.track("shell_exec", { command: "dotnet test" }, shellRun("dotnet test", `${DOTNET_NO_TESTS}\n${failed}`, 1));
    expect(red.getState().lastBuildOk).toBe(false);
    expect(red.getPrompt()).toContain("[TESTS FAILING]");
    expect(red.getPrompt()).not.toContain("NOT MEASURED");

    const masked = wrote("Game.Tests/BoardTests.cs");
    const command = "dotnet test 2>&1 | tail -20";
    masked.track("shell_exec", { command }, shellRun(command, `${DOTNET_NO_TESTS}\n${failed}`));
    expect(masked.getState().lastBuildOk).toBe(false);
    expect(masked.getPrompt()).toContain("[TESTS FAILING]");
  });
});
