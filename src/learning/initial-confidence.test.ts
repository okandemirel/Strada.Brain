/**
 * LRN-3: a rule's stored confidence is where its evidence starts.
 *
 * Teachings (0.7) and seeds (0.65) are created with a confidence and no
 * alpha/beta. The first piece of evidence used to restart them from the flat
 * Beta(1,1) prior, so a thumbs-up, a successful application or a task the rule
 * helped with LOWERED its confidence and could demote it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.ts";
import { LearningPipeline } from "./pipeline/learning-pipeline.ts";
import { PatternMatcher } from "./matching/pattern-matcher.ts";
import { ConfidenceScorer, EVIDENCE_WEIGHTS } from "./scoring/confidence-scorer.ts";
import { ErrorLearningHooks, type ErrorContext } from "./hooks/error-learning-hooks.ts";
import type { Instinct } from "./types.ts";
import type { TimestampMs } from "../types/index.ts";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;
let hooks: ErrorLearningHooks;

const errorContext: ErrorContext = {
  toolName: "dotnet_build",
  errorOutput: "CS0246: The type or namespace name 'Foo' could not be found",
  analysis: { hasErrors: true, errorCount: 1, summary: "1 missing_type", recoveryInjection: "" },
  sessionId: "session-initial-confidence",
  timestamp: new Date(),
};

function seedLike(confidence: number): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: `seed_initial_${confidence}`,
    name: "seed rule",
    type: "seed",
    status: "active",
    confidence,
    triggerPattern: "always register systems through the module config",
    action: "register the system in ModuleConfig",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: ["seed"],
  } as unknown as Instinct;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "initial-confidence-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  pipeline = new LearningPipeline(storage);
  hooks = new ErrorLearningHooks(pipeline, new PatternMatcher(storage), new ConfidenceScorer(), storage);
  hooks.enable();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("initial confidence survives the first evidence (LRN-3)", () => {
  it("positive evidence never lowers a seeded confidence", () => {
    const scorer = new ConfidenceScorer();
    for (const confidence of [0.65, 0.7, 0.9]) {
      const rule = seedLike(confidence);
      expect(scorer.applyEvidence(rule, EVIDENCE_WEIGHTS.reactionUp).confidence).toBeGreaterThan(confidence);
      expect(scorer.applyEvidence(rule, EVIDENCE_WEIGHTS.outcomeSuccess).confidence).toBeGreaterThan(confidence);
      expect(scorer.updateConfidence(rule, true, 0.9).confidence).toBeGreaterThanOrEqual(confidence);
    }
  });

  it("a flat 0.5 rule starts from exactly the old Beta(1,1) prior", () => {
    const scorer = new ConfidenceScorer();
    const updated = scorer.updateConfidence(seedLike(0.5), true, 0.9);
    expect(updated.bayesianAlpha).toBeCloseTo(1.9, 12);
    expect(updated.bayesianBeta).toBeCloseTo(1.1, 12);
  });

  it("a teaching stays active and gains confidence from a task it informed (pipeline path)", async () => {
    const id = await pipeline.teachExplicit("when the build fails with CS0246 add the missing using directive", "user", "alice");
    expect(storage.getInstinct(id)).toMatchObject({ status: "active", confidence: 0.7 });

    pipeline.recordInstinctOutcomeEvidence(id, true);

    const after = storage.getInstinct(id)!;
    expect(after.confidence).toBeGreaterThan(0.7);
    expect(after.status).toBe("active");
  });

  it("a teaching stays active and gains confidence from a successful application (recovery path)", async () => {
    const id = await pipeline.teachExplicit("when the build fails with CS0246 add the missing using directive", "user", "alice");

    const moved = hooks.reinforceInstinct(id, { errorContext, success: true, verdictScore: 0.9 });

    expect(moved?.confidenceBefore).toBe(0.7);
    expect(moved?.confidenceAfter).toBeGreaterThan(0.7);
    const after = storage.getInstinct(id)!;
    expect(after.confidence).toBeGreaterThan(0.7);
    expect(after.status).toBe("active");
  });
});
