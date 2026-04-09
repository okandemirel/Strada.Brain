/**
 * Error Recovery Engine
 *
 * Analyzes tool execution results for errors, categorizes them with O(1)
 * hash-map lookup by error code, and generates structured recovery context
 * so the LLM can self-correct instead of guessing.
 *
 * Performance:
 *   - Error categorization: O(1) per error via Map lookup
 *   - File grouping: O(n) single-pass with Map accumulation
 *   - Recovery dedup: O(k) via Set where k = unique categories (bounded ≤ 14)
 * 
 * Learning Integration:
 *   - Records error patterns for learning
 *   - Suggests learned solutions
 *   - Tracks resolution success/failure
 */

import type { ToolResult } from "../providers/provider.interface.js";
import { sanitizePromptInjection } from "../orchestrator-text-utils.js";
import { TEST_FAILURE_RE } from "../orchestrator-runtime-utils.js";
import type { ErrorLearningHooks } from "../../learning/index.js";
import type { 
  ErrorCategory as LearningErrorCategory,
} from "../../learning/types.js";
import { 
  type JsonObject,
} from "../../types/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Error categories specific to error recovery (more granular than learning categories) */
export type ErrorCategory =
  | "missing_type"
  | "undefined_symbol"
  | "missing_member"
  | "type_mismatch"
  | "syntax"
  | "missing_reference"
  | "duplicate"
  | "access"
  | "override"
  | "null_safety"
  | "build_config"
  | "dependency"
  | "test_failure"
  | "runtime"
  | "unknown";

interface StructuredError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  category: ErrorCategory;
}

export interface ErrorAnalysis {
  hasErrors: boolean;
  errorCount: number;
  summary: string;
  /** Ready-to-append recovery context for the tool result */
  recoveryInjection: string;
  /** Learned solutions that might help */
  learnedSolutions?: string;
}

export interface ErrorRecoveryConfig {
  /** Enable learning from errors */
  enableLearning?: boolean;
  /** Session ID for learning correlation */
  sessionId?: string;
}

interface CachedResolution {
  errorPattern: string;
  errorCategory: ErrorCategory;
  resolution: string;
  toolName: string;
  timestamp: number;
  successCount: number;
}

// ─── O(1) Lookup Tables ─────────────────────────────────────────────────────────

/** C#/MSBuild error code → category. O(1) per lookup. */
const CODE_CATEGORY: ReadonlyMap<string, ErrorCategory> = new Map<string, ErrorCategory>([
  // Missing type / namespace
  ["CS0246", "missing_type"], ["CS0234", "missing_type"],
  ["CS0400", "missing_type"], ["CS1069", "missing_type"],
  // Undefined symbol
  ["CS0103", "undefined_symbol"], ["CS0118", "undefined_symbol"],
  ["CS0841", "undefined_symbol"],
  // Missing member
  ["CS1061", "missing_member"], ["CS0117", "missing_member"],
  ["CS0176", "missing_member"], ["CS1501", "missing_member"],
  ["CS7036", "missing_member"],
  // Type mismatch
  ["CS0029", "type_mismatch"], ["CS0266", "type_mismatch"],
  ["CS1503", "type_mismatch"], ["CS0030", "type_mismatch"],
  ["CS0039", "type_mismatch"],
  // Syntax
  ["CS1002", "syntax"], ["CS1003", "syntax"], ["CS1513", "syntax"],
  ["CS1514", "syntax"], ["CS1519", "syntax"], ["CS1520", "syntax"],
  ["CS1525", "syntax"], ["CS1026", "syntax"], ["CS1022", "syntax"],
  // Missing reference
  ["CS0012", "missing_reference"], ["CS0006", "missing_reference"],
  // Duplicate
  ["CS0101", "duplicate"], ["CS0102", "duplicate"],
  ["CS0111", "duplicate"], ["CS0128", "duplicate"],
  // Access
  ["CS0122", "access"], ["CS0143", "access"],
  // Override
  ["CS0115", "override"], ["CS0506", "override"],
  ["CS0507", "override"], ["CS0534", "override"], ["CS0535", "override"],
  // Null safety
  ["CS8600", "null_safety"], ["CS8601", "null_safety"],
  ["CS8602", "null_safety"], ["CS8603", "null_safety"],
  ["CS8604", "null_safety"], ["CS8618", "null_safety"],
  ["CS8625", "null_safety"],
]);

