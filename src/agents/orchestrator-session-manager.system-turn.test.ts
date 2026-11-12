/**
 * A gate or replan prompt the system pushes as a plain-text user turn is
 * marked (pushSystemTurn), and the reads of what the user last said pass over
 * it. The mark is a field on the message, so it must survive what the history
 * goes through — a restart (serializeSession / deserializeSession) and
 * compaction — and must not reach a provider's request.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./orchestrator-session-manager.js";
import { isSystemTurn, pushSystemTurn } from "./orchestrator-session-manager-last-user.js";
import { compactSession } from "./session-compaction.js";
import { isTaskTurn } from "./orchestrator-session-manager-task-turn.js";
import { ClaudeProvider } from "./providers/claude.js";
import { OpenAIProvider } from "./providers/openai.js";
import { OllamaProvider } from "./providers/ollama.js";
import type { ConversationMessage } from "./providers/provider-core.interface.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const SAID = "move the export button to the settings tab";
const GATE = "[LOOP RECOVERY] Stop restating the plan; open the file and change it.";

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

function sessionWithGate() {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, SAID);
  session.messages.push({ role: "assistant", content: "Here is my plan again: …" });
  pushSystemTurn(session.messages, GATE);
  return { sm, session };
}

describe("a system turn is not what the user last said", () => {
  it("the gate is the last user-role turn; both reads return the person's words", () => {
    const { sm, session } = sessionWithGate();
    expect(session.messages.at(-1)).toMatchObject({ role: "user", content: GATE });
    expect(sm.extractLastUserMessage(session)).toBe(SAID);
    expect(sm.extractLastUserContent(session)).toBe(SAID);
  });

  it("a session holding only system turns reads empty", () => {
    const sm = sessionManager();
    const session = sm.getOrCreateSession("chat-2");
    pushSystemTurn(session.messages, GATE);
    expect(sm.extractLastUserMessage(session)).toBe("");
  });

  it("the mark survives a restart", () => {
    const { session } = sessionWithGate();
    const restored = SessionManager.deserializeSession(SessionManager.serializeSession(session))!;
    expect(isSystemTurn(restored.messages.at(-1)!)).toBe(true);
    expect(sessionManager().extractLastUserMessage(restored)).toBe(SAID);
  });

  it("the mark survives compaction, the turn kept whole or cut", () => {
    const { session } = sessionWithGate();
    const filler: ConversationMessage[] = [];
    for (let i = 0; i < 30; i++) {
      filler.push({ role: "user", content: `older question ${i} ${"x".repeat(400)}` });
      filler.push({ role: "assistant", content: `older answer ${i} ${"y".repeat(400)}` });
    }
    const messages = [...filler, ...session.messages];
    for (const maxTokens of [600, 40]) {
      const result = compactSession(messages, { maxTokens, preserveRecent: 4 });
      expect(result.compacted).toBe(true);
      const gateTurn = result.messages.at(-1)!;
      expect(isSystemTurn(gateTurn)).toBe(true);
      // The person's turn is the run's task: compaction keeps it beside the gate (board #63).
      const said = result.messages.filter((m) => isTaskTurn(m));
      expect(said).toHaveLength(1);
      if (maxTokens === 600) {
        expect(String(gateTurn.content).startsWith(GATE.slice(0, 10))).toBe(true);
        expect(said[0]!.content).toBe(SAID);
      } else {
        // 40 tokens is shared by the two pinned turns: both are cut to the marker, neither dropped.
        expect(String(gateTurn.content)).toContain("truncated to fit the context window");
        expect(String(said[0]!.content)).toContain("truncated to fit the context window");
      }
    }
  });

  it("the mark never reaches a provider's request", () => {
    const { session } = sessionWithGate();
    const wire = [
      (new ClaudeProvider("test-key") as unknown as { buildMessages: (m: ConversationMessage[]) => unknown }).buildMessages(session.messages),
      (new OpenAIProvider("sk-test") as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown }).buildMessages("sys", session.messages),
      (new OllamaProvider() as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown }).buildMessages("sys", session.messages),
    ];
    for (const request of wire) {
      expect(JSON.stringify(request)).toContain(GATE);
      expect(JSON.stringify(request)).not.toContain("systemTurn");
    }
  });
});
