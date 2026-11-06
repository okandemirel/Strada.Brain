/**
 * silentStream sends the turn context after the history and never stores it, on every path a
 * worker turn can take: the RunClock stream, the v1 stream, STREAMING_ENABLED=false (chat()) and
 * the non-streaming retry after a stream error. The system prompt it is handed goes out as is,
 * so it stays the same bytes from call to call and the provider's prefix cache reaches the
 * history (turn-context.ts). The "Provider call" line names the context's size apart from the
 * prompt and the history, so the offline replay counts it as neither.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { ConversationMessage, ProviderResponse } from "./providers/provider.interface.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { openRunClock, type RunClock } from "../agent-core/control/run-clock.js";
import type { RunBudgetPolicy } from "../agent-core/control/policy.js";

const logged = vi.hoisted(() => [] as Array<{ message: string; fields: Record<string, unknown> }>);

vi.mock("../utils/logger.js", () => {
  const logger = {
    info: vi.fn((message: string, fields: Record<string, unknown> = {}) => void logged.push({ message, fields })),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { getLogger: () => logger, getLoggerSafe: () => logger, getLogRingBuffer: () => [] };
});

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const SYSTEM = "The run's system prompt.";
const CONTEXT = "[Turn context]\n\n## Current Plan\n1. write a\n\nCurrent iteration: 4";

function answer(): ProviderResponse {
  return { text: "ok", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20 } };
}

function createProvider(name: string) {
  return {
    name,
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      thinkingSupported: false,
    },
    chat: vi.fn(async (_system: string, _messages: ConversationMessage[]): Promise<ProviderResponse> => answer()),
    chatStream: vi.fn(async (
      _system: string,
      _messages: ConversationMessage[],
      _tools: unknown,
      onChunk: (chunk: string) => void,
    ): Promise<ProviderResponse> => {
      onChunk("ok");
      return answer();
    }),
  };
}

type SilentStream = (
  chatId: string, systemPrompt: string, session: { messages: ConversationMessage[] }, provider: unknown,
  tools: unknown[], externalSignal?: AbortSignal, onLiveness?: () => void, runClock?: RunClock, turnContext?: string,
) => Promise<ProviderResponse>;

function setup(name: string, streamingEnabled: boolean) {
  const clock = new FakeClock(0);
  const provider = createProvider(name);
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getActiveInfo: () => ({ providerName: provider.name, model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { name: "mock", onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: clock,
    streamingEnabled,
  });
  const silentStream = (orch as unknown as { silentStream: SilentStream }).silentStream;
  const policy: RunBudgetPolicy = {
    mode: "background",
    taskHardMs: Number.POSITIVE_INFINITY,
    taskInactivityMs: 1_800_000,
    callFirstResponseMs: 600_000,
    callStallMs: 300_000,
    callHardMs: 600_000,
    outputTokenCap: Number.POSITIVE_INFINITY,
    costCapUsd: Number.POSITIVE_INFINITY,
  };
  return { provider, silentStream, runClock: openRunClock(clock, policy) };
}

const history = (): ConversationMessage[] => [
  { role: "user", content: "Write a.txt" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "file_write", input: { path: "a.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "File written: a.txt" }] },
];

/** What a call sent: its system prompt and the last user turn's blocks. */
function sent(call: unknown[] | undefined): { system: unknown; messages: ConversationMessage[] } {
  return { system: call?.[0], messages: call?.[1] as ConversationMessage[] };
}

function expectContextSentNotStored(call: unknown[] | undefined, session: { messages: ConversationMessage[] }): void {
  const { system, messages } = sent(call);
  expect(system).toBe(SYSTEM);
  expect(messages.slice(0, 2)).toEqual(history().slice(0, 2));
  expect(messages.at(-1)).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "c1", content: "File written: a.txt" },
      { type: "text", text: CONTEXT },
    ],
  });
  expect(session.messages).toEqual(history());
}

describe("silentStream: the turn context is sent after the history and never stored", () => {
  afterEach(() => {
    logged.length = 0;
    vi.clearAllMocks();
  });

  it("the RunClock stream sends it, keeps the prompt, and logs its size apart from prompt and history", async () => {
    const { provider, silentStream, runClock } = setup("tc-runclock", true);
    const session = { messages: history() };
    await silentStream("chat-1", SYSTEM, session, provider, [], undefined, undefined, runClock, CONTEXT);

    expectContextSentNotStored(provider.chatStream.mock.calls[0], session);
    const line = logged.find((l) => l.message === "Provider call" && l.fields.label === "turn");
    expect(line?.fields).toMatchObject({
      chatId: "chat-1",
      promptChars: SYSTEM.length,
      messages: 3,
      turnContextChars: CONTEXT.length,
    });
  });

  it("the v1 stream sends it too", async () => {
    const { provider, silentStream } = setup("tc-v1", true);
    const session = { messages: history() };
    await silentStream("chat-2", SYSTEM, session, provider, [], undefined, undefined, undefined, CONTEXT);

    expectContextSentNotStored(provider.chatStream.mock.calls[0], session);
    const line = logged.find((l) => l.message === "Provider call" && l.fields.label === "turn");
    expect(line?.fields.turnContextChars).toBe(CONTEXT.length);
  });

  it("STREAMING_ENABLED=false sends it through chat()", async () => {
    const { provider, silentStream, runClock } = setup("tc-chat", false);
    const session = { messages: history() };
    await silentStream("chat-3", SYSTEM, session, provider, [], undefined, undefined, runClock, CONTEXT);

    expect(provider.chatStream).not.toHaveBeenCalled();
    expectContextSentNotStored(provider.chat.mock.calls[0], session);
  });

  it("the non-streaming retry after a stream error sends it again", async () => {
    const { provider, silentStream, runClock } = setup("tc-retry", true);
    provider.chatStream.mockRejectedValueOnce(new Error("socket hang up"));
    const session = { messages: history() };
    await silentStream("chat-4", SYSTEM, session, provider, [], undefined, undefined, runClock, CONTEXT);

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expectContextSentNotStored(provider.chat.mock.calls[0], session);
  });

  it("a call without a context sends the history as it is stored", async () => {
    const { provider, silentStream, runClock } = setup("tc-none", true);
    const session = { messages: history() };
    await silentStream("chat-5", SYSTEM, session, provider, [], undefined, undefined, runClock);

    expect(sent(provider.chatStream.mock.calls[0]).messages).toEqual(history());
    const line = logged.find((l) => l.message === "Provider call" && l.fields.label === "turn");
    expect(line?.fields.turnContextChars).toBe(0);
  });
});
