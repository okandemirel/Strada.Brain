/**
 * HOW MUCH OF THE MISFIRE MEASUREMENT IS NOT BEING MADE (round 14 follow-up).
 *
 * Round 13 #24 and round 14 #14 stopped the system guessing at which guidance a
 * run applied. The honest replacement for a guess is a RECORDED ABSENCE: an
 * exposure that nothing ever judged has to be a row that says so, or "no misfires
 * found" and "nobody looked" are the same number again.
 *
 * `ErrorLearningHooks.getStats().unjudgedExposures` counted it in memory, which
 * dies with the process and can only ever answer for one run of the daemon. What
 * an operator needs is "this rule was shown in 40 runs and judged in 2", over a
 * period, across restarts — so the exposure itself is durable now.
 *
 * The rule every number here obeys: it names what it measured. No exposure rows
 * for a period means NOT MEASURED — never "none unjudged".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LearningStorage } from "./storage/learning-storage.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { exposureCoverage, renderExposureCoverage } from "./ledger.js";
import {
  ErrorLearningHooks,
  NON_APPLICATION_BETA,
  type ErrorContext,
} from "./hooks/error-learning-hooks.js";
import { PatternMatcher } from "./matching/pattern-matcher.js";
import { ConfidenceScorer } from "./scoring/confidence-scorer.js";

let dir: string;
let dbPath: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;
let hooks: ErrorLearningHooks;

const RULE = "cs0006-build-dependency";
const OTHER = "cs0006-restore-packages";
const SESSION = "session-coverage";

function taughtRule(id: string) {
  storage.createInstinct({
    id,
    name: id,
    type: "error_fix" as const,
    status: "active" as const,
    confidence: 0.8,
    triggerPattern: "error CS0006",
    action: `action of ${id}`,
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    bayesianAlpha: 4,
    bayesianBeta: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return storage.getInstinct(id)!;
}

/** The error text the recovery hook's fixture rule triggers on. */
const CS0006 = "error CS0006: Metadata file 'Strada.Modules.dll' could not be found";

