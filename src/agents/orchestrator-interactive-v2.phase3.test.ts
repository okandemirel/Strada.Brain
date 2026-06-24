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
import { DEFAULT_TASK_CONFIG } from "../config/config.js";
import type { TaskConfig } from "../config/config.js";

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

const CAP = {
  maxTokens: 4096,
  streaming: false,
  structuredStreaming: false,
  toolCalling: true,
  vision: false,
  systemPrompt: true,
  thinkingSupported: false,
};

/** Provider that returns an internal plan-artifact (matches draftLooksLikeInternalPlanArtifact) with
 *  no tool calls — drives the 3.5 plan-review gate when the user explicitly asked for a plan. */
function createPlanArtifactProvider() {
  let n = 0;
  const chat = vi.fn(async (): Promise<ProviderResponse> => {
    n++;
    // Turn 1: a plan artifact (first line is a PLAN heading). Turn 2 (after approval): a normal answer.
    const text = n === 1 ? "## Plan\n1. First, read the files\n2. Then apply the change" : ANSWER;
    return { text, toolCalls: [], stopReason: "end_turn" as const, usage: { inputTokens: 10, outputTokens: 20 } };
  });
  return { name: "mock-plan", capabilities: CAP, chat };
}

/** Provider that ALWAYS returns a goal block — drives the 3.6 goal→background handoff. "Always"
 *  is deliberate: if the spine fails to TERMINATE after the handoff, it would loop PLANNING and call
 *  taskManager.submit on every iteration, so asserting submit-called-once is the no-double-run guard. */
function createGoalBlockProvider(extraText = "") {
  const goal = '```goal\n{"isGoal": true, "estimatedMinutes": 5, "nodes": [{"id": "a", "task": "do the thing", "dependsOn": []}]}\n```';
  const chat = vi.fn(async (): Promise<ProviderResponse> => ({
    text: `${extraText}${goal}`,
    toolCalls: [],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 10, outputTokens: 20 },
  }));
  return { name: "mock-goal", capabilities: CAP, chat };
}

/** Minimal TaskManager stand-in: only `submit` is exercised by the goal-handoff path. */
function createTaskManagerSpy() {
  return { submit: vi.fn().mockReturnValue({ id: "task-1" }) };
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
  tools?: ReturnType<typeof createMockTool>[];
  taskConfig?: Partial<TaskConfig>;
}) {
  return new Orchestrator({
    providerManager: makeProviderManager(opts.provider),
    tools: opts.tools ?? [],
    channel: opts.channel,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    streamingEnabled: false, // force the non-streaming CallScope `chat` path
    agentCoreClock: opts.clock ?? new FakeClock(0),
    agentCoreFlagSet: opts.flagSet,
    ...(opts.streamInitialTimeoutMs ? { streamInitialTimeoutMs: opts.streamInitialTimeoutMs } : {}),
    ...(opts.streamStallTimeoutMs ? { streamStallTimeoutMs: opts.streamStallTimeoutMs } : {}),
    ...(opts.taskConfig ? { taskConfig: { ...DEFAULT_TASK_CONFIG, ...opts.taskConfig } } : {}),
  });
}

/** A mock tool that always succeeds — lets a looping provider drive iterations without ending. */
function createMockTool(name: string) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({ content: `${name} ok` }),
  };
}

/** Provider that ALWAYS returns a tool call → the interactive loop never reaches end_turn, so it
 *  exhausts its iteration budget (drives the 3.4 max-iterations notice). */
function createLoopingProvider(toolName: string) {
  const chat = vi.fn(async (): Promise<ProviderResponse> => ({
    text: "still working",
    toolCalls: [{ id: "tc-1", name: toolName, input: {} }],
    stopReason: "tool_use" as const,
    usage: { inputTokens: 10, outputTokens: 20 },
  }));
  return { name: "mock-loop", capabilities: CAP, chat };
}

/** Provider that burns a large OUTPUT-token count each call → trips a low interactive token budget
 *  (drives the 3.3 budget-exceeded notice). */
