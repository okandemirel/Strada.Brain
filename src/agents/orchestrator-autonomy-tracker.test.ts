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

  it("works without optional params", () => {
    const bundle = createAutonomyBundle({
      prompt: "Test",
      iterationBudget: 5,
    });
    expect(bundle.stradaConformance).toBeDefined();
    expect(bundle.controlLoopTracker).toBeNull();
  });
});
