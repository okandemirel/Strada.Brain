/**
 * The history trim keeps the run's task turn (board #58).
 *
 * The trim cut by position alone. It did not know which user turn was the
 * run's task, so a plain-text gate the loop pushed after the task became the
 * head on the soft path, and, when the task was multimodal (never a soft
 * boundary) or the limit shrank (a model switch), an older chat turn became
 * the head on the hard-cap path. Either way the model's next call carried no
 * task, or an old request that read as the current one.
 *
 * A turn a person or a run request writes is now a TaskTurn (a field, set in
 * appendVisibleUserMessage and buildFreshRunSession), and the newest one stays
 * in the history on both trim paths. The mark must stay off the wire and must
 * survive a restart and compaction.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../utils/logger.js";
import { SessionManager, type Session, type SessionManagerDeps } from "./orchestrator-session-manager.js";
import { isTaskTurn, taskTurn } from "./orchestrator-session-manager-task-turn.js";
import { compactSession } from "./session-compaction.js";
import { ClaudeProvider } from "./providers/claude.js";
import { OpenAIProvider } from "./providers/openai.js";
import { OllamaProvider } from "./providers/ollama.js";
import { Orchestrator } from "./orchestrator.js";
import type { AssistantMessage, ConversationMessage, MessageContent } from "./providers/provider-core.interface.js";

const TASK = "List every ferry that leaves the north pier after six and its fare";
const OLD = "What was the bakery's opening time last spring?";
const GATE = "[VERIFIER] You said it is done, but nothing was checked. Check it.";
const IMAGE_TASK: MessageContent[] = [
  { type: "text", text: TASK },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
];

function sessionManager(): SessionManager {
  return new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as SessionManagerDeps);
}

let callSeq = 0;
function toolPair(): ConversationMessage[] {
  const id = `call-${callSeq++}`;
  return [
    { role: "assistant", content: "", tool_calls: [{ id, name: "timetable_read", input: {} }] } as ConversationMessage,
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } as ConversationMessage,
  ];
}

function textOf(msg: ConversationMessage | undefined): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** The provider contract a trimmed history must keep. */
function expectSendable(messages: readonly ConversationMessage[], max: number): void {
  expect(messages.length).toBeLessThanOrEqual(max);
  const head = messages[0]!;
  expect(head.role, "the head is a user turn").toBe("user");
  expect(Array.isArray(head.content) && head.content.some((b) => b.type === "tool_result"), "the head is no tool_result").toBe(false);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const prev = messages[i - 1] as AssistantMessage | undefined;
      expect(prev?.tool_calls?.map((c) => c.id), `tool_result at ${i} follows its tool_use`).toContain(block.tool_use_id);
    }
  }
}

/** Push turns one step at a time and trim after each step, as the run loop does. */
function runSteps(sm: SessionManager, session: Session, steps: ConversationMessage[][], max: number): number {
  let trims = 0;
  for (const step of steps) {
    session.messages.push(...step);
    if (sm.trimSession(session, max).length > 0) trims++;
    expect(session.messages.map(textOf), "the task stays in the history after every step").toContain(TASK);
    if (trims > 0) expect(textOf(session.messages[0]), "once trimmed, the task leads the history").toBe(TASK);
    expectSendable(session.messages, max * 2);
  }
  return trims;
}

function pairs(n: number): ConversationMessage[][] {
  return Array.from({ length: n }, () => toolPair());
}

