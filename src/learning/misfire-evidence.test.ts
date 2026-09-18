/**
 * ROUND 13 #24 / #25 — WHAT A MISFIRE PENALTY MAY BE BUILT FROM.
 *
 * The cost-only misfire penalty (97f7d92d) was derived from TEXT: whatever the
 * run reported as its resolution was compared, by substring, against every
 * ACTIVE instinct's action, and every rule shown to the run that did not match
 * was booked as "shown and not used" and had its confidence lowered.
 *
 * That punishes a rule for WORDING. Suggest "Build the dependency project first"
 * and resolve the error with "Compile the referenced dependency before
 * rebuilding" — the same remedy, said differently — and the rule that was right
 * is penalised, repeatedly, until it drops under the recovery gate and stops
 * being recalled at all. Tightening a gate cuts both ways: a penalty meant to
 * find misfiring triggers was silencing correct ones, which is learning going
 * dark.
 *
 * So a penalty now needs EVIDENCE of what the run actually used, and what it
 * measures is a demonstrated trigger misfire. A resolution that reports nothing
 * leaves the exposure UNJUDGED and says so — an honest gap beats a wrong number.
 *
 * #25 is the other half: one exposure must produce ONE ledger row. The hook wrote
 * its negative row straight to storage while the run's terminal settlement wrote
 * a positive one for the same instinct, the same run and the same exposure time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ErrorLearningHooks,
  NON_APPLICATION_BETA,
  type ErrorContext,
  type ResolutionContext,
} from "./hooks/error-learning-hooks.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { PatternMatcher } from "./matching/pattern-matcher.js";
import { ConfidenceScorer } from "./scoring/confidence-scorer.js";
import { LearningStorage } from "./storage/learning-storage.js";
import type { InstinctStatus } from "./types.js";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;
let hooks: ErrorLearningHooks;

const CS0006 = "error CS0006: Metadata file 'Strada.Modules.dll' could not be found";
/** The taught remedy, in the words the rule happens to use. */
const TAUGHT_ACTION = "Build the dependency project first, then re-run";
/** The SAME remedy, in the words a run happens to report. */
const SAME_REMEDY_OTHER_WORDS = "Compile the referenced dependency before rebuilding";

