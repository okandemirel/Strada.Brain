/**
 * Reflection is a model round-trip, so it has to be spent where it pays.
 *
 * The trigger was: any tool error, or every third step. Measured on a
 * from-scratch run — 33 minutes, 131 model calls, 62 tool executions, five C#
 * files. 99% of the wall clock was model time and 1% was tools; roughly every
 * other turn produced no action at all, each costing 17–51 seconds against a
 * conversation that kept growing.
 *
 * Two things made that worse than it needed to be.
 *
 * A single failed tool call spent a whole round-trip on reflection, and the
 * failure was already in the tool result the model reads on its very next turn.
 * There were eleven such errors, most of them one-offs the agent recovered from
 * immediately — a missing .csproj, a path it re-tried correctly.
 *
 * And the interval counted every step alike, so three directory listings bought
 * the same reflection as three file writes. Of the 62 executions, the large
 * majority were lookups.
 *
 * So: reflect when a failure persists or blocks, and count only steps that
 * changed something or verified something. Nothing here removes reflection from
 * the paths that matter — a build that fails, or an error that repeats, still
 * gets it immediately.
 */

import { describe, it, expect } from "vitest";
import { recordStepResultsAndCheckReflection } from "./orchestrator-loop-utils.js";
import { AgentPhase, type AgentState } from "./agent-state.js";
import type { ToolCall, ToolExecutionResult } from "./tools/tool-core.interface.js";

const REFLECT_INTERVAL = 3;

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    plan: "build the board",
    stepResults: [],
    iteration: 0,
    consecutiveErrors: 0,
    ...overrides,
  } as AgentState;
}

const call = (name: string): ToolCall => ({ id: name, name, input: {} }) as ToolCall;
const ok = (): ToolExecutionResult => ({ content: "done" }) as ToolExecutionResult;
const failed = (content = "boom"): ToolExecutionResult =>
  ({ content, isError: true }) as ToolExecutionResult;

function run(
  tools: string[],
  results: ToolExecutionResult[],
  agentState = state(),
): ReturnType<typeof recordStepResultsAndCheckReflection> {
  return recordStepResultsAndCheckReflection({
    agentState,
    toolCalls: tools.map(call),
    toolResults: results,
    reflectInterval: REFLECT_INTERVAL,
  });
}

describe("when a step fails", () => {
  it("does not reflect on a single failure the model will read anyway", () => {
    const { shouldReflect } = run(["dotnet_build"], [failed("no .csproj found")]);
    expect(shouldReflect).toBe(false);
  });

  it("reflects once the failure repeats", () => {
    // The agent tried and did not recover; that is worth a round-trip.
    const first = run(["dotnet_build"], [failed()]);
    const second = run(["dotnet_build"], [failed()], first.agentState);
    expect(second.shouldReflect).toBe(true);
  });

  it("forgets the failure once a step succeeds", () => {
    const first = run(["dotnet_build"], [failed()]);
    const recovered = run(["file_write"], [ok()], first.agentState);
    const later = run(["file_read"], [failed()], recovered.agentState);
    expect(later.shouldReflect).toBe(false);
  });
});

describe("the reflection interval", () => {
  it("does not count lookups towards it", () => {
    // Three directory listings are not three steps of progress.
    let s = state();
    for (const tool of ["list_directory", "glob_search", "file_read"]) {
      const result = run([tool], [ok()], s);
      expect(result.shouldReflect, `${tool} triggered a reflection`).toBe(false);
      s = result.agentState;
    }
  });

  it("counts steps that changed something", () => {
    let s = state();
    let last = false;
    for (const tool of ["file_write", "file_write", "file_write"]) {
      const result = run([tool], [ok()], s);
      last = result.shouldReflect;
      s = result.agentState;
    }
    expect(last, "three writes went unreflected").toBe(true);
  });

  it("counts verification the same way", () => {
    let s = state();
    let last = false;
    for (const tool of ["unity_verify_change", "dotnet_build", "unity_test_run"]) {
      const result = run([tool], [ok()], s);
      last = result.shouldReflect;
      s = result.agentState;
    }
    expect(last).toBe(true);
  });

  it("is not reset by lookups in between", () => {
    // Reads interleaved with writes must neither trigger nor delay it.
    let s = state();
    const sequence = ["file_write", "file_read", "file_write", "list_directory", "file_write"];
    let last = false;
    for (const tool of sequence) {
      const result = run([tool], [ok()], s);
      last = result.shouldReflect;
      s = result.agentState;
    }
    expect(last, "the third write did not trigger a reflection").toBe(true);
  });

  it("still records every step, counted or not", () => {
    // The cadence changes; the agent's history does not.
    const { agentState } = run(["list_directory", "file_write"], [ok(), ok()]);
    expect(agentState.stepResults).toHaveLength(2);
  });
});