describe("the trim keeps the run's task turn", () => {
  beforeAll(() => {
    createLogger("error", "test.log");
  });

  it("soft trim: a plain-text gate after the task does not become the head", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("soft");
    sm.appendVisibleUserMessage(session, TASK);
    const trims = runSteps(sm, session, [
      ...pairs(15),
      [{ role: "assistant", content: "All fares are listed." }],
      [{ role: "user", content: GATE }],
      ...pairs(15),
    ], 40);

    expect(trims, "the soft trim ran").toBeGreaterThan(0);
    expect(session.messages.length).toBeLessThanOrEqual(40);
    expect(session.messages.map(textOf), "the gate is kept too").toContain(GATE);
    expect(session.visibleMessages?.map(textOf)).toContain(TASK);
    expectSendable(session.messages, 40);
  });

  it("hard cap: after an old chat turn and an image task with 60 tool pairs, the head is the task", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("hard");
    sm.appendVisibleUserMessage(session, OLD);
    sm.appendVisibleAssistantMessage(session, "It opened at seven.");
    sm.appendVisibleUserMessage(session, IMAGE_TASK);
    const trims = runSteps(sm, session, pairs(60), 40);

    expect(trims, "the hard-cap trim ran").toBeGreaterThan(0);
    expect(session.messages[0]!.content, "the image survives with the task").toEqual(IMAGE_TASK);
    expect(session.messages.map(textOf)).not.toContain(OLD);
    expect(session.visibleMessages?.map(textOf)).not.toContain(OLD);
    expectSendable(session.messages, 80);
    expect((session.messages.at(-2) as AssistantMessage).tool_calls?.[0]?.id, "the newest pair is kept").toBe(`call-${callSeq - 1}`);
  });

  it("a limit that drops from 80 to 40 keeps the current task in one trim", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("shrink");
    sm.appendVisibleUserMessage(session, OLD);
    sm.appendVisibleAssistantMessage(session, "It opened at seven.");
    sm.appendVisibleUserMessage(session, TASK);
    for (const step of pairs(50)) session.messages.push(...step);
    expect(sm.trimSession(session, 80), "under the 80 limit's hard cap nothing is cut").toEqual([]);

    const removed = sm.trimSession(session, 40);

    expect(removed.map(textOf)).toContain(OLD);
    expect(textOf(session.messages[0])).toBe(TASK);
    expectSendable(session.messages, 40);
  });

  it("the task inside the window: the cut lands at the task at the latest, even an image task", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("inside");
    for (let i = 0; i < 10; i++) {
      sm.appendVisibleUserMessage(session, `${OLD} (${i})`);
      sm.appendVisibleAssistantMessage(session, "It opened at seven.");
    }
    sm.appendVisibleUserMessage(session, IMAGE_TASK);
    for (const step of pairs(4)) session.messages.push(...step);
    session.messages.push({ role: "user", content: GATE });
    for (const step of pairs(4)) session.messages.push(...step);

    // 38 turns, limit 19: the overflow lands on the answer right before the image task, so no
    // plain boundary precedes the task inside the window; the next one is the gate after it.
    sm.trimSession(session, 19);

    expect(session.messages[0]!.content).toEqual(IMAGE_TASK);
    expectSendable(session.messages, 19);
  });

  it("the task inside the window: only the overflow goes, the turns before the task that fit stay", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("inside-keeps");
    for (let i = 0; i < 10; i++) {
      sm.appendVisibleUserMessage(session, `${OLD} (${i})`);
      sm.appendVisibleAssistantMessage(session, "It opened at seven.");
    }
    sm.appendVisibleUserMessage(session, IMAGE_TASK);
    for (const step of pairs(4)) session.messages.push(...step);
    session.messages.push({ role: "user", content: GATE });
    for (const step of pairs(4)) session.messages.push(...step);

    // 38 turns, limit 20: the overflow (18) lands on the last old chat turn, a safe boundary.
    const removed = sm.trimSession(session, 20);

    expect(removed).toHaveLength(18);
    expect(textOf(session.messages[0])).toBe(`${OLD} (9)`);
    expect(session.messages[2]!.content).toEqual(IMAGE_TASK);
    expectSendable(session.messages, 20);
  });

  it("keeping the task in front costs one slot: the kept history still fits the limit", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("one-slot");
    sm.appendVisibleUserMessage(session, TASK);
    for (const step of pairs(10)) session.messages.push(...step);
    session.messages.push({ role: "assistant", content: "All fares are listed." }, { role: "user", content: GATE });
    for (const step of pairs(10)) session.messages.push(...step);

    // 43 turns, limit 21: the overflow (22) is exactly the gate. Task + gate onwards is 22.
    sm.trimSession(session, 21);

    expect(textOf(session.messages[0])).toBe(TASK);
    expectSendable(session.messages, 21);
  });

  it("a history with no task turn trims as before: the first safe boundary after the overflow", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("unmarked");
    session.messages.push({ role: "user", content: TASK });
    for (const step of pairs(15)) session.messages.push(...step);
    session.messages.push({ role: "user", content: GATE });
    for (const step of pairs(15)) session.messages.push(...step);

    sm.trimSession(session, 40);

    expect(textOf(session.messages[0])).toBe(GATE);
  });
});

describe("the task-turn mark", () => {
  it("is set on the turns a person writes and on a background run's request", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("mark");
    sm.appendVisibleUserMessage(session, TASK);
    expect(isTaskTurn(session.messages[0]!)).toBe(true);

    const build = (Orchestrator.prototype as unknown as {
      buildFreshRunSession(request: object, queryText: string, supportsVision: boolean): Session;
    }).buildFreshRunSession;
    const fresh = build.call(null, {}, TASK, false);
    expect(fresh.messages[0]).toMatchObject({ role: "user", content: TASK });
    expect(isTaskTurn(fresh.messages[0]!)).toBe(true);
  });

  it("survives a restart", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("restart");
    sm.appendVisibleUserMessage(session, OLD);
    sm.appendVisibleAssistantMessage(session, "It opened at seven.");
    sm.appendVisibleUserMessage(session, IMAGE_TASK);
    for (const step of pairs(3)) session.messages.push(...step);

    const restored = SessionManager.deserializeSession(SessionManager.serializeSession(session))!;

    expect(restored.messages.filter(isTaskTurn).map(textOf)).toEqual([OLD, TASK]);
  });

  it("survives compaction, the task turn kept whole or cut", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(taskTurn(`${OLD} ${i} ${"x".repeat(400)}`), { role: "assistant", content: `answer ${i} ${"y".repeat(400)}` });
    }
    messages.push(taskTurn(TASK), { role: "assistant", content: "Reading the timetable." });
    for (const maxTokens of [600, 40]) {
      const result = compactSession(messages, { maxTokens, preserveRecent: 4 });
      expect(result.compacted).toBe(true);
      const newestUser = result.messages.filter((m) => m.role === "user").at(-1)!;
      expect(isTaskTurn(newestUser), `the kept task turn is still marked at ${maxTokens} tokens`).toBe(true);
      // At 40 tokens the turn is cut to its truncation marker; at 600 it keeps its words.
      if (maxTokens === 600) expect(textOf(newestUser).startsWith(TASK.slice(0, 20))).toBe(true);
    }
  });

  it("never reaches a provider's request", () => {
    const messages: ConversationMessage[] = [taskTurn(TASK), { role: "assistant", content: "On it." }, taskTurn(IMAGE_TASK)];
    const wire = [
      (new ClaudeProvider("test-key") as unknown as { buildMessages: (m: ConversationMessage[]) => unknown }).buildMessages(messages),
      (new OpenAIProvider("sk-test") as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown }).buildMessages("sys", messages),
      (new OllamaProvider() as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown }).buildMessages("sys", messages),
    ];
    for (const request of wire) {
      expect(JSON.stringify(request)).toContain(TASK);
      expect(JSON.stringify(request)).not.toContain("taskTurn");
    }
  });
});
