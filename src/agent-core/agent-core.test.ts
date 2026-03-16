import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCore } from "./agent-core.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { createObservation } from "./observation-types.js";
import { parseReasoningResponse, buildReasoningPrompt } from "./reasoning-prompt.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

describe("AgentCore", () => {
  it("skips tick when no observations", async () => {
    const engine = new ObservationEngine();
    const scorer = new PriorityScorer();
    const provider = { chat: vi.fn() };
    const taskManager = { submit: vi.fn(), listTasks: vi.fn().mockReturnValue([]) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 10 }) };

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget);
    await core.tick();

    expect(provider.chat).not.toHaveBeenCalled(); // No observations = no LLM call
  });

  it("skips tick when budget floor reached", async () => {
    const engine = new ObservationEngine();
    const scorer = new PriorityScorer();
    const provider = { chat: vi.fn() };
    const taskManager = { submit: vi.fn(), listTasks: vi.fn().mockReturnValue([]) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 9.5, limitUsd: 10, pct: 95 }) }; // 95% used

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget);
    await core.tick();

    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("skips tick when rate limited", async () => {
    const engine = new ObservationEngine();
    engine.register({ name: "test", collect: () => [createObservation("build", "Build failed", { priority: 90 })] });
    const scorer = new PriorityScorer();
    const provider = {
      chat: vi.fn().mockResolvedValue({ text: '```json\n{"action":"wait","reasoning":"ok"}\n```', toolCalls: [], stopReason: "end_turn" }),
    };
    const taskManager = { submit: vi.fn(), listTasks: vi.fn().mockReturnValue([]) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 10 }) };

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 60_000, minObservationPriority: 30, budgetFloorPct: 10 });

    await core.tick(); // First tick — LLM called
    expect(provider.chat).toHaveBeenCalledTimes(1);

    await core.tick(); // Second immediate tick — rate limited
    expect(provider.chat).toHaveBeenCalledTimes(1); // Still 1
  });

  it("prevents concurrent ticks", async () => {
    const engine = new ObservationEngine();
    engine.register({ name: "test", collect: () => [createObservation("build", "Fail", { priority: 90 })] });
    const scorer = new PriorityScorer();

    let resolveChat: (v: any) => void;
    const chatPromise = new Promise(r => { resolveChat = r; });
    const provider = { chat: vi.fn().mockReturnValue(chatPromise) };
    const taskManager = { submit: vi.fn(), listTasks: vi.fn().mockReturnValue([]) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 0, limitUsd: 10, pct: 0 }) };

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0, minObservationPriority: 0, budgetFloorPct: 10 });

    const tick1 = core.tick(); // Starts, blocks on LLM
    expect(core.isTickInFlight()).toBe(true);

    await core.tick(); // Should return immediately (tickInFlight guard)
    expect(provider.chat).toHaveBeenCalledTimes(1); // Only 1 call

    resolveChat!({ text: '{"action":"wait","reasoning":"ok"}', toolCalls: [], stopReason: "end_turn" });
    await tick1;
    expect(core.isTickInFlight()).toBe(false);
  });

  it("submits goal on execute decision", async () => {
    const engine = new ObservationEngine();
    engine.register({ name: "test", collect: () => [createObservation("build", "Build failed", { priority: 90 })] });
    const scorer = new PriorityScorer();
    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: '```json\n{"action":"execute","goal":"Fix the build error in src/foo.cs","reasoning":"Build is broken"}\n```',
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };
    const taskManager = { submit: vi.fn(), listTasks: vi.fn().mockReturnValue([]) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 10 }) };

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0, minObservationPriority: 0, budgetFloorPct: 10 });
    await core.tick();

    expect(taskManager.submit).toHaveBeenCalledWith(
      "agent-core",
      "daemon",
      "Fix the build error in src/foo.cs",
    );
  });
});

describe("parseReasoningResponse", () => {
  it("parses json block response", () => {
    const result = parseReasoningResponse('Some text\n```json\n{"action":"execute","goal":"Fix it","reasoning":"broken"}\n```\nMore text');
    expect(result.action).toBe("execute");
    expect(result.goal).toBe("Fix it");
  });

  it("parses bare json response", () => {
    const result = parseReasoningResponse('{"action":"wait","reasoning":"nothing to do"}');
    expect(result.action).toBe("wait");
  });

  it("returns wait on null input", () => {
    expect(parseReasoningResponse(null).action).toBe("wait");
    expect(parseReasoningResponse(undefined).action).toBe("wait");
  });

  it("returns wait on unparseable input", () => {
    expect(parseReasoningResponse("just some text").action).toBe("wait");
  });

  it("returns wait on unknown action", () => {
    const result = parseReasoningResponse('{"action":"destroy","reasoning":"chaos"}');
    expect(result.action).toBe("wait");
  });

  it("handles all 4 action types", () => {
    expect(parseReasoningResponse('{"action":"execute","goal":"x","reasoning":"y"}').action).toBe("execute");
    expect(parseReasoningResponse('{"action":"wait","reasoning":"y"}').action).toBe("wait");
    expect(parseReasoningResponse('{"action":"notify","message":"x","reasoning":"y"}').action).toBe("notify");
    expect(parseReasoningResponse('{"action":"escalate","question":"x","reasoning":"y"}').action).toBe("escalate");
  });
});

describe("buildReasoningPrompt", () => {
  it("includes observations in prompt", () => {
    const obs = createObservation("build", "Build failed", { priority: 90 });
    const prompt = buildReasoningPrompt({
      observations: [obs],
      budgetRemainingPct: 80,
      activeTaskCount: 0,
      learnedInsights: [],
      recentHistory: [],
    });
    expect(prompt).toContain("Build failed");
    expect(prompt).toContain("Budget remaining: 80%");
  });

  it("includes learned insights", () => {
    const prompt = buildReasoningPrompt({
      observations: [createObservation("git", "changes")],
      budgetRemainingPct: 90,
      activeTaskCount: 0,
      learnedInsights: ["Always run tests after build"],
      recentHistory: [],
    });
    expect(prompt).toContain("Always run tests after build");
  });
});

describe("PriorityScorer", () => {
  it("deduplicates recently acted observations", async () => {
    const scorer = new PriorityScorer();
    const obs = createObservation("build", "Build failed", { priority: 80 });

    const before = await scorer.scoreAll([obs]);
    expect(before[0]!.priority).toBe(80);

    scorer.recordAction(obs);

    const after = await scorer.scoreAll([obs]);
    expect(after[0]!.priority).toBe(50); // 80 - 30 penalty
  });

  it("sorts by priority descending", async () => {
    const scorer = new PriorityScorer();
    const low = createObservation("user", "idle", { priority: 20 });
    const high = createObservation("build", "fail", { priority: 90 });

    const result = await scorer.scoreAll([low, high]);
    expect(result[0]!.priority).toBeGreaterThan(result[1]!.priority);
  });
});