function taughtRule(
  id: string,
  trigger: string,
  action: string,
  confidence = 0.8,
  status: InstinctStatus = "active",
) {
  storage.createInstinct({
    id,
    name: id,
    type: "error_fix" as const,
    status,
    confidence,
    triggerPattern: trigger,
    action,
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    bayesianAlpha: confidence * 5,
    bayesianBeta: (1 - confidence) * 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return storage.getInstinct(id)!;
}

function errorContext(output: string, sessionId = "session-misfire"): ErrorContext {
  return {
    toolName: "dotnet_build",
    errorOutput: output,
    analysis: { hasErrors: true, errorCount: 1, summary: "1 error", recoveryInjection: "" },
    sessionId,
    timestamp: new Date(),
  };
}

function resolution(
  context: ErrorContext,
  action: string,
  extra: Partial<ResolutionContext> = {},
): ResolutionContext {
  return { errorContext: context, action, success: true, ...extra };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "misfire-evidence-"));
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

describe("#24 — a rule that was RIGHT is not penalised for wording", () => {
  it("leaves a correctly applied, differently worded resolution unpunished", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    expect(shown.suggestions.map((s) => String(s.instinct?.id))).toContain(String(rule.id));

    // The run used exactly this guidance and said so in its own words.
    await hooks.onAfterErrorResolution(resolution(context, SAME_REMEDY_OTHER_WORDS));

    // The repro: substring matching found no application, so the rule that was
    // right was booked as "shown and not used" and its confidence dropped.
    const penalties = storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied);
    expect(penalties).toHaveLength(0);
    expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThanOrEqual(rule.confidence);
  });

  it("keeps recalling that rule instead of pushing it under the gate", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION, 0.6);
    for (let i = 0; i < 12; i++) {
      const context = errorContext(CS0006);
      const shown = hooks.onBeforeErrorAnalysis(context);
      expect(shown.suggestions.map((s) => String(s.instinct?.id))).toContain(String(rule.id));
      await hooks.onAfterErrorResolution(resolution(context, SAME_REMEDY_OTHER_WORDS));
    }
    // The repro: twelve correct applications, reported in different words,
    // silenced the rule.
    expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThanOrEqual(0.6);
    const last = hooks.onBeforeErrorAnalysis(errorContext(CS0006));
    expect(last.suggestions.map((s) => String(s.instinct?.id))).toContain(String(rule.id));
  });

  it("penalises the rule the run demonstrably did not use", async () => {
    const shownRule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const usedRule = taughtRule("cs0006-remove-stale-reference", CS0006, "Remove the stale reference");
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    expect(shown.suggestions.map((s) => String(s.instinct?.id))).toContain(String(shownRule.id));

    // EVIDENCE, not wording: the run reports which guidance it applied.
    await hooks.onAfterErrorResolution(
      resolution(context, "Removed the stale reference from the csproj", {
        appliedInstinctIds: [String(usedRule.id)],
      }),
    );

    const penalties = storage
      .getInstinctCredits({ instinctId: String(shownRule.id) })
      .filter((c) => !c.applied);
    expect(penalties).toHaveLength(1);
    expect(storage.getInstinct(String(shownRule.id))!.confidence).toBeLessThan(shownRule.confidence);
    // The rule that WAS used is not penalised by its own misfire report.
    expect(
      storage.getInstinctCredits({ instinctId: String(usedRule.id) }).filter((c) => !c.applied),
    ).toHaveLength(0);
  });

  it("treats 'none of what I was shown' as evidence too", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const context = errorContext(CS0006);
    hooks.onBeforeErrorAnalysis(context);
    // An empty list is a REPORT ("I used none of it"), which is a demonstrated
    // misfire; `undefined` is silence, which is not evidence of anything.
    await hooks.onAfterErrorResolution(
      resolution(context, "Deleted the whole obj directory", { appliedInstinctIds: [] }),
    );
    expect(
      storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied),
    ).toHaveLength(1);
  });

  /**
   * ROUND 14 #14 — THE THIRD TIME THIS EXACT THING HAS BEEN CAUGHT.
   *
   * #24 made a penalty require evidence but left the TEXT path able to supply it:
   * a resolution whose text matched a rule's action identified that rule as
   * applied, which made every other shown rule a "demonstrated" misfire. Report a
   * resolution that names BOTH rules' actions — both were used — and the first
   * match wins while the second is penalised for the words it happens to use.
   *
   * A text match can no longer establish non-application at all. It may still
   * identify a rule to REINFORCE; it may never be the reason another rule is
   * punished. When the report is not explicit and complete, the answer is "we do
   * not know", and that is counted rather than guessed.
   */
  it("penalises neither rule when one resolution names both their actions", async () => {
    const first = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const second = taughtRule("cs0006-restore-packages", CS0006, "Restore the NuGet packages first");
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    const shownIds = shown.suggestions.map((s) => String(s.instinct?.id));
    expect(shownIds).toContain(String(first.id));
    expect(shownIds).toContain(String(second.id));

    // The run did both, and says so in one sentence.
    await hooks.onAfterErrorResolution(
      resolution(context, `${TAUGHT_ACTION}, and restore the NuGet packages first`),
    );

    for (const rule of [first, second]) {
      expect(
        storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied),
        `${String(rule.id)} was penalised for its wording`,
      ).toHaveLength(0);
      expect(storage.getInstinct(String(rule.id))!.confidence).toBeGreaterThanOrEqual(rule.confidence);
    }
    // Nobody said WHICH guidance was used, so nothing was judged — and it says so.
    expect(hooks.getStats().unjudgedExposures).toBe(1);
  });

  it("treats a report naming an unknown rule as incomplete, not as evidence", async () => {
    const rule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const context = errorContext(CS0006);
    hooks.onBeforeErrorAnalysis(context);
    // An id the store does not know means the report cannot be checked against
    // what was shown: the rule it names might be this one under another name.
    await hooks.onAfterErrorResolution(
      resolution(context, "Did something else", { appliedInstinctIds: ["rule-that-does-not-exist"] }),
    );
    expect(
      storage.getInstinctCredits({ instinctId: String(rule.id) }).filter((c) => !c.applied),
    ).toHaveLength(0);
    expect(hooks.getStats().unjudgedExposures).toBe(1);
  });

  it("counts the exposures it could not judge instead of guessing at them", async () => {
    taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const context = errorContext(CS0006);
    hooks.onBeforeErrorAnalysis(context);
    await hooks.onAfterErrorResolution(resolution(context, SAME_REMEDY_OTHER_WORDS));
    // NOT MEASURED has to be visible, or a silent zero reads as "no misfires".
    expect(hooks.getStats().unjudgedExposures).toBe(1);
  });

  it("offers a rule that graduated, and can see it as the one that was applied", async () => {
    const evolved = taughtRule("cs0006-evolved", CS0006, TAUGHT_ACTION, 0.85, "evolved");
    const permanent = taughtRule("cs0006-permanent", CS0006, "Restore the NuGet packages first", 0.95, "permanent");
    const context = errorContext(CS0006);
    const shown = hooks.onBeforeErrorAnalysis(context);
    // The first repro: error recovery asked only for "active" and "proposed", so a
    // rule that had EARNED its way to `evolved` — or one the user made permanent —
    // was never offered at all. The best guidance in the store was invisible.
    const shownIds = shown.suggestions.map((s) => String(s.instinct?.id));
    expect(shownIds).toContain(String(evolved.id));
    expect(shownIds).toContain(String(permanent.id));

    // The second repro: findAppliedInstinct only ever looked at status "active",
    // so a graduated rule could never be found as applied — it was penalised on
    // every run that applied it.
    await hooks.onAfterErrorResolution(resolution(context, TAUGHT_ACTION));
    expect(
      storage.getInstinctCredits({ instinctId: String(evolved.id) }).filter((c) => !c.applied),
    ).toHaveLength(0);

    // And NOTHING is penalised on the strength of that text match (round 14 #14):
    // matching identifies a rule to reinforce, never a reason to punish another —
    // the resolution might have used both, in words of its own.
    const permanentPenalties = () =>
      storage.getInstinctCredits({ instinctId: String(permanent.id) }).filter((c) => !c.applied).length;
    expect(permanentPenalties()).toBe(0);

    // The permanent rule, reported as the one that WAS used: still no penalty, and
    // now the report is explicit, so the exposure is judged rather than counted.
    const second = errorContext(CS0006);
    hooks.onBeforeErrorAnalysis(second);
    await hooks.onAfterErrorResolution(
      resolution(second, "Restore the NuGet packages first", {
        appliedInstinctIds: [String(permanent.id)],
      }),
    );
    expect(permanentPenalties()).toBe(0);
  });
});

