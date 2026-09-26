/**
 * LRN-20: a learned instinct's trust level moves on explicit HUMAN signals
 * only, and never past warn_enabled.
 *
 * Phase 4 pinned the opposite: InterventionEngine.advanceTrust had no caller,
 * so a learned instinct stayed 'new' (passive) however it was reinforced, and
 * this file asserted that 40 successful applications plus 20 likes changed
 * nothing. The maintainer's decision is now to let people promote learned
 * rules, conservatively:
 *  - the agent's own successes, verdicts and confidence gains still change
 *    nothing (first test, the old assertion kept);
 *  - a person's approval of a run that applied the rule promotes it
 *    new → suggest_only → warn_enabled, once per person per run, and never to
 *    auto_enabled;
 *  - a rejection demotes one step;
 *  - curated seed rules keep the trust they were given.
 * The warn tier is advisory (orchestrator-intervention-warn.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/logger.js")>()),
  getLoggerSafe: () => log,
}));

import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import { InterventionEngine } from "./intervention-engine.ts";
import { seedStradaConventions, STRADA_SEEDS } from "../seeds/strada-core-seeds.ts";
import { TypedEventBus, type LearningEventMap } from "../../core/event-bus.ts";
import type { Instinct } from "../types.ts";

const ACTION = "Add the missing using directive for the Game.Views namespace";

let storage: LearningStorage;
let bus: TypedEventBus<LearningEventMap>;
let pipeline: LearningPipeline;
let engine: InterventionEngine;
let runs: number;

beforeEach(() => {
  storage = new LearningStorage(":memory:");
  storage.initialize();
  bus = new TypedEventBus<LearningEventMap>();
  pipeline = new LearningPipeline(storage, { enabled: true }, undefined, undefined, bus);
  engine = new InterventionEngine(storage);
  runs = 0;
  log.info.mockClear();
});

afterEach(() => {
  pipeline.stop();
  storage.close();
});

async function learn(): Promise<string> {
  const learned = await pipeline.considerInstinctCreation({
    type: "error_fix",
    triggerPattern: "error CS0246: The type or namespace name 'EnemyView' could not be found",
    action: ACTION,
    toolName: "dotnet_build",
  });
  expect(learned).not.toBeNull();
  return learned!.id;
}

/** One run that applied the instinct and ended in a clean success. */
async function applyInRun(id: string, toolName = "dotnet_build"): Promise<void> {
  const runId = `run-${runs++}`;
  await pipeline.handleToolResult({
    sessionId: "chat-1",
    toolName,
    input: { project: "Game.csproj" },
    output: "Build succeeded",
    success: true,
    taskRunId: runId,
    appliedInstinctIds: [id],
    timestamp: Date.now(),
  });
  pipeline.clearRunInstinctCredits("chat-1", { success: true, verdictScore: 1 }, runId);
}

function react(type: "thumbs_up" | "thumbs_down", id: string, userId: string | undefined): void {
  bus.emit("feedback:reaction", {
    type,
    instinctIds: [id],
    userId,
    source: "reaction",
    channel: "web",
    timestamp: Date.now(),
  });
}

function trust(id: string): string {
  return storage.getInstinct(id)!.trustLevel ?? "new";
}

