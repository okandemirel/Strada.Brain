/**
 * What a memory refresh recalled is not what the user last said.
 *
 * The refresh appends its recall to the tool-result turn it follows (recall-ledger.ts), and the
 * session manager's last-user-message read returned the text of that turn. The step after a
 * refresh then handed the recall, not the task, to the shell reviewer ("Task: …"), the consensus
 * prompt and the end-turn handlers' ctx.prompt (verification, loop recovery, the exact-literal
 * check). A worker session holds no user turn, so the read is "" and the tool turn falls back to
 * the task description; the recall must read the same way.
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

const TASK = "Add a pause menu to the main scene";
const RECALLED = "[user] what colour should the loading bar be? [assistant] amber";

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

/** A refresher that recalls once, on the first tool turn. */
function refresher() {
  let fired = false;
  return {
    shouldRefresh: vi.fn(async () => (fired ? { should: false } : { should: true, reason: "interval" })),
    refresh: vi.fn(async () => {
      fired = true;
      return { triggered: true, newMemoryContext: RECALLED, newRagContext: "", reason: "interval", durationMs: 0, retrievalNumber: 1 };
    }),
  };
}

function setup() {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("worker-1");
  const bundle = createAutonomyBundle({ prompt: TASK, iterationBudget: 20 });
  const runCtx = {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session,
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
    lastAssignment: { providerName: "p", modelId: "m" },
    lastToolNames: [],
    progressTitle: "Task",
    joinsParentEpisode: true,
    memoryRefresher: refresher(),
    recallLedger: new RecallLedger(),
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;
  const taskPrompts: unknown[] = [];
  const deps = {
    sessionManager: sm,
    executeToolCalls: vi.fn(async (_c: string, calls: ToolCall[], opts?: { taskPrompt?: string }): Promise<ToolResult[]> => {
      taskPrompts.push(opts?.taskPrompt);
      return calls.map((tc) => ({ toolCallId: tc.id, content: `read ${tc.id}` }));
    }),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    currentSessionInstinctIds: new Map(),
  } as unknown as ToolTurnDeps;
  return { sm, session, runCtx, deps, taskPrompts };
}

const turn = (n: number) => [{ id: `tc-${n}`, name: "file_read", input: { path: `Assets/file-${n}.cs` } }] as unknown as ToolCall[];

describe("a mid-run recall is not what the user last said", () => {
  it("the tool turn after a refresh reviews against the task, and the end-turn prompt holds no recall", async () => {
    const { sm, session, runCtx, deps, taskPrompts } = setup();
    const state = transitionPhase(createInitialState(TASK), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps, [turn(1), undefined, state, "Reading the first file"], runCtx);
    // The refresh fired and its recall rides on the tool-result turn just pushed.
    expect(JSON.stringify(session.messages.at(-1))).toContain(RECALLED);

    // The end-turn handlers' ctx.prompt, had the model stopped here.
    const reflectionDeps = { sessionManager: sm, buildInterventionDeps: vi.fn() } as unknown as ReflectionDeps;
    const core = buildReflectionCoreContext(reflectionDeps, runCtx, "done", undefined, 0);
    expect(core.prompt).not.toContain(RECALLED);
    expect(core.prompt).not.toContain("strada:recall");
    expect(sm.extractLastUserMessage(session)).toBe("");

    await portExecuteToolTurn(deps, [turn(2), undefined, state, "Reading the second file"], runCtx);
    // The shell reviewer's task on the step after the refresh is the task, not the recall.
    expect(taskPrompts).toEqual([TASK, TASK]);
  });

  it("a restored recall reads the same way", () => {
    const { sm, session, runCtx } = setup();
    // A trim at the hard cap emptied the history; the restore opens a user turn of its own.
    runCtx.recallLedger.add(session.messages, `## Recalled during this task\n\n## Relevant Memory\n${RECALLED}`);
    session.messages.length = 0;
    expect(runCtx.recallLedger.restore(session.messages)).toBe(1);
    expect(JSON.stringify(session.messages)).toContain(RECALLED);
    expect(sm.extractLastUserMessage(session)).toBe("");
    expect(JSON.stringify(sm.extractLastUserContent(session))).not.toContain(RECALLED);
  });
});
