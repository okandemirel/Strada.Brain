import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCore } from "./agent-core.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { createObservation, type Observer, type AgentObservation } from "./observation-types.js";
import { parseReasoningResponse } from "./reasoning-prompt.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeObserver(name: string, observations: AgentObservation[]): Observer {
  return { name, collect: vi.fn().mockReturnValue(observations) };
}

function makeLLMResponse(json: Record<string, unknown>): { text: string; toolCalls: never[]; stopReason: string } {
  return {
    text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``,
    toolCalls: [],
    stopReason: "end_turn",
  };
}

function createMocks(overrides?: {
  observations?: AgentObservation[];
  budgetPct?: number;
  chatResponse?: Record<string, unknown>;
  activeForegroundTaskCount?: number;
}) {
  const obs = overrides?.observations ?? [createObservation("build", "Build failed", { priority: 80 })];
  const engine = new ObservationEngine();
  engine.register(makeObserver("test", obs));

  const scorer = new PriorityScorer();
  const provider = {
    chat: vi.fn().mockResolvedValue(
      makeLLMResponse(overrides?.chatResponse ?? { action: "execute", goal: "Fix build", reasoning: "broken" }),
    ),
  };
  const taskManager = {
    submit: vi.fn().mockReturnValue({ id: "task_mock01" }),
    listTasks: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(null),
    countActiveForegroundTasks: vi.fn().mockReturnValue(overrides?.activeForegroundTaskCount ?? 0),
  };
  const channel = { sendText: vi.fn().mockResolvedValue(undefined) };
  const budget = {
    getUsage: vi.fn().mockReturnValue({ usedUsd: 5, limitUsd: 10, pct: overrides?.budgetPct ?? 0.5 }),
  };

  return { engine, scorer, provider, taskManager, channel, budget };
}

/** Build an AgentCore with rate limiting bypassed (minReasoningIntervalMs: 0) */
function buildCore(
  mocks: ReturnType<typeof createMocks>,
  configOverrides?: Record<string, unknown>,
  instinctRetriever?: { getInsightsForTask: ReturnType<typeof vi.fn> },
) {
  return new AgentCore(
    mocks.engine,
    mocks.scorer,
    mocks.provider as any,
    mocks.taskManager as any,
    mocks.channel as any,
    mocks.budget,
    instinctRetriever,
    { minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10, ...configOverrides } as any,
  );
}

/* ------------------------------------------------------------------ */
/*  Integration Tests                                                 */
/* ------------------------------------------------------------------ */

