import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ErrorLearningHooks,
  MAX_TRACKED_ERRORS,
  TRACKED_ERROR_TTL_MS,
  type ErrorContext,
  type ResolutionContext,
} from "./error-learning-hooks.ts";
import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import { PatternMatcher } from "../matching/pattern-matcher.ts";
import { ConfidenceScorer } from "../scoring/confidence-scorer.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { ErrorAnalysis } from "../../agents/autonomy/error-recovery.ts";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ErrorLearningHooks", () => {
  let hooks: ErrorLearningHooks;
  let pipeline: LearningPipeline;
  let storage: LearningStorage;
  let patternMatcher: PatternMatcher;
  let confidenceScorer: ConfidenceScorer;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-test-"));
    const dbPath = join(tempDir, "test.db");
    storage = new LearningStorage(dbPath);
    storage.initialize();
    
    pipeline = new LearningPipeline(storage);
    patternMatcher = new PatternMatcher(storage);
    confidenceScorer = new ConfidenceScorer();
    
    hooks = new ErrorLearningHooks(pipeline, patternMatcher, confidenceScorer, storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("enable/disable", () => {
    it("should start disabled", () => {
      expect(hooks.isEnabled()).toBe(false);
    });

    it("should enable learning hooks", () => {
      hooks.enable();
      expect(hooks.isEnabled()).toBe(true);
    });

    it("should disable learning hooks", () => {
      hooks.enable();
      hooks.disable();
      expect(hooks.isEnabled()).toBe(false);
    });
  });

  describe("onBeforeErrorAnalysis", () => {
    const createErrorContext = (): ErrorContext => ({
      toolName: "dotnet_build",
      errorOutput: "Assets/Test.cs(10,20): CS0246 — The type or namespace name 'MyClass' could not be found",
      analysis: {
        hasErrors: true,
        errorCount: 1,
        summary: "1 missing_type",
        recoveryInjection: "test",
      },
      sessionId: "session-1",
      timestamp: new Date(),
      filePath: "Assets/Test.cs",
    });

    it("should return empty result when disabled", () => {
      const result = hooks.onBeforeErrorAnalysis(createErrorContext());
      expect(result.suggestions).toHaveLength(0);
      expect(result.recoveryInjection).toBe("");
    });

    it("should return suggestions when enabled", () => {
      hooks.enable();
      const result = hooks.onBeforeErrorAnalysis(createErrorContext());
      // May or may not have suggestions depending on stored instincts
      expect(typeof result.recoveryInjection).toBe("string");
    });

    it("should track active errors", () => {
      hooks.enable();
      hooks.onBeforeErrorAnalysis(createErrorContext());
      
      const stats = hooks.getStats();
      expect(stats.activeErrors).toBeGreaterThan(0);
    });
  });

  describe("onAfterErrorResolution", () => {
    const createResolutionContext = (success: boolean): ResolutionContext => ({
      errorContext: {
        toolName: "dotnet_build",
        errorOutput: "CS0246: Type not found",
        analysis: {
          hasErrors: true,
          errorCount: 1,
          summary: "1 missing_type",
          recoveryInjection: "test",
        },
        sessionId: "session-1",
        timestamp: new Date(),
      },
      action: "Add using MyNamespace;",
      success,
    });

    it("should do nothing when disabled", () => {
      hooks.enable();
      hooks.onBeforeErrorAnalysis(createResolutionContext(true).errorContext);
      hooks.disable();
      
      expect(() => {
        hooks.onAfterErrorResolution(createResolutionContext(true));
      }).not.toThrow();
    });

    it("should handle successful resolution", () => {
      hooks.enable();
      
      expect(() => {
        hooks.onAfterErrorResolution(createResolutionContext(true));
      }).not.toThrow();
    });

    it("should handle failed resolution", () => {
      hooks.enable();
      
      expect(() => {
        hooks.onAfterErrorResolution(createResolutionContext(false));
      }).not.toThrow();
    });
  });

  describe("reinforceInstinct", () => {
    it("should do nothing when disabled", () => {
      // Create an instinct first
      const instinct = {
        id: "test-instinct",
        name: "Test",
        type: "error_fix" as const,
        status: "active" as const,
        confidence: 0.7,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      storage.createInstinct(instinct);

      expect(() => {
        hooks.reinforceInstinct("test-instinct", {
          errorContext: {
            toolName: "test",
            errorOutput: "error",
            analysis: { hasErrors: true, errorCount: 1, summary: "test", recoveryInjection: "" },
            sessionId: "session-1",
            timestamp: new Date(),
          },
          success: true,
          verdictScore: 0.9,
        });
      }).not.toThrow();
    });

    it("should reinforce when enabled", () => {
      hooks.enable();
      
      // Create an instinct first
      const instinct = {
        id: "test-instinct-2",
        name: "Test",
        type: "error_fix" as const,
        status: "active" as const,
        confidence: 0.7,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      storage.createInstinct(instinct);

      const initialConfidence = instinct.confidence;

      hooks.reinforceInstinct("test-instinct-2", {
        errorContext: {
          toolName: "test",
          errorOutput: "error",
          analysis: { hasErrors: true, errorCount: 1, summary: "test", recoveryInjection: "" },
          sessionId: "session-1",
          timestamp: new Date(),
        },
        success: true,
        verdictScore: 0.9,
      });

      const updated = storage.getInstinct("test-instinct-2");
      expect(updated?.stats.timesApplied).toBe(5);
    });
  });

  describe("penalizeInstinct", () => {
    it("should do nothing when disabled", () => {
      const instinct = {
        id: "test-instinct-3",
        name: "Test",
        type: "error_fix" as const,
        status: "active" as const,
        confidence: 0.7,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      storage.createInstinct(instinct);

      expect(() => {
        hooks.penalizeInstinct("test-instinct-3", {
          errorContext: {
            toolName: "test",
            errorOutput: "error",
            analysis: { hasErrors: true, errorCount: 1, summary: "test", recoveryInjection: "" },
            sessionId: "session-1",
            timestamp: new Date(),
          },
          reason: "Failed to resolve",
        });
      }).not.toThrow();
    });

    it("should penalize when enabled", () => {
      hooks.enable();
      
      const instinct = {
        id: "test-instinct-4",
        name: "Test",
        type: "error_fix" as const,
        status: "active" as const,
        confidence: 0.7,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      storage.createInstinct(instinct);

      hooks.penalizeInstinct("test-instinct-4", {
        errorContext: {
          toolName: "test",
          errorOutput: "error",
          analysis: { hasErrors: true, errorCount: 1, summary: "test", recoveryInjection: "" },
          sessionId: "session-1",
          timestamp: new Date(),
        },
        reason: "Failed to resolve",
      });

      const updated = storage.getInstinct("test-instinct-4");
      expect(updated?.stats.timesFailed).toBe(2);
    });
  });

  describe("getStats", () => {
    it("should return tracking statistics", () => {
      const stats = hooks.getStats();
      
      expect(typeof stats.activeErrors).toBe("number");
      expect(typeof stats.totalTracked).toBe("number");
      expect(stats.activeErrors).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clearActiveErrors", () => {
    it("should clear all tracked errors", () => {
      hooks.enable();
      hooks.onBeforeErrorAnalysis({
        toolName: "test",
        errorOutput: "error",
        analysis: { hasErrors: true, errorCount: 1, summary: "test", recoveryInjection: "" },
        sessionId: "session-1",
        timestamp: new Date(),
      });

      expect(hooks.getStats().activeErrors).toBeGreaterThan(0);
      
      hooks.clearActiveErrors();
      
      expect(hooks.getStats().activeErrors).toBe(0);
    });
  });
});

// improvement on audit 04.6: a quarantine has to HOLD. This path rewrites an
// instinct's status from its confidence alone (confidenceScorer.getStatus), so a
// quarantined row would be silently returned to service — and a permanent one
// silently demoted to 'evolved'.
describe("a frozen lifecycle state is not rewritten from confidence (improvement on audit 04.6)", () => {
  let storage: LearningStorage;
  let hooks: ErrorLearningHooks;
  let tempDir: string;

  const errorContext: ErrorContext = {
    sessionId: "s1",
    toolName: "shell_exec",
    errorOutput: "error CS0246: type not found",
    analysis: { category: "missing_type", severity: "high", isRetryable: true } as unknown as ErrorAnalysis,
    timestamp: Date.now(),
  } as unknown as ErrorContext;

  function frozen(id: string, status: "quarantined" | "permanent") {
    storage.createInstinct({
      id: id as never,
      name: "Frozen",
      type: "user_teaching",
      status,
      confidence: 0.97 as never,
      triggerPattern: "any",
      action: "do the thing",
      contextConditions: [],
      stats: { timesSuggested: 60, timesApplied: 58, timesFailed: 2, successRate: 0.96, averageExecutionMs: 0 },
      createdAt: Date.now() as never,
      updatedAt: Date.now() as never,
      sourceTrajectoryIds: [],
      tags: [],
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-frozen-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    hooks = new ErrorLearningHooks(
      new LearningPipeline(storage),
      new PatternMatcher(storage),
      new ConfidenceScorer(),
      storage,
    );
    hooks.enable();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a quarantined instinct is not returned to service by a reinforcement", () => {
    frozen("instinct_quarantined_hold", "quarantined");

    hooks.reinforceInstinct("instinct_quarantined_hold", { errorContext, success: true, verdictScore: 0.9 });

    expect(storage.getInstinct("instinct_quarantined_hold")!.status).toBe("quarantined");
  });

  it("a permanent instinct is not demoted by a penalty either", () => {
    frozen("instinct_permanent_hold", "permanent");

    hooks.penalizeInstinct("instinct_permanent_hold", { errorContext, reason: "did not apply" });

    expect(storage.getInstinct("instinct_permanent_hold")!.status).toBe("permanent");
  });
});

// Recovery guidance is chosen for the run's user. The error-recovery path read
// every instinct with no ownership clause, so one user's private rule became
// [LEARNED SOLUTIONS] in every other user's tool result for the same error.
describe("recovery guidance respects who owns a rule", () => {
  let storage: LearningStorage;
  let hooks: ErrorLearningHooks;
  let tempDir: string;
  const PROJECT = "/projects/pixelflow";

  function rule(id: string, action: string, scope: "user" | "project", owner?: string): void {
    storage.createInstinct({
      id: id as never,
      name: id,
      type: "user_teaching",
      status: "active",
      confidence: 0.9 as never,
      triggerPattern: "CS0246 type or namespace could not be found",
      action,
      contextConditions: [],
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as never,
      updatedAt: Date.now() as never,
      sourceTrajectoryIds: [],
      tags: [],
    });
    storage.addInstinctScopeV2(id, PROJECT, scope, owner);
  }

  function context(userId?: string): ErrorContext {
    return {
      toolName: "dotnet_build",
      errorOutput: "Assets/Board.cs(3,7): error CS0246: The type or namespace name 'Tile' could not be found",
      analysis: { hasErrors: true, errorCount: 1, summary: "1 missing_type", recoveryInjection: "" },
      sessionId: `session-${userId ?? "anon"}`,
      timestamp: new Date(),
      ...(userId === undefined ? {} : { userId }),
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-ownership-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    hooks = new ErrorLearningHooks(
      new LearningPipeline(storage),
      new PatternMatcher(storage),
      new ConfidenceScorer(),
      storage,
    );
    hooks.enable();
    rule("instinct_alice_private", "add alice's private package feed", "user", "alice");
    rule("instinct_project_shared", "add the missing using directive", "project");
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const ids = (userId?: string): string[] =>
    hooks.onBeforeErrorAnalysis(context(userId)).suggestions.map((m) => String(m.instinct?.id));

  it("never shows a user's private rule to another user", () => {
    expect(ids("bob")).not.toContain("instinct_alice_private");
    expect(hooks.onBeforeErrorAnalysis(context("bob")).recoveryInjection).not.toContain("private package feed");
  });

  it("never shows a user's private rule to an unidentified caller", () => {
    expect(ids(undefined)).not.toContain("instinct_alice_private");
  });

  it("still shows the owner their own rule, and everyone the shared one", () => {
    expect(ids("alice")).toContain("instinct_alice_private");
    expect(ids("alice")).toContain("instinct_project_shared");
    expect(ids("bob")).toContain("instinct_project_shared");
  });

  it("carries the run's user from the autonomy bundle through the recovery engine", () => {
    const failing = {
      content: "\n### Errors\n  Assets/Board.cs(3,7): CS0246 — The type or namespace name 'Tile' could not be found\n",
      isError: true,
    };
    const forUser = (userId: string) =>
      createAutonomyBundle({
        errorLearning: { hooks, sessionId: `chat-${userId}`, userId },
        prompt: "build the board",
        iterationBudget: 10,
      }).errorRecovery.analyze("dotnet_build", failing as never)?.learnedSolutions ?? "";

    expect(forUser("bob")).not.toContain("private package feed");
    expect(forUser("alice")).toContain("private package feed");
  });
});

// LRN-11: the recovery path ran its own confidence-to-status table
// (ConfidenceScorer.getStatus). It retired the best rules into 'evolved' (out of
// retrieval and interventions), demoted active rules to 'proposed' on one
// failure, and revived retired rules. The pipeline's state machine is the one
// lifecycle authority.
describe("recovery evidence goes through the pipeline's lifecycle (LRN-11)", () => {
  let storage: LearningStorage;
  let hooks: ErrorLearningHooks;
  let tempDir: string;

  const errorContext = {
    sessionId: "s1",
    toolName: "dotnet_build",
    errorOutput: "error CS0246: type not found",
    analysis: { hasErrors: true, errorCount: 1, summary: "1 missing_type", recoveryInjection: "" },
    timestamp: new Date(),
  } as unknown as ErrorContext;

  function rule(id: string, status: "active" | "deprecated", alpha: number, beta: number) {
    storage.createInstinct({
      id: id as never,
      name: id,
      type: "error_fix",
      status,
      confidence: (alpha / (alpha + beta)) as never,
      triggerPattern: "error CS0246: type not found",
      action: "add the missing using directive",
      contextConditions: [],
      stats: { timesSuggested: 10, timesApplied: 10, timesFailed: 0, successRate: 1, averageExecutionMs: 0 },
      bayesianAlpha: alpha,
      bayesianBeta: beta,
      createdAt: Date.now() as never,
      updatedAt: Date.now() as never,
      sourceTrajectoryIds: [],
      tags: [],
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-lifecycle-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    hooks = new ErrorLearningHooks(
      new LearningPipeline(storage),
      new PatternMatcher(storage),
      new ConfidenceScorer(),
      storage,
    );
    hooks.enable();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a rule reinforced past 0.9 stays active and retrievable", () => {
    rule("rule_strong", "active", 10, 1);

    hooks.reinforceInstinct("rule_strong", { errorContext, success: true, verdictScore: 0.9 });

    const after = storage.getInstinct("rule_strong")!;
    expect(after.confidence).toBeGreaterThan(0.9);
    expect(after.status).toBe("active");
    expect(storage.getInstincts({ status: "active" }).map((i) => i.id)).toContain("rule_strong");
  });

  it("one failed application does not demote an active rule", () => {
    rule("rule_one_failure", "active", 3, 1);

    hooks.penalizeInstinct("rule_one_failure", { errorContext, reason: "the build still failed" });

    const after = storage.getInstinct("rule_one_failure")!;
    expect(after.confidence).toBeLessThan(0.7);
    expect(after.status).toBe("active");
  });

  it("reinforcing a retired rule leaves it retired", () => {
    rule("rule_retired", "deprecated", 3, 1);

    hooks.reinforceInstinct("rule_retired", { errorContext, success: true, verdictScore: 0.9 });

    const after = storage.getInstinct("rule_retired")!;
    expect(after.confidence).toBeGreaterThan(0.7);
    expect(after.status).toBe("deprecated");
  });
});

// LRN-6: one hooks instance serves the whole process, and an error nobody
// resolved was never forgotten, each entry holding the whole tool output.
describe("tracked errors are bounded (LRN-6)", () => {
  let storage: LearningStorage;
  let hooks: ErrorLearningHooks;
  let tempDir: string;

  function failure(i: number, at = new Date()): ErrorContext {
    return {
      sessionId: "s1",
      toolName: "dotnet_build",
      errorOutput: `error CS0246: type 'Missing${i}' not found ${"x".repeat(2_000)}`,
      analysis: { hasErrors: true, errorCount: 1, summary: "1 missing_type", recoveryInjection: "" },
      timestamp: at,
    } as unknown as ErrorContext;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-bounded-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    hooks = new ErrorLearningHooks(
      new LearningPipeline(storage),
      new PatternMatcher(storage),
      new ConfidenceScorer(),
      storage,
    );
    hooks.enable();
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("10,000 unresolved errors keep the tracked set at the cap", () => {
    for (let i = 0; i < 10_000; i++) hooks.onBeforeErrorAnalysis(failure(i));
    expect(hooks.getStats().activeErrors).toBe(MAX_TRACKED_ERRORS);
  });

  it("the newest errors stay correlatable and an expired one is forgotten", async () => {
    vi.useFakeTimers();
    const first = hooks.onBeforeErrorAnalysis(failure(1));
    vi.advanceTimersByTime(TRACKED_ERROR_TTL_MS + 1);
    const second = hooks.onBeforeErrorAnalysis(failure(2));

    expect(hooks.getStats().activeErrors).toBe(1);
    // The live one still correlates: resolving it removes it from the tracked set.
    await hooks.onAfterErrorResolution({
      errorContext: failure(2),
      action: "",
      success: true,
      correlationId: second.correlationId,
      derivation: "observed-success",
    });
    expect(hooks.getStats().activeErrors).toBe(0);
    expect(first.correlationId).not.toBe(second.correlationId);
  });
});
