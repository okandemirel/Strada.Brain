/**
 * LRN-2: promotion to permanent and runtime-artifact materialization must be
 * reachable through normal evidence, and not through reactions alone.
 *
 * The configured 0.95 bar sat above what verdict-weighted evidence can reach
 * (a flawless record of clean runs tends to about 0.913), so promotion never
 * happened, while a barely observed rule inflated by thumbs-up was the only
 * kind that could cross it and be materialized.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.ts";
import { LearningPipeline, reachableAutoEvolveBar } from "./pipeline/learning-pipeline.ts";
import { ConfidenceScorer } from "./scoring/confidence-scorer.ts";
import { TypedEventBus } from "../core/event-bus.ts";
import type { BayesianConfig, Instinct } from "./types.ts";
import type { TimestampMs } from "../types/index.ts";

let dir: string;
let storage: LearningStorage;

function rule(id: string, stats: { applied: number; failed: number }, confidence = 0.5): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id,
    name: id,
    type: "tool_usage",
    status: "active",
    confidence,
    triggerPattern: `trigger for ${id}`,
    action: "read error -> inspect files -> dotnet build",
    contextConditions: [],
    stats: {
      timesSuggested: stats.applied + stats.failed,
      timesApplied: stats.applied,
      timesFailed: stats.failed,
      successRate: stats.applied + stats.failed === 0 ? 0 : stats.applied / (stats.applied + stats.failed),
      averageExecutionMs: 0,
    },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
  } as unknown as Instinct;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "promotion-reachable-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("promotion and evolution are reachable (LRN-2)", () => {
  it("a rule with a flawless record is promoted and materialized after a bounded number of clean runs", () => {
    const pipeline = new LearningPipeline(storage);
    const scorer = new ConfidenceScorer();
    storage.createInstinct(rule("rule_clean_record", { applied: 0, failed: 0 }));

    let promotedAfter: number | null = null;
    for (let run = 1; run <= 60 && promotedAfter === null; run++) {
      const current = storage.getInstinct("rule_clean_record")!;
      // What a run's clean terminal credit does: a verdict-weighted update, then the lifecycle.
      pipeline.updateInstinctStatus(scorer.updateConfidence(current, true, 0.9));
      if (storage.getInstinct("rule_clean_record")!.status === "permanent") promotedAfter = run;
    }

    // Exactly the observation minimum: the bar is what that record reaches.
    expect(promotedAfter).toBe(25);
    expect(pipeline.runEvolution()).toEqual({ proposals: 1, artifacts: 1 });
    expect(storage.getRuntimeArtifacts({ states: ["shadow"] })).toHaveLength(1);
  });

  it("a rule with a failing record is not promoted", () => {
    const pipeline = new LearningPipeline(storage);
    const scorer = new ConfidenceScorer();
    storage.createInstinct(rule("rule_mixed_record", { applied: 0, failed: 0 }));

    for (let run = 1; run <= 60; run++) {
      const current = storage.getInstinct("rule_mixed_record")!;
      const failed = run % 5 === 0;
      pipeline.updateInstinctStatus(scorer.updateConfidence(current, !failed, failed ? 0.2 : 0.9));
    }

    expect(storage.getInstinct("rule_mixed_record")!.status).toBe("active");
    expect(pipeline.runEvolution()).toEqual({ proposals: 0, artifacts: 0 });
  });

  it("a barely observed rule inflated by reactions alone is not materialized", () => {
    const eventBus = new TypedEventBus();
    const pipeline = new LearningPipeline(storage, {}, undefined, undefined, eventBus);
    storage.createInstinct(rule("rule_reaction_inflated", { applied: 3, failed: 0 }));

    // Distinct people, so this holds however reactions are de-duplicated.
    for (let i = 0; i < 60; i++) {
      eventBus.emit("feedback:reaction", {
        type: "thumbs_up",
        instinctIds: ["rule_reaction_inflated"],
        userId: `user-${i}`,
        source: "reaction",
        channel: "discord",
        timestamp: Date.now(),
      });
    }

    const inflated = storage.getInstinct("rule_reaction_inflated")!;
    expect(inflated.confidence).toBeGreaterThan(0.95);
    expect(inflated.status).toBe("active");
    expect(pipeline.runEvolution()).toEqual({ proposals: 0, artifacts: 0 });
    expect(storage.getRuntimeArtifacts({ states: ["shadow"] })).toHaveLength(0);
  });

  it("the bar honours a configured threshold that is reachable", () => {
    const scorer = new ConfidenceScorer();
    const config = {
      autoEvolveThreshold: 0.8,
      promotionMinObservations: 25,
      verdictCleanSuccess: 0.9,
    } as BayesianConfig;
    expect(reachableAutoEvolveBar(config, scorer)).toBe(0.8);
    // Out of reach: the flawless-record confidence instead.
    const unreachable = { ...config, autoEvolveThreshold: 0.95 } as BayesianConfig;
    const bar = reachableAutoEvolveBar(unreachable, scorer);
    expect(bar).toBeLessThan(0.95);
    expect(bar).toBeCloseTo(scorer.confidenceAfterCleanRuns(25, 0.9), 6);
  });
});
