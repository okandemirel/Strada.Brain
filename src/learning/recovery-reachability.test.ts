/**
 * A FIX THE PIPELINE LEARNED MUST BE OFFERABLE WHEN ITS ERROR COMES BACK.
 *
 * Every learned rule starts at the initial-confidence cap (MAX_INITIAL = 0.5),
 * and recovery scores a match as a fraction of that confidence: 0.95 for the
 * same error code, 0.9 for the same message. The recovery gate sat at 0.5, so
 * the identical error scored 0.475 (or 0.45) against a gate of 0.5 and the
 * rule was never shown — and a rule that is never shown is never credited,
 * so its confidence could never rise past the gate either.
 *
 * These tests learn the rule through the real pipeline (a failure, then the
 * repair of the same target in the same run) and ask the real recovery hook,
 * so the gate is proved reachable on the scoring path production uses, not on
 * a rule handed a confidence no learned rule starts with. The gate must still
 * refuse a fresh rule that only resembles the error.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.ts";
import { LearningPipeline } from "./pipeline/learning-pipeline.ts";
import { PatternMatcher } from "./matching/pattern-matcher.ts";
import { ConfidenceScorer } from "./scoring/confidence-scorer.ts";
import { ErrorLearningHooks, type ErrorContext } from "./hooks/error-learning-hooks.ts";
import { CONFIDENCE_THRESHOLDS, type Instinct } from "./types.ts";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;
let hooks: ErrorLearningHooks;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recovery-reachability-"));
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

/** The way a real run teaches a fix: it fails, then repairs the same target in the same run. */
async function learnFix(params: { tool: string; input: Record<string, unknown>; errorOutput: string; run: string }): Promise<Instinct> {
  const before = new Set(storage.getInstincts({}).map((i) => String(i.id)));
  const event = (success: boolean, output: string) => ({
    sessionId: "session-learn",
    taskRunId: params.run,
    toolName: params.tool,
    input: params.input,
    output,
    success,
    ...(success ? {} : { errorDetails: { category: "build", message: output } }),
    timestamp: Date.now(),
  });
  await pipeline.handleToolResult(event(false, params.errorOutput) as never);
  await pipeline.handleToolResult(event(true, "the repair succeeded") as never);
  const minted = storage.getInstincts({}).filter((i) => !before.has(String(i.id)) && i.type === "error_fix");
  expect(minted).toHaveLength(1);
  return minted[0]!;
}

/** Successful runs that report applying the rule, as the eval's warm arm pays for its recall. */
async function reinforce(rule: Instinct, params: { tool: string; input: Record<string, unknown>; runs: number }): Promise<Instinct> {
  for (let n = 0; n < params.runs; n++) {
    const run = `run-reinforce-${n}`;
    await pipeline.handleToolResult({
      sessionId: "session-reinforce",
      taskRunId: run,
      toolName: params.tool,
      input: params.input,
      output: "the repair succeeded",
      success: true,
      appliedInstinctIds: [String(rule.id)],
      timestamp: Date.now(),
    } as never);
    pipeline.clearRunInstinctCredits("session-reinforce", { success: true, verdictScore: 0.95 }, run);
  }
  return storage.getInstinct(rule.id)!;
}

/** A rule in the shape the live store holds from before repairs had to name a target (D39). */
function legacyRule(
  id: string,
  tool: string,
  trigger: string,
  action: string,
  type: "error_fix" | "correction" = "error_fix",
): void {
  storage.createInstinct({
    id: id as never,
    name: `${type.replace("_", "-")}:${tool}:1788120205388`,
    type,
    status: "proposed",
    confidence: CONFIDENCE_THRESHOLDS.MAX_INITIAL as never,
    triggerPattern: trigger,
    action,
    contextConditions: [{ id: `ctx_${id}` as never, type: "tool_name", value: tool, match: "include" }],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: Date.now() as never,
    updatedAt: Date.now() as never,
    sourceTrajectoryIds: [],
    tags: [],
  });
}

function errorContext(tool: string, errorOutput: string): ErrorContext {
  return {
    toolName: tool,
    errorOutput,
    analysis: { hasErrors: true, errorCount: 1, summary: "1 error", recoveryInjection: "" },
    sessionId: "session-recur",
    timestamp: new Date(),
  };
}

