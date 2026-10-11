/**
 * persistTerminal books ONE outcome for a run (metric phase, step trajectory,
 * instinct-credit settle) from the spine's typed terminal.
 *
 * Interactive runs keep terminalStatus "completed" for terminals that are not
 * a finish: a reflection that settled blocked, a write the self-managed review
 * refused (v2-agent-runner changes the status for non-interactive runs only),
 * and the spent iteration budget. A hand-kept list of arbiter reasons missed
 * all three, so each was booked a clean success: a 'Replay success' step row,
 * chain credit and an auto-generated verdict for work that never finished.
 */

import { describe, it, expect, vi } from "vitest";
import { createAgentCorePort } from "./port.js";
import type { AgentEngine } from "./agent-engine.js";
import type { PortDeps } from "./port.js";
import { AgentPhase, createInitialState } from "../../agents/agent-state.js";
import type { TerminalStatus } from "../runner/index.js";

function harness() {
  const recordMetricEnd = vi.fn();
  const recordInRunTrajectoryCredit = vi.fn();
  const clearRunInstinctCredits = vi.fn();
  const runCtx = {
    chatId: "chat-1",
    identityKey: "user-1",
    metricId: "metric-1",
    session: { messages: [] },
    executionJournal: { snapshot: () => ({}) },
    goalsDecomposed: false,
    selfVerification: { dispose: vi.fn() },
  };
  const engine = {
    setupAgentCoreRun: vi.fn(async () => ({ runCtx, setup: {} })),
    recordMetricEnd,
    buildPolicySeed: () => ({}),
  } as unknown as AgentEngine;
  const deps = {
    sessionManager: {
      persistExecutionMemory: vi.fn(),
      persistSessionToMemory: vi.fn(async () => {}),
      getVisibleTranscript: () => [],
    },
    recordInRunTrajectoryCredit,
    clearRunInstinctCredits,
    settleGoalTree: vi.fn(),
    settleRunResponse: vi.fn(),
    currentSessionInstinctIds: new Map(),
    getTaskExecutionContext: () => undefined,
    monitorLifecycle: () => undefined,
    createGateway: () => ({}),
  } as unknown as PortDeps;
  const { port } = createAgentCorePort(engine, deps);
  return { port, recordMetricEnd, recordInRunTrajectoryCredit, clearRunInstinctCredits };
}

async function settle(status: TerminalStatus, reason: string | undefined) {
  const h = harness();
  await h.port.setupRun({ chatId: "chat-1" } as never);
  const state = {
    ...createInitialState("add a health bar"),
    stepResults: [{ toolName: "file_edit", success: true, summary: "edited", timestamp: 1 }],
  };
  await h.port.persistTerminal(state, {} as never, undefined, status, reason);
  return {
    phase: (h.recordMetricEnd.mock.calls[0]![1] as { agentPhase: AgentPhase }).agentPhase,
    trajectorySuccess: (h.recordInRunTrajectoryCredit.mock.calls[0]![0] as { success: boolean }).success,
    creditSuccess: (h.clearRunInstinctCredits.mock.calls[0]![1] as { success: boolean }).success,
  };
}

describe("persistTerminal — the run's outcome comes from its terminal key", () => {
  it.each([
    ["blocked"],
    ["self-managed-write-rejected"],
    ["max-iterations"],
  ])("an interactive run that ended '%s' with status completed is booked a failure", async (reason) => {
    const outcome = await settle("completed", reason);

    expect(outcome).toEqual({ phase: AgentPhase.FAILED, trajectorySuccess: false, creditSuccess: false });
  });

  it.each([
    ["done"],
    ["end_turn"],
    ["plan-review"],
    [undefined],
    // A reason the terminal table does not name, with a clean status, is recorded as it always was.
    ["some-future-reason"],
  ])("a run that ended '%s' with status completed is still booked a success", async (reason) => {
    const outcome = await settle("completed", reason);

    expect(outcome).toEqual({ phase: AgentPhase.COMPLETE, trajectorySuccess: true, creditSuccess: true });
  });
});
