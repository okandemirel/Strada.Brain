/**
 * N-3 — STREAMING_ENABLED decides how the engine calls providers.
 *
 * The flag was read by the boot report only: cutover Step 5 stopped the engine
 * from consulting it, so `STREAMING_ENABLED=false` still opened a stream for
 * every model turn. The documented meaning (config catalog, .env.example,
 * README) is the provider call mode: false → `chat()`, true (the default) →
 * `chatStream()`. Replies reach the channel once complete either way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { ProviderHealthRegistry } from "./providers/provider-health.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { resolveFlagSetById } from "../agent-core/runner/index.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const ANSWER = "Here is the answer.";

function answer(): ProviderResponse {
  return { text: ANSWER, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20 } };
}

/** A provider that can do both, so the call mode is the orchestrator's choice. */
function createStreamingCapableProvider(name: string) {
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
    chat: vi.fn(async (): Promise<ProviderResponse> => answer()),
    chatStream: vi.fn(async (
      _system: string,
      _messages: unknown,
      _tools: unknown,
      onChunk: (chunk: string) => void,
    ): Promise<ProviderResponse> => {
      onChunk(ANSWER);
      return answer();
    }),
  };
}

function createChannel() {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    // A streaming-capable channel: a partial reply would show up here.
    startStreamingMessage: vi.fn().mockResolvedValue("stream-1"),
    updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
    finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

function makeOrchestrator(
  provider: ReturnType<typeof createStreamingCapableProvider>,
  channel: ReturnType<typeof createChannel>,
  streamingEnabled: boolean | undefined,
) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getActiveInfo: () => ({ providerName: provider.name, model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: channel as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: new FakeClock(0),
    agentCoreFlagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    ...(streamingEnabled === undefined ? {} : { streamingEnabled }),
  });
}

async function runTurn(orch: Orchestrator, chatId: string): Promise<void> {
  await orch.handleMessage({ channelType: "cli", chatId, userId: "u1", text: "What is the answer?", timestamp: new Date() });
}

function answerRenders(channel: ReturnType<typeof createChannel>, chatId: string): number {
  return channel.sendMarkdown.mock.calls.filter(
    (c: unknown[]) => c[0] === chatId && typeof c[1] === "string" && (c[1] as string).includes(ANSWER),
  ).length;
}

describe("STREAMING_ENABLED (N-3)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("false: model turns call chat(), never chatStream(), and the reply is sent once, complete", async () => {
    const provider = createStreamingCapableProvider("mock-flag-off");
    const channel = createChannel();
    await runTurn(makeOrchestrator(provider, channel, false), "stream-off");

    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalled();
    expect(channel.startStreamingMessage).not.toHaveBeenCalled();
    expect(channel.updateStreamingMessage).not.toHaveBeenCalled();
    expect(answerRenders(channel, "stream-off")).toBe(1);
  });

  it("default (unset) and true: model turns stream, as before", async () => {
    for (const [flag, chatId] of [[undefined, "stream-default"], [true, "stream-on"]] as const) {
      const provider = createStreamingCapableProvider(`mock-${chatId}`);
      const channel = createChannel();
      await runTurn(makeOrchestrator(provider, channel, flag), chatId);

      expect(provider.chatStream).toHaveBeenCalled();
      expect(provider.chat).not.toHaveBeenCalled();
      expect(answerRenders(channel, chatId)).toBe(1);
    }
  });

  it("false: a cancelled call is rethrown as a cancel, not recorded as a provider failure", async () => {
    const provider = createStreamingCapableProvider("mock-cancelled");
    const controller = new AbortController();
    provider.chat.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const orch = makeOrchestrator(provider, createChannel(), false);
    const recordFailure = vi.spyOn(ProviderHealthRegistry.getInstance(), "recordFailure");
    const silentStream = (orch as unknown as {
      silentStream: (
        chatId: string, systemPrompt: string, session: { messages: unknown[] }, p: unknown,
        tools: unknown[], externalSignal?: AbortSignal,
      ) => Promise<ProviderResponse>;
    }).silentStream;

    await expect(
      silentStream("cancelled", "system", { messages: [{ role: "user", content: "hi" }] }, provider, [], controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(recordFailure.mock.calls.filter(([name]) => name === "mock-cancelled")).toEqual([]);
    recordFailure.mockRestore();
  });
});