describe("error recovery offers a fix the pipeline learned (gate reachable by a fresh rule)", () => {
  it("the same coded compiler error brings back the fix learned for it", async () => {
    const errorOutput =
      "Assets/Scripts/Player.cs(12,5): error CS0246: The type or namespace name 'ScoreService' could not be found";
    const rule = await learnFix({
      tool: "dotnet_build",
      input: { command: "dotnet build Game.csproj" },
      errorOutput,
      run: "run-learn-cs",
    });
    // The rule recovery has to reach is the one learning actually produces.
    expect(rule.status).toBe("proposed");
    expect(rule.confidence).toBe(CONFIDENCE_THRESHOLDS.MAX_INITIAL);

    const result = hooks.onBeforeErrorAnalysis(errorContext("dotnet_build", errorOutput));

    expect(result.suggestions.map((m) => String(m.instinct?.id))).toContain(String(rule.id));
    expect(result.recoveryInjection).toContain("[LEARNED SOLUTIONS]");
    expect(result.recoveryInjection).toContain(rule.action.slice(0, 40));
  });

  it("the same uncoded error brings back its fix by message alone", async () => {
    const errorOutput = "Error: cannot open Assets/Scenes/Main.unity because the scene file is missing";
    const rule = await learnFix({
      tool: "file_read",
      input: { path: "Assets/Scenes/Main.unity" },
      errorOutput,
      run: "run-learn-msg",
    });
    expect(rule.confidence).toBe(CONFIDENCE_THRESHOLDS.MAX_INITIAL);

    const result = hooks.onBeforeErrorAnalysis(errorContext("file_read", errorOutput));

    expect(result.suggestions.map((m) => String(m.instinct?.id))).toContain(String(rule.id));
    expect(result.recoveryInjection).toContain("[LEARNED SOLUTIONS]");
  });

  it("a fresh rule that only shares the tool with a different error is still not offered", async () => {
    await learnFix({
      tool: "file_read",
      input: { path: "Assets/Scenes/Main.unity" },
      errorOutput: "Error: cannot open Assets/Scenes/Main.unity because the scene file is missing",
      run: "run-learn-other",
    });

    const result = hooks.onBeforeErrorAnalysis(
      errorContext("file_read", "Error: permission denied while reading ProjectSettings/TagManager.asset"),
    );

    expect(result.suggestions).toEqual([]);
    expect(result.recoveryInjection).toBe("");
  });
});

