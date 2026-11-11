/**
 * The consensus reviewer judges a critical step against the run's request.
 *
 * The tool turn read the request as the session's last user-role message. After the first tool
 * turn that is the tool-result turn, whose only text is a tool result or a gate note, so from the
 * second turn on the consensus reviewer was told the request was "" or "[VERIFY] …" (measured
 * 2026-11-06 in the golden run, where the visibility review read the same value). The request is
 * pinned once at setup (EngineRunContext.requestText).
 */

import { describe, it, expect, vi } from "vitest";
import { portExecuteToolTurn, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState, transitionPhase } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import { SessionManager } from "../../agents/orchestrator-session-manager.js";
import { RecallLedger } from "../../agents/recall-ledger.js";
import type { ToolCall, ToolResult } from "../../agents/providers/provider-core.interface.js";

const TASK = "Write docs/greenhouse.md describing the watering schedule";

function setup() {
  const sm = new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
  // A worker's fresh session: the task is its one user turn.
  const session = { messages: [{ role: "user", content: TASK }], visibleMessages: [], lastActivity: new Date() };
  const bundle = createAutonomyBundle({ prompt: TASK, iterationBudget: 20 });
  const current = { providerName: "worker-seat", modelId: "m" };
  const runCtx = {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session,
    requestText: TASK,
    chatId: "worker-1",
    toolExecMode: "background",
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: bundle.errorRecovery,
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: undefined,
    systemPrompt: "sys",
    identityKey: "id-1",
    executionStrategy: { reviewer: { providerName: "review-seat", modelId: "r" } },
    lastAssignment: current,
    lastToolNames: [],
    progressTitle: "Task",
    joinsParentEpisode: true,
    memoryRefresher: null,
    recallLedger: new RecallLedger(),
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;

  const consensusPrompts: string[] = [];
  const reviewer = { name: "review-seat" };
  const deps = {
    sessionManager: sm,
    executeToolCalls: vi.fn(async (_c: string, calls: ToolCall[]): Promise<ToolResult[]> =>
      calls.map((tc) => ({ toolCallId: tc.id, content: `wrote ${String(tc.input["path"])}` }))),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    currentSessionInstinctIds: new Map(),
    taskClassifier: {
      classify: () => ({ type: "code-generation", complexity: "simple", criticality: "critical" }),
    },
    confidenceEstimator: { estimate: () => 0.2 },
    consensusManager: {
      shouldConsult: () => "review",
      verify: vi.fn(async (p: { prompt: string }) => {
        consensusPrompts.push(p.prompt);
        return { agreed: true, strategy: "review", reasoning: "fine" };
      }),
    },
    providerRouter: {},
    providerManager: {
      listAvailable: () => [{ name: "worker-seat" }, reviewer],
      getPrimaryProviderByName: () => reviewer,
    },
    getSupervisorRoutingContext: () => ({
      providerManager: {
        listAvailable: () => [{ name: "worker-seat" }, reviewer],
        getPrimaryProviderByName: () => reviewer,
      },
    }),
    resolveTaskRunId: () => undefined,
  } as unknown as ToolTurnDeps;
  return { sm, session, runCtx, deps, consensusPrompts };
}

const write = (n: number) =>
  [{ id: `tc-${n}`, name: "file_write", input: { path: `docs/part-${n}.md`, content: "x" } }] as unknown as ToolCall[];

describe("the consensus step reads the run's request", () => {
  it("on the turn after a tool turn, the reviewer is given the request, not the tool-result turn", async () => {
    const { sm, session, runCtx, deps, consensusPrompts } = setup();
    const state = transitionPhase(createInitialState(TASK), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps, [write(1), undefined, state, "Writing the first part"], runCtx);
    // What the session's last user-role message holds now: not the request.
    expect(session.messages.length).toBeGreaterThan(1);
    expect(sm.extractLastUserContent(session as never)).not.toBe(TASK);

    await portExecuteToolTurn(deps, [write(2), undefined, state, "Writing the second part"], runCtx);
    expect(consensusPrompts).toEqual([TASK, TASK]);
  });
});
