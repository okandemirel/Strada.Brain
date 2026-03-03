import { describe, it, expect, beforeEach } from "vitest";
import { ErrorRecoveryEngine, type ErrorAnalysis, type ErrorCategory } from "./error-recovery.ts";
import { ErrorLearningHooks } from "../../learning/hooks/error-learning-hooks.ts";
import { LearningPipeline } from "../../learning/pipeline/learning-pipeline.ts";
import { PatternMatcher } from "../../learning/matching/pattern-matcher.ts";
import { ConfidenceScorer } from "../../learning/scoring/confidence-scorer.ts";
import { LearningStorage } from "../../learning/storage/learning-storage.ts";
import type { ToolResult } from "../providers/provider.interface.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ErrorRecoveryEngine", () => {
  let engine: ErrorRecoveryEngine;

  beforeEach(() => {
    engine = new ErrorRecoveryEngine();
  });

  describe("Basic Error Analysis", () => {
    it("should return null for successful tool result", () => {
      const result: ToolResult = {
        content: "Build succeeded",
        isError: false,
      };

      const analysis = engine.analyze("dotnet_build", result);
      expect(analysis).toBeNull();
    });

    it("should analyze build errors", () => {
      const result: ToolResult = {
        content: `
### Errors
  Assets/Test.cs(10,20): CS0246 — The type or namespace name 'MyClass' could not be found
  Assets/Test2.cs(15,10): CS0103 — The name 'variable' does not exist in the current context
`,
        isError: true,
      };

      const analysis = engine.analyze("dotnet_build", result);
      expect(analysis).not.toBeNull();
      expect(analysis?.hasErrors).toBe(true);
      expect(analysis?.errorCount).toBe(2);
      expect(analysis?.summary).toContain("missing type");
      expect(analysis?.summary).toContain("undefined symbol");
    });

    it("should analyze test failures", () => {
      const result: ToolResult = {
        content: `
Test Run Summary
  Total tests: 10
  Failed: 2

FAILED
  ✗ TestMethod1
  ✗ TestMethod2
`,
        isError: true,
      };

      const analysis = engine.analyze("dotnet_test", result);
      expect(analysis).not.toBeNull();
      expect(analysis?.errorCount).toBe(2);
      expect(analysis?.summary).toContain("test failure");
    });

    it("should detect runtime errors", () => {
      const result: ToolResult = {
        content: "Unhandled Exception: System.NullReferenceException: Object reference not set",
        isError: true,
      };

      const analysis = engine.analyze("shell_exec", result);
      expect(analysis).not.toBeNull();
      expect(analysis?.summary).toContain("runtime");
    });

    it("should handle generic tool errors", () => {
      const result: ToolResult = {
        content: "Something went wrong",
        isError: true,
      };

      const analysis = engine.analyze("custom_tool", result);
      expect(analysis).not.toBeNull();
      expect(analysis?.errorCount).toBe(1);
    });
  });

  describe("Error Categories", () => {
    const testCases: Array<{ code: string; expected: ErrorCategory }> = [
      { code: "CS0246", expected: "missing_type" },
      { code: "CS0103", expected: "undefined_symbol" },
      { code: "CS1061", expected: "missing_member" },
      { code: "CS0029", expected: "type_mismatch" },
      { code: "CS1002", expected: "syntax" },
      { code: "CS0012", expected: "missing_reference" },
      { code: "CS0101", expected: "duplicate" },
      { code: "CS0122", expected: "access" },
      { code: "CS0115", expected: "override" },
      { code: "CS8600", expected: "null_safety" },
    ];

    it.each(testCases)("should categorize $code as $expected", ({ code, expected }) => {
      const result: ToolResult = {
        content: `Assets/Test.cs(10,20): ${code} — Error message`,
        isError: true,
      };

      const analysis = engine.analyze("dotnet_build", result);
      // Summary uses display format (with spaces instead of underscores)
      const displayExpected = expected.replace(/_/g, " ");
      expect(analysis?.summary).toContain(displayExpected);
    });
  });

  describe("Recovery Injection", () => {
    it("should include recovery steps in analysis", () => {
      const result: ToolResult = {
        content: `
### Errors
  Assets/Test.cs(10,20): CS0246 — The type or namespace name 'MyClass' could not be found
`,
        isError: true,
      };

      const analysis = engine.analyze("dotnet_build", result);
      expect(analysis?.recoveryInjection).toContain("[ERROR RECOVERY ANALYSIS]");
      expect(analysis?.recoveryInjection).toContain("[RECOVERY STEPS]");
      expect(analysis?.recoveryInjection).toContain("Add the correct 'using' directive");
    });
  });

  describe("Learning Integration", () => {
    let tempDir: string;
    let storage: LearningStorage;
    let hooks: ErrorLearningHooks;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "recovery-test-"));
      const dbPath = join(tempDir, "test.db");
      storage = new LearningStorage(dbPath);
      storage.initialize();
      
      const pipeline = new LearningPipeline(storage);
      const patternMatcher = new PatternMatcher(storage);
      const confidenceScorer = new ConfidenceScorer();
      
      hooks = new ErrorLearningHooks(pipeline, patternMatcher, confidenceScorer, storage);
    });

    afterEach(() => {
      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should start with learning disabled", () => {
      expect(engine.isLearningEnabled()).toBe(false);
    });

    it("should enable learning", () => {
      engine.enableLearning(hooks, { sessionId: "test-session" });
      expect(engine.isLearningEnabled()).toBe(true);
    });

    it("should disable learning", () => {
      engine.enableLearning(hooks, { sessionId: "test-session" });
      engine.disableLearning();
      expect(engine.isLearningEnabled()).toBe(false);
    });

    it("should record resolution when learning is enabled", () => {
      engine.enableLearning(hooks, { sessionId: "test-session" });
      
      const analysis: ErrorAnalysis = {
        hasErrors: true,
        errorCount: 1,
        summary: "1 missing_type",
        recoveryInjection: "test",
      };

      expect(() => {
        engine.recordResolution({
          toolName: "dotnet_build",
          errorOutput: "CS0246: Type not found",
          analysis,
          action: "Add using MyNamespace;",
          success: true,
          resolutionTimeMs: 1000,
          attempts: 1,
        });
      }).not.toThrow();
    });

    it("should include learned solutions when learning is enabled", () => {
      engine.enableLearning(hooks, { sessionId: "test-session" });
      
      const result: ToolResult = {
        content: `
### Errors
  Assets/Test.cs(10,20): CS0246 — The type or namespace name 'MyClass' could not be found
`,
        isError: true,
      };

      const analysis = engine.analyze("dotnet_build", result);
      // When enabled with learning, learnedSolutions should be set (can be empty string)
      expect(analysis?.learnedSolutions !== undefined).toBe(true);
    });
  });
});
