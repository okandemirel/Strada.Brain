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
}) {
  return new Orchestrator({
    providerManager: makeProviderManager(opts.provider),
    tools: [],
    channel: opts.channel,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    streamingEnabled: false, // force the non-streaming CallScope `chat` path
    agentCoreClock: new FakeClock(0),
    agentCoreFlagSet: opts.flagSet,
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
});