/** Recovery strategy per category. Bounded set (14 entries). */
const RECOVERY: ReadonlyMap<ErrorCategory, string> = new Map<ErrorCategory, string>([
  ["missing_type", "Add the correct 'using' directive or verify the type name. grep for the type in the project to find its namespace."],
  ["undefined_symbol", "Variable/method not in scope. Check for typos, missing declarations, or wrong scope."],
  ["missing_member", "Type lacks this member. Read the type definition to find available members."],
  ["type_mismatch", "Incompatible types. Check expected vs actual. May need a cast or conversion."],
  ["syntax", "Fix syntax at the indicated position. Common: missing semicolons, braces, parentheses."],
  ["missing_reference", "Add a project/package reference in .csproj."],
  ["duplicate", "Symbol already exists. Rename or remove the duplicate definition."],
  ["access", "Member is inaccessible. Change access modifier or use correct access path."],
  ["override", "Override signature must match base. Check return type, parameters, virtual/abstract."],
  ["null_safety", "Nullable reference issue. Add null checks or use '!' / '?' operators."],
  ["build_config", "MSBuild config issue. Check .csproj target framework and property groups."],
  ["dependency", "Package issue. Run 'dotnet restore' or check versions in .csproj."],
  ["test_failure", "Assertion failed. Check expected vs actual values in the code under test."],
  ["runtime", "Runtime error. Check stack trace for root cause."],
  ["unknown", "Analyze the error message and fix the issue."],
]);

// ─── Prefix → category fallback (for codes not in the hash map) ─────────────

function categorizeByPrefix(code: string): ErrorCategory {
  if (code.startsWith("CS")) return "unknown";
  if (code.startsWith("MSB")) return "build_config";
  if (code.startsWith("NU")) return "dependency";
  return "unknown";
}

/** Map recovery ErrorCategory to learning ErrorCategory */
function toLearningCategory(category: ErrorCategory): LearningErrorCategory {
  const mapping: Record<ErrorCategory, LearningErrorCategory> = {
    missing_type: "validation",
    undefined_symbol: "validation",
    missing_member: "validation",
    type_mismatch: "validation",
    syntax: "syntax",
    missing_reference: "resource",
    duplicate: "validation",
    access: "permission",
    override: "validation",
    null_safety: "validation",
    build_config: "resource",
    dependency: "resource",
    test_failure: "runtime",
    runtime: "runtime",
    unknown: "unknown",
  };
  return mapping[category] ?? "unknown";
}

// ─── Build output error line regex ──────────────────────────────────────────────

// Matches the formatted output from DotnetBuildTool:
//   Assets/Foo.cs(42,10): CS0103 — message here
// Also supports lines without leading whitespace for test compatibility
const BUILD_ERROR_LINE = /^\s*(.+?)\((\d+),(\d+)\):\s+(\w+)\s+—\s+(.+)$/gm;

// Matches test failure lines from DotnetTestTool:
//   ✗ TestName
const TEST_FAIL_LINE = /^\s+✗\s+(.+)$/gm;

// Runtime error patterns (checked in order, short-circuit on first match)
const RUNTIME_PATTERNS: RegExp[] = [
  /(?:Unhandled\s+)?(?:Exception|Error):\s+(.+)/,
  /FATAL:\s+(.+)/i,
  /panic:\s+(.+)/,
];

// ─── Engine ─────────────────────────────────────────────────────────────────────

