/**
 * PRV-8: only the chat-completions adapters repaired broken tool-call pairs.
 * Claude, the Codex `/responses` input and Ollama forwarded a history that had
 * lost a result (or kept a result whose call was compacted away), and every
 * replay of that session was rejected with a 400.
 */
import { describe, expect, it, vi } from "vitest";
import { repairConversationToolPairing } from "./tool-pairing.js";
import type { ConversationMessage, MessageContent } from "./provider-core.interface.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const call = (id: string) => ({ id, name: "file_read", input: { path: `${id}.cs` } });
const result = (id: string, content = "ok"): MessageContent => ({ type: "tool_result", tool_use_id: id, content });

/** A dangling call: the run aborted before its result was recorded. */
const DANGLING: ConversationMessage[] = [
  { role: "user", content: "read both" },
  { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
  { role: "user", content: [result("a")] },
  { role: "user", content: "and then?" },
];

describe("repairConversationToolPairing", () => {
  it("answers a call whose result never arrived with an error result", () => {
    const repaired = repairConversationToolPairing(DANGLING);
    const answer = repaired[2] as { content: MessageContent[] };
    expect(answer.content).toEqual([
      result("a"),
      expect.objectContaining({ type: "tool_result", tool_use_id: "b", is_error: true }),
    ]);
  });

  it("adds the answer turn when the call was the last thing in the history", () => {
    const repaired = repairConversationToolPairing([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [call("a")] },
    ]);
    expect(repaired).toHaveLength(3);
    expect((repaired[2] as { content: MessageContent[] }).content[0]).toMatchObject({ tool_use_id: "a", is_error: true });
  });

  it("folds a result whose call is gone into text, keeping what it said", () => {
    const repaired = repairConversationToolPairing([
      { role: "user", content: [result("gone", "found 3 files"), { type: "text", text: "continue" }] },
    ]);
    const content = (repaired[0] as { content: MessageContent[] }).content;
    expect(content.some((b) => b.type === "tool_result")).toBe(false);
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("found 3 files") });
  });

  it("puts results first, in call order, ahead of the user's text in the same turn", () => {
    const repaired = repairConversationToolPairing([
      { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "user", content: [{ type: "text", text: "note" }, result("b"), result("a")] },
    ]);
    const content = (repaired[1] as { content: MessageContent[] }).content;
    expect(content.map((b) => (b.type === "tool_result" ? b.tool_use_id : b.type))).toEqual(["a", "b", "text"]);
  });

  it("leaves a history with no tool calls untouched", () => {
    const plain: ConversationMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(repairConversationToolPairing(plain)).toEqual(plain);
  });
});

describe("adapters send paired history", () => {
  it("Claude: a dangling tool_use gets a synthetic is_error tool_result", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
    const { ClaudeProvider } = await import("./claude.js");
    await new ClaudeProvider("k").chat("sys", DANGLING, []);
    vi.doUnmock("@anthropic-ai/sdk");

    const sent = (create.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: unknown }> }])[0].messages;
    const answer = sent[2]!.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(answer).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", tool_use_id: "b", is_error: true }),
    ]));
  });

  it("Codex /responses: every function_call has a function_call_output", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const provider = new OpenAIProvider({ mode: "chatgpt-subscription", accessToken: "t", accountId: "a" });
    const input = (provider as unknown as { buildChatGptInput: (m: ConversationMessage[]) => Array<Record<string, unknown>> })
      .buildChatGptInput(DANGLING);
    const calls = input.filter((i) => i["type"] === "function_call").map((i) => i["call_id"]);
    const outputs = input.filter((i) => i["type"] === "function_call_output").map((i) => i["call_id"]);
    expect(calls).toEqual(["a", "b"]);
    expect(outputs).toEqual(["a", "b"]);
  });
});
