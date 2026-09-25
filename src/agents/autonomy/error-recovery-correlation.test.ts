/**
 * ROUND 13 #26 — THE EVIDENCE NEVER REACHED PRODUCTION.
 *
 * Two independent reasons, both measured here.
 *
 *   1. THE CORRELATION ID WAS A HASH OF A TIMESTAMP. `analyze()` tracks the
 *      exposure under `tool:error:Date.now()`, and `recordResolution()` built a
 *      FRESH `new Date()` for its own ErrorContext — so one millisecond later the
 *      id was different, `activeErrors` had no such key, and every resolution took
 *      the "untracked" branch: no application evidence, no non-application
 *      evidence, nothing about which guidance the run used.
 *   2. NOTHING CALLED IT. `recordResolution` had no runtime caller at all, so even
 *      a correct id would have arrived from nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorRecoveryEngine } from "./error-recovery.js";
import { ErrorLearningHooks } from "../../learning/hooks/error-learning-hooks.js";
import { LearningPipeline } from "../../learning/pipeline/learning-pipeline.js";
import { PatternMatcher } from "../../learning/matching/pattern-matcher.js";
import { ConfidenceScorer } from "../../learning/scoring/confidence-scorer.js";
import { LearningStorage } from "../../learning/storage/learning-storage.js";
import type { ToolResult } from "../providers/provider.interface.js";

const CS0006 =
  "Assets/App.cs(1,1): CS0006 — Metadata file 'Strada.Modules.dll' could not be found";
const RULE = "cs0006-build-dependency";
const OTHER_RULE = "cs0006-remove-stale-reference";

let dir: string;
let storage: LearningStorage;
let hooks: ErrorLearningHooks;
let engine: ErrorRecoveryEngine;

function taughtRule(id: string, action: string) {
  storage.createInstinct({
    id,
    name: id,
    type: "error_fix" as const,
    status: "active" as const,
    confidence: 0.8,
    triggerPattern: CS0006,
    action,
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    bayesianAlpha: 4,
    bayesianBeta: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return storage.getInstinct(id)!;
}

const failing: ToolResult = { content: CS0006, isError: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recovery-correlation-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  hooks = new ErrorLearningHooks(
    new LearningPipeline(storage),
    new PatternMatcher(storage),
    new ConfidenceScorer(),
    storage,
  );
  engine = new ErrorRecoveryEngine();
  engine.enableLearning(hooks, { enableLearning: true, sessionId: "session-recovery" });
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a resolution recorded through the recovery engine", () => {
  it("correlates with the exposure the same engine created", async () => {
    taughtRule(RULE, "Build the dependency project first, then re-run");
    const used = taughtRule(OTHER_RULE, "Remove the stale reference from the csproj");

    const analysis = engine.analyze("dotnet_build", failing);
    expect(analysis?.recoveryInjection).toContain(RULE);

    // A millisecond later, as production would: the engine must carry its own
    // correlation id rather than rebuild one from a new Date.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await engine.recordResolution({
      toolName: "dotnet_build",
      errorOutput: CS0006,
      analysis: analysis!,
      action: "Removed the stale reference from the csproj",
      success: true,
      appliedInstinctIds: [String(used.id)],
    });

    // THE TEETH: a row against the rule that was shown and demonstrably not used.
    // Before the fix the resolution correlated with nothing, so the exposure was
    // never judged at all — the untracked branch skipped it in silence.
    const rows = storage.getInstinctCredits({ instinctId: RULE }).filter((c) => !c.applied);
    expect(rows).toHaveLength(1);
    expect(hooks.getStats().activeErrors).toBe(0);
  });

  /**
   * ROUND 14 #15 — an older queued resolution erased a newer error.
   *
   * `recordResolution` deleted the open error for the tool unconditionally, and it
   * is scheduled rather than awaited. So A's resolution, draining after failure B
   * has already been analysed for the same tool, removed B's correlation — and
   * B's eventual success had nothing to close, leaving its exposure unjudged for
   * ever. Only the entry the resolution is actually FOR may be removed.
   */
  it("does not erase a newer error's correlation when an older resolution drains", async () => {
    taughtRule(RULE, "Build the dependency project first, then re-run");

    // Failure A, then A's repair lands: the report is scheduled, not yet run.
    engine.analyze("dotnet_build", failing);
    engine.analyze("dotnet_build", { content: "Build succeeded", isError: false });

    // Failure B on the SAME tool, analysed while A's report is still in flight.
    // Another CS0006, so the same rule is shown for B too — both exposures are
    // real exposures, and both must end up judged or counted.
    const secondError =
      "Assets/Other.cs(9,4): CS0006 — Metadata file 'Strada.Other.dll' could not be found";
    engine.analyze("dotnet_build", { content: secondError, isError: true });
    expect(hooks.getStats().activeErrors).toBe(2);

    // A's queued report drains here.
    await engine.flushLearning();

    // B's own repair lands. Its exposure must still be closable.
    engine.analyze("dotnet_build", { content: "Build succeeded", isError: false });
    await engine.flushLearning();

    // The repro: A's drain had deleted B's correlation, so this stayed at 1 and
    // B's exposure was never judged or counted.
    expect(hooks.getStats().activeErrors).toBe(0);
    expect(hooks.getStats().unjudgedExposures).toBe(2);
  });

  it("is reported by the runtime when the same tool succeeds afterwards", async () => {
    taughtRule(RULE, "Build the dependency project first, then re-run");
    engine.analyze("dotnet_build", failing);
    expect(hooks.getStats().activeErrors).toBe(1);

    // The repair lands: the same tool, on the same target, succeeds. This is the
    // completion signal the engine sees on every tool result — and nothing was
    // wired to it, so `recordResolution` had no caller in the whole runtime.
    engine.analyze("dotnet_build", { content: "Build succeeded", isError: false });
    await engine.flushLearning();

    expect(hooks.getStats().activeErrors).toBe(0);
    // Nobody reported WHICH guidance was used, so the exposure is unjudged and
    // says so — never a penalty invented from the success text, and never a new
    // rule minted from a tool's output.
    expect(hooks.getStats().unjudgedExposures).toBe(1);
    expect(storage.getInstinctCredits({ instinctId: RULE })).toHaveLength(0);
    expect(storage.getInstincts().map((i) => i.id)).toEqual([RULE]);
  });
});

