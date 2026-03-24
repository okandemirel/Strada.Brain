import { describe, it, expect } from "vitest";
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";

describe("createAutonomyBundle", () => {
  it("creates all autonomy objects for background loop", () => {
    const bundle = createAutonomyBundle({
      prompt: "Build the feature",
      iterationBudget: 15,
      includeControlLoopTracker: true,
    });
    expect(bundle.errorRecovery).toBeDefined();
    expect(bundle.taskPlanner).toBeDefined();
    expect(bundle.selfVerification).toBeDefined();
    expect(bundle.executionJournal).toBeDefined();
    expect(bundle.controlLoopTracker).not.toBeNull();
    expect(bundle.stradaConformance).toBeDefined();
  });

  it("creates bundle without ControlLoopTracker for interactive loop", () => {
    const bundle = createAutonomyBundle({
      prompt: "Hello",
      iterationBudget: 10,
    });
    expect(bundle.controlLoopTracker).toBeNull();
    expect(bundle.errorRecovery).toBeDefined();
  });

  it("attaches project world context when provided", () => {
    const bundle = createAutonomyBundle({
      prompt: "Task",
      iterationBudget: 10,
      projectWorldSummary: "Unity project",
      projectWorldFingerprint: "abc123",
    });
    const snapshot = bundle.executionJournal.snapshot();
    expect(snapshot).toBeDefined();
  });

  it("seeds execution journal from previous snapshot when provided", () => {
    const bundle = createAutonomyBundle({
      prompt: "continue",
      iterationBudget: 10,
      previousJournalSnapshot: {
        learnedInsights: ["Config uses Zod"],
        verifierSummary: "Build passed",
      },
    });
    const snapshot = bundle.executionJournal.snapshot();
    expect(snapshot.learnedInsights).toContain("Config uses Zod");
    expect(snapshot.verifierSummary).toBe("Build passed");
  });

  it("works without optional params", () => {
    const bundle = createAutonomyBundle({
      prompt: "Test",
      iterationBudget: 5,
    });
    expect(bundle.stradaConformance).toBeDefined();
    expect(bundle.controlLoopTracker).toBeNull();
  });
});