function createBudgetBurnerProvider() {
  const chat = vi.fn(async (): Promise<ProviderResponse> => ({
    text: "burning tokens",
    toolCalls: [],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 10, outputTokens: 5000 },
  }));
  return { name: "mock-burn", capabilities: CAP, chat };
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
      renderInteractiveResilienceEvent(
        e: unknown,
        language: string,
        enqueue: (t: string, transient?: boolean) => void,
      ): void;
    };
    const render = (e: unknown, language = "en"): string[] => {
      const out: string[] = [];
      adapter.renderInteractiveResilienceEvent(e, language, (t) => out.push(t));
      return out;
    };
    // Capture both the text AND the transient flag so the pill-vs-answer routing is pinned.
    const renderWithTransient = (e: unknown, language = "en"): Array<{ text: string; transient: boolean }> => {
      const out: Array<{ text: string; transient: boolean }> = [];
      adapter.renderInteractiveResilienceEvent(e, language, (text, transient = false) =>
        out.push({ text, transient }),
      );
      return out;
    };

    // backoff → provider_slow (v1 degraded tier, no params), flagged TRANSIENT so the
    // enqueueRender tail routes it to a system pill (not the recorded transcript).
    expect(renderWithTransient({ type: "backoff", ms: 2000, reason: "retry" })).toEqual([
      { text: "The AI provider is experiencing delays. Retrying...", transient: true },
    ]);
    // Every terminal/prompt arm is NON-transient (stays a recorded, visible answer).
    expect(renderWithTransient({ type: "ask_user", question: "q", visibleText: "Need your input." })[0]!.transient).toBe(false);
    expect(renderWithTransient({ type: "show_plan", visibleText: "## Plan" })[0]!.transient).toBe(false);
    expect(renderWithTransient({ type: "run.ending", reason: "task-inactivity" })[0]!.transient).toBe(false);
    expect(renderWithTransient({ type: "run.ending", reason: "max-iterations" })[0]!.transient).toBe(false);
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
    // 3.5 plan-review / 3.6 goal-handoff terminals — the plan/ack was already rendered (show_plan);
    // these must skip, else a successful plan-review or goal handoff renders a spurious abort.
    expect(render({ type: "run.ending", reason: "plan-review" })).toEqual([]);
    expect(render({ type: "run.ending", reason: "goal-handoff" })).toEqual([]);
    // 3.4 max-iterations → dedicated arm renders the localized "max steps" notice (NOT skip, NOT abort).
    expect(render({ type: "run.ending", reason: "max-iterations" })[0]).toContain("maximum number of steps");
    // Localization is the point of 3.4's arm over v1's hardcoded English: a tr language renders the tr notice.
    expect(render({ type: "run.ending", reason: "max-iterations" }, "tr")[0]).toContain("maksimum adım");
    // 3.3 interactive token-budget stop → skip-set (the port already rendered the specific notice inline).
    expect(render({ type: "run.ending", reason: "budget-exhausted:tokens" })).toEqual([]);
    // non-user-facing lifecycle events → no-op
    expect(render({ type: "step.completed", step: 1, phase: "EXECUTING" })).toEqual([]);
    expect(render({ type: "heartbeat", source: "model-keepalive" })).toEqual([]);
  });

  it("flag ON (v2): 3.5 — an explicit plan request + plan-artifact response parks a review gate, presents the plan, terminates without a spurious abort, and the next approval clears the gate", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createPlanArtifactProvider(),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    });
    const sm = (
      orch as unknown as {
        sessionManager: { getPendingPlanReviewVisibleText(id: string): string | undefined };
      }
    ).sessionManager;

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-plan-1",
      userId: "u1",
      text: "show me your plan before you proceed",
      timestamp: new Date(),
    });

    const rendered = channel.sendMarkdown.mock.calls
      .filter((c: unknown[]) => c[0] === "v2-plan-1")
      .map((c: unknown[]) => c[1] as string);
    // The plan was presented (show_plan render) and the write-blocking review gate is parked.
    expect(rendered.some((m) => m.includes("## Plan"))).toBe(true);
    expect(sm.getPendingPlanReviewVisibleText("v2-plan-1")).toBeTruthy();
    // No spurious provider_abort — the run terminated with the happy "plan-review" reason.
    expect(rendered.some((m) => m.includes("Unable to complete"))).toBe(false);

    // Resume: the next message approves → noteUserMessage clears the gate; the run won't re-park.
    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-plan-1",
      userId: "u1",
      text: "yes, go ahead",
      timestamp: new Date(),
    });
    expect(sm.getPendingPlanReviewVisibleText("v2-plan-1")).toBeFalsy();
  });

  it("flag ON (v2): 3.6 — a goal-block response submits exactly ONE background task, acks, and terminates (no inline double-run)", async () => {
    const channel = createMockChannel();
    const taskManager = createTaskManagerSpy();
    const orch = makeOrchestrator({
      provider: createGoalBlockProvider(),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    });
    (orch as unknown as { setTaskManager(tm: unknown): void }).setTaskManager(taskManager);

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-goal-1",
      userId: "u1",
      text: "build me a full feature end to end",
      timestamp: new Date(),
    });

    // Exactly ONE submit: the run TERMINATED after the handoff (before decomposeGoalsIfPlanning). An
    // always-goal-block provider would re-submit every PLANNING iteration if the terminate break were
    // missing → submit-called-once is the no-double-run guard.
    expect(taskManager.submit).toHaveBeenCalledTimes(1);
    expect(taskManager.submit.mock.calls[0][0]).toBe("v2-goal-1");
    const rendered = channel.sendMarkdown.mock.calls
      .filter((c: unknown[]) => c[0] === "v2-goal-1")
      .map((c: unknown[]) => c[1] as string);
    expect(rendered.some((m) => m.includes("Working on:"))).toBe(true);
    expect(rendered.some((m) => m.includes("Unable to complete"))).toBe(false);
  });

  it("flag ON (v2): 3.8 — goal-block detection takes precedence over the plan-review gate (v1 ordering)", async () => {
    const channel = createMockChannel();
    const taskManager = createTaskManagerSpy();
    // A response that looks like a plan artifact AND carries a goal block, with an explicit plan request.
    const orch = makeOrchestrator({
      provider: createGoalBlockProvider("## Plan\nHere is the approach.\n\n"),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
    });
    (orch as unknown as { setTaskManager(tm: unknown): void }).setTaskManager(taskManager);

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-prec-1",
      userId: "u1",
      text: "show me your plan before you proceed",
      timestamp: new Date(),
    });

    // Goal-detection wins: the task was submitted and NO plan-review gate was parked.
    expect(taskManager.submit).toHaveBeenCalledTimes(1);
    const sm = (
      orch as unknown as {
        sessionManager: { getPendingPlanReviewVisibleText(id: string): string | undefined };
      }
    ).sessionManager;
    expect(sm.getPendingPlanReviewVisibleText("v2-prec-1")).toBeFalsy();
  });

  it("flag ON (v2): 3.4 — exhausting the iteration budget renders the 'max steps' notice, not an abort", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createLoopingProvider("noop"),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
      tools: [createMockTool("noop")],
      taskConfig: { interactiveMaxIterations: 2 }, // exhaust fast: 2 looping iterations → max-iterations
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-maxiter-1",
      userId: "u1",
      text: "do a long thing",
      timestamp: new Date(),
    });

    const rendered = channel.sendMarkdown.mock.calls
      .filter((c: unknown[]) => c[0] === "v2-maxiter-1")
      .map((c: unknown[]) => c[1] as string);
    // v1 "Hit max iterations" parity: the localized max_steps_reached notice renders, NOT a provider_abort.
    expect(rendered.some((m) => m.includes("maximum number of steps"))).toBe(true);
    expect(rendered.some((m) => m.includes("Unable to complete"))).toBe(false);
  });

  it("flag ON (v2): 3.3 — exceeding the live token budget renders the token-budget notice, not an abort", async () => {
    const channel = createMockChannel();
    const orch = makeOrchestrator({
      provider: createBudgetBurnerProvider(),
      channel,
      flagSet: resolveFlagSetById("v2-all-routes+full-control-plane"),
      taskConfig: { interactiveTokenBudget: 1000 }, // 1000 output-token cap; the provider burns 5000/call
    });

    await orch.handleMessage({
      channelType: "cli",
      chatId: "v2-budget-1",
      userId: "u1",
      text: "burn it",
      timestamp: new Date(),
    });

    const rendered = channel.sendMarkdown.mock.calls
      .filter((c: unknown[]) => c[0] === "v2-budget-1")
      .map((c: unknown[]) => c[1] as string);
    // v1 parity: the specific token_budget_exceeded notice renders inline (port-side), NOT a provider_abort.
    expect(rendered.some((m) => m.includes("Token budget exceeded"))).toBe(true);
    expect(rendered.some((m) => m.includes("Unable to complete"))).toBe(false);
  });
});
