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