/**
 * AUT-14 — the engine lost correlation ids the process-wide hooks kept waiting
 * on: a newer failure of the same tool replaced the open one, a repair came too
 * late to link, and a failure with no analysis was asked about before it was
 * analysed, so guidance that never reached a prompt was recorded as shown.
 */
describe("exposures the engine can no longer close", () => {
  const variant = (i: number) =>
    `Assets/App${i}.cs(1,1): CS0006 — Metadata file 'Strada.Modules.dll' could not be found`;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("failing the same tool three times, then succeeding, leaves nothing tracked", async () => {
    taughtRule(RULE, "Build the dependency project first, then re-run");
    for (let i = 0; i < 3; i++) {
      engine.analyze("dotnet_build", { content: variant(i), isError: true });
    }
    engine.analyze("dotnet_build", { content: "Build succeeded", isError: false });
    await engine.flushLearning();

    expect(hooks.getStats().activeErrors).toBe(0);
    // All three were shown and none was judged: counted, not lost.
    expect(hooks.getStats().unjudgedExposures).toBe(3);
  });

  it("a repair outside the link window releases the exposure", async () => {
    vi.useFakeTimers();
    taughtRule(RULE, "Build the dependency project first, then re-run");
    engine.analyze("dotnet_build", failing);
    vi.advanceTimersByTime(121_000);
    engine.analyze("dotnet_build", { content: "Build succeeded", isError: false });
    await engine.flushLearning();

    expect(hooks.getStats().activeErrors).toBe(0);
    expect(hooks.getStats().unjudgedExposures).toBe(1);
  });

  it("a failure with no analysis is never recorded as shown guidance", () => {
    taughtRule(RULE, "Build the dependency project first, then re-run");
    // A failed shell command whose output matches the rule but none of the
    // runtime error shapes: there is no analysis to carry any guidance.
    const analysis = engine.analyze("shell_exec", failing);

    expect(analysis).toBeNull();
    expect(hooks.getStats().activeErrors).toBe(0);
    expect(storage.getExposureCoverage()).toEqual([]);
  });
});
