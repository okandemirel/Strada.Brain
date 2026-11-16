/**
 * #69: the normalizer now leaves a person's turn as its own user turn right after a tool answer,
 * so a request can hold two user turns in a row. This measures what each adapter family sends
 * for that shape: Anthropic, the OpenAI-compatible chat adapters, and Gemini (which speaks the
 * OpenAI-compatible endpoint). The person's text and the gate note stay apart in the session
 * whatever the wire does, because every adapter builds its request from a copy and leaves the
 * session messages as they were.
 */

import { describe, it, expect, vi } from "vitest";
import { ClaudeProvider } from "./providers/claude.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { normalizeConversation } from "./conversation-normalizer.js";
import { taskTurn } from "./orchestrator-session-manager-task-turn.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function session(): ConversationMessage[] {
  return normalizeConversation([
    taskTurn("old request"),
    { role: "assistant", content: "done" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_a", name: "file_read", input: {} }] },
    taskTurn("new request"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }, { type: "text", text: "[VERIFY] gate" }] },
  ]);
}

type WireBuilder = { buildMessages(...args: unknown[]): unknown[] };

describe("two user turns in a row after a tool answer, per provider adapter (#69)", () => {
  it("the session holds the answer and then the person's turn", () => {
    expect(session().slice(-2).map((m) => m.content)).toEqual([
      [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }, { type: "text", text: "[VERIFY] gate" }],
      "new request",
    ]);
  });

  it("Anthropic: the result turn and the person's turn go out as two user messages; the session is untouched", () => {
    const messages = session();
    const before = JSON.stringify(messages);
    const wire = (new ClaudeProvider("test-key") as unknown as WireBuilder).buildMessages(messages);
    expect(wire.slice(-3)).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: expect.any(String), name: "file_read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: expect.any(String), content: "ok", is_error: undefined },
        { type: "text", text: "[VERIFY] gate" },
      ] },
      { role: "user", content: "new request" },
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  for (const [name, make] of [
    ["OpenAI-compatible", () => new OpenAIProvider("test-key")],
    ["Gemini", () => new GeminiProvider("test-key")],
  ] as const) {
    it(`${name}: the tool message, the gate note and the person's text are three messages; the session is untouched`, () => {
      const messages = session();
      const before = JSON.stringify(messages);
      const wire = (make() as unknown as WireBuilder).buildMessages("System", messages) as Array<{ role: string; content?: unknown }>;
      expect(wire.slice(-3).map((m) => [m.role, m.content])).toEqual([
        ["tool", "ok"],
        ["user", "[VERIFY] gate"],
        ["user", "new request"],
      ]);
      expect(JSON.stringify(messages)).toBe(before);
    });
  }
});
