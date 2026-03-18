import { describe, expect, it } from "vitest";
import { AgentPhase, createInitialState } from "../agent-state.js";
import { ExecutionJournal } from "./execution-journal.js";

describe("ExecutionJournal", () => {
  it("builds replanning context from failed approaches and verifier memory", () => {
    const journal = new ExecutionJournal("Fix the Unity level regression");
    let state = createInitialState("Fix the Unity level regression");
    state = {
      ...state,
      phase: AgentPhase.EXECUTING,
      plan: "1. Inspect Level_031\n2. Assume the YAML is valid\n3. Report success",
      stepResults: [
        {
          toolName: "file_read",
          success: true,
          summary: "Read Level_031.asset",
          timestamp: 1,
        },
        {
          toolName: "unity_console",
          success: false,
          summary: "Editor still reports a null ScriptableObject payload",
          timestamp: 2,
        },
      ],
      lastReflection: "The current path did not explain why Unity still sees an empty asset.",
    };

    journal.recordPlan(state.plan, AgentPhase.PLANNING, "planner", "planner-model");
    journal.recordVerifierResult({
      decision: "replan",
      summary: "The current path inspected the file but did not verify the live failing behavior.",
      gate: "[VERIFIER PIPELINE: REPLAN REQUIRED]\n\nRequired actions:\n- Reproduce the failing Unity path.\n- Compare the serialized asset against runtime behavior.",
      checks: [],
      evidence: {
        task: { type: "analysis", complexity: "complex", criticality: "high" },
        hasTerminalFailureReport: false,
        conformanceRequired: false,
        recentFailures: [],
        recentSteps: [],
        recentLogIssues: [],
        touchedFiles: [],
        mutationStepCount: 0,
        inspectionStepCount: 0,
        verificationStepCount: 0,
        totalStepCount: 0,
        lastVerificationAt: null,
      },
    });
    journal.beginReplan({
      state,
      reason: "Verifier requested a new approach around the concrete Unity failure path.",
      providerName: "reviewer",
      modelId: "review-model",
    });

    const prompt = journal.buildPromptSection(AgentPhase.REPLANNING);
    expect(prompt).toContain("Execution Journal");
    expect(prompt).toContain("Current branch: branch-1");
    expect(prompt).toContain("Latest verifier result");
    expect(prompt).toContain("Avoid repeating exhausted strategies");
    expect(prompt).toContain("Required verifier actions");
  });
});
