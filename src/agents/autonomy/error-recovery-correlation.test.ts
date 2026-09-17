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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