describe("learned-instinct trust follows explicit human signals only (LRN-20)", () => {
  it("the agent's own successful applications alone do not change the trust level", async () => {
    const id = await learn();
    for (let run = 0; run < 40; run++) await applyInRun(id);
    const instinct: Instinct = storage.getInstinct(id)!;

    // Not vacuous: the evidence carried the rule to the lifecycle and confidence
    // that would auto-apply it if its trust allowed.
    expect(instinct.stats.timesApplied).toBeGreaterThanOrEqual(20);
    expect(instinct.status).toBe("permanent");
    expect(instinct.confidence).toBeGreaterThan(0.8);
    expect(engine.evaluate("dotnet_build", {}, [{ ...instinct, trustLevel: "auto_enabled" }]).action).toBe("auto_apply");

    expect(instinct.trustLevel ?? "new").toBe("new");
    const result = engine.evaluate("dotnet_build", {}, [instinct]);
    expect(result.matches.map((m) => m.tier)).toEqual(["passive"]);
    expect(result.action).toBe("enrich");
  });

  it("human approvals promote it to warn_enabled and never beyond", async () => {
    const id = await learn();

    await applyInRun(id);
    react("thumbs_up", id, "user-1");
    expect(trust(id)).toBe("suggest_only");

    await applyInRun(id);
    react("thumbs_up", id, "user-1");
    expect(trust(id)).toBe("suggest_only");

    await applyInRun(id);
    react("thumbs_up", id, "user-1");
    expect(trust(id)).toBe("warn_enabled");

    for (let run = 0; run < 30; run++) {
      await applyInRun(id);
      react("thumbs_up", id, "user-1");
    }
    const instinct = storage.getInstinct(id)!;
    expect(instinct.status).toBe("permanent");
    expect(instinct.confidence).toBeGreaterThan(0.8);
    expect(instinct.trustLevel).toBe("warn_enabled");
    // The rule's evidence alone would auto-apply it; its trust caps it at warn.
    expect(engine.evaluate("dotnet_build", {}, [instinct]).action).toBe("warn");

    // Each change is logged with ids and counts, never the rule's text.
    const changes = log.info.mock.calls.filter(([message]) => message === "Learned instinct trust level changed");
    expect(changes.map(([, meta]) => [meta?.["from"], meta?.["to"]])).toEqual([
      ["new", "suggest_only"],
      ["suggest_only", "warn_enabled"],
    ]);
    expect(changes[1]![1]).toMatchObject({ instinctId: id, approvals: 3, rejections: 0 });
    expect(JSON.stringify(changes)).not.toContain(ACTION);
  });

  it("one person's repeated reaction to one run counts once", async () => {
    const id = await learn();
    await applyInRun(id);
    for (let i = 0; i < 5; i++) react("thumbs_up", id, "user-1");
    expect(trust(id)).toBe("suggest_only");

    // Other people approving the same run are separate signals.
    react("thumbs_up", id, "user-2");
    expect(trust(id)).toBe("suggest_only");
    react("thumbs_up", id, "user-3");
    expect(trust(id)).toBe("warn_enabled");
  });

  it("a rejection demotes one step, and blocks re-promotion to warn while it is recent", async () => {
    const id = await learn();
    for (let run = 0; run < 3; run++) {
      await applyInRun(id);
      react("thumbs_up", id, "user-1");
    }
    expect(trust(id)).toBe("warn_enabled");

    await applyInRun(id);
    react("thumbs_down", id, "user-1");
    expect(trust(id)).toBe("suggest_only");

    for (let run = 0; run < 3; run++) {
      await applyInRun(id);
      react("thumbs_up", id, "user-1");
    }
    expect(trust(id)).toBe("suggest_only");

    await applyInRun(id);
    react("thumbs_down", id, "user-2");
    expect(trust(id)).toBe("new");
  });

  it("a reaction nobody can be named for, or on a rule no run applied, changes nothing", async () => {
    const id = await learn();
    react("thumbs_up", id, "user-1");
    expect(trust(id)).toBe("new");

    await applyInRun(id);
    react("thumbs_up", id, undefined);
    expect(trust(id)).toBe("new");
  });
});

describe("curated seed rules keep their trust (LRN-20)", () => {
  it("a curated seed rule can still warn, and reactions do not move its trust", async () => {
    await seedStradaConventions(storage);
    const seed = storage.getInstinctByPattern(STRADA_SEEDS[0]!.pattern, "global");
    expect(seed).not.toBeNull();
    expect(engine.evaluate("file_write", {}, [seed!]).action).toBe("warn");

    // Reactions to runs that applied it still move a seed's confidence; its
    // curated trust stays.
    await applyInRun(seed!.id, "file_write");
    expect(storage.getInstinctCredits({ instinctId: seed!.id }).some((c) => c.applied)).toBe(true);
    react("thumbs_down", seed!.id, "user-1");
    await applyInRun(seed!.id, "file_write");
    react("thumbs_up", seed!.id, "user-2");
    expect(storage.getInstinct(seed!.id)!.trustLevel).toBe(seed!.trustLevel);
  });
});
