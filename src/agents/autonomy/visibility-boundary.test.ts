import { describe, expect, it } from "vitest";
import { decideInteractionBoundary } from "./visibility-boundary.js";
import type { CompletionReviewEvidence } from "./completion-review.js";
import type { TaskClassification } from "../../agent-core/routing/routing-types.js";

const baseEvidence: CompletionReviewEvidence = {
  touchedFiles: [],
  recentFailures: [],
  recentLogIssues: [],
  recentSteps: [],
  totalStepCount: 0,
  inspectionStepCount: 0,
  verificationStepCount: 0,
  mutationStepCount: 0,
  verificationState: {
    pendingFiles: new Set<string>(),
    touchedFiles: new Set<string>(),
    hasCompilableChanges: false,
    lastBuildOk: null,
    lastVerificationAt: null,
  },
};

function task(type: TaskClassification["type"]): TaskClassification {
  return {
    type,
    complexity: "simple",
    criticality: "medium",
  };
}

describe("decideInteractionBoundary", () => {
  it("allows conversational short replies even when the task classifier fell back to code-generation", () => {
    const decision = decideInteractionBoundary({
      prompt: "Hi there",
      workerDraft: "Hello!",
      visibleDraft: "Hello!",
      task: task("code-generation"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "grep_search"],
    });

    expect(decision.kind).toBe("final_answer");
    expect(decision.visibleText).toBe("Hello!");
  });

  it("keeps locally inspectable project work internal when no tool evidence exists yet", () => {
    const decision = decideInteractionBoundary({
      prompt: "Fix the dashboard page crash in the web portal",
      workerDraft: "I will fix it next.",
      visibleDraft: "I will fix it next.",
      task: task("code-generation"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "grep_search", "file_edit"],
    });

    expect(decision.kind).toBe("internal_continue");
    expect(decision.gate).toContain("Executable work cannot finish from a plain-text draft alone.");
  });

  it("treats dynamic tool checklists as internal orchestration artifacts", () => {
    const decision = decideInteractionBoundary({
      prompt: "Do the work",
      workerDraft: "Execution plan:\n1. Run unity_scene_info to inspect the scene.\n2. Run custom_probe to verify the runtime state.\n3. Report the result.",
      visibleDraft: "",
      task: task("analysis"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["unity_scene_info", "custom_probe"],
    });

    expect(decision.kind).toBe("internal_continue");
    expect(decision.gate).toContain("[AUTONOMY REQUIRED]");
  });

  it("keeps short pending-decision blocker memos internal", () => {
    const decision = decideInteractionBoundary({
      prompt: "Update the auth flow in this repo",
      workerDraft: "Pending decision: keep OAuth or switch to PAT auth before implementation.",
      visibleDraft: "",
      task: task("code-generation"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "file_edit"],
      terminalFailureReported: true,
    });

    expect(decision.kind).toBe("internal_continue");
  });

  it("does not surface broad approval blockers that are still internal selection memos", () => {
    const decision = decideInteractionBoundary({
      prompt: "Refactor the provider routing layer",
      workerDraft: "Approval blocker: choose between the fast path and the replay-aware path before implementation.",
      visibleDraft: "",
      task: task("refactoring"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "file_edit"],
      terminalFailureReported: true,
    });

    expect(decision.kind).toBe("internal_continue");
  });

  it("keeps internal inspection memos internal even when a terminal failure was reported", () => {
    const decision = decideInteractionBoundary({
      prompt: "Fix the Unity editor freeze in this project",
      workerDraft: "I need to inspect the relevant files and run the profiler first.",
      visibleDraft: "",
      task: task("debugging"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "grep_search", "shell_exec"],
      terminalFailureReported: true,
    });

    expect(decision.kind).toBe("internal_continue");
    expect(decision.gate).toContain("internal progress memo");
  });

  // AUT-11: the memo rule matched any "will/should … check/test/run" plus an
  // artifact noun, so a completion report that describes what the GAME does at
  // runtime, or what the USER can do next, was held back as a progress memo.
  const workEvidence: CompletionReviewEvidence = {
    ...baseEvidence,
    totalStepCount: 4,
    mutationStepCount: 2,
    verificationStepCount: 1,
  };

  it.each([
    "Done. Implemented the win condition: GameSystem will now check the board after every move and fire LevelComplete. Compile is clean.",
    "Added the pause menu. To try it, you should open the Main scene and press Escape to test it.",
    "Wired the HUD system; the ScoreView will read the score from the service each frame.",
  ])("surfaces a completion report that describes runtime behaviour: %s", (draft) => {
    const decision = decideInteractionBoundary({
      prompt: "Add the win condition to the board game system",
      workerDraft: draft,
      visibleDraft: draft,
      task: task("code-generation"),
      evidence: workEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "file_edit", "dotnet_build"],
    });

    expect(decision.kind).toBe("final_answer");
  });

  it.each([
    "Edited GameSystem.cs. I still need to run the build and check the errors.",
    "Need to verify the scene wiring in Main.unity before this is done.",
    "We'll rerun the tests for the board system next.",
  ])("still holds the agent's own next-step memo internal: %s", (draft) => {
    const decision = decideInteractionBoundary({
      prompt: "Add the win condition to the board game system",
      workerDraft: draft,
      visibleDraft: draft,
      task: task("code-generation"),
      evidence: workEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "file_edit", "dotnet_build"],
    });

    expect(decision.kind).toBe("internal_continue");
  });

  it("keeps milestone handoff memos internal instead of surfacing them as progress narration", () => {
    const decision = decideInteractionBoundary({
      prompt: "Analyze the project fully and implement the improvement plan",
      workerDraft: "The MainCollection fix is complete and verified. Next steps available: start on the Level Selector implementation or the Asset Inventory integration.",
      visibleDraft: "",
      task: task("code-generation"),
      evidence: baseEvidence,
      canInspectLocally: true,
      availableToolNames: ["file_read", "file_edit"],
    });

    expect(decision.kind).toBe("internal_continue");
    expect(decision.gate).toContain("hands the next step back to the user");
  });

  it("surfaces concise user-actionable terminal blockers", () => {
    const decision = decideInteractionBoundary({
      prompt: "Open the configured dashboard",
      workerDraft: "OpenAI authentication token expired. Please sign in again to continue.",
      visibleDraft: "",
      task: task("analysis"),
      evidence: baseEvidence,
      canInspectLocally: false,
      availableToolNames: [],
      terminalFailureReported: true,
    });

    expect(decision.kind).toBe("terminal_failure");
    expect(decision.visibleText).toContain("Please sign in again");
  });

  it("keeps internal capability memos for direct Temp tasks internal and strips reasoning blocks", () => {
    const decision = decideInteractionBoundary({
      prompt: "Temp altında `strada_autonomy_smoke.txt` oluştur ve sonra sil",
      workerDraft: "<reasoning>\nI cannot finish this.\n</reasoning>\n\nMevcut araç setimde dizin oluşturma yeteneği olmadığı için Temp klasörünü oluşturup dosya yazamıyorum.",
      visibleDraft: "",
      task: task("analysis"),
      evidence: {
        ...baseEvidence,
        totalStepCount: 3,
        inspectionStepCount: 1,
      },
      canInspectLocally: true,
      availableToolNames: ["file_write", "shell_exec", "list_directory"],
      terminalFailureReported: true,
    });

    expect(decision.kind).toBe("internal_continue");
    expect(decision.gate).toContain("internal capability limitation");
    expect(decision.gate).not.toContain("<reasoning>");
  });
});
