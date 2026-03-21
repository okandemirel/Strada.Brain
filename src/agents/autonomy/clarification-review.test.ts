import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import {
  analyzeClarificationDraft,
  buildClarificationContinuationGate,
  buildClarificationReviewRequest,
  collectClarificationReviewEvidence,
  formatClarificationPrompt,
  parseClarificationReviewDecision,
  sanitizeClarificationReviewDecision,
  shouldRunClarificationReview,
} from "./clarification-review.js";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Investigate Unity level generation issue",
    iteration: 2,
    plan: "Inspect the asset and verify the failing behavior",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

describe("clarification-review", () => {
  it("collects local-inspection evidence for clarification review", () => {
    const evidence = collectClarificationReviewEvidence({
      prompt: "Analyze the Unity level assets and keep going until the issue is real.",
      draft: "Clarify the objective you want me to act on.",
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() },
          { toolName: "file_read", success: true, summary: "Read Level_031.asset", timestamp: Date.now() },
        ],
      }),
      projectPath: "/tmp/unity-project",
      touchedFiles: ["Assets/Resources/Levels/Level_031.asset"],
    });

    expect(evidence.hasLocalProjectAccess).toBe(true);
    expect(evidence.canInspectLocally).toBe(true);
    expect(buildClarificationReviewRequest(evidence)).toContain("Local inspection path exists: yes");
  });

  it("parses and sanitizes clarification review json", () => {
    const decision = sanitizeClarificationReviewDecision(
      parseClarificationReviewDecision(`\`\`\`json
{"decision":"ask_user","reason":"A product-direction choice is still required.","blockingType":"product_direction","recommendedNextAction":"Ask for the preferred target behavior.","question":"Which behavior should Strada preserve?","options":["Keep current flow","Use the new flow"],"recommendedOption":"Use the new flow"}
\`\`\``),
    );

    expect(decision?.decision).toBe("ask_user");
    expect(decision?.question).toBe("Which behavior should Strada preserve?");
    expect(decision?.options).toEqual(["Keep current flow", "Use the new flow"]);
    expect(formatClarificationPrompt(decision)).toContain("1. Keep current flow");
  });

  it("builds an internal continuation gate when clarification should stay inside Strada", () => {
    const evidence = collectClarificationReviewEvidence({
      prompt: "Fix the level editor crash.",
      draft: "Clarify the objective you want me to act on.",
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Game/Levels", timestamp: Date.now() },
        ],
      }),
      projectPath: "/tmp/unity-project",
    });

    const gate = buildClarificationContinuationGate(evidence, {
      decision: "internal_continue",
      reason: "The task remains locally inspectable.",
      recommendedNextAction: "Read the relevant assets and editor logs before asking the user anything else.",
    });

    expect(gate).toContain("[CLARIFICATION REVIEW REQUIRED]");
    expect(gate).toContain("The task remains locally inspectable.");
    expect(gate).toContain("Read the relevant assets and editor logs");
  });

  it("only runs clarification review for drafts that structurally look user-facing", () => {
    expect(shouldRunClarificationReview("Execution verified.")).toBe(false);
    expect(shouldRunClarificationReview("Clarify the objective you want me to act on.")).toBe(true);
    expect(shouldRunClarificationReview("Please share the crash log so I can continue.")).toBe(true);
    expect(shouldRunClarificationReview("Should I continue with the refactor?")).toBe(true);
    expect(shouldRunClarificationReview("Want me to install the package now?")).toBe(true);

    const signals = analyzeClarificationDraft("A) Fix the bug\nB) Add a feature");
    expect(signals.enumeratesChoices).toBe(true);
    expect(shouldRunClarificationReview("A) Fix the bug\nB) Add a feature")).toBe(true);
  });
});
