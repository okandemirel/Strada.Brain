/**
 * ORC-5 — the tool turn answers the assistant's tool_use with ONE user message whose leading
 * blocks are the tool_result blocks. The consensus objection and the reflection prompt used to
 * sit before the results (as a separate user message, or as leading text blocks), which
 * Anthropic rejects and which the OpenAI-compatible repair turned into "no result was recorded"
 * — telling the model its (possibly destructive) calls never ran.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../agents/orchestrator-loop-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/orchestrator-loop-shared.js")>()),
  runConsensusIfAvailable: vi.fn(async () => ({ agreed: false, reasoning: "the edit targets the wrong file" })),
}));

import { portExecuteToolTurn, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState, transitionPhase } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { ConversationMessage, MessageContent, ToolCall, ToolResult } from "../../agents/providers/provider-core.interface.js";

const TOOL_CALLS = [
  { id: "tc-1", name: "file_read", input: {} },
  { id: "tc-2", name: "file_write", input: {} },
] as unknown as ToolCall[];

function deps(): ToolTurnDeps {
  return {
    sessionManager: { extractLastUserMessage: () => "fix the build" },
    executeToolCalls: async (_c: string, calls: ToolCall[]): Promise<ToolResult[]> =>
      calls.map((tc) => ({ toolCallId: tc.id, content: `${tc.name} ok` })),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    // Truthy managers so STEP D runs (the verdict itself is mocked above).
    consensusManager: {},
    confidenceEstimator: {},
    providerRouter: {},
    providerManager: {},
    taskClassifier: {},
    getSupervisorRoutingContext: () => ({}),
    currentSessionInstinctIds: new Map(),
    propagateInstinctIdsToChannel: vi.fn(),
  } as unknown as ToolTurnDeps;
}

function runCtx(session: { messages: ConversationMessage[] }): EngineRunContext {
  const bundle = createAutonomyBundle({ prompt: "fix the build", iterationBudget: 20 });
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
    joinsParentEpisode: true, // no plain-loop monitor step
    memoryRefresher: null,
    plainLoopStepIndex: 0,
  } as unknown as EngineRunContext;
}

describe("the tool turn answers tool_use first (ORC-5)", () => {
  it("tool results lead the answer; the consensus objection and reflection prompt follow in the same turn", async () => {
    const session = { messages: [{ role: "user", content: "fix the build" }] as ConversationMessage[] };
    // Enough consequential history that this turn enters REFLECTING (the reflection prompt is
    // one of the text blocks that used to precede the results).
    const state = transitionPhase(createInitialState("fix the build"), AgentPhase.EXECUTING);

    await portExecuteToolTurn(deps(), [TOOL_CALLS, undefined, { ...state, consequentialStepCount: 2 }, ""], runCtx(session));

    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const answer = session.messages[2]!.content as MessageContent[];
    expect(answer.slice(0, 2)).toEqual([
      { type: "tool_result", tool_use_id: "tc-1", content: "file_read ok", is_error: undefined },
      { type: "tool_result", tool_use_id: "tc-2", content: "file_write ok", is_error: undefined },
    ]);
    const texts = answer.slice(2).map((b) => (b.type === "text" ? b.text : `<${b.type}>`));
    expect(texts.some((t) => t.startsWith("[CONSENSUS REVIEWER OBJECTION]"))).toBe(true);
    expect(answer.slice(2).every((b) => b.type === "text")).toBe(true);
  });
});
