/**
 * A COST-ONLY MISFIRE IS EVIDENCE (§9 improvement 6.4/6.3 follow-up).
 *
 * The 6.3 ablation measured it: guidance recalled on a look-alike trigger is
 * noticed to be irrelevant, discarded, and costs the run one attempt — and used
 * to leave NOTHING behind. No credit row, no confidence movement, nothing
 * `findSuspectGuidance` could rank. So the same rule kept being recalled for the
 * same wrong trigger for ever, and the harmful-recall rate could only be
 * measured, never reduced.
 *
 * What a non-application is NOT: a failed application. The rule's action was
 * never tried, so `timesFailed` must not move and one misfire must not retire a
 * rule that is right about its own trigger.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorLearningHooks, NON_APPLICATION_BETA, type ErrorContext, type ResolutionContext } from "./hooks/error-learning-hooks.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { PatternMatcher } from "./matching/pattern-matcher.js";
import { ConfidenceScorer } from "./scoring/confidence-scorer.js";
import { LearningStorage } from "./storage/learning-storage.js";
import Database from "better-sqlite3";
import { findSuspectGuidance } from "./ledger.js";

let dir: string;
let storage: LearningStorage;
let hooks: ErrorLearningHooks;

/** The taught rule: a CS0006 metadata error means build the dependency first. */
function taughtRule(id: string, trigger: string, action: string, confidence = 0.8) {
  storage.createInstinct({
    id,
    name: id,
    type: "error_fix" as const,
    status: "active" as const,
    confidence,
    triggerPattern: trigger,
    action,
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    // The posterior the stored confidence actually comes from: five
    // observations. Without it the scorer re-derives alpha/beta from the
    // stats and the number MOVES for a reason that has nothing to do with
    // this test.
    bayesianAlpha: confidence * 5,
    bayesianBeta: (1 - confidence) * 5,
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
    sessionId: "session-misfire",
    timestamp: new Date(),
  };
}

/** The SAME context object the run was shown, which is what production passes. */
function resolution(context: ErrorContext, action: string, success = true): ResolutionContext {
  return { errorContext: context, action, success };
}

/** Show the guidance for one error, then resolve that same error another way. */
function showThenResolveOtherwise(output: string, otherRepair: string) {
  const context = errorContext(output);
  const shown = hooks.onBeforeErrorAnalysis(context);
  return { shown, settle: () => hooks.onAfterErrorResolution(resolution(context, otherRepair)) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "non-application-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  hooks = new ErrorLearningHooks(new LearningPipeline(storage), new PatternMatcher(storage), new ConfidenceScorer(), storage);
  hooks.enable();
});
afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("guidance shown to a run that did not use it", () => {
  const CS0006 = "error CS0006: Metadata file 'Strada.Modules.dll' could not be found";
  /** The same code, a cause the taught repair cannot fix: the project is gone. */
  const OTHER_CAUSE =
    "error CS0006: Metadata file 'Legacy.Removed.dll' could not be found — the reference points at a project deleted from the solution";
  const OTHER_REPAIR = "Remove the stale reference from the csproj";

  /** Show the rule for OTHER_CAUSE and prove it really was shown. */
  async function misfireOnce(ruleId: string) {
    const run = showThenResolveOtherwise(OTHER_CAUSE, OTHER_REPAIR);
    expect(run.shown.suggestions.map((x) => String(x.instinct?.id))).toContain(ruleId);
    await run.settle();
  }

  it("leaves dated evidence against the rule instead of nothing at all", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, "Build the dependency project first, then re-run");
    // The run is shown the rule for a DIFFERENT cause with the same error code.
    const run = showThenResolveOtherwise(OTHER_CAUSE, OTHER_REPAIR);
    expect(run.shown.recoveryInjection.length).toBeGreaterThan(0);
    expect(run.shown.suggestions.map((s) => String(s.instinct?.id))).toContain(rule.id);

    // It is repaired a completely different way: remove the stale reference.
    await run.settle();

    const credits = storage.getInstinctCredits({ instinctId: String(rule.id) });
    expect(credits).toHaveLength(1);
    expect(credits[0]!.applied).toBe(false);
    expect(credits[0]!.success).toBe(false);
    expect(credits[0]!.exposedAt).toBeTypeOf("number");
    // Weaker than a failure, and it moved.
    const after = storage.getInstinct(String(rule.id))!;
    expect(after.confidence).toBeLessThan(rule.confidence);
    // The ACTION was never tried, so nothing counts it as a failed application.
    expect(after.stats.timesFailed).toBe(rule.stats.timesFailed);
  });

  it("makes the misfiring rule findable, and says the action was never tried", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, "Build the dependency project first, then re-run");
    await misfireOnce(String(rule.id));

    const suspects = findSuspectGuidance(storage);
    const row = suspects.find((s) => s.id === String(rule.id));
    expect(row).toBeDefined();
    expect(row!.shownNotApplied).toBe(1);
    // Not reported as a broken action: no failed run, and the sentence says so.
    expect(row!.failedRuns).toBe(0);
    expect(row!.why).toContain("did not use it");
    // The clock on "wrong and still in effect" has started.
    expect(row!.msWrongAndStillInEffect).toBeGreaterThanOrEqual(0);
  });

  it("does not punish the rule the run actually applied (guard)", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, "Build the dependency project first, then re-run");
    // The resolution IS the rule's own action.
    await showThenResolveOtherwise(CS0006, "Build the dependency project first, then re-run").settle();

    const credits = storage.getInstinctCredits({ instinctId: String(rule.id) });
    expect(credits.filter((c) => !c.applied)).toHaveLength(0);
    expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThanOrEqual(rule.confidence);
  });

  it("one misfire cannot silence a rule; repeated ones take it under the gate", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, "Build the dependency project first, then re-run", 0.6);
    await misfireOnce(String(rule.id));
    const afterOne = storage.getInstinct(String(rule.id))!.confidence;
    // Still usable after a single coincidence — tightening a gate cuts both ways.
    expect(afterOne).toBeGreaterThan(0.5);
    // Keep misfiring on the same wrong trigger. THE POINT is that the recall
    // stops: the run is no longer shown this rule for this error, so the
    // wasted attempt stops being paid every time.
    let misfires = 1;
    let stillShown = true;
    for (let i = 0; i < 30 && stillShown; i++) {
      const run = showThenResolveOtherwise(OTHER_CAUSE, OTHER_REPAIR);
      stillShown = run.shown.suggestions.some((x) => String(x.instinct?.id) === String(rule.id));
      await run.settle();
      if (stillShown) misfires++;
    }
    expect(stillShown).toBe(false);
    // Not on the first coincidence, and not after an unbounded number either.
    expect(misfires).toBeGreaterThan(1);
    expect(misfires).toBeLessThan(12);
    const afterMany = storage.getInstinct(String(rule.id))!.confidence;
    expect(afterMany).toBeLessThan(afterOne);
    expect(storage.getInstinctCredits({ instinctId: String(rule.id) }).every((c) => !c.applied)).toBe(true);
  });

  it("records nothing when nothing was shown, and nothing when the hooks are off", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, "Build the dependency project first, then re-run");
    // Never shown: onAfterErrorResolution alone must not invent evidence.
    await hooks.onAfterErrorResolution(resolution(errorContext(CS0006), "Some unrelated repair"));
    expect(storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied)).toHaveLength(0);

    // Tracked, but nothing MATCHED, so nothing was shown: an unrelated error
    // must not hand out evidence against every rule in the store.
    const unrelated = errorContext("git_commit failed: cannot lock ref 'refs/heads/main'");
    const nothingShown = hooks.onBeforeErrorAnalysis(unrelated);
    expect(nothingShown.suggestions).toHaveLength(0);
    await hooks.onAfterErrorResolution(resolution(unrelated, "Remove the stale index.lock"));
    expect(storage.getInstinctCredits({ instinctId: String(rule.id) })).toHaveLength(0);

    const context = errorContext(CS0006);
    hooks.onBeforeErrorAnalysis(context);
    hooks.disable();
    await hooks.onAfterErrorResolution(resolution(context, "Some unrelated repair"));
    expect(storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied)).toHaveLength(0);
  });

  it("weighs a misfire below a real failure", () => {
    // The constant is the contract: a failed application adds ~0.8 to beta.
    expect(NON_APPLICATION_BETA).toBeLessThan(0.8 / 2);
    expect(NON_APPLICATION_BETA).toBeGreaterThan(0);
  });
});

