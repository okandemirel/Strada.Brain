import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import {
  finalizeVerifierPipelineReview,
  planVerifierPipeline,
} from "./verifier-pipeline.js";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Investigate the Unity level issue",
    iteration: 2,
    plan: "Inspect the relevant asset and verify the real failure path",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

const DEBUG_TASK = {
  type: "debugging",
  complexity: "complex",
  criticality: "high",
} as const;

const IMPLEMENTATION_TASK = {
  type: "implementation",
  complexity: "moderate",
  criticality: "medium",
} as const;

describe("verifier-pipeline", () => {
  it("continues when compilable changes still need clean verification", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the runtime error",
      draft: "All fixed.\nDONE",
      state: createState(),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(["src/runtime/reviewer.ts"]),
        touchedFiles: new Set(["src/runtime/reviewer.ts"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: "[VERIFICATION REQUIRED] Run the relevant verification.",
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-build",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[VERIFIER PIPELINE]");
    expect(plan.gate).toContain("build");
  });

  it("continues when a failing path still lacks targeted verification", () => {
    const plan = planVerifierPipeline({
      prompt: "Analyze why the Unity editor crashed",
      draft: "All 100 levels analyzed.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() - 500 },
          { toolName: "file_read", success: false, summary: "Level_031.asset not found", timestamp: Date.now() - 250 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Assets/Resources/Levels/Level_031.asset"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-repro",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[VERIFIER PIPELINE]");
    expect(plan.gate).toContain("targeted-repro");
  });

  it("approves honest terminal blocker drafts without forcing another review pass", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the broken asset",
      draft: "The asset is missing and the task is blocked until the user restores it.",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: false, summary: "Asset missing", timestamp: Date.now() - 100 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-blocked",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.evidence.hasTerminalFailureReport).toBe(true);
    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("approve");
  });

  it("approves bounded Temp shell tasks without forcing completion review", () => {
    const plan = planVerifierPipeline({
      prompt: "Temp altında `strada_autonomy_smoke.txt` oluştur, içine `autonomy ok` yaz, sonra dosyayı oku ve sil.",
      draft: "Temp görevini tamamladım.",
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Temp", timestamp: Date.now() - 900 },
          { toolName: "shell_exec", success: true, summary: "Touched Temp workspace", timestamp: Date.now() - 750 },
          { toolName: "glob_search", success: true, summary: "Matched strada_autonomy_smoke.txt", timestamp: Date.now() - 600 },
          { toolName: "file_write", success: true, summary: "Wrote Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 450 },
          { toolName: "file_read", success: true, summary: "Read Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 300 },
          { toolName: "file_delete", success: true, summary: "Deleted Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 150 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Temp/strada_autonomy_smoke.txt"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-temp-shell",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("approve");
    expect(plan.summary).toContain("No additional verifier review");
  });

  it("forces completion review for read-only investigation work even when static verifier checks are clean", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the runtime issue and keep going until the real issue is verified",
      draft: `Build successful. Strada.Core compatible fixes are complete.

Remaining potential issues:
- ArrowInputSystem may still scan every arrow on input.
- If the freeze continues, inspect Unity Profiler CPU Usage and Call Stack.
DONE`,
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "file_read", success: true, summary: "Read GameRenderer.cs", timestamp: Date.now() - 200 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-debug-review",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(true);
    expect(plan.initialDecision).toBe("continue");
  });

  it("keeps the verifier pipeline open when completion review approves only a partial closure", () => {
    const plan = planVerifierPipeline({
      prompt: "Analyze why the Unity editor freezes and keep going until the real issue is verified",
      draft: "Build succeeded.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "dotnet_build", success: true, summary: "Build passed", timestamp: Date.now() - 100 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/runtime/arrow-input-system.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-partial-closure",
      taskStartedAtMs: Date.now() - 1000,
    });

    const result = finalizeVerifierPipelineReview(plan, {
      decision: "approve",
      summary: "The build fix is clean, but the runtime freeze still has open hypotheses.",
      closureStatus: "partial",
      openInvestigations: [
        "ArrowInputSystem input path still needs profiler-backed verification.",
      ],
      findings: [],
      requiredActions: [
        "Continue with runtime-path inspection before declaring the task complete.",
      ],
      reviews: {
        security: "clean",
        code: "clean",
        simplify: "clean",
      },
      logStatus: "clean",
    });

    expect(result.decision).toBe("continue");
    expect(result.gate).toContain("[COMPLETION REVIEW REQUIRED]");
    expect(result.gate).toContain("Open investigations:");
  });

  it("keeps the verifier pipeline open when the reviewer omits closure fields on a hedged success draft", () => {
    const draft = `Build successful. Strada.Core compatible fixes are complete.

Remaining potential issues:
- ArrowInputSystem may still scan every arrow on input.
- If the freeze continues, inspect Unity Profiler CPU Usage and Call Stack.
DONE`;

    const plan = planVerifierPipeline({
      prompt: "Fix the runtime issue and keep going until the real issue is verified",
      draft,
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "file_read", success: true, summary: "Read GameRenderer.cs", timestamp: Date.now() - 200 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-hedged-approve",
      taskStartedAtMs: Date.now() - 1000,
    });

    const result = finalizeVerifierPipelineReview(plan, {
      decision: "approve",
      summary: "The compile fix is clean.",
      findings: [],
      requiredActions: [],
      reviews: {
        security: "clean",
        code: "clean",
        simplify: "clean",
      },
      logStatus: "clean",
    }, draft);

    expect(result.decision).toBe("continue");
    expect(result.gate).toContain("[COMPLETION REVIEW REQUIRED]");
  });

  it("marks build check as not_applicable when buildToolsAvailable is false", () => {
    const plan = planVerifierPipeline({
      prompt: "fix the level editor",
      draft: "I updated the ArrowLevelEditorWindow.cs file to fix the issue.",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowLevelEditorWindow.cs", timestamp: Date.now() - 300 },
          { toolName: "file_edit", success: true, summary: "Updated ArrowLevelEditorWindow.cs", timestamp: Date.now() - 100 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(["Assets/Editor/ArrowLevelEditorWindow.cs"]),
        touchedFiles: new Set(["Assets/Editor/ArrowLevelEditorWindow.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: "[VERIFICATION REQUIRED] Run build",
      conformanceGate: null,
      logEntries: [],
      chatId: "test-build-tools",
      taskStartedAtMs: Date.now() - 1000,
      buildToolsAvailable: false,
    });

    const buildCheck = plan.checks.find(c => c.name === "build");
    expect(buildCheck?.status).toBe("not_applicable");
    expect(buildCheck?.gate).toBeUndefined();

    const targetedCheck = plan.checks.find(c => c.name === "targeted-repro");
    expect(targetedCheck).toBeUndefined();
  });

  it("exposes buildToolsAvailable on the plan when explicitly set", () => {
    const plan = planVerifierPipeline({
      prompt: "fix arrow input",
      draft: "Fixed ArrowInputSystem.cs.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "file_edit", success: true, summary: "Updated ArrowInputSystem.cs", timestamp: Date.now() - 100 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(["Assets/Game/Systems/ArrowInputSystem.cs"]),
        touchedFiles: new Set(["Assets/Game/Systems/ArrowInputSystem.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "test-expose",
      taskStartedAtMs: Date.now() - 1000,
      buildToolsAvailable: false,
    });

    expect(plan.buildToolsAvailable).toBe(false);
  });

  it("exposes buildToolsAvailable as undefined when not explicitly set", () => {
    const plan = planVerifierPipeline({
      prompt: "fix runtime issue",
      draft: "All fixed.\nDONE",
      state: createState(),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/utils/helpers.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 200,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "test-default",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.buildToolsAvailable).toBeUndefined();
  });

  it("turns a completion review replan decision into a verifier replan gate", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the runtime issue",
      draft: "All fixed.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read RuntimeReviewer.cs", timestamp: Date.now() - 500 },
          { toolName: "file_edit", success: true, summary: "Updated RuntimeReviewer.cs", timestamp: Date.now() - 300 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/runtime/reviewer.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 200,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-review",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(true);

    const result = finalizeVerifierPipelineReview(plan, {
      decision: "replan",
      summary: "The current fix path still does not line up with the verified failing path.",
      findings: ["The implementation changed code, but the failing path itself was never reproduced cleanly."],
      requiredActions: ["Discard the current patch path and create a new plan around the real failing path."],
      reviews: {
        security: "clean",
        code: "issues",
        simplify: "clean",
      },
      logStatus: "clean",
    });

    expect(result.decision).toBe("replan");
    expect(result.gate).toContain("[VERIFIER PIPELINE: REPLAN REQUIRED]");
    expect(result.gate).toContain("Discard the current patch path");
  });
});
