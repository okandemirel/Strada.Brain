/**
 * PRV-7: tool-call ids crossed providers verbatim. Some are illegal for the
 * fallback target (Kimi's `functions.read_file:0` for Anthropic's
 * `^[a-zA-Z0-9_-]+$`; anything but nine alphanumerics for Mistral), and Ollama
 * restarted its ids at `ollama-tc-0` every turn, so a history held duplicates.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const FOREIGN: ConversationMessage[] = [
  { role: "user", content: "read both" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "functions.read_file:0", name: "file_read", input: { path: "a.cs" } },
      { id: "functions.read_file:1", name: "file_read", input: { path: "b.cs" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "functions.read_file:0", content: "A" },
      { type: "tool_result", tool_use_id: "functions.read_file:1", content: "B" },
    ],
  },
];

describe("Claude receives legal, still-paired tool ids", () => {
  it("maps a Kimi-style id on the tool_use and its tool_result alike", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
    const { ClaudeProvider } = await import("./claude.js");
    await new ClaudeProvider("k").chat("sys", FOREIGN, []);
    vi.doUnmock("@anthropic-ai/sdk");

    const sent = (create.mock.calls[0] as unknown as [{ messages: Array<{ content: Array<Record<string, string>> }> }])[0].messages;
    const useIds = sent[1]!.content.filter((b) => b["type"] === "tool_use").map((b) => b["id"]!);
    const resultIds = sent[2]!.content.filter((b) => b["type"] === "tool_result").map((b) => b["tool_use_id"]!);
    for (const id of useIds) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(new Set(useIds).size).toBe(2);
    expect(resultIds).toEqual(useIds);
  });
});

describe("Mistral receives nine-alphanumeric, still-paired tool ids", () => {
  it("maps foreign ids on the call and on the tool message alike", async () => {
    const { MistralProvider } = await import("./mistral.js");
    const built = (new MistralProvider("k") as unknown as {
      buildMessages: (s: string, m: ConversationMessage[]) => Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    }).buildMessages("sys", FOREIGN);

    const callIds = built.flatMap((m) => m.tool_calls?.map((tc) => tc.id) ?? []);
    const resultIds = built.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(callIds).toHaveLength(2);
    for (const id of callIds) expect(id).toMatch(/^[a-zA-Z0-9]{9}$/u);
    expect(new Set(callIds).size).toBe(2);
    expect(resultIds).toEqual(callIds);
  });
});

describe("Ollama tool-call ids", () => {
  it("are unique across turns, not restarted per response", async () => {
    const { OllamaProvider } = await import("./ollama.js");
    const parse = (p: InstanceType<typeof OllamaProvider>) =>
      (p as unknown as { parseResponse: (d: unknown) => { toolCalls: Array<{ id: string }> } }).parseResponse({
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "file_read", arguments: { path: "a" } } }] },
        done: true,
      });
    const provider = new OllamaProvider("llama3.3");
    const first = parse(provider).toolCalls[0]!.id;
    const second = parse(provider).toolCalls[0]!.id;
    expect(first).not.toBe(second);
  });
});
