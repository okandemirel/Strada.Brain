/**
 * Round 10 #12 — TWO SOLUTIONS TO ONE TRIGGER.
 *
 * D43 fixed the eager MERGE (trigger AND action must match before one instinct
 * destroys another), but the two other gates in the same path still judged on the
 * trigger alone:
 *
 *  - creation (`considerInstinctCreation`) refused anything whose TRIGGER
 *    resembled a stored instinct, so the second solution was never written;
 *  - retrieval (`InstinctRetriever.filterDedupAndBoost`) bucketed matches by
 *    `triggerPattern`, so if the second solution WAS written it never surfaced.
 *
 * Two further blockers hid in the creation gate: another owner's private
 * instinct blocked creation, and a QUARANTINED instinct — one deliberately held
 * out of use for being wrong — blocked the replacement meant to supersede it.
 *
 * The guard direction: a real duplicate (same trigger AND same action AND same
 * owner) is still refused at creation and still collapsed at retrieval, so this
 * does not become a licence to store the same rule twice.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningStorage } from "./storage/learning-storage.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { PatternMatcher } from "./matching/pattern-matcher.js";
import { InstinctRetriever } from "../agents/instinct-retriever.js";
import type { Instinct, InstinctId } from "./types.js";
import type { TimestampMs } from "../types/index.js";

const PROJECT = "/projects/pixelflow";
const TRIGGER = "NullReferenceException in BoardController.Resolve";
const ACTION_A = "add a null guard around the resolved board reference";
const ACTION_B = "construct the board eagerly in Awake so it is never null";

function makeInstinct(over: Partial<Instinct> = {}): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: `instinct_${Math.random().toString(36).slice(2)}` as InstinctId,
    name: "rival",
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern: TRIGGER,
    action: ACTION_A,
    contextConditions: [],
    stats: { timesSuggested: 3, timesApplied: 3, timesFailed: 0, successRate: 1, averageExecutionMs: 10 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

describe("rival solutions to one trigger (round 10 #12)", () => {
  let storage: LearningStorage;
  let pipeline: LearningPipeline;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
    pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
    pipeline.setProjectPath(PROJECT);
  });

  afterEach(() => {
    pipeline.stop();
    storage.close();
  });

  const create = (over: {
    action: string;
    scopeType?: "user" | "project" | "global";
    userId?: string;
    triggerPattern?: string;
  }) =>
    pipeline.considerInstinctCreation({
      type: "error_fix",
      triggerPattern: over.triggerPattern ?? TRIGGER,
      action: over.action,
      confidence: 0.6,
      ...(over.scopeType ? { scopeType: over.scopeType } : {}),
      ...(over.userId ? { userId: over.userId } : {}),
    });

  // ─── creation ──────────────────────────────────────────────────────────────

  it("a second solution to a trigger that already has one is created", async () => {
    const first = await create({ action: ACTION_A });
    const second = await create({ action: ACTION_B });

    expect(first, "the first solution was not created at all").not.toBeNull();
    expect(second, "a rival solution to a known trigger was refused").not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect(storage.getInstinct(first!.id)?.action).toBe(ACTION_A);
    expect(storage.getInstinct(second!.id)?.action).toBe(ACTION_B);
  });

  it("GUARD: the same solution to the same trigger is still refused", async () => {
    const first = await create({ action: ACTION_A });
    const duplicate = await create({ action: ACTION_A });

    expect(first).not.toBeNull();
    expect(duplicate, "the very same rule was stored twice").toBeNull();
  });

  it("another owner's private instinct does not block creation", async () => {
    const alices = await create({ action: ACTION_A, scopeType: "user", userId: "alice" });
    expect(alices).not.toBeNull();

    const bobs = await create({ action: ACTION_A, scopeType: "user", userId: "bob" });
    expect(bobs, "Alice's private rule blocked Bob from learning the same thing").not.toBeNull();
    expect(bobs!.id).not.toBe(alices!.id);
  });

  it("GUARD: the same owner's duplicate private instinct is still refused", async () => {
    const first = await create({ action: ACTION_A, scopeType: "user", userId: "alice" });
    const again = await create({ action: ACTION_A, scopeType: "user", userId: "alice" });

    expect(first).not.toBeNull();
    expect(again, "Alice got two copies of her own rule").toBeNull();
  });

  it("a quarantined instinct does not block its replacement", async () => {
    const wrong = await create({ action: ACTION_A });
    expect(wrong).not.toBeNull();
    storage.updateInstinct({ ...storage.getInstinct(wrong!.id)!, status: "quarantined" });

    const replacement = await create({ action: ACTION_A });
    expect(replacement, "a quarantined rule blocked the replacement meant to supersede it").not.toBeNull();
    expect(replacement!.id).not.toBe(wrong!.id);
  });

  // ─── retrieval ─────────────────────────────────────────────────────────────

  function retrieverOver(instincts: Instinct[]): InstinctRetriever {
    for (const instinct of instincts) {
      storage.createInstinct(instinct);
      storage.addInstinctScopeV2(
        String(instinct.id),
        PROJECT,
        instinct.scopeType ?? "project",
        instinct.userId,
      );
    }
    const matcher = new PatternMatcher(storage);
    return new InstinctRetriever(matcher, {
      storage,
      scopeContext: {
        projectPath: PROJECT,
        scopeFilter: "project+universal",
        recencyBoost: 1.0,
        scopeBoost: 1.0,
      },
    });
  }

  it("both rival solutions surface from retrieval", async () => {
    const a = makeInstinct({ action: ACTION_A, confidence: 0.9 });
    const b = makeInstinct({ action: ACTION_B, confidence: 0.7 });
    const retriever = retrieverOver([a, b]);

    const matched = await retriever.getMatchedInstincts(TRIGGER, 5);
    const ids = matched.map((i) => String(i.id));

    expect(ids, "one of two rival solutions was dropped by trigger-only dedup").toContain(String(a.id));
    expect(ids).toContain(String(b.id));

    const { insights } = await retriever.getInsightsForTask(TRIGGER, 5);
    expect(insights.some((s) => s.includes("null guard"))).toBe(true);
    expect(insights.some((s) => s.includes("eagerly in Awake"))).toBe(true);
  });

  it("GUARD: a true duplicate is still collapsed to one", async () => {
    const shared = makeInstinct({ action: ACTION_A, scopeType: "global", confidence: 0.9 });
    const narrow = makeInstinct({ action: ACTION_A, scopeType: "project", confidence: 0.7 });
    const retriever = retrieverOver([shared, narrow]);

    const matched = await retriever.getMatchedInstincts(TRIGGER, 5);
    const ids = matched.map((i) => String(i.id));

    // Same trigger AND same action AND same (absent) owner: one rule, shown once.
    // Which of the two survives is the matcher's eager-merge decision (higher
    // confidence wins, D43); the retriever's own scope tiebreak is covered by
    // instinct-retriever.test.ts over mock matches.
    expect(ids, "the same rule surfaced twice").toHaveLength(1);
    expect([String(shared.id), String(narrow.id)]).toContain(ids[0]);
  });

  it("two owners' identically-triggered rules are not collapsed into one", async () => {
    const alices = makeInstinct({ action: ACTION_A, scopeType: "user", userId: "alice", confidence: 0.9 });
    const bobs = makeInstinct({ action: ACTION_A, scopeType: "user", userId: "bob", confidence: 0.7 });
    const retriever = retrieverOver([alices, bobs]);

    // Each identity sees only its own — and the other's is not merged away.
    const forAlice = (await retriever.getMatchedInstincts(TRIGGER, 5, "alice")).map((i) => String(i.id));
    const forBob = (await retriever.getMatchedInstincts(TRIGGER, 5, "bob")).map((i) => String(i.id));

    expect(forAlice).toEqual([String(alices.id)]);
    expect(forBob).toEqual([String(bobs.id)]);
    expect(storage.getInstinct(alices.id)?.status).toBe("active");
    expect(storage.getInstinct(bobs.id)?.status, "Bob's rule was merged into Alice's").toBe("active");
  });

  // ─── end to end ────────────────────────────────────────────────────────────

  it("created rivals both come back out of retrieval", async () => {
    const first = await create({ action: ACTION_A });
    const second = await create({ action: ACTION_B });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // considerInstinctCreation stores 'proposed'; retrieval's default status set
    // includes proposed, so no promotion is needed to read them back.
    const matcher = new PatternMatcher(storage);
    const retriever = new InstinctRetriever(matcher, {
      storage,
      scopeContext: {
        projectPath: PROJECT,
        scopeFilter: "project+universal",
        recencyBoost: 1.0,
        scopeBoost: 1.0,
      },
    });

    const ids = (await retriever.getMatchedInstincts(TRIGGER, 5)).map((i) => String(i.id));
    expect(ids).toContain(String(first!.id));
    expect(ids).toContain(String(second!.id));
  });
});
