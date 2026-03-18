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
