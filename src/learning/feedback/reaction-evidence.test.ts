/**
 * LRN-10: a reaction is evidence once per person, rule and direction.
 *
 * Every reaction event used to apply full evidence to every rule the channel
 * had applied, with no identity and no de-duplication, so one member could
 * toggle an emoji until a rule crossed any threshold in either direction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../storage/learning-storage.ts";
import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import { TypedEventBus, type FeedbackReactionEvent } from "../../core/event-bus.ts";
import type { Instinct } from "../types.ts";
import type { TimestampMs } from "../../types/index.ts";

let dir: string;
let dbPath: string;
let storage: LearningStorage;

function rule(id: string): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id,
    name: id,
    type: "tool_usage",
    status: "active",
    confidence: 0.6,
    triggerPattern: `trigger for ${id}`,
    action: "run the unity verification step",
    contextConditions: [],
    stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8, averageExecutionMs: 0 },
    bayesianAlpha: 3,
    bayesianBeta: 2,
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
  } as unknown as Instinct;
}

function reaction(type: FeedbackReactionEvent["type"], instinctIds: string[], userId?: string): FeedbackReactionEvent {
  return {
    type,
    instinctIds,
    ...(userId === undefined ? {} : { userId }),
    source: "reaction",
    channel: "discord",
    timestamp: Date.now(),
  };
}

function stack(): { eventBus: TypedEventBus; pipeline: LearningPipeline } {
  const eventBus = new TypedEventBus();
  const pipeline = new LearningPipeline(storage, {}, undefined, undefined, eventBus);
  return { eventBus, pipeline };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reaction-evidence-"));
  dbPath = join(dir, "learning.db");
  storage = new LearningStorage(dbPath);
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reaction evidence (LRN-10)", () => {
  it("fifty thumbs-up from one person move alpha by at most one reaction's worth", () => {
    const { eventBus, pipeline } = stack();
    storage.createInstinct(rule("rule_spammed"));

    for (let i = 0; i < 50; i++) eventBus.emit("feedback:reaction", reaction("thumbs_up", ["rule_spammed"], "mallory"));

    const after = storage.getInstinct("rule_spammed")!;
    expect(after.bayesianAlpha! - 3).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(after.bayesianAlpha!).toBeGreaterThan(3);
    pipeline.stop();
  });

  it("repeated thumbs-down from one person count once", () => {
    const { eventBus, pipeline } = stack();
    storage.createInstinct(rule("rule_downvoted"));

    for (let i = 0; i < 20; i++) eventBus.emit("feedback:reaction", reaction("thumbs_down", ["rule_downvoted"], "mallory"));

    expect(storage.getInstinct("rule_downvoted")!.bayesianBeta!).toBeCloseTo(3, 9);
    pipeline.stop();
  });

  it("a reaction nobody can be named for moves nothing, and a second person still counts", () => {
    const { eventBus, pipeline } = stack();
    storage.createInstinct(rule("rule_anonymous"));

    eventBus.emit("feedback:reaction", reaction("thumbs_down", ["rule_anonymous"]));
    eventBus.emit("feedback:reaction", reaction("thumbs_down", ["rule_anonymous"], "  "));
    expect(storage.getInstinct("rule_anonymous")!.bayesianBeta!).toBe(2);

    eventBus.emit("feedback:reaction", reaction("thumbs_down", ["rule_anonymous"], "alice"));
    eventBus.emit("feedback:reaction", reaction("thumbs_down", ["rule_anonymous"], "bob"));
    expect(storage.getInstinct("rule_anonymous")!.bayesianBeta!).toBe(4);
    pipeline.stop();
  });

  it("the de-duplication survives a restart", () => {
    const first = stack();
    storage.createInstinct(rule("rule_restart"));
    first.eventBus.emit("feedback:reaction", reaction("thumbs_up", ["rule_restart"], "mallory"));
    first.pipeline.stop();
    storage.close();

    storage = new LearningStorage(dbPath);
    storage.initialize();
    const second = stack();
    second.eventBus.emit("feedback:reaction", reaction("thumbs_up", ["rule_restart"], "mallory"));

    expect(storage.getInstinct("rule_restart")!.bayesianAlpha!).toBeCloseTo(3.5, 9);
    second.pipeline.stop();
  });
});
