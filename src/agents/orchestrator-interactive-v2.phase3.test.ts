/**
 * Agent Core v2 — Step 3 interactive-driver routing test (cutover Step 3, increment 3.0).
 *
 * processMessage (orchestrator.ts) now branches at the flip point: when
 * `agentCoreFlagSet.interactive === "v2"` it routes the interactive turn through
 * `selectAgentRunner(this, "interactive").run(request, io)` (the V2AgentRunner spine over the real
 * `createAgentCorePort`); otherwise it calls the unchanged `runAgentLoop` (v1). This file drives a
 * real interactive turn through the PUBLIC `handleMessage` entry against the REAL port + gateway —
 * the first end-to-end exercise of the v2 interactive happy-path through the orchestrator (the spine
 * unit/integration tests use a mock port).
 *
 * THE KEYSTONE ASSERTION (no double-render): on the v2 path the port's dispatch handlers
 * (portDispatchEndTurn → emitVisibleBoundary → sendVisibleAssistantMarkdown) render the terminal
 * answer to the channel DURING the run, and the interactive `IOStrategy.deliverFinal` is a NO-OP.
 * So the channel must receive the answer EXACTLY ONCE. If deliverFinal rendered too, it would be
 * twice — the bug this increment is built to avoid.
 *
 *  - Arm A — flag ON (`v2-all-routes+full-control-plane`, interactive:"v2"): the turn runs on the
 *    V2 spine and the channel gets the answer exactly once.
 *  - Arm B — flag OFF (`all-v1`, the baseline): the SAME message on the v1 loop also renders exactly
 *    once. Same harness, only the flag differs → a direct equivalence A/B for the render count.
 */
import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { resolveFlagSetById } from "../agent-core/runner/index.js";

// ─── Logger + knowledge mocks (mirror orchestrator-runclock.phase1c.test.ts) ──

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const ANSWER = "Here is the answer.";

