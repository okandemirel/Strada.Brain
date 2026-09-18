/**
 * THE ENGINE A RUN USES WAS NOT THE ENGINE THAT LEARNS.
 *
 * Every round-13/14/15 fix to error-recovery learning — the correlation id, the
 * per-tool open error, the run-scoped exposure — was made to an
 * ErrorRecoveryEngine that `enableLearning` was called on ONCE at startup
 * (bootstrap's learning init) and that nothing ever ran. The engine a task
 * actually calls `analyze()` on is built per task by `createAutonomyBundle`, and
 * it had no hooks at all: no exposure was recorded, no learned solution was
 * injected, and `strada learning coverage` could only ever report absence
 * because nothing in a real run had ever reported presence.
 *
 * Two things are asserted here: the bundle's engine learns when the host has
 * hooks, and the scope it files under is the one the credit ledger keys by.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";
import { ErrorLearningHooks } from "../learning/hooks/error-learning-hooks.js";
import { LearningPipeline } from "../learning/pipeline/learning-pipeline.js";
import { PatternMatcher } from "../learning/matching/pattern-matcher.js";
import { ConfidenceScorer } from "../learning/scoring/confidence-scorer.js";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import type { ToolResult } from "./providers/provider.interface.js";

const CS0006 = "Assets/App.cs(1,1): CS0006 — Metadata file 'Strada.Modules.dll' could not be found";
const RULE = "cs0006-build-dependency";
const failing: ToolResult = { content: CS0006, isError: true };

let dir: string;
let storage: LearningStorage;
let hooks: ErrorLearningHooks;

function taughtRule(): void {
  storage.createInstinct({
    id: RULE,
    name: RULE,
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
}

function exposures(): Array<{ instinct_id: string; session_id: string; task_run_id: string }> {
  return storage
    .getDatabase()!
    .prepare("SELECT instinct_id, session_id, task_run_id FROM instinct_exposure_log ORDER BY id")
    .all() as Array<{ instinct_id: string; session_id: string; task_run_id: string }>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recovery-wiring-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  hooks = new ErrorLearningHooks(
    new LearningPipeline(storage),
    new PatternMatcher(storage),
    new ConfidenceScorer(),
    storage,
  );
  taughtRule();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the autonomy bundle's recovery engine learns", () => {
  it("records the exposure under the run's own scope, asked for at analysis time", () => {
    let liveRun: string | undefined = "run-1";
    const bundle = createAutonomyBundle({
      prompt: "fix the build",
      iterationBudget: 5,
      errorLearning: { hooks, sessionId: "chat-42", resolveTaskRunId: () => liveRun },
    });
    expect(bundle.errorRecovery.isLearningEnabled()).toBe(true);

    // The call the tool loop makes, on the engine the tool loop holds.
    const analysis = bundle.errorRecovery.analyze("dotnet_build", failing);
    expect(analysis?.hasErrors).toBe(true);
    // And the taught rule reached the run: an exposure is only worth recording
    // because something was actually shown.
    expect(analysis?.recoveryInjection).toContain("Build the dependency project first");
    expect(exposures()).toEqual([{ instinct_id: RULE, session_id: "chat-42", task_run_id: "run-1" }]);

    // A SECOND RUN ON THE SAME ENGINE IS A SECOND SCOPE. The engine outlives no
    // run, so the scope cannot be a field captured when learning was enabled.
    liveRun = "run-2";
    bundle.errorRecovery.analyze("dotnet_build", failing);
    expect(exposures().map((row) => row.task_run_id)).toEqual(["run-1", "run-2"]);
  });

  it("a host with no hooks keeps an engine that analyses and does not learn", () => {
    const bundle = createAutonomyBundle({ prompt: "fix the build", iterationBudget: 5 });
    expect(bundle.errorRecovery.isLearningEnabled()).toBe(false);
    expect(bundle.errorRecovery.analyze("dotnet_build", failing)?.hasErrors).toBe(true);
    expect(exposures()).toEqual([]);
  });

  it("with no run named, the exposure and its judgement still share one scope", async () => {
    const bundle = createAutonomyBundle({
      prompt: "fix the build",
      iterationBudget: 5,
      // A path with no run executing (maintenance), so the hooks fall back to the
      // episode's own correlation id — the documented fallback. What matters is
      // that BOTH ends land in the same scope: an exposure filed under one key and
      // judged under another stays unjudged for ever, which the coverage number
      // then reports as "shown, never judged".
      errorLearning: { hooks, sessionId: "chat-42", resolveTaskRunId: () => undefined },
    });
    const analysis = bundle.errorRecovery.analyze("dotnet_build", failing)!;
    const [shown] = exposures();
    expect(shown).toMatchObject({ instinct_id: RULE, session_id: "chat-42" });
    expect(shown!.task_run_id).not.toBe("");

    await bundle.errorRecovery.recordResolution({
      toolName: "dotnet_build",
      errorOutput: CS0006,
      analysis,
      action: "Built the dependency project first, then re-ran",
      success: true,
      appliedInstinctIds: [RULE],
    });
    await bundle.errorRecovery.flushLearning();
    const judged = storage
      .getDatabase()!
      .prepare("SELECT task_run_id, judged_at, judged_as FROM instinct_exposure_log")
      .all() as Array<{ task_run_id: string; judged_at: number | null; judged_as: string | null }>;
    expect(judged).toHaveLength(1);
    expect(judged[0]!.task_run_id).toBe(shown!.task_run_id);
    expect(judged[0]!.judged_at).not.toBeNull();
  });
});

/**
 * A TEXTUAL TRIPWIRE, AND WHY IT HAS TO BE ONE.
 *
 * The defect above was not in any function's logic: it was an argument nobody
 * passed. The only place that can be checked is the production wiring itself,
 * and there is no seam to drive — proving it by running it means booting the
 * whole application. So the wiring is read, and each row says what breaks if the
 * line goes missing. A run-time test for each of these would be the better test;
 * a startup this large is why there is not one yet.
 */
