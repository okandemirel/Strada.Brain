/**
 * Agent Core v2 — Phase 1b orchestrator gate test (flag-OFF/ON RunClock equivalence).
 *
 * Proves the gate opens the RunClock ONLY when `agentCoreFlagSet.runClock === true`: drives a
 * real `runBackgroundTask` with a fake STREAMING provider and an injected counting Clock, then
 * asserts the injected clock is NEVER touched on flag-OFF (the verbatim v1 createStreamingProgress
 * watchdog path uses real setTimeout, not the Clock) and IS armed on flag-ON (the CallScope
 * timers). No production test-only accessor — the assertion rides the existing loop end-to-end.
 */
import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { SystemClock, type Clock, type TimerHandle } from "../agent-core/control/clock.js";
import { DEFAULT_FLAG_SET, resolveLegalFlagSet } from "../agent-core/runner/index.js";

// ─── Logger + knowledge mocks (mirror orchestrator-integration.test.ts) ──────

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (params: { projectPath: string }) => ({
    content: `## Project/World Memory\nActive project root: ${params.projectPath}`,
    contentHashes: [params.projectPath],
    summary: `root=${params.projectPath} | modules=none`,
    fingerprint: `root ${params.projectPath.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase()}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "\n## Agent Capability Manifest\n",
  buildToolUsageHints: () => "",
}));

// ─── A Clock that delegates to SystemClock but counts setTimer invocations ────

class CountingClock implements Clock {
  setTimerCalls = 0;
  private readonly inner = new SystemClock();
  now(): number {
    return this.inner.now();
  }
  setTimer(ms: number, cb: () => void): TimerHandle {
    this.setTimerCalls += 1;
    return this.inner.setTimer(ms, cb);
  }
  clearTimer(handle: TimerHandle): void {
    this.inner.clearTimer(handle);
  }
}

// ─── A fake STREAMING provider that returns a simple end_turn (one iteration) ─

function createStreamingProvider() {
  const chatStream = vi.fn(
    async (
      _systemPrompt: string,
      _messages: unknown[],
      _tools: unknown[],
      onChunk: (chunk: string) => void,
    ): Promise<ProviderResponse> => {
      onChunk("Analysis complete.\n**DONE**"); // one visible chunk → firstTokenSeen + touch
      return {
        text: "Analysis complete.\n**DONE**",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  );
  return {
    name: "mock-stream",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      thinkingSupported: false,
    },
    chat: vi.fn().mockResolvedValue({
      text: "Analysis complete.\n**DONE**",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
    chatStream,
  };
}

function createMockChannel() {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

function makeProviderManager(provider: ReturnType<typeof createStreamingProvider>) {
  return {
    getProvider: () => provider,
    getActiveInfo: () => ({ providerName: "mock-stream", model: "default", isDefault: true }),
    shutdown: vi.fn(),
  } as any;
}

const PHASE_1B_SET = resolveLegalFlagSet({
  ...DEFAULT_FLAG_SET,
  failureLedger: true,
  runClock: true,
});

describe("Phase 1b orchestrator gate — silentStream RunClock equivalence", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("flag-OFF (default): never touches the injected clock (verbatim v1 watchdog path)", async () => {
    const clock = new CountingClock();
    const provider = createStreamingProvider();
    const orch = new Orchestrator({
      providerManager: makeProviderManager(provider),
      tools: [],
      channel: createMockChannel(),
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: true,
      agentCoreClock: clock,
      // agentCoreFlagSet left undefined → runClock OFF → v1 path.
    });

    await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-runclock-off",
      channelType: "cli",
    });

    expect(provider.chatStream).toHaveBeenCalled(); // the streaming path WAS taken
    expect(clock.setTimerCalls).toBe(0); // …but the injected Clock was never used (OFF)
  });

  it("flag-ON (failure-ledger+run-clock): arms CallScope timers on the injected clock", async () => {
    const clock = new CountingClock();
    const provider = createStreamingProvider();
    const orch = new Orchestrator({
      providerManager: makeProviderManager(provider),
      tools: [],
      channel: createMockChannel(),
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: true,
      agentCoreClock: clock,
      agentCoreFlagSet: PHASE_1B_SET,
    });

    await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-runclock-on",
      channelType: "cli",
    });

    expect(provider.chatStream).toHaveBeenCalled();
    // The CallScope arms an inactivity + hard timer per call via the injected clock (finite
    // streamInitialTimeoutMs); flag-ON therefore touches it at least once.
    expect(clock.setTimerCalls).toBeGreaterThan(0);
  });
});
