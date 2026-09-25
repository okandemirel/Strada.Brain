/**
 * LRN-20: learned instincts stay advisory. Nothing in the learning loop
 * advances an instinct's trust level (InterventionEngine.advanceTrust is
 * deliberately unwired), so however well a learned rule scores it resolves to
 * the passive tier. Only seeded / curated rules can warn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import { InterventionEngine } from "./intervention-engine.ts";
import { seedStradaConventions, STRADA_SEEDS } from "../seeds/strada-core-seeds.ts";
import { TypedEventBus, type LearningEventMap } from "../../core/event-bus.ts";
import type { Instinct } from "../types.ts";

let storage: LearningStorage;
let bus: TypedEventBus<LearningEventMap>;
let pipeline: LearningPipeline;
let engine: InterventionEngine;

beforeEach(() => {
  storage = new LearningStorage(":memory:");
  storage.initialize();
  bus = new TypedEventBus<LearningEventMap>();
  pipeline = new LearningPipeline(storage, { enabled: true }, undefined, undefined, bus);
  engine = new InterventionEngine(storage);
});

afterEach(() => {
  pipeline.stop();
  storage.close();
});

async function learnAndReinforce(): Promise<Instinct> {
  const learned = await pipeline.considerInstinctCreation({
    type: "error_fix",
    triggerPattern: "error CS0246: The type or namespace name 'EnemyView' could not be found",
    action: "Add the missing using directive for the Game.Views namespace",
    toolName: "dotnet_build",
  });
  expect(learned).not.toBeNull();
  const id = learned!.id;

  // Many runs that applied the rule and ended in a clean success...
  for (let run = 0; run < 40; run++) {
    const runId = `run-${run}`;
    await pipeline.handleToolResult({
      sessionId: "chat-1",
      toolName: "dotnet_build",
      input: { project: "Game.csproj" },
      output: "Build succeeded",
      success: true,
      taskRunId: runId,
      appliedInstinctIds: [id],
      timestamp: Date.now(),
    });
    pipeline.clearRunInstinctCredits("chat-1", { success: true, verdictScore: 1 }, runId);
  }
  // ...and repeated positive feedback from the user.
  for (let i = 0; i < 20; i++) {
    bus.emit("feedback:reaction", {
      type: "thumbs_up",
      instinctIds: [id],
      userId: "user-1",
      source: "reaction",
      channel: "web",
      timestamp: Date.now(),
    });
  }
  return storage.getInstinct(id)!;
}

describe("learned instincts never escalate past the passive tier (LRN-20)", () => {
  it("a well-reinforced learned instinct still resolves to passive", async () => {
    const instinct = await learnAndReinforce();

    // Not vacuous: the evidence carried the rule to the lifecycle and confidence
    // that would auto-apply it if its trust were ever advanced.
    // (A permanent rule's stats freeze, so not every run is counted.)
    expect(instinct.stats.timesApplied).toBeGreaterThanOrEqual(20);
    expect(instinct.status).toBe("permanent");
    expect(instinct.confidence).toBeGreaterThan(0.8);
    expect(engine.evaluate("dotnet_build", {}, [{ ...instinct, trustLevel: "auto_enabled" }]).action).toBe("auto_apply");

    expect(instinct.trustLevel ?? "new").toBe("new");
    const result = engine.evaluate("dotnet_build", {}, [instinct]);
    expect(result.matches.map((m) => m.tier)).toEqual(["passive"]);
    expect(result.action).toBe("enrich");
  });

  it("a curated seed rule can still warn", async () => {
    await seedStradaConventions(storage);
    const seed = storage.getInstinctByPattern(STRADA_SEEDS[0]!.pattern, "global");
    expect(seed).not.toBeNull();

    expect(engine.evaluate("file_write", {}, [seed!]).action).toBe("warn");
  });
});
