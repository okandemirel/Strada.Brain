import { describe, it, expect } from "vitest";
import {
  AgentPhase,
  createInitialState,
  canTransition,
  transitionPhase,
  type AgentState,
} from "./agent-state.ts";

describe("AgentState", () => {
  describe("createInitialState", () => {
    it("should set phase to PLANNING", () => {
      const state = createInitialState("test task");
      expect(state.phase).toBe(AgentPhase.PLANNING);
    });

    it("should store the task description", () => {
      const state = createInitialState("build a widget");
      expect(state.taskDescription).toBe("build a widget");
    });

    it("should set iteration to 0", () => {
      const state = createInitialState("test task");
      expect(state.iteration).toBe(0);
    });

    it("should set plan to null", () => {
      const state = createInitialState("test task");
      expect(state.plan).toBeNull();
    });

    it("should set empty stepResults", () => {
      const state = createInitialState("test task");
      expect(state.stepResults).toEqual([]);
    });

    it("should set empty failedApproaches", () => {
      const state = createInitialState("test task");
      expect(state.failedApproaches).toEqual([]);
    });

    it("should set reflectionCount to 0", () => {
      const state = createInitialState("test task");
      expect(state.reflectionCount).toBe(0);
    });

    it("should set lastReflection to null", () => {
      const state = createInitialState("test task");
      expect(state.lastReflection).toBeNull();
    });

    it("should set consecutiveErrors to 0", () => {
      const state = createInitialState("test task");
      expect(state.consecutiveErrors).toBe(0);
    });

    it("should set empty learnedInsights", () => {
      const state = createInitialState("test task");
      expect(state.learnedInsights).toEqual([]);
    });
  });

  describe("canTransition", () => {
    it("should allow PLANNING -> EXECUTING", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.EXECUTING)).toBe(true);
    });

    it("should allow PLANNING -> FAILED", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.FAILED)).toBe(true);
    });

    it("should allow EXECUTING -> REFLECTING", () => {
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.REFLECTING)).toBe(true);
    });

    it("should allow EXECUTING -> COMPLETE", () => {
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.COMPLETE)).toBe(true);
    });

    it("should allow EXECUTING -> FAILED", () => {
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.FAILED)).toBe(true);
    });

    it("should allow REFLECTING -> EXECUTING", () => {
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.EXECUTING)).toBe(true);
    });

    it("should allow REFLECTING -> REPLANNING", () => {
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.REPLANNING)).toBe(true);
    });

    it("should allow REFLECTING -> COMPLETE", () => {
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.COMPLETE)).toBe(true);
    });

    it("should allow REFLECTING -> FAILED", () => {
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.FAILED)).toBe(true);
    });

    it("should allow REPLANNING -> EXECUTING", () => {
      expect(canTransition(AgentPhase.REPLANNING, AgentPhase.EXECUTING)).toBe(true);
    });

    it("should allow REPLANNING -> FAILED", () => {
      expect(canTransition(AgentPhase.REPLANNING, AgentPhase.FAILED)).toBe(true);
    });

    it("should reject PLANNING -> REFLECTING", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.REFLECTING)).toBe(false);
    });

    it("should reject PLANNING -> COMPLETE", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.COMPLETE)).toBe(false);
    });

    it("should reject PLANNING -> REPLANNING", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.REPLANNING)).toBe(false);
    });

    it("should reject COMPLETE -> any phase", () => {
      for (const phase of Object.values(AgentPhase)) {
        expect(canTransition(AgentPhase.COMPLETE, phase)).toBe(false);
      }
    });

    it("should reject FAILED -> any phase", () => {
      for (const phase of Object.values(AgentPhase)) {
        expect(canTransition(AgentPhase.FAILED, phase)).toBe(false);
      }
    });

    it("should reject EXECUTING -> PLANNING", () => {
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.PLANNING)).toBe(false);
    });

    it("should reject REFLECTING -> PLANNING", () => {
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.PLANNING)).toBe(false);
    });

    it("should reject self-transitions", () => {
      expect(canTransition(AgentPhase.PLANNING, AgentPhase.PLANNING)).toBe(false);
      expect(canTransition(AgentPhase.EXECUTING, AgentPhase.EXECUTING)).toBe(false);
      expect(canTransition(AgentPhase.REFLECTING, AgentPhase.REFLECTING)).toBe(false);
      expect(canTransition(AgentPhase.REPLANNING, AgentPhase.REPLANNING)).toBe(false);
    });
  });

  describe("transitionPhase", () => {
    it("should return a new state object with updated phase", () => {
      const state = createInitialState("test task");
      const next = transitionPhase(state, AgentPhase.EXECUTING);

      expect(next.phase).toBe(AgentPhase.EXECUTING);
      expect(next).not.toBe(state);
    });

    it("should preserve all other fields", () => {
      const state = createInitialState("test task");
      const next = transitionPhase(state, AgentPhase.EXECUTING);

      expect(next.taskDescription).toBe(state.taskDescription);
      expect(next.iteration).toBe(state.iteration);
      expect(next.plan).toBe(state.plan);
      expect(next.stepResults).toEqual(state.stepResults);
      expect(next.failedApproaches).toEqual(state.failedApproaches);
      expect(next.reflectionCount).toBe(state.reflectionCount);
      expect(next.lastReflection).toBe(state.lastReflection);
      expect(next.consecutiveErrors).toBe(state.consecutiveErrors);
      expect(next.learnedInsights).toEqual(state.learnedInsights);
    });

    it("should not mutate the original state", () => {
      const state = createInitialState("test task");
      transitionPhase(state, AgentPhase.EXECUTING);

      expect(state.phase).toBe(AgentPhase.PLANNING);
    });

    it("should throw on invalid transition", () => {
      const state = createInitialState("test task");
      expect(() => transitionPhase(state, AgentPhase.REFLECTING)).toThrow();
    });

    it("should throw with descriptive message on invalid transition", () => {
      const state = createInitialState("test task");
      expect(() => transitionPhase(state, AgentPhase.COMPLETE)).toThrow(
        /planning.*complete/i,
      );
    });

    it("should throw when transitioning from terminal state COMPLETE", () => {
      const state = createInitialState("test task");
      const executing = transitionPhase(state, AgentPhase.EXECUTING);
      const complete = transitionPhase(executing, AgentPhase.COMPLETE);

      expect(() => transitionPhase(complete, AgentPhase.EXECUTING)).toThrow();
    });

    it("should throw when transitioning from terminal state FAILED", () => {
      const state = createInitialState("test task");
      const failed = transitionPhase(state, AgentPhase.FAILED);

      expect(() => transitionPhase(failed, AgentPhase.PLANNING)).toThrow();
    });

    it("should support multi-step valid transition chains", () => {
      const s0 = createInitialState("test task");
      const s1 = transitionPhase(s0, AgentPhase.EXECUTING);
      const s2 = transitionPhase(s1, AgentPhase.REFLECTING);
      const s3 = transitionPhase(s2, AgentPhase.REPLANNING);
      const s4 = transitionPhase(s3, AgentPhase.EXECUTING);
      const s5 = transitionPhase(s4, AgentPhase.COMPLETE);

      expect(s5.phase).toBe(AgentPhase.COMPLETE);
    });
  });
});