describe("the fresh-rule allowance is for the same error and a named repair only", () => {
  // The eval's p5 trap, on the scoring path production uses: a rule earned past
  // 0.75 matches an unrelated error on its tool at 0.6 x confidence (~0.49).
  // That sits between a fresh rule's same-error score and the general gate, so
  // a gate lowered for every match type offered it on the tool name alone.
  it("a rule reinforced past 0.75 is not offered for an unrelated error on the same tool", async () => {
    const input = { file_path: "/proj/Assembly-CSharp.csproj" };
    const errorOutput = "error CS0006: Metadata file '/proj/Library/ScriptAssemblies/Strada.Core.dll' could not be found";
    const learned = await learnFix({ tool: "dotnet_build", input, errorOutput, run: "run-learn-cs0006" });
    const rule = await reinforce(learned, { tool: "dotnet_build", input, runs: 4 });
    expect(rule.confidence).toBeGreaterThanOrEqual(0.75);
    expect(rule.confidence).toBeLessThan(0.5 / 0.6);

    // Its own error still brings it back.
    const own = hooks.onBeforeErrorAnalysis(errorContext("dotnet_build", errorOutput));
    expect(own.suggestions.map((m) => String(m.instinct?.id))).toContain(String(rule.id));

    const unrelated = hooks.onBeforeErrorAnalysis(
      errorContext("dotnet_build", "error CS1061: 'BoardController' does not contain a definition for 'SpawnTile'"),
    );
    expect(unrelated.suggestions.map((m) => `${m.type} ${m.confidence.toFixed(3)}`)).toEqual([]);
    expect(unrelated.recoveryInjection).toBe("");
  });

  // 359 of the 364 error_fix rules in the live store (2026-10-11) were minted
  // before a repair had to act on the failure's target (D39), 329 of them saying
  // only that the call was retried, all at the cap. A message match on the error
  // that minted them scores 0.45: let through, they filled the learned-solutions
  // slots with filler that no observed-success resolution ever credits or
  // penalises, so it would never decay.
  it.each([
    ["pre-D39 retry", "When file_read fails with this pattern, the resolution involved: retrying with corrected input"],
    ["pre-D39 unrelated command", "When file_read fails with this pattern, the resolution involved: git log --oneline -3"],
    ["retry with no target", "When file_read fails with this pattern, the resolution was to retry with corrected input"],
  ])("a fresh rule with no verified repair (%s) is not offered for its own error", (_label, action) => {
    const errorOutput =
      "Error: file not found: Assets/Modules/IdentityModule/Scripts/Module/IdentityModuleConfig.cs [ERROR RECOVERY: file_read] Fix: Analyze the error and try an alternative approach.";
    legacyRule("instinct_retry_only", "file_read", errorOutput, action);

    const result = hooks.onBeforeErrorAnalysis(errorContext("file_read", errorOutput));

    expect(result.suggestions).toEqual([]);
    expect(result.recoveryInjection).toBe("");
  });

  // Refused tool-only matches rank above a fresh rule's code match (0.486 at
  // relevance 1 vs 0.475), so refusing them after the top 3 were cut would
  // leave the one rule that IS about this error out.
  it("refused matches do not take the slots of the fresh rule the error is about", async () => {
    for (const n of [1, 2, 3]) {
      storage.createInstinct({
        id: `instinct_other_${n}` as never,
        name: `other-${n}`,
        type: "error_fix",
        status: "active",
        confidence: 0.81 as never,
        triggerPattern: `error CS010${n}: an unrelated failure number ${n}`,
        action: `Fix unrelated failure number ${n} by editing its own file`,
        contextConditions: [{ id: `ctx_other_${n}` as never, type: "tool_name", value: "dotnet_build", match: "include" }],
        stats: { timesSuggested: 5, timesApplied: 5, timesFailed: 0, successRate: 1, averageExecutionMs: 0 },
        createdAt: Date.now() as never,
        updatedAt: Date.now() as never,
        sourceTrajectoryIds: [],
        tags: [],
      });
    }
    const errorOutput =
      "Assets/Scripts/Player.cs(12,5): error CS0246: The type or namespace name 'ScoreService' could not be found";
    const rule = await learnFix({
      tool: "dotnet_build",
      input: { command: "dotnet build Game.csproj" },
      errorOutput,
      run: "run-learn-slots",
    });

    const result = hooks.onBeforeErrorAnalysis(errorContext("dotnet_build", errorOutput));

    expect(result.suggestions.map((m) => String(m.instinct?.id))).toEqual([String(rule.id)]);
  });

  // The allowance is for a learned FIX. The live store's corrections at the cap
  // are pre-2026-09-02 "Auto-resolved: …" rows keyed on a success output; one
  // whose trigger an error output contains matches it "exactly" at 0.45.
  it("a correction at the cap is not offered on the fresh-fix allowance", () => {
    const trigger = "total=1 passed=1 failed=0 skipped=0 runResult=Passed unityExit=0";
    legacyRule(
      "instinct_auto_resolved",
      "unity_playmode_verify",
      trigger,
      'Auto-resolved: unity_playmode_verify failed with "PlayMode verification FAILED: 1 of 1 tests failed" then succeeded with "PlayMode verification passed"',
      "correction",
    );

    const result = hooks.onBeforeErrorAnalysis(
      errorContext("unity_playmode_verify", `PlayMode verification FAILED: the scene did not load\n${trigger}`),
    );

    expect(result.suggestions).toEqual([]);
  });

  it("a rule whose repair is only a retry is still offered once it clears the general gate", () => {
    const errorOutput = "Error: Path resolves outside the project directory (/var/folders/T/strada-workspaces/task-1)";
    legacyRule(
      "instinct_retry_earned",
      "list_directory",
      errorOutput,
      "When list_directory fails with this pattern, the resolution involved: retrying with corrected input",
    );
    storage.updateInstinct({ ...storage.getInstinct("instinct_retry_earned" as never)!, confidence: 0.6 as never });

    const result = hooks.onBeforeErrorAnalysis(errorContext("list_directory", errorOutput));

    expect(result.suggestions.map((m) => String(m.instinct?.id))).toEqual(["instinct_retry_earned"]);
  });
});