describe("production wiring: the run's engine is given the hooks (tripwire)", () => {
  const source = (path: string): string => readFileSync(path, "utf8");

  it("bootstrap hands the orchestrator the pipeline and the error-learning hooks", () => {
    const bootstrap = source("src/core/bootstrap.ts");
    const construction = bootstrap.slice(
      bootstrap.indexOf("const orchestrator = new Orchestrator({"),
      bootstrap.indexOf("// Wire FrameworkPromptGenerator"),
    );
    expect(construction).not.toBe("");
    // Without the pipeline: guidance exposure, run credit settlement, teaching
    // and correction capture are all no-ops on a null.
    expect(construction).toContain("learningPipeline: learningResult.pipeline");
    // Without the hooks: the per-task recovery engine cannot learn at all.
    expect(construction).toContain("errorLearningHooks: learningResult.errorLearningHooks");
  });

  it("the learning init RETURNS the hooks it built, instead of only an engine nothing runs", () => {
    const bootstrap = source("src/core/bootstrap.ts");
    // The returned bundle, not the file: the old code named `errorLearningHooks`
    // too — it handed them to a throwaway engine and returned that instead.
    const returned = bootstrap.slice(
      bootstrap.indexOf("    return {\n      pipeline,"),
      bootstrap.indexOf("      notices,\n    };", bootstrap.indexOf("    return {\n      pipeline,")),
    );
    expect(returned).not.toBe("");
    expect(returned).toContain("errorLearningHooks,");
  });

  it("the engine setup passes them into the bundle it is about to run", () => {
    const setup = source("src/agent-core/engine/setup.ts");
    expect(setup).toContain("const errorLearningHooks = deps.errorLearningHooks?.()");
    expect(setup).toContain("errorLearning: {");
    // The scope must be the ledger's: the chat as the session, the live run.
    expect(setup).toContain("sessionId: chatId");
    expect(setup).toContain("resolveTaskRunId: () => deps.getTaskExecutionContext()?.taskRunId");
  });

  it("the orchestrator exposes the hooks to the engine", () => {
    expect(source("src/agents/orchestrator.ts")).toContain(
      "errorLearningHooks: () => this.errorLearningHooks ?? undefined,",
    );
  });
});