/** A non-streaming provider that returns a single clean end-turn answer (the interactive happy path). */
function createAnswerProvider() {
  const chat = vi.fn(
    async (): Promise<ProviderResponse> => ({
      text: ANSWER,
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  );
  return {
    name: "mock-answer",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      thinkingSupported: false,
    },
    chat,
  };
}

const SILENT_PER_CALL_MS = 700_000; // > the 600_000 task-inactivity ceiling, tripped on the first call

/** A non-streaming provider that simulates a SILENT call (advances the injected clock past the task
 *  inactivity ceiling) then throws — drives the full control plane to a rule-4 hard stop (the abort
 *  path), mirroring orchestrator-runclock.phase1c.test.ts's createGoSilentProvider. */
function createSilentProvider(clock: FakeClock) {
  const chat = vi.fn(async (): Promise<ProviderResponse> => {
    clock.advance(SILENT_PER_CALL_MS);
    throw new Error("provider stalled (silent timeout)");
  });
  return {
    name: "mock-silent",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      thinkingSupported: false,
    },
    chat,
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

function makeProviderManager(provider: { name: string }) {
  return {
    getProvider: () => provider,
    getActiveInfo: () => ({ providerName: "mock-answer", model: "default", isDefault: true }),
    shutdown: vi.fn(),
  } as any;
}

function makeOrchestrator(opts: {
  provider: { name: string };
  channel: ReturnType<typeof createMockChannel>;
  flagSet: ReturnType<typeof resolveFlagSetById>;
  clock?: FakeClock;
  streamInitialTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}) {
  return new Orchestrator({
    providerManager: makeProviderManager(opts.provider),
    tools: [],
    channel: opts.channel,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    streamingEnabled: false, // force the non-streaming CallScope `chat` path
    agentCoreClock: opts.clock ?? new FakeClock(0),
    agentCoreFlagSet: opts.flagSet,
    ...(opts.streamInitialTimeoutMs ? { streamInitialTimeoutMs: opts.streamInitialTimeoutMs } : {}),
    ...(opts.streamStallTimeoutMs ? { streamStallTimeoutMs: opts.streamStallTimeoutMs } : {}),
  });
}

/** Count of channel renders of the terminal answer for a given chat. */
function answerRenderCount(channel: ReturnType<typeof createMockChannel>, chatId: string): number {
  return channel.sendMarkdown.mock.calls.filter(
    (c: unknown[]) => c[0] === chatId && typeof c[1] === "string" && (c[1] as string).includes(ANSWER),
  ).length;
}

describe("Step 3 — interactive route flip (v2 spine vs v1 loop, no double-render)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("flag ON (interactive v2): the answer is rendered to the channel EXACTLY ONCE (deliverFinal is a no-op)", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createAnswerProvider(),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-int-1",
      userId: "u1",
      text: "What is the answer?",
      timestamp: new Date(),
    });

    // The keystone: the port's dispatch rendered the answer once; the IOStrategy.deliverFinal NO-OP
    // did NOT render it a second time. Exactly one channel render, not two.
    expect(answerRenderCount(channel, "v2-int-1")).toBe(1);
  });

  it("flag OFF (all-v1 baseline): the SAME turn on the v1 loop also renders EXACTLY ONCE", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createAnswerProvider(),
      channel,
      flagSet: resolveFlagSetById("all-v1"),
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v1-int-1",
      userId: "u1",
      text: "What is the answer?",
      timestamp: new Date(),
    });

    // Equivalence: the v1 loop renders the answer once too. Same harness, only the flag differs.
    expect(answerRenderCount(channel, "v1-int-1")).toBe(1);
  });

  it("flag ON (v2): persistTerminal snapshots the execution journal onto the session (cross-turn continuity, gap #6)", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createAnswerProvider(),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-journal-1",
      userId: "u1",
      text: "What is the answer?",
      timestamp: new Date(),
    });

    // gap #6: persistTerminal must write `executionJournal.snapshot()` back onto the session so the
    // NEXT turn's setupAgentCoreRun reads it as `previousJournalSnapshot`. Before the write-back this
    // stayed undefined on the v2 path → silent stale cross-turn continuity. (sessionManager is
    // internal; reach it directly for the assertion — same persistent session the run used.)
    const session = (
      orch as unknown as {
        sessionManager: { getOrCreateSession(id: string): { lastJournalSnapshot?: unknown } };
      }
    ).sessionManager.getOrCreateSession("v2-journal-1");
    expect(session.lastJournalSnapshot).toBeDefined();
  });

  it("flag ON (v2): a provider hard-stop renders the localized abort resilience message to the channel (gap #3/#8)", async () => {
    const clock = new FakeClock(0);
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createSilentProvider(clock),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
      clock,
      streamInitialTimeoutMs: 10_000_000,
      streamStallTimeoutMs: 1000,
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-res-1",
      userId: "u1",
      text: "go",
      timestamp: new Date(),
    });

    const rendered = channel.sendMarkdown.mock.calls
      .filter((c: unknown[]) => c[0] === "v2-res-1")
      .map((c: unknown[]) => c[1] as string);

    // The interactive onEvent adapter rendered the v1 abort-tier resilience message (provider_abort)
    // from the control-plane stop (run.ending: "task-inactivity") — invisible before increment 3.2.
    expect(rendered.some((m) => m.includes("Unable to complete this task"))).toBe(true);
  });

  it("renderInteractiveResilienceEvent maps each user-facing event to the right localized message", () => {
    // Direct unit test of the mapping table — deterministic coverage of the variants the integration
    // path can't easily trigger (backoff/ask_user/show_plan), keyed on the real getResilienceMessage text.
    const orch = makeOrchestrator({
      provider: createAnswerProvider(),
      channel: createMockChannel(),
      flagSet: resolveFlagSetById("all-v1"),
    });
    const adapter = orch as unknown as {
      renderInteractiveResilienceEvent(e: unknown, language: string, enqueue: (t: string) => void): void;
    };
    const render = (e: unknown): string[] => {
      const out: string[] = [];
      adapter.renderInteractiveResilienceEvent(e, "en", (t) => out.push(t));
      return out;
    };

    // backoff → provider_slow (v1 degraded tier, no params)
    expect(render({ type: "backoff", ms: 2000, reason: "retry" })).toEqual([
      "The AI provider is experiencing delays. Retrying...",
    ]);
    // ask_user with a real question → render the model's visibleText verbatim
    expect(render({ type: "ask_user", question: "q", visibleText: "Need your input on X." })).toEqual([
      "Need your input on X.",
    ]);
    // ask_user with blank visibleText → fall back to the static provider_ask_user notice
    expect(render({ type: "ask_user", question: "q", visibleText: "   " })[0]).toContain("unreliable");
    // show_plan → the plan body verbatim
    expect(render({ type: "show_plan", visibleText: "## Plan\n1. step" })).toEqual(["## Plan\n1. step"]);
    // run.ending with a control-plane stop reason → provider_abort
    expect(render({ type: "run.ending", reason: "task-inactivity" })[0]).toContain("Unable to complete");
    expect(render({ type: "run.ending", reason: "provider-failure" })[0]).toContain("Unable to complete");
    // run.ending happy/handled reasons → no render (no double-render of the answer / no spurious abort)
    expect(render({ type: "run.ending", reason: "end_turn" })).toEqual([]);
    expect(render({ type: "run.ending", reason: "done" })).toEqual([]);
    expect(render({ type: "run.ending", reason: "max-tokens-runaway" })).toEqual([]);
    // The reflection terminal carries action.status ("completed"/"blocked") as the run.ending reason
    // (portDispatchReflection); the port already rendered the answer/block text, so these must SKIP —
    // else a successful reflection-completed turn would render a spurious "Unable to complete" abort.
    expect(render({ type: "run.ending", reason: "completed" })).toEqual([]);
    expect(render({ type: "run.ending", reason: "blocked" })).toEqual([]);
    // non-user-facing lifecycle events → no-op
    expect(render({ type: "step.completed", step: 1, phase: "EXECUTING" })).toEqual([]);
    expect(render({ type: "heartbeat", source: "model-keepalive" })).toEqual([]);
  });
});
