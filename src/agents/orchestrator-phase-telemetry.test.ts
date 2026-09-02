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

  it("transitions verifier replans from PLANNING phase", () => {
    const state = createInitialState("planning task");

    const updated = transitionToVerifierReplan(state, "Plan rejected");

    expect(updated.phase).toBe(AgentPhase.REPLANNING);
    expect(updated.reflectionCount).toBe(1);
    expect(updated.failedApproaches).toHaveLength(1);
    expect(updated.lastReflection).toBe("Plan rejected");
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

  // audited 2026-09-02: the assignment names the router's pick; a fallback chain may have
  // answered from a sibling. Outcomes and traces must be attributed to who actually served,
  // or the served provider's work raises the assigned provider's behavioral profile.
  describe("attribution follows the member that served", () => {
    const task = { type: "implementation" } as any;
    const base = {
      providerName: "openai",
      modelId: "gpt-5",
      role: "planner" as const,
      reason: "router pick",
    };

    it("stamps the served provider and model on the outcome and the trace", () => {
      const assignment = { ...base, servedBy: { provider: "opencode2", model: "oc-large" } };
      const outcome = buildPhaseOutcomeRecord({
        identityKey: "u", assignment, phase: "planning", status: "approved", task, timestampMs: 1,
      });
      const trace = buildExecutionTraceRecord({
        identityKey: "u", assignment, phase: "planning", task, timestampMs: 1,
      });
      expect(outcome.provider, "outcome credited to the provider that did not answer").toBe("opencode2");
      expect(outcome.model).toBe("oc-large");
      expect(trace.provider).toBe("opencode2");
      expect(trace.model).toBe("oc-large");
    });

    it("does not pair a sibling with the assigned model when the sibling's model is unknown", () => {
      const assignment = { ...base, servedBy: { provider: "opencode2" } };
      const outcome = buildPhaseOutcomeRecord({
        identityKey: "u", assignment, phase: "planning", status: "approved", task, timestampMs: 1,
      });
      expect(outcome.provider).toBe("opencode2");
      expect(outcome.model).toBeUndefined();
    });

    it("keeps the assigned model when the assigned provider itself served without naming one", () => {
      const assignment = { ...base, servedBy: { provider: "openai" } };
      const outcome = buildPhaseOutcomeRecord({
        identityKey: "u", assignment, phase: "planning", status: "approved", task, timestampMs: 1,
      });
      expect(outcome.provider).toBe("openai");
      expect(outcome.model).toBe("gpt-5");
    });

    it("falls back to the assignment when nothing reported who served", () => {
      const outcome = buildPhaseOutcomeRecord({
        identityKey: "u", assignment: base, phase: "planning", status: "approved", task, timestampMs: 1,
      });
      expect(outcome.provider).toBe("openai");
      expect(outcome.model).toBe("gpt-5");
    });
  });
});