/** A rule the pattern matcher will actually recall for CS0006. */
function hookRule(id: string) {
  storage.createInstinct({
    id,
    name: id,
    type: "error_fix" as const,
    status: "active" as const,
    confidence: 0.8,
    triggerPattern: CS0006,
    action: "Build the dependency project first, then re-run",
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    bayesianAlpha: 4,
    bayesianBeta: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return storage.getInstinct(id)!;
}

function errorContext(output: string): ErrorContext {
  return {
    toolName: "dotnet_build",
    errorOutput: output,
    analysis: { hasErrors: true, errorCount: 1, summary: "1 error", recoveryInjection: "" },
    sessionId: SESSION,
    timestamp: new Date(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exposure-coverage-"));
  dbPath = join(dir, "learning.db");
  storage = new LearningStorage(dbPath);
  storage.initialize();
  pipeline = new LearningPipeline(storage);
  hooks = new ErrorLearningHooks(pipeline, new PatternMatcher(storage), new ConfidenceScorer(), storage);
  hooks.enable();
});
afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an exposure nothing judged", () => {
  it("is a row on disk that outlives the process that recorded it", () => {
    taughtRule(RULE);
    pipeline.noteGuidanceShown({
      sessionId: SESSION,
      taskRunId: "run-1",
      instinctIds: [RULE],
      shownAt: Date.now() - 5_000,
    });
    // The daemon restarts: a counter in memory is gone, a row is not.
    storage.close();
    storage = new LearningStorage(dbPath);
    storage.initialize();

    const coverage = exposureCoverage(storage);
    expect(coverage.measured).toBe(true);
    expect(coverage.shown).toBe(1);
    expect(coverage.judged).toBe(0);
    expect(coverage.unjudged).toBe(1);
    const row = coverage.perInstinct.find((r) => r.instinctId === RULE);
    expect(row?.shown).toBe(1);
    expect(row?.judged).toBe(0);
  });

  it("counts one exposure per run, however often the same run is told", () => {
    taughtRule(RULE);
    const shownAt = Date.now() - 5_000;
    // Told four times, with LATER times each time (a mid-run re-retrieval).
    for (let i = 0; i < 4; i++) {
      pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-1", instinctIds: [RULE], shownAt: shownAt + i });
    }
    // A second run, later still — so the earliest time on record can only come
    // from run-1's FIRST report. Aggregating over a run whose exposure was earlier
    // would hide a re-report overwriting it.
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-2", instinctIds: [RULE], shownAt: shownAt + 1_000 });

    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(2);
    // Earliest wins, exactly as the in-memory exposure does.
    expect(coverage.perInstinct.find((r) => r.instinctId === RULE)?.firstShownAt).toBe(shownAt);
  });

  it("is judged once: a second judgement is reported, not applied", () => {
    taughtRule(RULE);
    const shownAt = Date.now() - 5_000;
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-1", instinctIds: [RULE], shownAt });

    const first = storage.markInstinctExposureJudged({
      instinctId: RULE,
      sessionId: SESSION,
      taskRunId: "run-1",
      judgedAs: "not-applied",
    });
    expect(first).toBe(true);
    // A run's outcome is decided once (r13 #25, r14 #13). A later writer must be
    // told it changed nothing rather than quietly restamping the judgement.
    expect(
      storage.markInstinctExposureJudged({
        instinctId: RULE,
        sessionId: SESSION,
        taskRunId: "run-1",
        judgedAs: "credited",
      }),
    ).toBe(false);
    // And an exposure nobody recorded is not invented by judging it.
    expect(
      storage.markInstinctExposureJudged({
        instinctId: RULE,
        sessionId: SESSION,
        taskRunId: "run-never-shown",
        judgedAs: "credited",
      }),
    ).toBe(false);
    expect(exposureCoverage(storage).shown).toBe(1);
  });
});

describe("an exposure the system did judge", () => {
  it("is marked judged when the run's credit settles", () => {
    taughtRule(RULE);
    const shownAt = Date.now() - 5_000;
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-1", instinctIds: [RULE], shownAt });
    pipeline.noteAppliedInstinctCredit({
      sessionId: SESSION,
      taskRunId: "run-1",
      toolName: "dotnet_build",
      input: {},
      output: "ok",
      success: true,
      appliedInstinctIds: [RULE],
      timestamp: shownAt + 10,
    });
    pipeline.clearRunInstinctCredits(SESSION, { success: true, verdictScore: 1 }, "run-1");

    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(1);
    expect(coverage.judged).toBe(1);
    expect(coverage.unjudged).toBe(0);
  });

  it("is marked judged when it is recorded as a non-application", () => {
    taughtRule(RULE);
    const shownAt = Date.now() - 5_000;
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-1", instinctIds: [RULE], shownAt });
    expect(
      pipeline.noteGuidanceNotApplied({
        sessionId: SESSION,
        taskRunId: "run-1",
        instinctId: RULE,
        exposedAt: shownAt,
        betaDelta: NON_APPLICATION_BETA,
      }),
    ).toBe("recorded");

    const coverage = exposureCoverage(storage);
    expect(coverage.judged).toBe(1);
    expect(coverage.unjudged).toBe(0);
  });

  it("reports the mix per rule, so one rule's blind spot is visible", () => {
    taughtRule(RULE);
    taughtRule(OTHER);
    const shownAt = Date.now() - 5_000;
    for (const run of ["run-1", "run-2", "run-3"]) {
      pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: run, instinctIds: [RULE, OTHER], shownAt });
    }
    // Only one of the six exposures is ever judged.
    pipeline.noteGuidanceNotApplied({
      sessionId: SESSION,
      taskRunId: "run-1",
      instinctId: OTHER,
      exposedAt: shownAt,
      betaDelta: NON_APPLICATION_BETA,
    });

    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(6);
    expect(coverage.judged).toBe(1);
    expect(coverage.perInstinct.find((r) => r.instinctId === RULE)).toMatchObject({ shown: 3, judged: 0 });
    expect(coverage.perInstinct.find((r) => r.instinctId === OTHER)).toMatchObject({ shown: 3, judged: 1 });
  });
});

