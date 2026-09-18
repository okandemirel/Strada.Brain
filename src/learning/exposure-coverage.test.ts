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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LearningStorage } from "./storage/learning-storage.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { exposureCoverage, renderExposureCoverage } from "./ledger.js";
import { NON_APPLICATION_BETA } from "./hooks/error-learning-hooks.js";

let dir: string;
let dbPath: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exposure-coverage-"));
  dbPath = join(dir, "learning.db");
  storage = new LearningStorage(dbPath);
  storage.initialize();
  pipeline = new LearningPipeline(storage);
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
