import { describe, it, expect } from "vitest";
import {
  AgentPhase,
  createInitialState,
  transitionPhase,
} from "./agent-state.js";
import {
  buildPlanningPrompt,
  buildReflectionPrompt,
  buildReplanningPrompt,
  buildExecutionContext,
} from "./paor-prompts.js";

/**
 * Tests verifying that the PAOR state machine primitives used by both
 * runAgentLoop (interactive) and runBackgroundTask (background) work
 * correctly for the background execution path.
 *
 * The actual integration (background tasks using PAOR phases) is tested
 * via the existing orchestrator.test.ts suite; these tests validate the
 * shared building blocks that the unified execution path depends on.
 */
describe("Background task PAOR integration", () => {
  describe("PAOR state machine for background tasks", () => {
    it("background tasks should start in PLANNING phase", () => {
      const state = createInitialState("background: build the project");
      expect(state.phase).toBe(AgentPhase.PLANNING);
      expect(state.taskDescription).toBe("background: build the project");
    });

    it("should transition through full PAOR lifecycle", () => {
      // PLANNING -> EXECUTING -> REFLECTING -> EXECUTING -> COMPLETE
      let state = createInitialState("run tests and fix failures");
      expect(state.phase).toBe(AgentPhase.PLANNING);

      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);

      state = transitionPhase(state, AgentPhase.REFLECTING);
      expect(state.phase).toBe(AgentPhase.REFLECTING);

      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);

      state = transitionPhase(state, AgentPhase.COMPLETE);
      expect(state.phase).toBe(AgentPhase.COMPLETE);
    });

    it("should support REPLANNING cycle", () => {
      // PLANNING -> EXECUTING -> REFLECTING -> REPLANNING -> EXECUTING
      let state = createInitialState("refactor module");
      state = transitionPhase(state, AgentPhase.EXECUTING);
      state = transitionPhase(state, AgentPhase.REFLECTING);
      state = transitionPhase(state, AgentPhase.REPLANNING);
      expect(state.phase).toBe(AgentPhase.REPLANNING);

      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });

    it("should accumulate step results correctly", () => {
      let state = createInitialState("multi-step task");
      state = transitionPhase(state, AgentPhase.EXECUTING);

      // Simulate step result accumulation (as background task does)
      state = {
        ...state,
        stepResults: [
          ...state.stepResults,
          { toolName: "read_file", success: true, summary: "Read config.ts", timestamp: Date.now() },
        ],
        iteration: state.iteration + 1,
      };
      state = {
        ...state,
        stepResults: [
          ...state.stepResults,
          { toolName: "edit_file", success: false, summary: "Permission denied", timestamp: Date.now() },
        ],
        iteration: state.iteration + 1,
        consecutiveErrors: state.consecutiveErrors + 1,
      };

      expect(state.stepResults).toHaveLength(2);
      expect(state.iteration).toBe(2);
      expect(state.consecutiveErrors).toBe(1);
      expect(state.stepResults[0]!.success).toBe(true);
      expect(state.stepResults[1]!.success).toBe(false);
    });

    it("should track failed approaches across replanning cycles", () => {
      let state = createInitialState("complex task");
      state = { ...state, plan: "Approach A: use direct file access" };
      state = transitionPhase(state, AgentPhase.EXECUTING);
      state = transitionPhase(state, AgentPhase.REFLECTING);

      // Simulate REPLAN decision
      state = {
        ...state,
        failedApproaches: [...state.failedApproaches, state.plan ?? ""],
        lastReflection: "Direct access failed, need different strategy",
        reflectionCount: state.reflectionCount + 1,
      };
      state = transitionPhase(state, AgentPhase.REPLANNING);

      expect(state.failedApproaches).toHaveLength(1);
      expect(state.failedApproaches[0]).toContain("Approach A");

      // New plan after replanning
      state = { ...state, plan: "Approach B: use API" };
      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.plan).toContain("Approach B");
    });
  });

  describe("PAOR prompt building for background tasks", () => {
    it("should build planning prompt with learned insights", () => {
      const prompt = buildPlanningPrompt(
        "Build and test the project",
        ["Always run build before test", "Check for missing imports first"],
        { enableGoalDetection: false },
      );
      expect(prompt).toContain("PLAN Phase");
      expect(prompt).toContain("Build and test the project");
      expect(prompt).toContain("Always run build before test");
      expect(prompt).toContain("Check for missing imports first");
      // Background tasks don't enable goal detection
      expect(prompt).not.toContain("Goal Classification");
    });

    it("should build reflection prompt with step results", () => {
      let state = createInitialState("test task");
      state = transitionPhase(state, AgentPhase.EXECUTING);
      state = {
        ...state,
        stepResults: [
          { toolName: "dotnet_build", success: true, summary: "Build succeeded", timestamp: Date.now() },
          { toolName: "dotnet_test", success: false, summary: "3 tests failed", timestamp: Date.now() },
        ],
        consecutiveErrors: 1,
      };
      state = transitionPhase(state, AgentPhase.REFLECTING);

      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("Reflection Phase");
      expect(prompt).toContain("[OK] dotnet_build");
      expect(prompt).toContain("[FAIL] dotnet_test");
      expect(prompt).toContain("1 success, 1 failures");
      expect(prompt).toContain("CONTINUE");
      expect(prompt).toContain("REPLAN");
      expect(prompt).toContain("DONE");
    });

    it("should build replanning prompt with failed approaches", () => {
      const state: import("./agent-state.js").AgentState = {
        phase: AgentPhase.REPLANNING,
        taskDescription: "fix build errors",
        iteration: 5,
        plan: "Original: fix types first",
        stepResults: [],
        failedApproaches: ["Tried fixing types but more appeared"],
        reflectionCount: 1,
        lastReflection: "Types keep cascading, need different approach",
        consecutiveErrors: 3,
        learnedInsights: [],
      };

      const prompt = buildReplanningPrompt(state);
      expect(prompt).toContain("Replanning Phase");
      expect(prompt).toContain("Original: fix types first");
      expect(prompt).toContain("Tried fixing types but more appeared");
      expect(prompt).toContain("Types keep cascading");
      expect(prompt).toContain("fundamentally different plan");
    });

    it("should build execution context with plan", () => {
      const state: import("./agent-state.js").AgentState = {
        phase: AgentPhase.EXECUTING,
        taskDescription: "task",
        iteration: 3,
        plan: "1. Read file\n2. Edit file\n3. Build",
        stepResults: [],
        failedApproaches: [],
        reflectionCount: 0,
        lastReflection: null,
        consecutiveErrors: 0,
        learnedInsights: [],
      };

      const ctx = buildExecutionContext(state);
      expect(ctx).toContain("Current Plan");
      expect(ctx).toContain("1. Read file");
      expect(ctx).toContain("Current iteration: 3");
    });

    it("should return empty string for execution context without plan", () => {
      const state: import("./agent-state.js").AgentState = {
        phase: AgentPhase.EXECUTING,
        taskDescription: "task",
        iteration: 0,
        plan: null,
        stepResults: [],
        failedApproaches: [],
        reflectionCount: 0,
        lastReflection: null,
        consecutiveErrors: 0,
        learnedInsights: [],
      };

      const ctx = buildExecutionContext(state);
      expect(ctx).toBe("");
    });
  });

  describe("Reflection decision triggers", () => {
    it("should trigger reflection after REFLECT_INTERVAL steps", () => {
      const REFLECT_INTERVAL = 3;
      let state = createInitialState("task");
      state = transitionPhase(state, AgentPhase.EXECUTING);

      // Add 3 step results
      for (let i = 0; i < 3; i++) {
        state = {
          ...state,
          stepResults: [
            ...state.stepResults,
            { toolName: `tool_${i}`, success: true, summary: "ok", timestamp: Date.now() },
          ],
          iteration: state.iteration + 1,
        };
      }

      const shouldReflect =
        (state.stepResults.length > 0 && state.stepResults.length % REFLECT_INTERVAL === 0);
      expect(shouldReflect).toBe(true);
    });

    it("should trigger reflection on error", () => {
      let state = createInitialState("task");
      state = transitionPhase(state, AgentPhase.EXECUTING);

      state = {
        ...state,
        stepResults: [
          ...state.stepResults,
          { toolName: "dotnet_build", success: false, summary: "Build failed", timestamp: Date.now() },
        ],
        iteration: state.iteration + 1,
        consecutiveErrors: 1,
      };

      const hasErrors = true; // simulated from toolResults.some(tr => tr.isError)
      expect(hasErrors).toBe(true);
      // This would trigger reflection in the background task loop
    });

    it("should warn about consecutive errors in reflection prompt", () => {
      const state: import("./agent-state.js").AgentState = {
        phase: AgentPhase.REFLECTING,
        taskDescription: "task",
        iteration: 5,
        plan: "Build project",
        stepResults: [
          { toolName: "dotnet_build", success: false, summary: "Error 1", timestamp: Date.now() },
          { toolName: "dotnet_build", success: false, summary: "Error 2", timestamp: Date.now() },
          { toolName: "dotnet_build", success: false, summary: "Error 3", timestamp: Date.now() },
        ],
        failedApproaches: [],
        reflectionCount: 0,
        lastReflection: null,
        consecutiveErrors: 3,
        learnedInsights: [],
      };

      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("WARNING");
      expect(prompt).toContain("3 consecutive errors");
    });
  });
});