/**
 * ROUND 15 #13, #14, #15, #16 — the exposure log's own defects.
 *
 * A coverage number that overstates the gap is as useless as one that hides it:
 * if an application we DID observe still reads as unjudged, nobody can tell
 * progress from noise, and the number stops being worth reading.
 */
describe("the exposure and its judgement are keyed the same way (#13)", () => {
  it("judges the exposure the recovery hook recorded", async () => {
    const rule = hookRule(RULE);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    expect(shown.suggestions.map((s) => String(s.instinct?.id))).toContain(String(rule.id));

    await hooks.onAfterErrorResolution({
      errorContext: context,
      action: "Removed the stale reference",
      success: true,
      appliedInstinctIds: [],
      correlationId: shown.correlationId,
    });

    // The repro: the exposure went in under a blank run id while the judgement
    // looked for the resolution's run, so it was never closed.
    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(1);
    expect(coverage.judged).toBe(1);
  });

  it("keeps successive recovery episodes apart instead of collapsing them", async () => {
    hookRule(RULE);
    const started = Date.now();
    // Three separate recovery episodes, each with its own error.
    for (let i = 0; i < 3; i++) {
      const context = errorContext(`${CS0006} (attempt ${i})`);
      const shown = hooks.onBeforeErrorAnalysis(context);
      expect(shown.suggestions.length).toBeGreaterThan(0);
      await hooks.onAfterErrorResolution({
        errorContext: context,
        action: "Repaired another way",
        success: true,
        appliedInstinctIds: [],
        correlationId: shown.correlationId,
      });
    }

    // The repro: all three collapsed onto one row keyed by a blank run, which kept
    // the EARLIEST shown_at — so a window covering only recent activity found
    // nothing and printed NOT MEASURED while three exposures had just happened.
    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(3);
    const recent = exposureCoverage(storage, { sinceMs: started - 1_000 });
    expect(recent.measured).toBe(true);
    expect(recent.shown).toBe(3);
  });
});

describe("an application somebody reported (#14)", () => {
  it("is judged, not left as an unmeasured exposure", async () => {
    const rule = hookRule(RULE);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);

    await hooks.onAfterErrorResolution({
      errorContext: context,
      action: "Built the dependency project first",
      success: true,
      appliedInstinctIds: [String(rule.id)],
      correlationId: shown.correlationId,
    });

    const coverage = exposureCoverage(storage);
    expect(coverage.shown).toBe(1);
    // The repro: confidence moved, so the system plainly DID observe the
    // application — and coverage still read shown 1, judged 0, overstating the
    // gap the number exists to measure.
    expect(coverage.judged).toBe(1);
    expect(coverage.unjudged).toBe(0);
    expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThan(rule.confidence);
  });

  it("moves the confidence once, not twice", async () => {
    const rule = hookRule(RULE);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    await hooks.onAfterErrorResolution({
      errorContext: context,
      action: "Built the dependency project first",
      success: true,
      appliedInstinctIds: [String(rule.id)],
      correlationId: shown.correlationId,
    });
    const afterOne = storage.getInstinct(String(rule.id))!.confidence;

    // One application, one credit row, one confidence movement: routing the
    // judgement through the common writer must not add a second update.
    const rows = storage.getInstinctCredits({ instinctId: String(rule.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applied).toBe(true);
    expect(rows[0]!.confidenceAfter).toBeCloseTo(afterOne, 10);
  });
});

describe("an application report that is not usable (#16)", () => {
  it("treats a blank id as INCOMPLETE, not as 'nothing was applied'", async () => {
    const rule = hookRule(RULE);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);

    await hooks.onAfterErrorResolution({
      errorContext: context,
      action: "Something happened",
      success: true,
      appliedInstinctIds: [" "],
      correlationId: shown.correlationId,
    });

    // The repro: [" "] was filtered to [], which reads as the explicit report
    // "I used none of it" — so garbage input penalised a rule.
    expect(
      storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied),
    ).toHaveLength(0);
    expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThanOrEqual(rule.confidence);
    expect(hooks.getStats().unjudgedExposures).toBe(1);
  });

  it("still honours a genuinely empty report", async () => {
    const rule = hookRule(RULE);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    await hooks.onAfterErrorResolution({
      errorContext: context,
      action: "Repaired another way",
      success: true,
      appliedInstinctIds: [],
      correlationId: shown.correlationId,
    });
    // An empty array IS a statement, and must keep meaning one.
    expect(
      storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied),
    ).toHaveLength(1);
  });
});

