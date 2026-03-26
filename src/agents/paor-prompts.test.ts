import { describe, it, expect } from "vitest";
import {
  buildPlanningPrompt,
  buildReflectionPrompt,
  buildReplanningPrompt,
  buildExecutionContext,
} from "./paor-prompts.ts";
import type { AgentState } from "./agent-state.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: "reflect",
    taskDescription: "Fix the login bug",
    iteration: 1,
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

describe("buildPlanningPrompt", () => {
  it("includes task description and PLAN keyword", () => {
    const result = buildPlanningPrompt("Create a user service");
    expect(result).toContain("Create a user service");
    expect(result.toUpperCase()).toContain("PLAN");
  });

  it("includes learned insights when provided and non-empty", () => {
    const insights = ["Always validate input", "Use transactions for DB writes"];
    const result = buildPlanningPrompt("Build API", insights);
    expect(result).toContain("Learned Patterns");
    expect(result).toContain("Always validate input");
    expect(result).toContain("Use transactions for DB writes");
  });

  it("excludes insights section when array is empty", () => {
    const result = buildPlanningPrompt("Build API", []);
    expect(result).not.toContain("Learned Patterns");
  });

  it("excludes insights section when undefined", () => {
    const result = buildPlanningPrompt("Build API");
    expect(result).not.toContain("Learned Patterns");
  });

  it("adds an exact-target execution priority section when the prompt names files or project-relative paths", () => {
    const result = buildPlanningPrompt(
      "Temp altında `strada_autonomy_smoke.txt` oluştur, oku ve sil",
    );
    expect(result).toContain("## Execution Priority");
    expect(result).toContain("The user named explicit targets:");
    expect(result).toContain("Temp");
    expect(result).toContain("strada_autonomy_smoke.txt");
    expect(result).toContain("Do not reinterpret project paths like `Temp/...` as absolute OS paths like `/tmp/...`");
  });
});

describe("buildReflectionPrompt", () => {
  it("includes step results with OK/FAIL status", () => {
    const state = makeState({
      stepResults: [
        { toolName: "file_read", success: true, summary: "Read config", timestamp: Date.now() },
        { toolName: "shell_exec", success: false, summary: "Build failed", timestamp: Date.now(), errorCategory: "build" },
      ],
    });
    const result = buildReflectionPrompt(state);
    expect(result).toContain("file_read");
    expect(result).toContain("OK");
    expect(result).toContain("shell_exec");
    expect(result).toContain("FAIL");
  });

  it("shows only last 5 step results when more exist", () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      toolName: `tool_${i}`,
      success: true,
      summary: `Step ${i}`,
      timestamp: Date.now(),
    }));
    const state = makeState({ stepResults: steps });
    const result = buildReflectionPrompt(state);
    // Should contain last 5 (indices 3-7) but not first ones
    expect(result).toContain("tool_7");
    expect(result).toContain("tool_3");
    expect(result).not.toContain("tool_2");
  });

  it("shows success/failure counts", () => {
    const state = makeState({
      stepResults: [
        { toolName: "a", success: true, summary: "ok", timestamp: Date.now() },
        { toolName: "b", success: true, summary: "ok", timestamp: Date.now() },
        { toolName: "c", success: false, summary: "err", timestamp: Date.now() },
      ],
    });
    const result = buildReflectionPrompt(state);
    expect(result).toMatch(/2.*success/i);
    expect(result).toMatch(/1.*fail/i);
  });

  it("adds WARNING when consecutiveErrors >= 3", () => {
    const state = makeState({ consecutiveErrors: 3 });
    const result = buildReflectionPrompt(state);
    expect(result.toUpperCase()).toContain("WARNING");
  });

  it("does not add WARNING when consecutiveErrors < 3", () => {
    const state = makeState({ consecutiveErrors: 1 });
    const result = buildReflectionPrompt(state);
    expect(result.toUpperCase()).not.toContain("WARNING");
  });

  it("lists failed approaches as do NOT repeat", () => {
    const state = makeState({ failedApproaches: ["brute force", "regex parsing"] });
    const result = buildReflectionPrompt(state);
    expect(result).toContain("brute force");
    expect(result).toContain("regex parsing");
    expect(result.toUpperCase()).toContain("NOT");
  });

  it("asks LLM to respond with CONTINUE, REPLAN, or DONE", () => {
    const state = makeState();
    const result = buildReflectionPrompt(state);
    expect(result).toContain("CONTINUE");
    expect(result).toContain("REPLAN");
    expect(result).toContain("DONE");
  });
});

describe("buildReplanningPrompt", () => {
  it("shows original plan if it exists", () => {
    const state = makeState({ plan: "1. Read file\n2. Parse data\n3. Write output" });
    const result = buildReplanningPrompt(state);
    expect(result).toContain("1. Read file");
    expect(result).toContain("2. Parse data");
  });

  it("lists failed approaches", () => {
    const state = makeState({ failedApproaches: ["regex approach", "brute force scan"] });
    const result = buildReplanningPrompt(state);
    expect(result).toContain("regex approach");
    expect(result).toContain("brute force scan");
  });

  it("shows last reflection", () => {
    const state = makeState({ lastReflection: "The build keeps failing due to missing types" });
    const result = buildReplanningPrompt(state);
    expect(result).toContain("The build keeps failing due to missing types");
  });

  it("asks for fundamentally different approach", () => {
    const state = makeState();
    const result = buildReplanningPrompt(state);
    expect(result.toLowerCase()).toContain("different");
  });
});

describe("buildExecutionContext", () => {
  it("returns empty string when plan is null", () => {
    const state = makeState({ plan: null });
    const result = buildExecutionContext(state);
    expect(result).toBe("");
  });

  it("includes plan text and iteration number when plan exists", () => {
    const state = makeState({ plan: "1. Read config\n2. Apply changes", iteration: 3 });
    const result = buildExecutionContext(state);
    expect(result).toContain("1. Read config");
    expect(result).toContain("2. Apply changes");
    expect(result).toContain("3");
  });
});

describe("buildPlanningPrompt - Goal Classification", () => {
  it("includes Goal Classification section when enableGoalDetection is true", () => {
    const result = buildPlanningPrompt("Build a REST API", undefined, { enableGoalDetection: true });
    expect(result).toContain("Goal Classification");
    expect(result).toContain("goal");
    expect(result).toContain("isGoal");
  });

  it("does NOT include goal classification when enableGoalDetection is false", () => {
    const result = buildPlanningPrompt("Build a REST API", undefined, { enableGoalDetection: false });
    expect(result).not.toContain("Goal Classification");
  });

  it("does NOT include goal classification when options is undefined", () => {
    const result = buildPlanningPrompt("Build a REST API");
    expect(result).not.toContain("Goal Classification");
  });

  it("includes both learned insights AND goal classification when both provided", () => {
    const insights = ["Use TypeScript strictly", "Always add error handling"];
    const result = buildPlanningPrompt("Build API", insights, { enableGoalDetection: true });
    expect(result).toContain("Learned Patterns");
    expect(result).toContain("Use TypeScript strictly");
    expect(result).toContain("Goal Classification");
    expect(result).toContain("isGoal");
  });
});
