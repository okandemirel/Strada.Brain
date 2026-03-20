import { describe, expect, it } from "vitest";
import { AgentPhase, createInitialState } from "./agent-state.js";
import {
  buildExecutionTraceRecord,
  buildPhaseOutcomeRecord,
  buildPhaseOutcomeTelemetry,
  toExecutionPhase,
  toPhaseOutcomeStatus,
  transitionToVerifierReplan,
} from "./orchestrator-phase-telemetry.js";

describe("orchestrator-phase-telemetry", () => {
  it("maps execution phases and verifier decisions", () => {
    expect(toExecutionPhase(AgentPhase.PLANNING)).toBe("planning");
    expect(toExecutionPhase(AgentPhase.REPLANNING)).toBe("replanning");
    expect(toExecutionPhase(AgentPhase.EXECUTING)).toBe("executing");
    expect(toPhaseOutcomeStatus("approve")).toBe("approved");
    expect(toPhaseOutcomeStatus("replan")).toBe("replanned");
  });

  it("transitions verifier replans with enriched state", () => {
    const state = {
      ...createInitialState(),
      phase: AgentPhase.EXECUTING,
      plan: "Inspect logs",
      stepResults: [{ toolName: "shell", summary: "ls", success: true }],
    };

    const updated = transitionToVerifierReplan(state, "Need another pass");

    expect(updated.phase).toBe(AgentPhase.REPLANNING);
    expect(updated.reflectionCount).toBe(1);
    expect(updated.failedApproaches).toHaveLength(1);
    expect(updated.lastReflection).toBe("Need another pass");
  });

  it("builds execution and outcome telemetry records", () => {
    const state = {
      ...createInitialState(),
      reflectionCount: 2,
      failedApproaches: ["attempt-1"],
      plan: "Compile project",
    };
    const task = { type: "implementation" } as any;
    const assignment = {
      providerName: "claude",
      modelId: "sonnet",
      role: "reviewer" as const,
      reason: "cross-check output",
    };

    const telemetry = buildPhaseOutcomeTelemetry({
      state,
      usage: { inputTokens: 12, outputTokens: 24 },
      verifierDecision: "continue",
    });
    const trace = buildExecutionTraceRecord({
      identityKey: "user-1",
      assignment,
      phase: "reflecting",
      task,
      timestampMs: 123,
      taskRunId: "task-1",
    });
    const outcome = buildPhaseOutcomeRecord({
      identityKey: "user-1",
      assignment,
      phase: "reflecting",
      status: "continued",
      task,
      timestampMs: 124,
      telemetry,
    });

    expect(trace).toMatchObject({
      provider: "claude",
      role: "reviewer",
      phase: "reflecting",
      timestamp: 123,
      taskRunId: "task-1",
    });
    expect(outcome.telemetry).toMatchObject({
      verifierDecision: "continue",
      inputTokens: 12,
      outputTokens: 24,
      retryCount: 2,
      rollbackDepth: 1,
      phaseVerdict: expect.any(String),
    });
  });
});
