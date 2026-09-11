import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCore, workspacePolicyFor } from "./agent-core.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { createObservation } from "./observation-types.js";
import { parseReasoningResponse, buildReasoningPrompt } from "./reasoning-prompt.js";
import { readFileSync } from "node:fs";
import { BuildStateObserver } from "./observers/build-state-observer.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

describe("AgentCore — an aborted tick must not destroy the batch it collected (audited 2026-09-02)", () => {
  it("provider throws after a latching observer reported the broken build → the observation comes back on a later tick", async () => {
    vi.useFakeTimers();
    try {
      // The REAL engine + the REAL BuildStateObserver: collect() latches lastReportedState, so a
      // still-broken build is reported exactly once. If the tick that consumed it then aborts,
      // nothing re-queues it and the agent stays silent about the broken build.
      const engine = new ObservationEngine();
      engine.register(
        new BuildStateObserver({
          getState: () => ({ pendingFiles: new Set(["Player.cs"]), hasCompilableChanges: true, lastBuildOk: false }),
        }),
      );
      const scorer = new PriorityScorer();
      const provider = { chat: vi.fn().mockRejectedValue(new Error("provider outage")) };
      const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
      const channel = { sendText: vi.fn() };
      const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
      const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10 });

      await core.tick(); // tick 1: the build observation reached the LLM call, which threw
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(taskManager.submit).not.toHaveBeenCalled();

      // The provider recovers; the build is STILL broken (observer stays latched → returns []).
      provider.chat.mockResolvedValue({
        text: '```json\n{"action":"execute","goal":"Fix the build","reasoning":"build is red"}\n```',
        toolCalls: [],
        stopReason: "end_turn",
      });
      vi.advanceTimersByTime(61_000); // past the engine's dedup window and the re-queue delay
      await core.tick();

      // The unacted observation was put back, so the recovered provider sees it and acts.
      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(taskManager.submit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentCore — a goal about the working tree runs in the working tree (2026-09-10)", () => {
  it("a git observation's goal is submitted with workspacePolicy 'none'; a build observation's goal keeps the lease", async () => {
    const run = async (source: "git" | "build", summary: string, goal = "Look into it", extra: Array<["git" | "build", string, number]> = []) => {
      const engine = new ObservationEngine();
      engine.register({ name: `fake-${source}`, collect: () => [
        createObservation(source, summary, { priority: 90 }),
        ...extra.map(([src, text, priority]) => createObservation(src, text, { priority })),
      ] });
      const scorer = new PriorityScorer();
      const provider = { chat: vi.fn().mockResolvedValue({
        text: '```json\n{"action":"execute","goal":"' + goal + '","reasoning":"worth a look"}\n```',
        toolCalls: [],
        stopReason: "end_turn",
      }) };
      const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
      const channel = { sendText: vi.fn() };
      const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
      const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10 });
      await core.tick();
      expect(taskManager.submit).toHaveBeenCalledTimes(1);
      return taskManager.submit.mock.calls[0]![3];
    };
    // Measured 22:31: "investigate the 1118 uncommitted changes" ran in a
    // worktree lease seeded from HEAD and reported a clean tree.
    expect(await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 1118 — 1000 untracked", "Investigate the uncommitted changes and categorize them")).toMatchObject({ origin: "daemon", workspacePolicy: "none" });
    const build = await run("build", "Build broken: 3 compile errors");
    expect(build).toMatchObject({ origin: "daemon" });
    expect(build.workspacePolicy).toBeUndefined();
    // The goal's subject decides, not the top-ranked observation (Codex 2026-09-11 #9):
    // a build observation outranks a git one, yet the chosen goal is about the working tree.
    const goalAboutTree = await run("build", "Build broken: 3 compile errors", "Investigate the uncommitted working-tree changes", [["git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", 60]]);
    expect(goalAboutTree).toMatchObject({ workspacePolicy: "none" });
    // …and a build goal keeps its lease even when a git observation was on the list.
    const goalAboutBuild = await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", "Fix the compile errors in Board.cs", [["build", "Build broken: 3 compile errors", 60]]);
    expect(goalAboutBuild.workspacePolicy).toBeUndefined();
    // "Review the staged changes" is about the tree; "Add a git status button"
    // is ordinary work that merely says git (Codex 2026-09-11 C#27).
    const staged = await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", "Review the staged changes and say what they touch");
    expect(staged).toMatchObject({ workspacePolicy: "none" });
    const feature = await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", "Add a git status button to the dashboard");
    expect(feature.workspacePolicy).toBeUndefined();
    // "write a summary" is the REPORT, not implementation (Codex 2026-09-11 D#17).
    const summary = await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", "Review the staged changes and write a summary");
    expect(summary).toMatchObject({ workspacePolicy: "none" });
    const writesCode = await run("git", "Uncommitted changes in the project's working tree (outside Strada's own output): 40", "Write a git status panel component");
    expect(writesCode.workspacePolicy).toBeUndefined();
  });
});

describe("AgentCore", () => {
  it("skips tick when no observations", async () => {
    const engine = new ObservationEngine();
    const scorer = new PriorityScorer();
    const provider = { chat: vi.fn() };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) }; // 10% used

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget);
    await core.tick();

    expect(provider.chat).not.toHaveBeenCalled(); // No observations = no LLM call
  });

  it("skips tick when budget floor reached", async () => {
    const engine = new ObservationEngine();
    const scorer = new PriorityScorer();
    const provider = { chat: vi.fn() };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 9.5, limitUsd: 10, pct: 0.95 }) }; // 95% used (decimal)

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget);
    await core.tick();

    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("skips tick while every provider is cooling down, keeping the observations", async () => {
    // Measured 2026-09-08 01:12-01:16: a tick error every two minutes into a cooled chain.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("ac-cool");
    registry.recordOverloaded("ac-cool", "quota wall");
    setLiveChainMemberNames(["ac-cool"]);
    try {
      const engine = new ObservationEngine();
      engine.register({ name: "test", collect: () => [createObservation("build", "Build failed", { priority: 90 })] });
      const scorer = new PriorityScorer();
      const provider = { chat: vi.fn() };
      const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn() };
      const channel = { sendText: vi.fn() };
      const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
      const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0 });
      await core.tick();
      expect(provider.chat).not.toHaveBeenCalled();
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("ac-cool");
    }
  });

  it("skips tick when rate limited", async () => {
    vi.useFakeTimers();
    const engine = new ObservationEngine();
    engine.register({ name: "test", collect: () => [createObservation("build", "Build failed", { priority: 90 })] });
    const scorer = new PriorityScorer();
    const provider = {
      chat: vi.fn().mockResolvedValue({ text: '```json\n{"action":"wait","reasoning":"ok"}\n```', toolCalls: [], stopReason: "end_turn" }),
    };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 60_000, minObservationPriority: 30, budgetFloorPct: 10 });

    // Advance past the initial lastReasoningMs guard
    vi.advanceTimersByTime(61_000);

    await core.tick(); // First tick — LLM called (past rate limit window)
    expect(provider.chat).toHaveBeenCalledTimes(1);

    await core.tick(); // Second immediate tick — rate limited
    expect(provider.chat).toHaveBeenCalledTimes(1); // Still 1

    vi.useRealTimers();
  });

  it("prevents concurrent ticks", async () => {
    const engine = new ObservationEngine();
    engine.register({ name: "test", collect: () => [createObservation("build", "Fail", { priority: 90 })] });
    const scorer = new PriorityScorer();

    let resolveChat: (v: any) => void;
    const chatPromise = new Promise(r => { resolveChat = r; });
    const provider = { chat: vi.fn().mockReturnValue(chatPromise) };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 0, limitUsd: 10, pct: 0.0 }) }; // 0% used (decimal)

    // minReasoningIntervalMs: 0 bypasses rate limit, but lastReasoningMs starts at Date.now()
    // so we need interval=0 to ensure first tick passes
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
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) }; // 10% used (decimal)

    const core = new AgentCore(engine, scorer, provider as any, taskManager as any, channel as any, budget, undefined, { minReasoningIntervalMs: 0, minObservationPriority: 0, budgetFloorPct: 10 });
    await core.tick();

    expect(taskManager.submit).toHaveBeenCalledWith(
      "agent-core",
      "daemon",
      "Fix the build error in src/foo.cs",
      { origin: "daemon" },
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

  it("handles all 7 action types", () => {
    expect(parseReasoningResponse('{"action":"execute","goal":"x","reasoning":"y"}').action).toBe("execute");
    expect(parseReasoningResponse('{"action":"wait","reasoning":"y"}').action).toBe("wait");
    expect(parseReasoningResponse('{"action":"notify","message":"x","reasoning":"y"}').action).toBe("notify");
    expect(parseReasoningResponse('{"action":"escalate","question":"x","reasoning":"y"}').action).toBe("escalate");
    expect(parseReasoningResponse('{"action":"batch","batchObservationIds":["id1"],"goal":"x","reasoning":"y"}').action).toBe("batch");
    expect(parseReasoningResponse('{"action":"defer","deferMinutes":10,"reasoning":"y"}').action).toBe("defer");
    expect(parseReasoningResponse('{"action":"adjust","adjustments":{"priorityThreshold":50},"reasoning":"y"}').action).toBe("adjust");
  });

  it("parses batch action with batchObservationIds", () => {
    const result = parseReasoningResponse('{"action":"batch","batchObservationIds":["a","b","c"],"goal":"fix all","reasoning":"related"}');
    expect(result.action).toBe("batch");
    expect(result.batchObservationIds).toEqual(["a", "b", "c"]);
    expect(result.goal).toBe("fix all");
  });

  it("clamps batchObservationIds to max 20", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    const result = parseReasoningResponse(JSON.stringify({ action: "batch", batchObservationIds: ids, goal: "big batch", reasoning: "many" }));
    expect(result.batchObservationIds).toHaveLength(20);
  });

  it("parses defer action with deferMinutes", () => {
    const result = parseReasoningResponse('{"action":"defer","deferMinutes":15,"reasoning":"not urgent"}');
    expect(result.action).toBe("defer");
    expect(result.deferMinutes).toBe(15);
  });

  it("clamps deferMinutes 0 -> 1", () => {
    const result = parseReasoningResponse('{"action":"defer","deferMinutes":0,"reasoning":"min"}');
    expect(result.deferMinutes).toBe(1);
  });

  it("clamps deferMinutes 999 -> 120", () => {
    const result = parseReasoningResponse('{"action":"defer","deferMinutes":999,"reasoning":"max"}');
    expect(result.deferMinutes).toBe(120);
  });

  it("parses adjust action with adjustments", () => {
    const result = parseReasoningResponse('{"action":"adjust","adjustments":{"priorityThreshold":50,"sourceBoost":{"source":"build","delta":10},"reasoningIntervalMs":15000},"reasoning":"tune"}');
    expect(result.action).toBe("adjust");
    expect(result.adjustments).toEqual({
      priorityThreshold: 50,
      sourceBoost: { source: "build", delta: 10 },
      reasoningIntervalMs: 15000,
    });
  });

  it("clamps priorityThreshold 200 -> 100", () => {
    const result = parseReasoningResponse('{"action":"adjust","adjustments":{"priorityThreshold":200},"reasoning":"high"}');
    expect(result.adjustments!.priorityThreshold).toBe(100);
  });

  it("clamps reasoningIntervalMs 100 -> 5000", () => {
    const result = parseReasoningResponse('{"action":"adjust","adjustments":{"reasoningIntervalMs":100},"reasoning":"fast"}');
    expect(result.adjustments!.reasoningIntervalMs).toBe(5000);
  });
});

