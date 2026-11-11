/**
 * The text the system puts on a tool-result turn is not what the user last said.
 *
 * After a tool batch the tool turn pushes a user-role turn: the tool results, then gate notes,
 * the plan-state injection and, in the reflection phase, the reflection prompt
 * (buildToolResultContentBlocks). The session manager's last-user-message read returned that
 * text, so the readers that still use it mid-run (the interactive memory-refresh query, the
 * interactive PLANNING/REPLANNING handler, proactive decomposition) worked from the system's own
 * prompt instead of the request. A worker session holds no user turn, so the read is "" and the
 * reviewers fall back to the task description; an interactive one returns the person's words.
 */

import { describe, it, expect, vi } from "vitest";
import { portExecuteToolTurn, type ToolTurnDeps } from "./tool-turn.js";
import { buildReflectionCoreContext, type ReflectionDeps } from "./reflection.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState, transitionPhase } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import { SessionManager } from "../../agents/orchestrator-session-manager.js";
import { RecallLedger } from "../../agents/recall-ledger.js";
import type { ToolCall, ToolResult } from "../../agents/providers/provider-core.interface.js";

const TASK = "Add a watering reminder to the greenhouse planner";
const SAID = "make the reminder fire at dawn";
const REFLECTION_HEADER = "## Reflection Phase";

function sessionManager(): SessionManager {
  return new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
}

function setup(mode: "background" | "interactive") {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("chat-1");
  if (mode === "interactive") sm.appendVisibleUserMessage(session, SAID);
  const bundle = createAutonomyBundle({ prompt: TASK, iterationBudget: 20 });
  const queries: string[] = [];
  const runCtx = {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session,
    // What setup read from this session: a worker's holds no user turn.
    requestText: mode === "interactive" ? SAID : "",
    chatId: "chat-1",
    toolExecMode: mode,
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: bundle.errorRecovery,
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: undefined,
    systemPrompt: "sys",
    identityKey: "id-1",
    lastAssignment: { providerName: "p", modelId: "m" },
    lastToolNames: [],
    progressTitle: "Task",
    joinsParentEpisode: true,
    memoryRefresher: {
      shouldRefresh: vi.fn(async (_i: number, query: string) => {
        queries.push(query);
        return { should: false };
      }),
      refresh: vi.fn(),
    },
    recallLedger: new RecallLedger(),
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;
  const taskPrompts: unknown[] = [];
  const deps = {
    sessionManager: sm,
    // Every call fails: two in a row put the run into the reflection phase.
    executeToolCalls: vi.fn(async (_c: string, calls: ToolCall[], opts?: { taskPrompt?: string }): Promise<ToolResult[]> => {
      taskPrompts.push(opts?.taskPrompt);
      return calls.map((tc) => ({ toolCallId: tc.id, content: `ENOENT: ${tc.id}`, isError: true }));
    }),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    currentSessionInstinctIds: new Map(),
  } as unknown as ToolTurnDeps;
  return { sm, session, runCtx, deps, taskPrompts, queries };
}

const batch = (n: number) =>
  [1, 2].map((k) => ({ id: `tc-${n}-${k}`, name: "file_read", input: { path: `src/part-${n}-${k}.ts` } })) as unknown as ToolCall[];

describe("the system's text on a tool-result turn is not what the user last said", () => {
  it("a worker: after a reflection-phase tool turn the read is empty and the reviewers get the task", async () => {
    const { sm, session, runCtx, deps, taskPrompts } = setup("background");
    const state = transitionPhase(createInitialState(TASK), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps, [batch(1), undefined, state, "Reading"], runCtx);
    // The reflection prompt rides on the tool-result turn just pushed.
    expect(JSON.stringify(session.messages.at(-1))).toContain(REFLECTION_HEADER);

    expect(sm.extractLastUserMessage(session)).toBe("");
    const reflectionDeps = { sessionManager: sm, buildInterventionDeps: vi.fn() } as unknown as ReflectionDeps;
    const core = buildReflectionCoreContext(reflectionDeps, runCtx, "done", undefined, 0);
    expect(core.prompt).not.toContain(REFLECTION_HEADER);

    await portExecuteToolTurn(deps, [batch(2), undefined, state, "Reading again"], runCtx);
    expect(taskPrompts).toEqual([TASK, TASK]);
  });

  it("an interactive session: the memory-refresh query after a tool turn is the person's words", async () => {
    const { sm, session, runCtx, deps, queries } = setup("interactive");
    const state = transitionPhase(createInitialState(TASK), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps, [batch(1), undefined, state, "Reading"], runCtx);
    expect(JSON.stringify(session.messages.at(-1))).toContain(REFLECTION_HEADER);

    expect(queries).toEqual([SAID]);
    expect(sm.extractLastUserMessage(session)).toBe(SAID);
  });
});