describe("exposure retention (#15)", () => {
  it("is swept by the pipeline's own retention pass", () => {
    taughtRule(RULE);
    const now = Date.now();
    pipeline.noteGuidanceShown({
      sessionId: SESSION,
      taskRunId: "old",
      instinctIds: [RULE],
      shownAt: now - 200 * 86_400_000,
    });
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "new", instinctIds: [RULE], shownAt: now - 3_600_000 });
    expect(exposureCoverage(storage).shown).toBe(2);

    // The repro: pruneInstinctExposures had no caller at all, so rows accumulated
    // for ever across restarts and maintenance.
    const swept = pipeline.pruneExposures();
    expect(swept.deleted).toBe(1);
    expect(swept.retentionDays).toBeGreaterThan(0);
    expect(exposureCoverage(storage).shown).toBe(1);
  });

  it("is swept by the periodic pass the daemon actually runs, not only on demand", async () => {
    // The finding was that NOTHING called it. A test that calls the method itself
    // proves the method works and says nothing about the wiring, so this drives the
    // timer the daemon drives: start() → periodic tick → retention.
    const swept = new LearningPipeline(storage, { detectionIntervalMs: 50 as never, exposureRetentionDays: 30 });
    try {
      const now = Date.now();
      swept.noteGuidanceShown({
        sessionId: SESSION,
        taskRunId: "ancient",
        instinctIds: [RULE],
        shownAt: now - 400 * 86_400_000,
      });
      swept.noteGuidanceShown({ sessionId: SESSION, taskRunId: "fresh", instinctIds: [RULE], shownAt: now - 60_000 });
      taughtRule(RULE);
      expect(exposureCoverage(storage).shown).toBe(2);

      vi.useFakeTimers();
      swept.start();
      await vi.advanceTimersByTimeAsync(60);
      expect(exposureCoverage(storage).shown).toBe(1);
    } finally {
      vi.useRealTimers();
      swept.stop();
    }
  });

  it("states the retained window, so 'since N days' cannot mislead", () => {
    taughtRule(RULE);
    const now = Date.now();
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "r", instinctIds: [RULE], shownAt: now - 3_600_000 });

    // A window reaching further back than retention keeps rows cannot be read as
    // "this is all that ever happened".
    const wide = exposureCoverage(storage, { sinceMs: now - 365 * 86_400_000, now, retentionDays: 90 });
    expect(wide.retentionDays).toBe(90);
    expect(wide.windowExceedsRetention).toBe(true);
    const text = renderExposureCoverage(wide);
    // The retained window is STATED, with the number, and the reader is told the
    // window they asked for reaches past it.
    expect(text).toMatch(/kept for 90 day/);
    expect(text).toMatch(/LESS than the window/);

    const inside = exposureCoverage(storage, { sinceMs: now - 7 * 86_400_000, now, retentionDays: 90 });
    expect(inside.windowExceedsRetention).toBe(false);
    expect(renderExposureCoverage(inside)).toMatch(/kept for 90 day\(s\), which covers this window/);
  });
});

