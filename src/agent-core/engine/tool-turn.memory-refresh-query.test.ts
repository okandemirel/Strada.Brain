/**
 * The interactive memory refresh asks memory about the run's request.
 *
 * The interactive tool turn passed the refresher the session's last user-role message. That
 * read happens after the tool-result turn is pushed, so from the first tool turn on the query
 * was that turn's text: "" for a plain tool result, or a gate note such as "[VERIFY] …".
 * Drift detection and re-retrieval then ran against that text, not against what the user
 * asked. The background route already pinned its query; the interactive route now reads the
 * request pinned at setup (EngineRunContext.requestText), as the reviewers do.
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

const REQUEST = "Add a watering reminder to the greenhouse planner";

function setup() {
  const sm = new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
  // An interactive chat: the user's message is the session's one user turn.
  const session = { messages: [{ role: "user", content: REQUEST }], visibleMessages: [], lastActivity: new Date() };
  const bundle = createAutonomyBundle({ prompt: REQUEST, iterationBudget: 20 });
  const queries: string[] = [];
  const memoryRefresher = {
    shouldRefresh: vi.fn(async (_iteration: number, queryContext: string) => {
      queries.push(queryContext);
      return { should: false };
    }),
    refresh: vi.fn(),
  };
  const runCtx = {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session,
    requestText: REQUEST,
    chatId: "chat-1",
    toolExecMode: "interactive",
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: bundle.errorRecovery,
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: undefined,
    systemPrompt: "sys",
    identityKey: "id-1",
    executionStrategy: {},
    lastAssignment: { providerName: "chat-seat", modelId: "m" },
    lastToolNames: [],
    progressTitle: "Task",
    joinsParentEpisode: false,
    memoryRefresher,
    recallLedger: new RecallLedger(),
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;

  const deps = {
    sessionManager: sm,
    executeToolCalls: vi.fn(async (_c: string, calls: ToolCall[]): Promise<ToolResult[]> =>
      calls.map((tc) => ({ toolCallId: tc.id, content: `read ${String(tc.input["path"])}` }))),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    currentSessionInstinctIds: new Map(),
    taskClassifier: {
      classify: () => ({ type: "analysis", complexity: "simple", criticality: "low" }),
    },
    confidenceEstimator: { estimate: () => 0.9 },
    consensusManager: { shouldConsult: () => "skip", verify: vi.fn() },
    providerRouter: {},
    providerManager: { listAvailable: () => [], getPrimaryProviderByName: () => undefined },
    getSupervisorRoutingContext: () => ({
      providerManager: { listAvailable: () => [], getPrimaryProviderByName: () => undefined },
    }),
    getTaskExecutionContext: () => undefined,
    resolveTaskRunId: () => undefined,
  } as unknown as ToolTurnDeps;
  return { sm, session, runCtx, deps, queries };
}

const read = (n: number) =>
  [{ id: `tc-${n}`, name: "file_read", input: { path: `src/planner-${n}.ts` } }] as unknown as ToolCall[];

describe("the interactive memory refresh reads the run's request", () => {
  it("every tool turn asks memory about the request, not the tool-result turn", async () => {
    const { sm, session, runCtx, deps, queries } = setup();
    const state = transitionPhase(createInitialState(REQUEST), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps, [read(1), undefined, state, "Reading the planner"], runCtx);
    // What the session's last user-role message says now: the tool-result turn, not the request.
    expect(sm.extractLastUserMessage(session as never)).not.toBe(REQUEST);

    await portExecuteToolTurn(deps, [read(2), undefined, state, "Reading the second file"], runCtx);
    expect(queries).toEqual([REQUEST, REQUEST]);
  });
});