describe("a credit ledger written before the column existed", () => {
  it("migrates, and every old row still reads as an application", () => {
    // The live learning.db has instinct_credit_log without `applied`; every
    // statement names the column now, so a missing migration would break the
    // ledger outright. Those rows WERE applications, so absence must not read
    // as a misfire and invent evidence against guidance that worked.
    const legacyPath = join(dir, "legacy-learning.db");
    const raw = new Database(legacyPath);
    raw.exec(`CREATE TABLE instinct_credit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, instinct_id TEXT NOT NULL, session_id TEXT NOT NULL,
      task_run_id TEXT, success INTEGER NOT NULL, verdict_score REAL NOT NULL, source TEXT NOT NULL,
      confidence_before REAL NOT NULL, confidence_after REAL NOT NULL, status_at TEXT NOT NULL,
      timestamp INTEGER NOT NULL)`);
    raw.prepare(
      `INSERT INTO instinct_credit_log (instinct_id, session_id, success, verdict_score, source,
        confidence_before, confidence_after, status_at, timestamp)
       VALUES ('old-rule', 'old-session', 1, 0.9, 'terminal', 0.7, 0.75, 'active', ?)`,
    ).run(Date.now());
    raw.close();

    const legacy = new LearningStorage(legacyPath);
    legacy.initialize();
    try {
      const credits = legacy.getInstinctCredits({ instinctId: "old-rule" });
      expect(credits).toHaveLength(1);
      expect(credits[0]!.applied).toBe(true);
      expect(credits[0]!.success).toBe(true);
    } finally {
      legacy.close();
    }
  });
});
