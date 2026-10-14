/**
 * The shell reviewer needs the task to review against.
 *
 * Measured in a live campaign: shell commands were refused with "Task not
 * provided; cannot verify alignment with the stated task". That is a reviewer
 * failing for want of its one required input, not because the command was
 * wrong — and each refusal costs the run a turn.
 *
 * A worker's session holds no user turn (it was handed a task, not a
 * conversation), so the user-message lookup returns "". The task description
 * sits in agent state and is already trusted elsewhere in the same function for
 * drift detection.
 */

import { describe, it, expect } from "vitest";
import { createInitialState } from "../../agents/agent-state.js";
import { reviewTaskPrompt as taskPromptFor } from "./tool-turn.js";

describe("what the shell reviewer is told the task is", () => {
  it("uses the user's own message when there is one", () => {
    const state = createInitialState("write the greenhouse irrigation scheduler");

    expect(taskPromptFor("add a watering log", state.taskDescription)).toBe("add a watering log");
  });

  it("falls back to the task description a worker was given", () => {
    // The case that produced "(not provided)": a worker's session has no user turn.
    const state = createInitialState("index the recipe archive and expose its search endpoint");

    expect(taskPromptFor("", state.taskDescription)).toBe(
      "index the recipe archive and expose its search endpoint",
    );
  });

  it("is empty only when neither exists, which is the honest answer", () => {
    expect(taskPromptFor("", createInitialState("").taskDescription)).toBe("");
    expect(taskPromptFor(undefined, undefined)).toBe("");
  });
});