export class ErrorRecoveryEngine {
  private learningHooks: ErrorLearningHooks | null = null;
  private config: ErrorRecoveryConfig = {};
  private recentResolutions: CachedResolution[] = [];
  private static readonly MAX_CACHED_RESOLUTIONS = 50;

  /**
   * Enable learning integration
   */
  enableLearning(
    hooks: ErrorLearningHooks,
    config: ErrorRecoveryConfig = {}
  ): void {
    this.learningHooks = hooks;
    this.config = { enableLearning: true, ...config };
    hooks.enable();
  }

  /**
   * Disable learning integration
   */
  disableLearning(): void {
    this.learningHooks?.disable();
    this.learningHooks = null;
    this.config = {};
  }

  /**
   * Check if learning is enabled
   */
  isLearningEnabled(): boolean {
    return this.config.enableLearning === true && this.learningHooks !== null;
  }

  /**
   * Record a successful resolution for learning
   */
  async recordResolution(params: {
    toolName: string;
    errorOutput: string;
    analysis: ErrorAnalysis;
    action: string;
    success: boolean;
    resolutionTimeMs?: number;
    attempts?: number;
  }): Promise<void> {
    if (!this.isLearningEnabled() || !this.learningHooks) return;

    await this.learningHooks.onAfterErrorResolution({
      errorContext: {
        toolName: params.toolName,
        errorOutput: params.errorOutput,
        analysis: params.analysis,
        sessionId: this.config.sessionId ?? "default",
        timestamp: new Date(),
      },
      action: params.action,
      success: params.success,
      resolutionTimeMs: params.resolutionTimeMs,
      attempts: params.attempts,
    });

    // Cache successful resolutions for pattern matching
    if (params.success) {
      this.cacheResolution({
        errorPattern: this.extractErrorSignature(params.errorOutput),
        errorCategory: this.detectCategory(params.errorOutput),
        resolution: params.action,
        toolName: params.toolName,
        timestamp: Date.now(),
        successCount: 1,
      });
    }
  }

  /**
   * Analyze a tool result for actionable errors.
   * Returns null if no errors detected (fast path).
   */
  analyze(
    toolName: string,
    result: ToolResult,
  ): ErrorAnalysis | null {
    if (!result.isError && !this.mightContainErrors(toolName, result.content)) {
      return null; // fast path: no error signals
    }

    // Get learned solutions before analysis
    let learnedSolutions = "";
    if (this.isLearningEnabled() && this.learningHooks) {
      const { recoveryInjection } = this.learningHooks.onBeforeErrorAnalysis({
        toolName,
        errorOutput: result.content,
        analysis: { hasErrors: true, errorCount: 0, summary: "", recoveryInjection: "" },
        sessionId: this.config.sessionId ?? "default",
        timestamp: new Date(),
      });
      learnedSolutions = recoveryInjection;
    }

    let analysis: ErrorAnalysis | null;

    switch (toolName) {
      case "dotnet_build": analysis = this.analyzeBuild(result.content); break;
      case "dotnet_test":  analysis = this.analyzeTests(result.content); break;
      case "shell_exec":   analysis = this.analyzeShell(result.content); break;
      default:
        analysis = result.isError ? this.analyzeGeneric(toolName, result.content) : null;
    }

    if (analysis && this.isLearningEnabled()) {
      analysis.learnedSolutions = learnedSolutions ?? "";
      if (learnedSolutions) {
        analysis.recoveryInjection += "\n" + learnedSolutions;
      }
    }

    // Look up similar past resolutions from pattern memory
    if (analysis) {
      const patternMemorySuggestions = this.lookupSimilarResolutions(toolName, result.content);
      if (patternMemorySuggestions) {
        analysis.recoveryInjection += patternMemorySuggestions;
      }
    }

    // Record error observation for learning
    if (analysis && this.isLearningEnabled()) {
      this.recordErrorObservation(toolName, result, analysis);
    }

    return analysis;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /** Quick signal check without full parse. O(1). */
  private mightContainErrors(toolName: string, content: string): boolean {
    if (toolName === "dotnet_build") return content.includes("### Errors");
    if (toolName === "dotnet_test") return content.includes("FAILED");
    return false;
  }

  /** Parse build tool formatted output → structured errors. */
  private analyzeBuild(content: string): ErrorAnalysis | null {
    const errors: StructuredError[] = [];
    BUILD_ERROR_LINE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = BUILD_ERROR_LINE.exec(content)) !== null) {
      const code = m[4]!;
      // O(1) category lookup
      const category = CODE_CATEGORY.get(code) ?? categorizeByPrefix(code);
      errors.push({
        file: m[1]!, line: +m[2]!, column: +m[3]!,
        code, message: m[5]!, category,
      });
    }

