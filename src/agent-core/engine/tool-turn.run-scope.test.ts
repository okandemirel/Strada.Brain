/**
 * The tool turn hands the run's scope on to its tools. A /cancel stopped at the spine: a
 * delegate or swarm call it was waiting on had no signal, so its sub-agents ran on to their
 * own timeouts, each spending out of the global headroom rather than the run's budget.
 */

import { describe, it, expect, vi } from "vitest";
import { portExecuteToolTurn, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import type { ParentRunScope } from "../runner/agent-runner.js";
import { createBudget } from "../control/budget.js";
import { AgentPhase, createInitialState, transitionPhase } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { ConversationMessage, ToolCall, ToolResult } from "../../agents/providers/provider-core.interface.js";

const TOOL_CALLS = [{ id: "tc-1", name: "swarm_tasks", input: {} }] as unknown as ToolCall[];

function deps(executeToolCalls: ToolTurnDeps["executeToolCalls"]): ToolTurnDeps {
  return {
    sessionManager: { extractLastUserMessage: () => "build the level" },
    executeToolCalls,
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    currentSessionInstinctIds: new Map(),
  } as unknown as ToolTurnDeps;
}

function runCtx(session: { messages: ConversationMessage[] }): EngineRunContext {
  const bundle = createAutonomyBundle({ prompt: "build the level", iterationBudget: 20 });
  return {
    iterationHealth: new IterationHealthTracker(Date.now()),
    session,
    chatId: "chat-1",
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
    memoryRefresher: null,
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;
}

describe("the tool turn hands the run's scope to its tools", () => {
  it("passes the run's cancel signal and budget/clock scope into tool execution", async () => {
    const controller = new AbortController();
    const scope: ParentRunScope = {
      signal: controller.signal,
      budget: createBudget(1_000, 1),
      clockView: { now: () => 0, remainingTaskMs: () => Number.POSITIVE_INFINITY },
    };
    const seen: Array<Record<string, unknown> | undefined> = [];
    const execute = vi.fn(async (_c: string, calls: ToolCall[], opts?: object): Promise<ToolResult[]> => {
      seen.push(opts as Record<string, unknown> | undefined);
      return calls.map((tc) => ({ toolCallId: tc.id, content: "ok" }));
    });
    const session = { messages: [{ role: "user", content: "build the level" }] as ConversationMessage[] };
    const state = transitionPhase(createInitialState("build the level"), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps(execute), [TOOL_CALLS, undefined, state, "", scope], runCtx(session));

    expect(seen[0]?.["signal"]).toBe(controller.signal);
    expect(seen[0]?.["parentRun"]).toBe(scope);
  });
});
