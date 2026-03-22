import { describe, it, expect } from "vitest";
import {
  AgentPhase,
  createInitialState,
  transitionPhase,
  canTransition,
} from "./agent-state.js";
import type { AgentState } from "./agent-state.js";
import { parseReflectionDecision, validateReflectionDecision } from "./orchestrator-runtime-utils.js";
import {
  buildPlanningPrompt,
  buildReflectionPrompt,
} from "./paor-prompts.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.PLANNING,
    taskDescription: "integration test task",
    iteration: 0,
    plan: null,
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

describe("PAOR integration", () => {
  describe("Full PAOR lifecycle", () => {
    it("starts in PLANNING and transitions through to COMPLETE", () => {
      let state = createInitialState("implement feature X");
      expect(state.phase).toBe(AgentPhase.PLANNING);

      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);

      state = transitionPhase(state, AgentPhase.REFLECTING);
      expect(state.phase).toBe(AgentPhase.REFLECTING);

      state = transitionPhase(state, AgentPhase.COMPLETE);
      expect(state.phase).toBe(AgentPhase.COMPLETE);
    });

    it("preserves immutable state fields across transitions", () => {
      const state = createInitialState("preserve fields");
      const next = transitionPhase(state, AgentPhase.EXECUTING);
      expect(next.taskDescription).toBe("preserve fields");
      expect(next.iteration).toBe(0);
      expect(next.stepResults).toEqual([]);
      expect(state.phase).toBe(AgentPhase.PLANNING); // original unchanged
    });
  });

  describe("Replan cycle", () => {
    it("transitions PLANNING -> EXECUTING -> REFLECTING -> REPLANNING -> EXECUTING", () => {
      let state = createInitialState("refactor module");
      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);

      state = transitionPhase(state, AgentPhase.REFLECTING);
      expect(state.phase).toBe(AgentPhase.REFLECTING);

      state = transitionPhase(state, AgentPhase.REPLANNING);
      expect(state.phase).toBe(AgentPhase.REPLANNING);

      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });

    it("preserves failed approaches and plan across replanning", () => {
      let state = makeState({
        phase: AgentPhase.REFLECTING,
        plan: "Approach A: brute force",
        failedApproaches: [],
      });
      state = {
        ...state,
        failedApproaches: [...state.failedApproaches, state.plan!],
      };
      state = transitionPhase(state, AgentPhase.REPLANNING);
      expect(state.failedApproaches).toContain("Approach A: brute force");

      state = { ...state, plan: "Approach B: indexed lookup" };
      state = transitionPhase(state, AgentPhase.EXECUTING);
      expect(state.plan).toBe("Approach B: indexed lookup");
      expect(state.failedApproaches).toHaveLength(1);
    });
  });

  describe("parseReflectionDecision parsing", () => {
    it("returns CONTINUE for null", () => {
      expect(parseReflectionDecision(null)).toBe("CONTINUE");
    });

    it("returns CONTINUE for undefined", () => {
      expect(parseReflectionDecision(undefined)).toBe("CONTINUE");
    });

    it("returns CONTINUE for empty string", () => {
      expect(parseReflectionDecision("")).toBe("CONTINUE");
    });

    it("parses **DONE**", () => {
      expect(parseReflectionDecision("All tasks verified.\n**DONE**")).toBe("DONE");
    });

    it("parses **REPLAN**", () => {
      expect(parseReflectionDecision("Build still failing.\n**REPLAN**")).toBe("REPLAN");
    });

    it("parses **CONTINUE**", () => {
      expect(parseReflectionDecision("Progress made.\n**CONTINUE**")).toBe("CONTINUE");
    });

    it("parses **DONE_WITH_SUGGESTIONS**", () => {
      expect(parseReflectionDecision("Done, consider adding tests.\n**DONE_WITH_SUGGESTIONS**")).toBe("DONE_WITH_SUGGESTIONS");
    });

    it("returns CONTINUE for random text with no marker", () => {
      expect(parseReflectionDecision("This is just some random analysis text.")).toBe("CONTINUE");
    });

    it("falls back to bare last-line DONE without **", () => {
      expect(parseReflectionDecision("Analysis complete.\nDONE")).toBe("DONE");
    });

    it("falls back to bare last-line REPLAN without **", () => {
      expect(parseReflectionDecision("Needs different strategy.\nREPLAN")).toBe("REPLAN");
    });
  });

  describe("consecutiveErrors reset on CONTINUE", () => {
    it("documents current behavior: consecutiveErrors resets to 0 on CONTINUE", () => {
      // Current code pattern: when CONTINUE is decided, consecutiveErrors is
      // reset to 0. This test documents that behavior — P1 may change it.
      let state = makeState({
        phase: AgentPhase.REFLECTING,
        consecutiveErrors: 3,
      });
      const decision = parseReflectionDecision("Some progress.\n**CONTINUE**");
      expect(decision).toBe("CONTINUE");

      // Simulate the loop behavior: on CONTINUE, reset consecutiveErrors
      if (decision === "CONTINUE") {
        state = { ...state, consecutiveErrors: 0 };
      }
      expect(state.consecutiveErrors).toBe(0);
    });
  });

  describe("Invalid transitions", () => {
    it("canTransition returns false for PLANNING -> REFLECTING", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.REFLECTING)).toBe(false);
    });

    it("canTransition returns false for PLANNING -> REPLANNING", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.REPLANNING)).toBe(false);
    });

    it("canTransition returns false for EXECUTING -> REPLANNING", () => {
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.REPLANNING)).toBe(false);
    });

    it("transitionPhase throws for invalid transition", () => {
      const state = createInitialState("task");
      expect(() => transitionPhase(state, AgentPhase.REFLECTING)).toThrow(
        "Invalid phase transition: planning -> reflecting",
      );
    });

    it("transitionPhase throws for COMPLETE -> any transition", () => {
      const state = makeState({ phase: AgentPhase.COMPLETE });
      expect(() => transitionPhase(state, AgentPhase.EXECUTING)).toThrow(
        "Invalid phase transition",
      );
    });

    it("transitionPhase throws for FAILED -> any transition", () => {
      const state = makeState({ phase: AgentPhase.FAILED });
      expect(() => transitionPhase(state, AgentPhase.PLANNING)).toThrow(
        "Invalid phase transition",
      );
    });
  });

  describe("buildReflectionPrompt content", () => {
    it("contains [OK] and [FAIL] markers for step results", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        stepResults: [
          { toolName: "read_file", success: true, summary: "Read config", timestamp: Date.now() },
          { toolName: "shell_exec", success: false, summary: "Build error", timestamp: Date.now() },
        ],
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("[OK] read_file");
      expect(prompt).toContain("[FAIL] shell_exec");
    });

    it("contains WARNING when consecutiveErrors >= 3", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        consecutiveErrors: 3,
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("WARNING");
      expect(prompt).toContain("3 consecutive errors");
    });

    it("does not contain WARNING when consecutiveErrors < 3", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        consecutiveErrors: 2,
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).not.toContain("WARNING");
    });

    it("contains Failed Approaches when failedApproaches is non-empty", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        failedApproaches: ["regex approach", "brute force scan"],
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("Failed Approaches");
      expect(prompt).toContain("regex approach");
      expect(prompt).toContain("brute force scan");
    });

    it("reports correct success/failure counts", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        stepResults: [
          { toolName: "a", success: true, summary: "ok", timestamp: 1 },
          { toolName: "b", success: true, summary: "ok", timestamp: 2 },
          { toolName: "c", success: false, summary: "err", timestamp: 3 },
          { toolName: "d", success: true, summary: "ok", timestamp: 4 },
        ],
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("3 success, 1 failures");
    });
  });

  describe("buildPlanningPrompt content", () => {
    it("contains ## PLAN Phase header", () => {
      const prompt = buildPlanningPrompt("Build the project");
      expect(prompt).toContain("## PLAN Phase");
    });

    it("contains ### Learned Patterns with insights", () => {
      const prompt = buildPlanningPrompt("Build API", [
        "Always validate input",
        "Check null before access",
      ]);
      expect(prompt).toContain("### Learned Patterns");
      expect(prompt).toContain("Always validate input");
      expect(prompt).toContain("Check null before access");
    });

    it("omits Learned Patterns when insights is empty", () => {
      const prompt = buildPlanningPrompt("Build API", []);
      expect(prompt).not.toContain("Learned Patterns");
    });

    it("contains ### Goal Classification when enabled", () => {
      const prompt = buildPlanningPrompt("Build API", undefined, { enableGoalDetection: true });
      expect(prompt).toContain("### Goal Classification");
    });

    it("omits Goal Classification when not enabled", () => {
      const prompt = buildPlanningPrompt("Build API");
      expect(prompt).not.toContain("Goal Classification");
    });
  });

  describe("validateReflectionDecision (P1: evidence-based override)", () => {
    it("should pass through non-DONE decisions unchanged", () => {
      const state = createInitialState("test task");
      expect(validateReflectionDecision("CONTINUE", state).decision).toBe("CONTINUE");
      expect(validateReflectionDecision("REPLAN", state).decision).toBe("REPLAN");
    });

    it("should allow DONE when all recent steps succeeded", () => {
      const state = makeState({ stepResults: [
        { toolName: "build", success: true, summary: "ok", timestamp: 1 },
        { toolName: "test", success: true, summary: "ok", timestamp: 2 },
      ]});
      expect(validateReflectionDecision("DONE", state).decision).toBe("DONE");
    });

    it("should override DONE to CONTINUE when recent steps have failures", () => {
      const state = makeState({ stepResults: [
        { toolName: "build", success: true, summary: "ok", timestamp: 1 },
        { toolName: "test", success: false, summary: "3 tests failed", timestamp: 2 },
      ]});
      const result = validateReflectionDecision("DONE", state);
      expect(result.decision).toBe("CONTINUE");
      expect(result.overrideReason).toContain("DONE overridden");
    });

    it("should override DONE_WITH_SUGGESTIONS to CONTINUE on failure", () => {
      const state = makeState({ stepResults: [
        { toolName: "deploy", success: false, summary: "timeout", timestamp: 1 },
      ]});
      const result = validateReflectionDecision("DONE_WITH_SUGGESTIONS", state);
      expect(result.decision).toBe("CONTINUE");
    });

    it("should allow DONE when no step results exist", () => {
      const state = createInitialState("test task");
      expect(validateReflectionDecision("DONE", state).decision).toBe("DONE");
    });
  });

  describe("buildReflectionPrompt last-step evidence (P1)", () => {
    it("includes **Last step** line with OK status", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        stepResults: [
          { toolName: "build", success: true, summary: "compiled successfully", timestamp: 1 },
        ],
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("**Last step**: [OK] build: compiled successfully");
    });

    it("includes **Last step** line with FAIL status", () => {
      const state = makeState({
        phase: AgentPhase.REFLECTING,
        stepResults: [
          { toolName: "build", success: true, summary: "ok", timestamp: 1 },
          { toolName: "test", success: false, summary: "3 tests failed", timestamp: 2 },
        ],
      });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).toContain("**Last step**: [FAIL] test: 3 tests failed");
    });

    it("omits **Last step** when no step results exist", () => {
      const state = makeState({ phase: AgentPhase.REFLECTING });
      const prompt = buildReflectionPrompt(state);
      expect(prompt).not.toContain("**Last step**");
    });
  });

  describe("Terminal states", () => {
    it("COMPLETE has no valid transitions", () => {
      expect(canTransition(AgentPhase.COMPLETE, AgentPhase.PLANNING)).toBe(false);
      expect(canTransition(AgentPhase.COMPLETE, AgentPhase.EXECUTING)).toBe(false);
      expect(canTransition(AgentPhase.COMPLETE, AgentPhase.REFLECTING)).toBe(false);
      expect(canTransition(AgentPhase.COMPLETE, AgentPhase.REPLANNING)).toBe(false);
      expect(canTransition(AgentPhase.COMPLETE, AgentPhase.FAILED)).toBe(false);
    });

    it("FAILED has no valid transitions", () => {
      expect(canTransition(AgentPhase.FAILED, AgentPhase.PLANNING)).toBe(false);
      expect(canTransition(AgentPhase.FAILED, AgentPhase.EXECUTING)).toBe(false);
      expect(canTransition(AgentPhase.FAILED, AgentPhase.REFLECTING)).toBe(false);
      expect(canTransition(AgentPhase.FAILED, AgentPhase.REPLANNING)).toBe(false);
      expect(canTransition(AgentPhase.FAILED, AgentPhase.COMPLETE)).toBe(false);
    });
  });
});