    return errors.length > 0 ? this.buildAnalysis(errors) : null;
  }

  /** Parse test tool output for failures. */
  private analyzeTests(content: string): ErrorAnalysis | null {
    const errors: StructuredError[] = [];
    TEST_FAIL_LINE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = TEST_FAIL_LINE.exec(content)) !== null) {
      errors.push({
        file: "", line: 0, column: 0,
        code: "TEST_FAIL", message: m[1]!.trim(),
        category: "test_failure",
      });
    }

    return errors.length > 0 ? this.buildAnalysis(errors) : null;
  }

  /** Detect runtime errors from shell output. Short-circuits on first match. */
  private analyzeShell(content: string): ErrorAnalysis | null {
    for (const pat of RUNTIME_PATTERNS) {
      const m = content.match(pat);
      if (m) {
        return {
          hasErrors: true,
          errorCount: 1,
          summary: "runtime error",
          recoveryInjection:
            `\n[ERROR RECOVERY]\nRuntime error: ${m[1]!.trim()}\n` +
            `Fix: ${RECOVERY.get("runtime")}\nThen re-run to verify.\n`,
        };
      }
    }
    return null;
  }

  /** Generic tool failure fallback. */
  private analyzeGeneric(toolName: string, content: string): ErrorAnalysis {
    return {
      hasErrors: true,
      errorCount: 1,
      summary: `${toolName} failed`,
      recoveryInjection:
        `\n[ERROR RECOVERY: ${toolName}]\n` +
        `${content.slice(0, 300)}\n` +
        `Fix: Analyze the error and try an alternative approach.\n`,
    };
  }

  /**
   * Build the full analysis + recovery injection from structured errors.
   * Single pass: groups by file via Map, deduplicates categories via Set.
   */
  private buildAnalysis(errors: StructuredError[]): ErrorAnalysis {
    // Group by file + count by category — O(n) single pass
    const byFile = new Map<string, StructuredError[]>();
    const catCounts = new Map<ErrorCategory, number>();

    for (const e of errors) {
      const key = e.file || "(unknown)";
      let arr = byFile.get(key);
      if (!arr) { arr = []; byFile.set(key, arr); }
      arr.push(e);
      catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1);
    }

    // Summary — O(k) where k = unique categories ≤ 14
    const summaryParts: string[] = [];
    for (const [cat, count] of catCounts) {
      summaryParts.push(`${count} ${cat.replace(/_/g, " ")}`);
    }
    const summary = summaryParts.join(", ");

    // Recovery injection — O(n + k)
    const lines: string[] = ["\n[ERROR RECOVERY ANALYSIS]"];

    for (const [file, fileErrors] of byFile) {
      lines.push(`\nFile: ${file}`);
      for (const e of fileErrors) {
        lines.push(`  L${e.line}: [${e.code}] ${e.message}`);
      }
    }

    lines.push("\n[RECOVERY STEPS]");
    let step = 1;
    for (const cat of catCounts.keys()) {
      lines.push(`${step}. ${RECOVERY.get(cat)}`);
      step++;
    }
    lines.push(`${step}. Run dotnet_build to verify fixes.`);

    return {
      hasErrors: true,
      errorCount: errors.length,
      summary,
      recoveryInjection: lines.join("\n"),
    };
  }

  private recordErrorObservation(
    toolName: string, 
    result: ToolResult, 
    analysis: ErrorAnalysis
  ): void {
    // Extract structured error info for learning
    const errorDetails = this.extractErrorDetails(result.content);
    
    for (const error of errorDetails) {
      // Build metadata as JsonObject - convert error category to learning category
      const metadata: JsonObject = {
        errorCode: error.code,
        errorCategory: toLearningCategory(error.category),
        line: error.line,
        column: error.column,
      };

      this.learningHooks?.onBeforeErrorAnalysis({
        toolName,
        errorOutput: result.content,
        analysis,
        sessionId: this.config.sessionId ?? "default",
        timestamp: new Date(),
        filePath: error.file,
        metadata,
      });
    }
  }

  private extractErrorDetails(content: string): StructuredError[] {
    const errors: StructuredError[] = [];
    
    BUILD_ERROR_LINE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BUILD_ERROR_LINE.exec(content)) !== null) {
      const code = m[4]!;
      const category = CODE_CATEGORY.get(code) ?? categorizeByPrefix(code);
      errors.push({
        file: m[1]!,
        line: +m[2]!,
        column: +m[3]!,
        code,
        message: m[5]!,
        category,
      });
    }

    return errors;
  }

  // ─── Pattern Memory ──────────────────────────────────────────────────────────

  /**
   * Cache a successful resolution for future pattern matching.
   * Deduplicates by error pattern signature and increments success count.
   */
  private cacheResolution(entry: CachedResolution): void {
    const existing = this.recentResolutions.find(
      r => r.errorPattern === entry.errorPattern && r.toolName === entry.toolName,
    );
    if (existing) {
      existing.successCount++;
      existing.resolution = entry.resolution;
      return;
    }

    this.recentResolutions.push(entry);
    if (this.recentResolutions.length > ErrorRecoveryEngine.MAX_CACHED_RESOLUTIONS) {
      this.recentResolutions.shift();
    }
  }

  /**
   * Look up similar past resolutions for the given error output.
   */
  private lookupSimilarResolutions(toolName: string, errorOutput: string): string {
    const errorSig = this.extractErrorSignature(errorOutput);
    const errorCat = this.detectCategory(errorOutput);

    const matches = this.recentResolutions.filter(r =>
      (r.errorPattern === errorSig && r.toolName === toolName) ||
      (r.errorCategory === errorCat && r.toolName === toolName),
    );

    if (matches.length === 0) return "";

    matches.sort((a, b) => b.successCount - a.successCount);
    const suggestions = matches.slice(0, 3).map(
      m => `  - [${m.successCount}x successful] ${sanitizePromptInjection(m.resolution.slice(0, 200))}`,
    );

    return [
      "\n[PATTERN MEMORY] Previously successful resolutions for similar errors:",
      ...suggestions,
    ].join("\n");
  }

  /**
   * Extract a normalized error signature for matching.
   * Strips line numbers and file paths to match error patterns across files.
   */
  private extractErrorSignature(errorOutput: string): string {
    const codes = errorOutput.match(/\b(?:CS|MSB|NU)\d{4}\b/g);
    if (codes && codes.length > 0) {
      return [...new Set(codes)].sort().join("+");
    }
    const firstError = errorOutput.match(/error[:\s]+(.{10,80})/i);
    return firstError ? firstError[1]!.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80) : "unknown";
  }

  /**
   * Detect error category from raw output (for pattern matching).
   */
  private detectCategory(errorOutput: string): ErrorCategory {
    const codeMatch = errorOutput.match(/\b(CS\d{4}|MSB\d{4}|NU\d{4})\b/);
    if (codeMatch) {
      return CODE_CATEGORY.get(codeMatch[1]!) ?? categorizeByPrefix(codeMatch[1]!);
    }
    if (TEST_FAILURE_RE.test(errorOutput)) return "test_failure";
    if (/exception|panic|fatal/i.test(errorOutput)) return "runtime";
    return "unknown";
  }
}
