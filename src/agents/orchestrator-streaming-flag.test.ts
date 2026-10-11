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
import { openRunClock, type RunClock } from "../agent-core/control/run-clock.js";
import type { RunBudgetPolicy } from "../agent-core/control/policy.js";
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

// A chat() answer arrives all at once when the call ends, and nothing marked
// the call scope live, so leave() booked every answered call's whole duration
// as task silence. The accumulator never resets: about thirty answered 60 s
// calls crossed the 30-minute ceiling and the run stopped as task-inactivity
// (reported "failed" off the interactive route) while it was making progress.
// A streamed answer only books the gap after its last token.
describe("an answered call without stream chunks is not task silence", () => {
  const CALL_MS = 60_000;
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

  function setup(streamingEnabled: boolean, name: string) {
    const clock = new FakeClock(0);
    const provider = createStreamingCapableProvider(name);
    const orch = new Orchestrator({
      providerManager: {
        getProvider: () => provider,
        getActiveInfo: () => ({ providerName: provider.name, model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as never,
      tools: [],
      channel: createChannel() as never,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      agentCoreClock: clock,
      streamingEnabled,
    });
    const runClock = openRunClock(clock, policy);
    const silentStream = (orch as unknown as {
      silentStream: (
        chatId: string, systemPrompt: string, session: { messages: unknown[] }, p: unknown,
        tools: unknown[], externalSignal?: AbortSignal, onLiveness?: () => void, runClock?: RunClock,
      ) => Promise<ProviderResponse>;
    }).silentStream;
    const call = () =>
      silentStream(name, "system", { messages: [{ role: "user", content: "hi" }] }, provider, [], undefined, undefined, runClock);
    return { clock, provider, runClock, call };
  }

  it("STREAMING_ENABLED=false: thirty answered 60 s calls leave the run under its silence ceiling", async () => {
    const { clock, provider, runClock, call } = setup(false, "mock-silence-answered");
    provider.chat.mockImplementation(async () => {
      clock.advance(CALL_MS);
      return answer();
    });
    for (let i = 0; i < 30; i++) await call();

    expect(provider.chat).toHaveBeenCalledTimes(30);
    expect(runClock.accumulatedSilentMs()).toBe(0);
    expect(runClock.silenceCeilingExceeded()).toBe(false);
  });

  it("a stream served without chunks (a non-streaming chain member) counts the same way", async () => {
    const { clock, provider, runClock, call } = setup(true, "mock-silence-chunkless");
    provider.chatStream.mockImplementation(async () => {
      clock.advance(CALL_MS);
      return answer();
    });
    await call();

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(runClock.accumulatedSilentMs()).toBe(0);
  });

  it("a call that brought no answer still books its whole wait", async () => {
    const empty = setup(false, "mock-silence-empty");
    empty.provider.chat.mockImplementation(async () => {
      empty.clock.advance(CALL_MS);
      return { ...answer(), text: "" };
    });
    await empty.call();
    expect(empty.runClock.accumulatedSilentMs()).toBe(CALL_MS);

    const failed = setup(false, "mock-silence-failed");
    failed.provider.chat.mockImplementation(async () => {
      failed.clock.advance(CALL_MS);
      throw new Error("socket hang up");
    });
    await failed.call();
    expect(failed.runClock.accumulatedSilentMs()).toBe(CALL_MS);
  });
});
