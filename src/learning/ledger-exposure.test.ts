/**
 * ROUND 11 #8 — THE LEDGER'S LEAK NUMBER AND ITS TIME-TO-NO-EFFECT NUMBER MUST
 * MEAN WHAT THEY SAY.
 *
 * `runsAfterRetirement` counted credit rows whose TIMESTAMP was after the
 * retirement, and a credit row's timestamp is the moment the credit SETTLED, not
 * the moment the run was shown the guidance. Since round 10 #14 the settlement
 * rides a serial queue behind the run's own events, so the ordinary case —
 * retire a rule while a run that already saw it is finishing — was reported as
 * "N run(s) settled credit for it AFTER it was retired — something is still
 * applying it". A person cannot tell that alarm apart from a real leak, and the
 * real leak is the one thing this measure exists to catch.
 *
 * The second half: the retirement-duration field measures the STATUS change
 * only. The ledger's own honesty rule says a retirement is not an effect ending
 * by itself — a derived artifact that is still active still carries the
 * guidance — so no "time until it stopped having an effect" may be reported
 * while a carrier is live.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { LearningStorage } from "./storage/learning-storage.js";
import { buildInstinctLedger, renderLedgerEntry, retireGuidance } from "./ledger.js";
import type { Instinct, RuntimeArtifact } from "./types.js";
import type { TimestampMs } from "../types/index.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

let storage: LearningStorage;

function instinct(over: Partial<Instinct> = {}): Instinct {
  return {
    id: `instinct_${randomUUID()}` as Instinct["id"],
    name: "pooling rule",
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern: "CS0246",
    action: "Add a using directive for the missing namespace",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: T0 as TimestampMs,
    updatedAt: T0 as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

function credit(
  id: string,
  opts: { settledAt: number; exposedAt?: number; success?: boolean },
): void {
  storage.recordInstinctCredit({
    instinctId: id,
    sessionId: `sess-${opts.settledAt}`,
    success: opts.success ?? false,
    verdictScore: opts.success ? 0.9 : 0.1,
    source: "terminal",
    confidenceBefore: 0.8,
    confidenceAfter: 0.7,
    statusAt: "active",
    timestamp: opts.settledAt,
    ...(opts.exposedAt === undefined ? {} : { exposedAt: opts.exposedAt }),
  });
}

function artifact(sourceInstinctId: string, state: RuntimeArtifact["state"], retiredAt?: number): RuntimeArtifact {
  return {
    id: `artifact_${randomUUID()}` as RuntimeArtifact["id"],
    kind: "workflow",
    state,
    name: "Using-directive flow",
    description: "d",
    guidance: "g",
    taskTypes: ["debugging"],
    taskPatterns: ["cs0246"],
    requiredToolNames: [],
    requiredCapabilities: [],
    sourceInstinctIds: [sourceInstinctId as Instinct["id"]],
    sourceTrajectoryIds: [],
    stats: {
      shadowSampleCount: 0,
      activeUseCount: 0,
      cleanCount: 0,
      retryCount: 0,
      failureCount: 0,
      blockerCount: 0,
      harmfulCount: 0,
      recentEvaluations: [],
      regressionFingerprints: {},
    },
    ...(retiredAt === undefined ? {} : { retiredAt: retiredAt as TimestampMs }),
    createdAt: T0 as TimestampMs,
    updatedAt: (retiredAt ?? T0) as TimestampMs,
  };
}

describe("exposure time and settlement time are different facts (r11 #8)", () => {
  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it("PROOF: a run exposed BEFORE the retirement whose credit settles after is not a leak", () => {
    const i = instinct();
    storage.createInstinct(i);
    credit(String(i.id), { settledAt: T0 + HOUR, success: false });
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + 2 * HOUR });
    // The ordinary #14 shape: the run saw the rule before the retirement; its
    // settlement rode the serial queue and landed afterwards.
    credit(String(i.id), { settledAt: T0 + 3 * HOUR, exposedAt: T0 + HOUR, success: false });

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;

    // TEETH: the unfixed measure counted this as 1 and reported "something is
    // still applying it".
    expect(entry.effect.runsAfterRetirement, "a delayed settlement was reported as a post-retirement application").toBe(0);
    expect(entry.effect.runsSettledAfterRetirementExposedBefore).toBe(1);
    const rendered = renderLedgerEntry(entry);
    expect(rendered).not.toContain("something is still applying it");
    expect(rendered).toContain("settled after the retirement");
  });

  it("GUARD: a run genuinely exposed AFTER the retirement is still counted as a leak", () => {
    const i = instinct();
    storage.createInstinct(i);
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + HOUR });
    credit(String(i.id), { settledAt: T0 + 3 * HOUR, exposedAt: T0 + 2 * HOUR, success: false });

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirement).toBe(1);
    expect(renderLedgerEntry(entry)).toContain("something is still applying it");
  });

  it("a credit with no recorded exposure time is reported as unknown, not as clean or as a leak", () => {
    const i = instinct();
    storage.createInstinct(i);
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + HOUR });
    // Rows written before the exposure column existed.
    credit(String(i.id), { settledAt: T0 + 2 * HOUR, success: false });

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirementExposureUnknown).toBe(1);
    expect(renderLedgerEntry(entry)).toContain("exposure time was never recorded");
  });

  it("PROOF: an active derived artifact prevents a completed time-to-no-effect measurement", () => {
    const i = instinct({ status: "deprecated" });
    storage.createInstinct(i);
    credit(String(i.id), { settledAt: T0 + HOUR, exposedAt: T0 + HOUR, success: false });
    storage.upsertRuntimeArtifact(artifact(String(i.id), "active"));

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 5 * HOUR })!;

    // TEETH: the only duration the ledger reported was the status change, which
    // reads as "it stopped" while a carrier is still live.
    expect(entry.effect.msFromFirstNegativeToNoEffect).toBeUndefined();
    expect(entry.effect.noEffectAt).toBeUndefined();
    expect(entry.effect.noEffectPendingReason).toContain("artifact");
    expect(renderLedgerEntry(entry)).toContain("has NOT stopped having an effect");
  });

  it("GUARD: with every carrier stopped, the measure completes and runs to the LAST carrier", () => {
    const i = instinct();
    storage.createInstinct(i);
    credit(String(i.id), { settledAt: T0 + HOUR, exposedAt: T0 + HOUR, success: false });
    storage.upsertRuntimeArtifact(artifact(String(i.id), "active"));

    // One action retires the rule AND everything generated from it.
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + 4 * HOUR });

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 9 * HOUR })!;
    expect(entry.effect.liveArtifacts).toHaveLength(0);
    expect(entry.effect.noEffectAt).toBe(T0 + 4 * HOUR);
    expect(entry.effect.msFromFirstNegativeToNoEffect).toBe(3 * HOUR);
    expect(renderLedgerEntry(entry)).toContain("time from the first evidence against it to no effect");
  });

  it("the measure runs to the last carrier even when an artifact outlives the status change", () => {
    const i = instinct({ status: "deprecated", updatedAt: (T0 + 2 * HOUR) as TimestampMs });
    storage.createInstinct(i);
    credit(String(i.id), { settledAt: T0 + HOUR, exposedAt: T0 + HOUR, success: false });
    // The rule stopped being offered at T0+2h; the generated skill kept
    // carrying it until T0+6h.
    storage.upsertRuntimeArtifact(artifact(String(i.id), "retired", T0 + 6 * HOUR));

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 9 * HOUR })!;
    expect(entry.effect.noEffectAt).toBe(T0 + 6 * HOUR);
    expect(entry.effect.msFromFirstNegativeToNoEffect).toBe(5 * HOUR);
  });
});
