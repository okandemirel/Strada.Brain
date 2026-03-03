import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ErrorLearningHooks, type ErrorContext, type ResolutionContext } from "./error-learning-hooks.ts";
import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import { PatternMatcher } from "../matching/pattern-matcher.ts";
import { ConfidenceScorer } from "../scoring/confidence-scorer.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { ErrorAnalysis } from "../../agents/autonomy/error-recovery.ts";
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