describe("buildReasoningPrompt", () => {
  it("includes observations in prompt", () => {
    const obs = createObservation("build", "Build failed", { priority: 90 });
    const prompt = buildReasoningPrompt({
      observations: [obs],
      budgetRemainingPct: 80,
      activeTaskCount: 0,
      activeForegroundTaskCount: 0,
      learnedInsights: [],
      recentHistory: [],
    });
    expect(prompt).toContain("Build failed");
    expect(prompt).toContain("Budget remaining: 80%");
    expect(prompt).toContain("Foreground user tasks: 0");
  });

  it("includes learned insights", () => {
    const prompt = buildReasoningPrompt({
      observations: [createObservation("git", "changes")],
      budgetRemainingPct: 90,
      activeTaskCount: 0,
      activeForegroundTaskCount: 1,
      learnedInsights: ["Always run tests after build"],
      recentHistory: [],
    });
    expect(prompt).toContain("Always run tests after build");
    expect(prompt).toContain("avoid notify/escalate unless the situation is truly urgent");
  });
});

describe("PriorityScorer", () => {
  it("deduplicates recently acted observations (0-60s band)", async () => {
    const scorer = new PriorityScorer();
    // build source: base 80 + source severity 10 = 90, actionable + >50 → +5 = 95
    const obs = createObservation("build", "Build failed", { priority: 80 });

    const before = await scorer.scoreAll([obs]);
    expect(before[0]!.priority).toBe(95); // 80 + 10 source + 5 actionability

    scorer.recordAction(obs);

    // After recordAction (0-60s): 80 + 10 - 30 = 60, actionable + >50 → +5 = 65
    const after = await scorer.scoreAll([obs]);
    expect(after[0]!.priority).toBe(65);
  });

  it("sorts by priority descending", async () => {
    const scorer = new PriorityScorer();
    const low = createObservation("user", "idle", { priority: 20 });
    const high = createObservation("build", "fail", { priority: 90 });

    const result = await scorer.scoreAll([low, high]);
    expect(result[0]!.priority).toBeGreaterThan(result[1]!.priority);
  });

  it("source severity: build gets boosted more than file-watch", async () => {
    const scorer = new PriorityScorer();
    const buildObs = createObservation("build", "Build failed", { priority: 50 });
    const fileObs = createObservation("file-watch", "File changed", { priority: 50 });

    const result = await scorer.scoreAll([fileObs, buildObs]);
    // build: 50 + 10 = 60, actionable >50 → +5 = 65
    // file-watch: 50 + 0 = 50, actionable but not >50 → 50
    expect(result[0]!.source).toBe("build");
    expect(result[0]!.priority).toBe(65);
    expect(result[1]!.source).toBe("file-watch");
    expect(result[1]!.priority).toBe(50);
  });

  it("graduated recency: 0-60s = -30, 60-180s = -20, 180-300s = -10", async () => {
    vi.useFakeTimers();
    const scorer = new PriorityScorer();
    // Use file-watch source (0 severity) and non-actionable to isolate recency factor
    const obs = createObservation("file-watch", "File changed", { priority: 60, actionable: false });

    scorer.recordAction(obs);

    // 0-60s band: -30 → 60 - 30 = 30
    const at0s = await scorer.scoreAll([obs]);
    expect(at0s[0]!.priority).toBe(30);

    // 60-180s band: -20 → 60 - 20 = 40
    vi.advanceTimersByTime(90_000); // 90s elapsed
    const at90s = await scorer.scoreAll([obs]);
    expect(at90s[0]!.priority).toBe(40);

    // 180-300s band: -10 → 60 - 10 = 50
    vi.advanceTimersByTime(120_000); // 210s total
    const at210s = await scorer.scoreAll([obs]);
    expect(at210s[0]!.priority).toBe(50);

    // Beyond 300s: no penalty → 60
    vi.advanceTimersByTime(120_000); // 330s total
    const at330s = await scorer.scoreAll([obs]);
    expect(at330s[0]!.priority).toBe(60);

    vi.useRealTimers();
  });

  it("instinct match count: 1 = +8, 2 = +12, 3+ = +15", async () => {
    const makeRetriever = (insightCount: number): any => ({
      getInsightsForTask: vi.fn().mockResolvedValue({
        insights: Array.from({ length: insightCount }, (_, i) => `insight-${i}`),
        matchedInstinctIds: [],
      }),
    });

    // Use file-watch source (0 severity), non-actionable to isolate instinct factor
    const obs = createObservation("file-watch", "File changed", { priority: 40, actionable: false });

    const scorer1 = new PriorityScorer(makeRetriever(1));
    const result1 = await scorer1.scoreAll([obs]);
    expect(result1[0]!.priority).toBe(48); // 40 + 8

    const scorer2 = new PriorityScorer(makeRetriever(2));
    const result2 = await scorer2.scoreAll([obs]);
    expect(result2[0]!.priority).toBe(52); // 40 + 12

    const scorer3 = new PriorityScorer(makeRetriever(4));
    const result3 = await scorer3.scoreAll([obs]);
    expect(result3[0]!.priority).toBe(55); // 40 + 15
  });

  it("actionability: actionable high-priority gets +5, non-actionable does not", async () => {
    const scorer = new PriorityScorer();
    // Use file-watch (0 severity) to isolate actionability
    const actionable = createObservation("file-watch", "File changed", { priority: 55, actionable: true });
    const nonActionable = createObservation("file-watch", "File changed too", { priority: 55, actionable: false });

    const result = await scorer.scoreAll([actionable, nonActionable]);
    // actionable: 55 + 0 source = 55, actionable + >50 → +5 = 60
    // non-actionable: 55 + 0 source = 55, no boost = 55
    expect(result[0]!.priority).toBe(60);
    expect(result[0]!.actionable).toBe(true);
    expect(result[1]!.priority).toBe(55);
    expect(result[1]!.actionable).toBe(false);
  });

  it("actionability: no boost when priority <= 50", async () => {
    const scorer = new PriorityScorer();
    const obs = createObservation("file-watch", "File changed", { priority: 45, actionable: true });

    const result = await scorer.scoreAll([obs]);
    // 45 + 0 source = 45, actionable but not >50 → no boost = 45
    expect(result[0]!.priority).toBe(45);
  });
});

