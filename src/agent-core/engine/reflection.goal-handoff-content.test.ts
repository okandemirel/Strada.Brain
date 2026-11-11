/**
 * An interactive goal handoff hands the background task the person's words, not a tool-result turn.
 *
 * The PLANNING handler reads the request twice: the text (extractLastUserMessage, which passes over
 * tool-result turns) and the content (extractLastUserContent). The content read did not pass over
 * them, so after a tool turn it returned the tool_result block and the plan-state text. A
 * tool_result is not text, so the handoff counted it as rich input: no goal tree was built, shared
 * planning was forced, and the handed-off task's fresh session opened on that content
 * (buildFreshRunSession prefers userContent to the prompt) instead of on what the person asked.
 */

import { describe, it, expect, vi } from "vitest";
import { portHandlePlanPhase, type ReflectionDeps } from "./reflection.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState } from "../../agents/agent-state.js";
import { SessionManager } from "../../agents/orchestrator-session-manager.js";
import type { PlanPhaseParams } from "../runner/orchestrator-port.js";
import type { MessageContent } from "../../agents/providers/provider-core.interface.js";
import { normalizeConversation } from "../../agents/conversation-normalizer.js";

const SAID = "build the dawn watering reminder";

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

const goalBlock =
  "```goal\n" +
  JSON.stringify({
    isGoal: true,
    estimatedMinutes: 10,
    nodes: [
      { id: "a", task: "Add the reminder schedule", dependsOn: [] },
      { id: "b", task: "Wire the reminder to the dawn event", dependsOn: ["a"] },
    ],
  }) +
  "\n```";

const toolTurn = [
  { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "file_read", input: {} }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: "## Plan State\n- step 1 pending" },
    ],
  },
] as never[];

/** `said` is the person's turn; `before` what the session held ahead of it. */
async function handoff(said: string | MessageContent[], before: never[] = [], after: never[] = toolTurn) {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("chat-1");
  session.messages.push(...before);
  sm.appendVisibleUserMessage(session, said);
  session.messages.push(...after);
  session.messages = normalizeConversation(session.messages);
  const submit = vi.fn();
  const deps = {
    sessionManager: sm,
    taskManager: () => ({ submit }),
  } as unknown as ReflectionDeps;
  const runCtx = { session, chatId: "chat-1", conversationScope: "chat-1", identityKey: "id-1" } as unknown as EngineRunContext;
  const params: PlanPhaseParams = {
    mode: "interactive",
    agentState: createInitialState(SAID),
    responseText: `Here is the plan.\n${goalBlock}`,
    providerName: "p",
    chatId: "chat-1",
    toolCallCount: 0,
  };
  expect(params.agentState.phase).toBe(AgentPhase.PLANNING);

  const result = await portHandlePlanPhase(deps, params, runCtx);
  expect(result.yield?.kind).toBe("goal_handoff");
  expect(submit).toHaveBeenCalledTimes(1);
  const [, , prompt, options] = submit.mock.calls[0]! as [string, string, string, Record<string, unknown>];
  return { prompt, options };
}

describe("the interactive goal handoff after a tool turn", () => {
  it("submits the person's content and builds the goal tree", async () => {
    const { prompt, options } = await handoff(SAID);
    expect(prompt).toBe(SAID);
    expect(options["userContent"]).toBe(SAID);
    expect(options["forceSharedPlanning"]).toBeUndefined();
    expect(options["goalTree"]).toBeDefined();
    expect(JSON.stringify(options)).not.toContain("Plan State");
  });

  it("after a call that never answered: the person's words folded into its answer, and a goal tree", async () => {
    // The normalizer answers the dangling call and folds the person's message into that answer.
    const dangling = [
      { role: "user", content: "an earlier request" },
      { role: "assistant", content: "", tool_calls: [{ id: "t0", name: "file_read", input: {} }] },
    ] as never[];
    const { prompt, options } = await handoff(SAID, dangling, []);
    expect(prompt).toBe(SAID);
    expect(options["userContent"]).toEqual([{ type: "text", text: SAID }]);
    expect(options["forceSharedPlanning"]).toBeUndefined();
    expect(options["goalTree"]).toBeDefined();
  });

  it("the person's own image is still rich input: shared planning, their content, no goal tree", async () => {
    const said: MessageContent[] = [
      { type: "text", text: SAID },
      { type: "image", source: { type: "url", url: "https://example.com/greenhouse.png" } } as MessageContent,
    ];
    const { prompt, options } = await handoff(said);
    expect(prompt).toBe(SAID);
    expect(options["userContent"]).toEqual(said);
    expect(options["forceSharedPlanning"]).toBe(true);
    expect(options["goalTree"]).toBeUndefined();
  });
});