describe("a learning.db written before the exposure log existed", () => {
  it("opens, gains the table, and records exposures from then on", () => {
    // The live learning.db has no instinct_exposure_log. A missing table would
    // break every exposure write — and those writes are guarded, so the failure
    // would be SILENT and the coverage number would read as "not measured" for
    // ever, which is the failure mode this whole feature exists to remove.
    const legacyPath = join(dir, "legacy-learning.db");
    const raw = new Database(legacyPath);
    raw.exec(`CREATE TABLE instinct_credit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, instinct_id TEXT NOT NULL, session_id TEXT NOT NULL,
      task_run_id TEXT, success INTEGER NOT NULL, verdict_score REAL NOT NULL, source TEXT NOT NULL,
      confidence_before REAL NOT NULL, confidence_after REAL NOT NULL, status_at TEXT NOT NULL,
      timestamp INTEGER NOT NULL)`);
    raw.close();

    const legacy = new LearningStorage(legacyPath);
    legacy.initialize();
    try {
      // Nothing was recorded before the table existed, so the honest answer for
      // the period before it is NOT MEASURED, not "none unjudged".
      expect(exposureCoverage(legacy).measured).toBe(false);
      legacy.recordInstinctExposure({ instinctId: RULE, sessionId: SESSION, taskRunId: "run-1", shownAt: Date.now() });
      const coverage = exposureCoverage(legacy);
      expect(coverage.measured).toBe(true);
      expect(coverage.unjudged).toBe(1);
    } finally {
      legacy.close();
    }
  });
});

describe("the report names what it measured", () => {
  it("says NOT MEASURED when no exposure was ever recorded, never 'none unjudged'", () => {
    taughtRule(RULE);
    const coverage = exposureCoverage(storage);
    expect(coverage.measured).toBe(false);
    expect(coverage.shown).toBe(0);
    const text = renderExposureCoverage(coverage);
    expect(text).toContain("NOT MEASURED");
    // The failure this whole exercise is about: a silent zero reading as health.
    expect(text).not.toMatch(/\b0 unjudged\b/);
    expect(text.toLowerCase()).toContain("no exposure");
  });

  it("states the period it covers, and excludes what falls outside it", () => {
    taughtRule(RULE);
    const now = Date.now();
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "old", instinctIds: [RULE], shownAt: now - 90 * 86_400_000 });
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "new", instinctIds: [RULE], shownAt: now - 3_600_000 });

    const week = exposureCoverage(storage, { sinceMs: now - 7 * 86_400_000, now });
    expect(week.shown).toBe(1);
    const text = renderExposureCoverage(week);
    expect(text).toMatch(/7d|last 7|since/i);
    expect(text).toContain("1 exposure");

    // And the whole history is still available, so a narrow window cannot read as
    // "this is all there ever was".
    expect(exposureCoverage(storage, { now }).shown).toBe(2);
  });

  it("says plainly how much of the measurement is missing", () => {
    taughtRule(RULE);
    const shownAt = Date.now() - 5_000;
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-1", instinctIds: [RULE], shownAt });
    pipeline.noteGuidanceShown({ sessionId: SESSION, taskRunId: "run-2", instinctIds: [RULE], shownAt });
    pipeline.noteGuidanceNotApplied({
      sessionId: SESSION,
      taskRunId: "run-1",
      instinctId: RULE,
      exposedAt: shownAt,
      betaDelta: NON_APPLICATION_BETA,
    });

    const text = renderExposureCoverage(exposureCoverage(storage));
    expect(text).toContain("2 exposure");
    expect(text).toContain("1");
    expect(text.toLowerCase()).toMatch(/unjudged|not judged/);
  });
});