describe("workspacePolicyFor — describing the tree, or building in it (Codex 2026-09-11 E#13, E#14, G#9)", () => {
  const git = [{ source: "git" }];
  const none = { workspacePolicy: "none" };

  it("runs in the REAL tree for anything that describes the tree's state", () => {
    // A lease seeded from HEAD reports a clean tree, which is a false answer.
    for (const goal of [
      "Investigate the uncommitted changes and categorize them",
      "Review the staged changes and write a summary",
      "Review the staged changes and write  a summary",
      "Review the staged changes and write the report",
      "Document the uncommitted changes in docs/status.md",
      "Give me a note about the working tree",
      "List the untracked files",
      "Explain the git diff",
    ]) {
      expect(workspacePolicyFor(git, goal)).toEqual(none);
    }
  });

  it("a goal that says it changes nothing, or that OPENS with a describing verb, reads the real tree (Codex 2026-09-11 I#14)", () => {
    // "fix" belongs to the thing being reviewed, not to the work.
    expect(workspacePolicyFor(git, "Review the uncommitted fix for crashes. Do not change files.")).toEqual(none);
    expect(workspacePolicyFor(git, "Review the uncommitted fix for crashes")).toEqual(none);
    expect(workspacePolicyFor(git, "Investigate the staged changes that add the new loader")).toEqual(none);
    expect(workspacePolicyFor(git, "Audit the working tree and list what the refactor touched")).toEqual(none);
    expect(workspacePolicyFor(git, "Implement the loader without changing the uncommitted work")).toEqual(none);
    // …and an ordinary implementation goal still keeps its lease, including
    // one that mentions reviewing LATER in the sentence: the goal's own verb
    // is the one at the front.
    expect(workspacePolicyFor(git, "Fix the uncommitted-changes observer")).toEqual({});
    expect(workspacePolicyFor(git, "Implement the loader, then review the staged changes it produces")).toEqual({});
  });

  it("keeps the lease when the goal BUILDS something, whatever else it says", () => {
    for (const goal of [
      "Implement a git status panel",
      "Implement a git status panel and write a report of the implementation",
      "Add a stash browser to the dashboard",
      "Fix the uncommitted-changes observer",
      "Refactor the working-tree scanner",
    ]) {
      expect(workspacePolicyFor(git, goal)).toEqual({});
    }
  });

  it("a tree word used as a NOUN PHRASE is a feature name, not the tree", () => {
    // "the git status panel" is a component; documenting it is ordinary work.
    expect(workspacePolicyFor(git, "Document the git status panel in docs/panel.md")).toEqual({});
    expect(workspacePolicyFor(git, "Document the git diff viewer in docs/viewer.md")).toEqual({});
    expect(workspacePolicyFor(git, "Describe the git status command we expose")).toEqual({});
    // …while the same verb about the tree ITSELF runs in the tree.
    expect(workspacePolicyFor(git, "Document the uncommitted changes")).toEqual(none);
  });

  it("leaves every other goal alone", () => {
    expect(workspacePolicyFor([{ source: "build" }], "Investigate the uncommitted changes")).toEqual({});
    expect(workspacePolicyFor(git, "Investigate the failing build")).toEqual({});
    expect(workspacePolicyFor([], "Investigate the uncommitted changes")).toEqual({});
  });
});