describe("#25 — one exposure, one ledger row", () => {
  it("does not credit and penalise the same exposure of the same rule", async () => {
    const shownRule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const usedRule = taughtRule("cs0006-remove-stale-reference", CS0006, "Remove the stale reference");
    const sessionId = "session-double";
    const runId = "run-double";
    const context = errorContext(CS0006, sessionId);
    const shown = hooks.onBeforeErrorAnalysis(context);
    expect(shown.suggestions.map((s) => String(s.instinct?.id))).toContain(String(shownRule.id));

    // The run's tool event names the guidance it was carrying, which is what
    // registers pending credit for the run's terminal verdict.
    await pipeline.handleToolResult({
      sessionId,
      taskRunId: runId,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [String(shownRule.id)],
      timestamp: Date.now(),
    });

    // The misfire hook says the run used the OTHER rule.
    await hooks.onAfterErrorResolution(
      resolution(context, "Removed the stale reference", {
        appliedInstinctIds: [String(usedRule.id)],
        taskRunId: runId,
      }),
    );

    // The run ends well.
    pipeline.clearRunInstinctCredits(sessionId, { success: true, verdictScore: 1 }, runId);

    const rows = storage.getInstinctCredits({ instinctId: String(shownRule.id) });
    // The repro: a negative `observed` row and a positive `terminal` row, both
    // stamped with the same exposure — the ledger contradicting itself about one
    // moment, so "which runs did this rule influence" has two answers.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.success).toBe(false);
  });

  it("weighs a misfire below a real failure", () => {
    expect(NON_APPLICATION_BETA).toBeLessThan(0.8 / 2);
    expect(NON_APPLICATION_BETA).toBeGreaterThan(0);
  });

  /**
   * ROUND 14 #13 — the dedup died with the run.
   *
   * The non-application is remembered per run so a later event cannot credit the
   * same exposure — but the run's teardown DELETED that memory, and the retained
   * verdict a late event settles against did not carry it. So an event that
   * arrived after teardown was judged by the run's (successful) verdict and wrote
   * a positive `terminal` row beside the negative `observed` one. The same
   * contradiction as #25, one queue delay later.
   */
  it("does not credit a settled non-application when the queued event arrives late", async () => {
    const shownRule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const usedRule = taughtRule("cs0006-remove-stale-reference", CS0006, "Remove the stale reference");
    const sessionId = "session-late";
    const runId = "run-late";
    const context = errorContext(CS0006, sessionId);
    hooks.onBeforeErrorAnalysis(context);

    await hooks.onAfterErrorResolution(
      resolution(context, "Removed the stale reference", {
        appliedInstinctIds: [String(usedRule.id)],
        taskRunId: runId,
      }),
    );
    // The run ends well, and is forgotten.
    pipeline.clearRunInstinctCredits(sessionId, { success: true, verdictScore: 1 }, runId);

    // NOW the tool event the serial queue was still holding arrives, naming the
    // rule the run was carrying.
    await pipeline.handleToolResult({
      sessionId,
      taskRunId: runId,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [String(shownRule.id)],
      timestamp: Date.now(),
    });

    const rows = storage.getInstinctCredits({ instinctId: String(shownRule.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applied).toBe(false);
    expect(rows.some((r) => r.success)).toBe(false);
  });

  /**
   * The same straggler, for a teardown that knew no terminal verdict.
   *
   * Nothing is remembered in `settledRuns` on that path — there is no verdict to
   * remember — so seeding `credited` cannot help: what protects this exposure is
   * that the run-scoped non-application record is NOT deleted at teardown (a
   * run-scoped key is never reused, unlike the chat's). Without it the late event
   * re-registered pending credit and the next teardown settled it.
   */
  it("does not re-open a settled non-application when the run had no terminal verdict", async () => {
    const shownRule = taughtRule("cs0006-build-dependency", CS0006, TAUGHT_ACTION);
    const usedRule = taughtRule("cs0006-remove-stale-reference", CS0006, "Remove the stale reference");
    const sessionId = "session-no-verdict";
    const runId = "run-no-verdict";
    const context = errorContext(CS0006, sessionId);
    hooks.onBeforeErrorAnalysis(context);

    await hooks.onAfterErrorResolution(
      resolution(context, "Removed the stale reference", {
        appliedInstinctIds: [String(usedRule.id)],
        taskRunId: runId,
      }),
    );
    // No terminal verdict: settled from what the run was observed to do.
    pipeline.clearRunInstinctCredits(sessionId, undefined, runId);

    await pipeline.handleToolResult({
      sessionId,
      taskRunId: runId,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [String(shownRule.id)],
      timestamp: Date.now(),
    });
    // A later teardown of the same run must find nothing to credit.
    pipeline.clearRunInstinctCredits(sessionId, { success: true, verdictScore: 1 }, runId);

    const rows = storage.getInstinctCredits({ instinctId: String(shownRule.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applied).toBe(false);
  });
});