describe("AgentCore OODA Integration", () => {
  /* 1. Full OODA tick */
  it("full tick: observe -> orient -> decide -> act (execute)", async () => {
    const m = createMocks({ budgetPct: 0.5, chatResponse: { action: "execute", goal: "Fix build", reasoning: "broken" } });
    const core = buildCore(m);
    await core.tick();

    expect(m.provider.chat).toHaveBeenCalledTimes(1);
    expect(m.taskManager.submit).toHaveBeenCalledWith("agent-core", "daemon", "Fix build", { origin: "daemon" });
  });

  /* 2. Budget floor blocks tick */
  it("skips tick when budget floor reached (pct >= 0.90)", async () => {
    const m = createMocks({ budgetPct: 0.95 });
    const core = buildCore(m);
    await core.tick();

    expect(m.provider.chat).not.toHaveBeenCalled();
    expect(m.taskManager.submit).not.toHaveBeenCalled();
  });

  /* 3. Rate limiting */
  it("skips tick within rate-limiting window", async () => {
    const m = createMocks();
    // Use a large interval so the initial lastReasoningMs (Date.now()) is always within the window
    const core = buildCore(m, { minReasoningIntervalMs: 60_000 });
    await core.tick();

    expect(m.provider.chat).not.toHaveBeenCalled();
  });

  /* 4. Priority threshold */
  it("skips tick when top observation priority is below threshold", async () => {
    const lowObs = createObservation("user", "Idle heartbeat", { priority: 10 });
    const m = createMocks({ observations: [lowObs] });
    const core = buildCore(m, { minObservationPriority: 30 });
    await core.tick();

    expect(m.provider.chat).not.toHaveBeenCalled();
  });

  /* 5. tickInFlight guard */
  it("second tick returns immediately when first tick is in flight", async () => {
    const m = createMocks();
    // Provider hangs forever (never-resolving promise)
    let resolveChat!: (v: any) => void;
    const hangPromise = new Promise((r) => { resolveChat = r; });
    m.provider.chat.mockReturnValue(hangPromise);

    const core = buildCore(m);
    const tick1 = core.tick();
    expect(core.isTickInFlight()).toBe(true);

    // Second tick should bail immediately
    await core.tick();
    expect(m.provider.chat).toHaveBeenCalledTimes(1); // Only the first tick called the provider

    // Clean up: resolve the hanging promise
    resolveChat(makeLLMResponse({ action: "wait", reasoning: "ok" }));
    await tick1;
    expect(core.isTickInFlight()).toBe(false);
  });

  /* 6a. Action type: execute */
  it("action execute -> taskManager.submit called", async () => {
    const m = createMocks({ chatResponse: { action: "execute", goal: "Run tests", reasoning: "tests needed" } });
    const core = buildCore(m);
    await core.tick();

    expect(m.taskManager.submit).toHaveBeenCalledWith("agent-core", "daemon", "Run tests", { origin: "daemon" });
  });

  /* 6b. Action type: wait */
  it("action wait -> no side effects", async () => {
    const m = createMocks({ chatResponse: { action: "wait", reasoning: "nothing urgent" } });
    const core = buildCore(m);
    await core.tick();

    expect(m.provider.chat).toHaveBeenCalledTimes(1);
    expect(m.taskManager.submit).not.toHaveBeenCalled();
    expect(m.channel.sendText).not.toHaveBeenCalled();
  });

  /* 6c. Action type: notify */
  it("action notify -> channel.sendText called", async () => {
    const m = createMocks({ chatResponse: { action: "notify", message: "Build is green", reasoning: "informing" } });
    const core = buildCore(m);
    await core.tick();

    expect(m.channel.sendText).toHaveBeenCalledWith("agent-core", "Build is green");
    expect(m.taskManager.submit).not.toHaveBeenCalled();
  });

  /* 6d. Action type: escalate */
  it("action escalate -> channel.sendText called with question prefix", async () => {
    const m = createMocks({ chatResponse: { action: "escalate", question: "Should I deploy?", reasoning: "need approval" } });
    const core = buildCore(m);
    await core.tick();

    expect(m.channel.sendText).toHaveBeenCalledWith("agent-core", "[Agent needs input] Should I deploy?");
    expect(m.taskManager.submit).not.toHaveBeenCalled();
  });

  it("suppresses notify while a foreground user task is active and defers the observation", async () => {
    const obs = createObservation("git", "65 uncommitted change(s) detected", { priority: 80 });
    const m = createMocks({
      observations: [obs],
      chatResponse: { action: "notify", message: "There are many local changes.", reasoning: "informing" },
      activeForegroundTaskCount: 1,
    });
    const core = buildCore(m);
    await core.tick();

    expect(m.channel.sendText).not.toHaveBeenCalled();
    expect(m.taskManager.submit).not.toHaveBeenCalled();
    expect(m.engine.getDeferredCount()).toBe(1);
  });

  it("suppresses escalate while a foreground user task is active and defers the observation", async () => {
    const obs = createObservation("git", "65 uncommitted change(s) detected", { priority: 80 });
    const m = createMocks({
      observations: [obs],
      chatResponse: { action: "escalate", question: "Should I review the diff now?", reasoning: "need approval" },
      activeForegroundTaskCount: 1,
    });
    const core = buildCore(m);
    await core.tick();

    expect(m.channel.sendText).not.toHaveBeenCalled();
    expect(m.taskManager.submit).not.toHaveBeenCalled();
    expect(m.engine.getDeferredCount()).toBe(1);
  });

  /* 8. Instinct integration */
  it("instinct insights appear in the prompt passed to provider.chat", async () => {
    const m = createMocks();
    const instinctRetriever = {
      getInsightsForTask: vi.fn().mockResolvedValue({
        insights: ["Always run lint before commit", "Prefer incremental builds"],
        matchedInstinctIds: ["inst-1", "inst-2"],
      }),
    };
    const core = buildCore(m, {}, instinctRetriever);
    await core.tick();

    expect(instinctRetriever.getInsightsForTask).toHaveBeenCalled();

    // The prompt is the user message content (second arg, first message's content)
    const chatCallArgs = m.provider.chat.mock.calls[0]!;
    const userMessages = chatCallArgs[1] as Array<{ role: string; content: string }>;
    const prompt = userMessages[0]!.content;

    expect(prompt).toContain("Always run lint before commit");
    expect(prompt).toContain("Prefer incremental builds");
    expect(prompt).toContain("Learned Patterns");
  });

  /* 9. Empty observations */
  it("returns without calling provider when observations are empty", async () => {
    const m = createMocks({ observations: [] });
    const core = buildCore(m);
    await core.tick();

    expect(m.provider.chat).not.toHaveBeenCalled();
  });

  /* 10. P2: inject() adds observations to next collect cycle */
  it("ObservationEngine.inject adds synthetic observation to next collect", () => {
    const engine = new ObservationEngine();
    engine.register({ name: "empty", collect: () => [] });

    const synthetic = createObservation("task-outcome", "Agent task succeeded: Fix build", {
      priority: 40,
      context: { taskId: "task_abc", success: true },
    });
    engine.inject(synthetic);

    const collected = engine.collect();
    expect(collected).toHaveLength(1);
    expect(collected[0]!.source).toBe("task-outcome");
    expect(collected[0]!.summary).toContain("succeeded");

    // Second collect should not re-emit the injected observation (drained)
    const second = engine.collect();
    expect(second).toHaveLength(0);
  });

  /* 11. P2: task outcome creates observation after completion */
  it("checkCompletedTasks injects outcome observation when tracked task completes", async () => {
    const m = createMocks({ chatResponse: { action: "execute", goal: "Deploy feature", reasoning: "ready" } });
    const instinctRetriever = {
      getInsightsForTask: vi.fn().mockResolvedValue({
        insights: ["Use staging first"],
        matchedInstinctIds: ["inst-a", "inst-b"],
      }),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    // First tick: submit task with instinct associations
    m.taskManager.submit.mockReturnValue({ id: "task_deploy01" });
    const core = buildCore(m, {}, instinctRetriever);
    await core.tick();

    expect(m.taskManager.submit).toHaveBeenCalled();

    // Simulate task completion: getStatus returns completed
    m.taskManager.getStatus.mockReturnValue({ id: "task_deploy01", status: "completed", title: "Deploy feature" });

    // Provide a new observation so the second tick's OBSERVE phase sees something
    (m.engine as any).observers.length = 0;
    m.engine.register({ name: "refresh", collect: () => [createObservation("build", "Build green", { priority: 50 })] });

    // Reset provider for second tick
    m.provider.chat.mockResolvedValue(
      makeLLMResponse({ action: "wait", reasoning: "all good" }),
    );

    // Second tick: checkCompletedTasks should fire
    await core.tick();

    // recordOutcome should have been called for both instinct IDs
    expect(instinctRetriever.recordOutcome).toHaveBeenCalledTimes(2);
    expect(instinctRetriever.recordOutcome).toHaveBeenCalledWith("inst-a", true);
    expect(instinctRetriever.recordOutcome).toHaveBeenCalledWith("inst-b", true);
  });

  /* 12. P2: failed task records failure outcome */
  it("checkCompletedTasks records failure when tracked task fails", async () => {
    const m = createMocks({ chatResponse: { action: "execute", goal: "Run tests", reasoning: "tests needed" } });
    const instinctRetriever = {
      getInsightsForTask: vi.fn().mockResolvedValue({
        insights: ["Check test config"],
        matchedInstinctIds: ["inst-c"],
      }),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    m.taskManager.submit.mockReturnValue({ id: "task_test01" });
    const core = buildCore(m, {}, instinctRetriever);
    await core.tick();

    // Simulate task failure
    m.taskManager.getStatus.mockReturnValue({ id: "task_test01", status: "failed", title: "Run tests" });

    (m.engine as any).observers.length = 0;
    m.engine.register({ name: "refresh", collect: () => [createObservation("build", "Build red", { priority: 80 })] });
    m.provider.chat.mockResolvedValue(makeLLMResponse({ action: "wait", reasoning: "investigating" }));

    await core.tick();

    expect(instinctRetriever.recordOutcome).toHaveBeenCalledWith("inst-c", false);
  });

  /* 14. batch action: submits compound goal with matched observation context */
  it("action batch -> submits compound goal with matched observation context", async () => {
    const obs1 = createObservation("build", "Build failed in module A", { priority: 80 });
    const obs2 = createObservation("test", "Tests failing in module A", { priority: 75 });
    const m = createMocks({
      observations: [obs1, obs2],
      chatResponse: {
        action: "batch",
        batchObservationIds: [obs1.id, obs2.id],
        goal: "Fix module A build and tests",
        reasoning: "related issues",
      },
    });
    const core = buildCore(m);
    await core.tick();

    expect(m.taskManager.submit).toHaveBeenCalledTimes(1);
    const submittedGoal = m.taskManager.submit.mock.calls[0]![2] as string;
    expect(submittedGoal).toContain("Fix module A build and tests");
    expect(submittedGoal).toContain("Build failed in module A");
    expect(submittedGoal).toContain("Tests failing in module A");
  });

  /* 15. defer action: observation deferred and re-appears after timeout */
  it("action defer -> observation deferred and re-appears after timeout", async () => {
    vi.useFakeTimers();

    const obs = createObservation("build", "Non-urgent build warning", { priority: 60 });
    const engine = new ObservationEngine();
    let collectCount = 0;
    engine.register({
      name: "test",
      collect: () => {
        collectCount++;
        // Only return the observation on the first collect
        return collectCount === 1 ? [obs] : [];
      },
    });

    const scorer = new PriorityScorer();
    const provider = {
      chat: vi.fn().mockResolvedValue(
        makeLLMResponse({ action: "defer", deferMinutes: 10, reasoning: "not urgent now" }),
      ),
    };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn().mockResolvedValue(undefined) };
    const budget = { getUsage: vi.fn().mockReturnValue({ usedUsd: 5, limitUsd: 10, pct: 0.5 }) };

    const core = new AgentCore(
      engine, scorer, provider as any, taskManager as any, channel as any, budget,
      undefined,
      { minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10 },
    );

    // First tick: should defer the observation
    await core.tick();
    expect(engine.getDeferredCount()).toBe(1);

    // Second tick before timeout: deferred item should NOT re-appear (no observations)
    provider.chat.mockClear();
    await core.tick();
    expect(provider.chat).not.toHaveBeenCalled(); // No observations available

    // Advance past defer timeout (10 minutes)
    vi.advanceTimersByTime(10 * 60_000);

    // Third tick: deferred item should re-appear
    provider.chat.mockResolvedValue(makeLLMResponse({ action: "wait", reasoning: "ok now" }));
    await core.tick();
    expect(provider.chat).toHaveBeenCalledTimes(1); // LLM was called with re-injected observation
    expect(engine.getDeferredCount()).toBe(0);

    vi.useRealTimers();
  });

  /* 16. adjust action: changes runtime priority threshold and reasoning interval */
  it("action adjust -> changes runtime priority threshold and reasoning interval", async () => {
    const m = createMocks({
      chatResponse: {
        action: "adjust",
        adjustments: { priorityThreshold: 50, reasoningIntervalMs: 15000 },
        reasoning: "tuning parameters",
      },
    });
    const core = buildCore(m);
    await core.tick();

    const overrides = core.getRuntimeOverrides();
    expect(overrides.priorityThreshold).toBe(50);
    expect(overrides.reasoningIntervalMs).toBe(15000);
  });

  /* 13. P2: no instincts => no recordOutcome calls */
  it("does not call recordOutcome when no instincts were matched", async () => {
    const m = createMocks({ chatResponse: { action: "execute", goal: "Cleanup", reasoning: "housekeeping" } });
    const instinctRetriever = {
      getInsightsForTask: vi.fn().mockResolvedValue({
        insights: [],
        matchedInstinctIds: [],
      }),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    m.taskManager.submit.mockReturnValue({ id: "task_clean01" });
    const core = buildCore(m, {}, instinctRetriever);
    await core.tick();

    // Simulate task completion
    m.taskManager.getStatus.mockReturnValue({ id: "task_clean01", status: "completed", title: "Cleanup" });

    (m.engine as any).observers.length = 0;
    m.engine.register({ name: "refresh", collect: () => [createObservation("trigger", "Cron", { priority: 50 })] });
    m.provider.chat.mockResolvedValue(makeLLMResponse({ action: "wait", reasoning: "done" }));

    await core.tick();

    // No instinct IDs were associated, so recordOutcome should not be called
    expect(instinctRetriever.recordOutcome).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  parseReasoningResponse (integration-oriented edge cases)          */
/* ------------------------------------------------------------------ */

describe("parseReasoningResponse integration", () => {
  it("parses valid JSON block with execute action", () => {
    const result = parseReasoningResponse('```json\n{"action":"execute","goal":"Fix tests","reasoning":"tests failing"}\n```');
    expect(result.action).toBe("execute");
    expect(result.goal).toBe("Fix tests");
    expect(result.reasoning).toBe("tests failing");
  });

  it("returns wait on malformed JSON", () => {
    const result = parseReasoningResponse('```json\n{action: broken}\n```');
    expect(result.action).toBe("wait");
  });

  it("returns wait on null input", () => {
    expect(parseReasoningResponse(null).action).toBe("wait");
  });

  it("returns wait on empty string", () => {
    expect(parseReasoningResponse("").action).toBe("wait");
  });

  it("returns wait on unknown action type", () => {
    const result = parseReasoningResponse('{"action":"explode","reasoning":"boom"}');
    expect(result.action).toBe("wait");
  });

  it("parses bare JSON (no code fence)", () => {
    const result = parseReasoningResponse('{"action":"notify","message":"hello","reasoning":"greet"}');
    expect(result.action).toBe("notify");
    expect(result.message).toBe("hello");
  });
});