describe("parseReasoningResponse marks a reply it could not read (Codex 2026-09-11 F#13)", () => {
  it("separates a malformed answer from a deliberate wait", () => {
    for (const text of ["", null, undefined, "I think we should hold off for now.", '```json\n{"action":"wait"\n```', '```json\n{"action":"fly"}\n```']) {
      const decision = parseReasoningResponse(text as string | null | undefined);
      expect(decision.action).toBe("wait");
      expect(decision.unparsed).toBe(true);
    }
    // A real wait is a decision and carries no flag.
    const real = parseReasoningResponse('```json\n{"action":"wait","reasoning":"nothing actionable"}\n```');
    expect(real).toMatchObject({ action: "wait", reasoning: "nothing actionable" });
    expect(real.unparsed).toBeUndefined();
  });

  it("puts the observations back rather than consuming them on an unreadable reply", () => {
    const source = readFileSync("src/agent-core/agent-core.ts", "utf8");
    const at = source.indexOf('case "wait":');
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at, at + 1800);
    expect(block).toContain("decision.unparsed === true");
    expect(block).toContain("this.requeueUnacted(batch, ");
    expect(block).toContain("unparsed-decision");
    // …and the requeue is BOUNDED (Codex 2026-09-11 H#15).
    expect(block).toContain("this.chargeUnparsed(batch)");
  });
});

