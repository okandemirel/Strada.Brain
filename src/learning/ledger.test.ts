/**
 * THE AUDITABLE LEARNING LEDGER (plan 6.4).
 *
 * The plan's measure is how long it takes wrong guidance to STOP HAVING AN
 * EFFECT, so these tests pin the loop that shortens it: a bad rule is
 * findable without its id, its whole record is readable, one action retires
 * it, and the ledger afterwards proves it stopped — or says what is still
 * carrying it.
 *
 * Both directions of the honesty hazard are pinned:
 *   - a rule nobody has measured is reported UNMEASURED, never clean;
 *   - a rule with real evidence against it is never softened into
 *     "not measured" because the evidence happens to be undated.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LearningStorage } from "./storage/learning-storage.js";
import type { Instinct, RuntimeArtifact } from "./types.js";
import {
  buildInstinctLedger,
  findSuspectGuidance,
  isRetrievableStatus,
  renderLedgerEntry,
  renderSuspects,
  retireGuidance,
  searchGuidance,
} from "./ledger.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

let storage: LearningStorage;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  storage = new LearningStorage(join(tempDir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function instinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: randomUUID(),
    name: "Always add the using directive",
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern: "CS0246",
    action: "Add a using directive for the missing namespace",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: T0,
    updatedAt: T0,
    sourceTrajectoryIds: [],
    tags: [],
    ...overrides,
  } as Instinct;
}

function credit(
  id: string,
  at: number,
  success: boolean,
  extra: Partial<Parameters<LearningStorage["recordInstinctCredit"]>[0]> = {},
): void {
  storage.recordInstinctCredit({
    instinctId: id,
    sessionId: `sess-${at}`,
    success,
    verdictScore: success ? 0.9 : 0.1,
    source: "terminal",
    confidenceBefore: 0.8,
    confidenceAfter: success ? 0.82 : 0.7,
    statusAt: "active",
    timestamp: at,
    ...extra,
  });
}

function artifact(sourceInstinctId: string, state: RuntimeArtifact["state"]): RuntimeArtifact {
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
    sourceInstinctIds: [sourceInstinctId],
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
    createdAt: T0,
    updatedAt: T0,
  } as unknown as RuntimeArtifact;
}

describe("the credit ledger — which runs a rule influenced, and how they ended", () => {
  it("records a settled run with its verdict, its source and the confidence it moved", () => {
    const i = instinct();
    storage.createInstinct(i);
    credit(String(i.id), T0 + HOUR, false, { sessionId: "chat-7", verdictScore: 0.15, source: "terminal" });

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "chat-7",
      success: false,
      verdictScore: 0.15,
      source: "terminal",
      confidenceBefore: 0.8,
      statusAt: "active",
    });
  });

  it("says whether an outcome was the run's TERMINAL verdict or inferred from what the run showed", () => {
    const i = instinct();
    storage.createInstinct(i);
    credit(String(i.id), T0 + 1, true, { source: "observed" });
    expect(storage.getInstinctCredits({ instinctId: String(i.id) })[0]!.source).toBe("observed");
  });

  it("filters by instinct, window and limit, newest first", () => {
    const a = instinct();
    const b = instinct({ name: "other" });
    storage.createInstinct(a);
    storage.createInstinct(b);
    credit(String(a.id), T0 + HOUR, false);
    credit(String(a.id), T0 + 2 * HOUR, true);
    credit(String(b.id), T0 + 3 * HOUR, false);

    expect(storage.getInstinctCredits({ instinctId: String(a.id) }).map((r) => r.timestamp)).toEqual([
      T0 + 2 * HOUR,
      T0 + HOUR,
    ]);
    expect(storage.getInstinctCredits({ instinctId: String(a.id), since: T0 + 2 * HOUR })).toHaveLength(1);
    expect(storage.getInstinctCredits({ limit: 1 })).toHaveLength(1);
  });

  it("prunes old rows and reports how many went", () => {
    const i = instinct();
    storage.createInstinct(i);
    credit(String(i.id), T0, false);
    credit(String(i.id), T0 + 10 * HOUR, false);
    expect(storage.pruneInstinctCredits(T0 + HOUR)).toBe(1);
    expect(storage.getInstinctCredits({ instinctId: String(i.id) })).toHaveLength(1);
  });
});

describe("the record for one piece of guidance", () => {
  it("carries where it came from, the evidence both ways, the runs and the status changes", () => {
    const i = instinct({
      originSessionId: "sess-origin",
      sourceTrajectoryIds: ["traj_1"] as Instinct["sourceTrajectoryIds"],
      userId: "u-okan",
      scopeType: "user",
      stats: { timesSuggested: 4, timesApplied: 3, timesFailed: 2, successRate: 0.6, averageExecutionMs: 10 },
    });
    storage.createInstinct(i);
    storage.addInstinctScopeV2(String(i.id), "/proj", "user", "u-okan");
    credit(String(i.id), T0 + HOUR, true);
    credit(String(i.id), T0 + 2 * HOUR, false);
    storage.writeLifecycleLog({
      instinctId: i.id,
      fromStatus: "proposed",
      toStatus: "active",
      reason: "Auto-promoted",
      confidenceAtTransition: 0.7,
      bayesianAlpha: 3,
      bayesianBeta: 2,
      observationCount: 5,
      timestamp: T0 + 30 * 60_000,
    });

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 3 * HOUR })!;
    expect(entry.origin).toMatchObject({ originSessionId: "sess-origin", owner: "u-okan", scopeType: "user" });
    expect(entry.origin.scopes.map((s) => s.projectPath)).toContain("/proj");
    expect(entry.evidence).toMatchObject({ for: 3, against: 2, unmeasured: false });
    expect(entry.evidence.firstNegativeAt).toBe(T0 + 2 * HOUR);
    expect(entry.runs.map((r) => r.timestamp)).toEqual([T0 + 2 * HOUR, T0 + HOUR]);
    expect(entry.timeline).toHaveLength(1);
    expect(entry.timeline[0]).toMatchObject({ fromStatus: "proposed", toStatus: "active", reason: "Auto-promoted" });
    // Still offered to runs, with evidence against it — and for how long.
    expect(entry.effect.inEffect).toBe(true);
    expect(entry.effect.msWrongAndStillInEffect).toBe(HOUR);
  });

  it("an unknown id has no ledger, and says so by absence rather than an empty record", () => {
    expect(buildInstinctLedger(storage, "nope")).toBeUndefined();
  });

  it("NO EVIDENCE IS NOT GOOD EVIDENCE: an unmeasured rule reads as unmeasured, not clean", () => {
    const i = instinct();
    storage.createInstinct(i);
    const entry = buildInstinctLedger(storage, String(i.id))!;
    expect(entry.evidence.unmeasured).toBe(true);
    const text = renderLedgerEntry(entry);
    expect(text).toContain("NOT MEASURED");
    expect(text).toContain("not the same as clean");
    expect(text).toContain("none recorded — no run has settled credit");
  });

  it("evidence that is COUNTED BUT UNDATED is disclosed, and the measure is refused rather than reported as zero", () => {
    // The hazard in the other direction: an older instinct carries failure
    // counters from before the credit ledger existed. Reporting "no dated
    // evidence" as "nothing against it" would hide a real failure.
    const i = instinct({
      stats: { timesSuggested: 9, timesApplied: 2, timesFailed: 7, successRate: 0.22, averageExecutionMs: 1 },
    });
    storage.createInstinct(i);
    const entry = buildInstinctLedger(storage, String(i.id))!;
    expect(entry.evidence.unmeasured).toBe(false);
    expect(entry.evidence.against).toBe(7);
    expect(entry.evidence.negativeEvidenceUndated).toBe(true);
    expect(entry.effect.msWrongAndStillInEffect).toBeUndefined();
    expect(renderLedgerEntry(entry)).toContain("COUNTED BUT UNDATED");
  });
});

describe("finding a bad rule without knowing its id", () => {
  it("ranks the guidance whose runs failed above a confident one nothing has tested", () => {
    const bad = instinct({ name: "bad rule", confidence: 0.9 });
    const untested = instinct({ name: "untested rule", confidence: 0.95 });
    const good = instinct({ name: "good rule", confidence: 0.6 });
    for (const i of [bad, untested, good]) storage.createInstinct(i);
    credit(String(bad.id), T0 + HOUR, false);
    credit(String(bad.id), T0 + 2 * HOUR, false);
    credit(String(good.id), T0 + HOUR, true);

    const rows = findSuspectGuidance(storage, { now: T0 + 3 * HOUR });
    expect(rows.map((r) => r.id)).toEqual([String(bad.id)]);
    expect(rows[0]!.failedRuns).toBe(2);
    expect(rows[0]!.why).toContain("2 of the 2 run(s) it influenced failed");
    expect(rows[0]!.msWrongAndStillInEffect).toBe(2 * HOUR);
    const text = renderSuspects(rows);
    expect(text).toContain("strada learning retire");
  });

  it("a real failure with UNDATED counters still makes the list (never filtered out as unmeasured)", () => {
    const old = instinct({
      name: "old bad rule",
      stats: { timesSuggested: 5, timesApplied: 1, timesFailed: 4, successRate: 0.2, averageExecutionMs: 1 },
    });
    storage.createInstinct(old);
    const rows = findSuspectGuidance(storage);
    expect(rows.map((r) => r.id)).toEqual([String(old.id)]);
    expect(rows[0]!.why).toContain("undated");
  });

  it("an empty list says nothing is flagged AND that unmeasured is not clean", () => {
    storage.createInstinct(instinct());
    expect(findSuspectGuidance(storage)).toHaveLength(0);
    expect(renderSuspects([])).toContain("unmeasured, not clean");
  });

  it("guidance already out of effect is not listed, unless asked for", () => {
    const retired = instinct({ name: "retired rule", status: "deprecated" });
    storage.createInstinct(retired);
    credit(String(retired.id), T0 + HOUR, false);
    expect(findSuspectGuidance(storage)).toHaveLength(0);
    expect(findSuspectGuidance(storage, { includeRetired: true }).map((r) => r.id)).toEqual([String(retired.id)]);
  });

  it("finds a rule by what it says", () => {
    const i = instinct({ name: "Pooling rule", action: "Reuse the object pool instead of Instantiate" });
    storage.createInstinct(i);
    expect(searchGuidance(storage, "object pool").map((r) => r.id)).toEqual([String(i.id)]);
    expect(searchGuidance(storage, "nothing matches this")).toHaveLength(0);
    expect(searchGuidance(storage, "   ")).toHaveLength(0);
  });
});

describe("retiring a piece of guidance, and proving it stopped", () => {
  it("one action ends the status, retires what it generated, and records actor and reason", () => {
    const i = instinct({ name: "bad rule" });
    storage.createInstinct(i);
    storage.addInstinctScope(String(i.id), "/proj");
    storage.upsertRuntimeArtifact(artifact(String(i.id), "active"));
    credit(String(i.id), T0 + HOUR, false);

    const result = retireGuidance(storage, String(i.id), {
      reason: "it tells runs to delete the asset database",
      actor: "okan",
      now: T0 + 4 * HOUR,
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("active → deprecated");
    expect(result.detail).toContain("1 generated artifact(s) retired");

    const entry = result.entry!;
    expect(entry.status).toBe("deprecated");
    expect(entry.effect.inEffect).toBe(false);
    expect(entry.effect.retiredReason).toContain("Retired by okan");
    expect(entry.effect.retiredReason).toContain("asset database");
    expect(entry.effect.liveArtifacts).toHaveLength(0);
    // THE MEASURE: from the first evidence against it to the moment it stopped.
    expect(entry.effect.msFromFirstNegativeToRetirement).toBe(3 * HOUR);
    expect(entry.timeline.at(-1)).toMatchObject({ fromStatus: "active", toStatus: "deprecated" });
    // …and it is out of the scope query a run retrieves through.
    expect(storage.getInstinctsForScope({ projectPath: "/proj", scopeFilter: "all" }).map((x) => String(x.id))).not.toContain(
      String(i.id),
    );
  });

  it("the retirement takes effect only for the rule retired — the others stay retrievable", () => {
    const bad = instinct({ name: "bad" });
    const keep = instinct({ name: "keep" });
    for (const i of [bad, keep]) {
      storage.createInstinct(i);
      storage.addInstinctScope(String(i.id), "/proj");
    }
    retireGuidance(storage, String(bad.id), { reason: "wrong", actor: "okan" });
    const ids = storage.getInstinctsForScope({ projectPath: "/proj", scopeFilter: "all" }).map((x) => String(x.id));
    expect(ids).toContain(String(keep.id));
    expect(ids).not.toContain(String(bad.id));
  });

  it("quarantine is available for a rule that must never come back", () => {
    const i = instinct({ status: "permanent" });
    storage.createInstinct(i);
    const result = retireGuidance(storage, String(i.id), { reason: "keeps being wrong", actor: "okan", quarantine: true });
    expect(result.ok).toBe(true);
    expect(result.entry!.status).toBe("quarantined");
    expect(isRetrievableStatus("quarantined")).toBe(false);
  });

  it("an unknown id and an already-retired rule are refused, not answered with a cheerful no-op", () => {
    expect(storage.retireInstinct("nope", { reason: "r", actor: "a" })).toMatchObject({ ok: false });
    const i = instinct({ status: "deprecated" });
    storage.createInstinct(i);
    const again = storage.retireInstinct(String(i.id), { reason: "r", actor: "a" });
    expect(again.ok).toBe(false);
    expect(again.detail).toContain("already deprecated");
  });

  it("A RETIREMENT IS NOT AN EFFECT ENDING BY ITSELF: a live artifact keeps the guidance in effect, and the ledger says which", () => {
    // The leak this measure exists to catch: the rule was deprecated by some
    // other path (a merge, a confidence slide) while the skill generated from
    // it stayed active.
    const i = instinct({ status: "deprecated" });
    storage.createInstinct(i);
    storage.upsertRuntimeArtifact(artifact(String(i.id), "active"));
    const entry = buildInstinctLedger(storage, String(i.id))!;
    expect(entry.effect.inEffect).toBe(true);
    expect(entry.effect.why).toContain("still carry its guidance");
    expect(entry.effect.liveArtifacts).toHaveLength(1);
    expect(renderLedgerEntry(entry)).toContain("IS IT STILL HAVING AN EFFECT?\n  YES");
    // …and it is listed as suspect while anything still carries it.
    credit(String(i.id), T0 + HOUR, false);
    expect(findSuspectGuidance(storage).map((r) => r.id)).toEqual([String(i.id)]);
  });

  it("a run SHOWN the rule after a retirement is flagged as something still applying it", () => {
    const i = instinct();
    storage.createInstinct(i);
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + HOUR });
    // Round 11 #8: the flag is about EXPOSURE, not about when the credit
    // settled. A row dated by settlement alone cannot tell the two apart, and
    // this test used to assert the settlement reading.
    credit(String(i.id), T0 + 3 * HOUR, false, { exposedAt: T0 + 2 * HOUR });
    const entry = buildInstinctLedger(storage, String(i.id))!;
    expect(entry.effect.runsAfterRetirement).toBe(1);
    expect(renderLedgerEntry(entry)).toContain("after it was retired");
  });

  it("credit settled after a retirement with no recorded exposure is reported as unplaceable", () => {
    const i = instinct();
    storage.createInstinct(i);
    retireGuidance(storage, String(i.id), { reason: "wrong", actor: "okan", now: T0 + HOUR });
    credit(String(i.id), T0 + 2 * HOUR, false);
    const entry = buildInstinctLedger(storage, String(i.id))!;
    expect(entry.effect.runsAfterRetirement).toBe(0);
    expect(entry.effect.runsAfterRetirementExposureUnknown).toBe(1);
    expect(renderLedgerEntry(entry)).toContain("exposure time was never recorded");
  });

  it("a SUPERSEDED rule explains itself in the timeline (a merge used to log nothing)", () => {
    const winner = instinct({ name: "winner" });
    const loser = instinct({ name: "loser" });
    storage.createInstinct(winner);
    storage.createInstinct(loser);
    storage.mergeInstincts(String(winner.id), String(loser.id));

    const entry = buildInstinctLedger(storage, String(loser.id))!;
    expect(entry.status).toBe("deprecated");
    expect(entry.timeline).toHaveLength(1);
    expect(entry.timeline[0]!.reason).toContain(`Superseded by ${String(winner.id)}`);
    expect(entry.effect.inEffect).toBe(false);
    expect(entry.effect.retiredReason).toContain("Superseded");
  });
});

describe("the run→ledger path (the settlement now leaves a row)", () => {
  it("a settled run appears in the ledger with its terminal verdict, and an inferred one says 'observed'", async () => {
    const { LearningPipeline } = await import("./pipeline/learning-pipeline.js");
    const pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
    try {
      const i = instinct({ confidence: 0.5, bayesianAlpha: 3, bayesianBeta: 3 });
      storage.createInstinct(i);
      const event = (sessionId: string, success: boolean) => ({
        sessionId,
        toolName: "shell",
        input: {},
        output: success ? "ok" : "boom",
        success,
        appliedInstinctIds: [String(i.id)],
        timestamp: Date.now(),
      });

      // A run whose terminal verdict is known.
      await pipeline.handleToolResult(event("run-a", true) as never);
      expect(storage.getInstinctCredits({ instinctId: String(i.id) }), "credit was booked mid-run").toHaveLength(0);
      pipeline.clearRunInstinctCredits("run-a", { success: false });

      // …and one whose caller knew no terminal verdict.
      await pipeline.handleToolResult(event("run-b", true) as never);
      pipeline.clearRunInstinctCredits("run-b");

      const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
      expect(rows).toHaveLength(2);
      const bySession = new Map(rows.map((r) => [r.sessionId, r]));
      expect(bySession.get("run-a")).toMatchObject({ success: false, source: "terminal" });
      expect(bySession.get("run-b")).toMatchObject({ success: true, source: "observed" });
      expect(bySession.get("run-a")!.confidenceAfter).toBeLessThan(bySession.get("run-a")!.confidenceBefore);

      const entry = buildInstinctLedger(storage, String(i.id))!;
      expect(entry.runs).toHaveLength(2);
      expect(renderLedgerEntry(entry)).toContain("session run-a");
    } finally {
      pipeline.stop();
    }
  });
});