describe("a reply with no decision in it is not a decision (Codex 2026-09-11 H#14)", () => {
  it("flags an empty object, an array and a missing action", () => {
    for (const body of ["{}", "[]", '{"reasoning":"repair build"}', '{"action":""}', '{"action":"   "}', '[{"action":"execute"}]']) {
      const decision = parseReasoningResponse(`\`\`\`json\n${body}\n\`\`\``);
      expect(decision.action).toBe("wait");
      expect(decision.unparsed).toBe(true);
    }
    // An explicit action is still honoured.
    expect(parseReasoningResponse('```json\n{"action":"execute","goal":"fix the build","reasoning":"red"}\n```'))
      .toMatchObject({ action: "execute", goal: "fix the build" });
  });
});

describe("unreadable reasoning is bounded (Codex 2026-09-11 H#15)", () => {
  it("stops requeueing after a few rounds and says so once", async () => {
    const engine = new ObservationEngine();
    engine.register({ name: "fake-test", collect: () => [createObservation("test", "SaveGame_RoundTrip failing", { priority: 90, actionable: true })] });
    const provider = { chat: vi.fn().mockResolvedValue({ text: "not JSON at all", toolCalls: [], stopReason: "end_turn" }) };
    const taskManager = { submit: vi.fn().mockReturnValue({ id: "task_mock01" }), listTasks: vi.fn().mockReturnValue([]), getStatus: vi.fn().mockReturnValue(null) };
    const channel = { sendText: vi.fn() };
    const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
    const core = new AgentCore(engine, new PriorityScorer(), provider as any, taskManager as any, channel as any, budget, undefined, {
      minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10,
    });
    const deferred: Array<{ minutes: number }> = [];
    const realDefer = engine.defer.bind(engine);
    vi.spyOn(engine, "defer").mockImplementation((obs: never, minutes: number) => {
      deferred.push({ minutes });
      return realDefer(obs, minutes);
    });

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 6; i++) {
        await core.tick();
        // Past the one-minute requeue, so the same observation comes back.
        vi.advanceTimersByTime(2 * 60_000);
      }
    } finally {
      vi.useRealTimers();
    }

    expect(taskManager.submit).not.toHaveBeenCalled();
    // The first rounds put it back quickly; once the patience is spent the
    // recheck is an hour and the trouble is reported exactly once.
    expect(deferred.some((d) => d.minutes >= 60)).toBe(true);
    expect(channel.sendText.mock.calls.filter((c: unknown[]) => String(c[1]).includes("could not read my own reasoning"))).toHaveLength(1);
  });
});
