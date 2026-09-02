/**
 * Code quality analyzer for C# / Strada.Core projects.
 *
 * Detects anti-patterns, computes quality scores, and generates
 * refactoring suggestions — both for general C# and Strada-specific patterns.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { glob } from "glob";
import {
  parseDeep,
  getClasses,
  getStructs,
  getInterfaces,
  getMethods,
  getConstructors,
  getFields,
  getProperties,
  getDependencies,
  deepInheritsFrom,
  deepImplements,
  type CSharpAST,
} from "./csharp-deep-parser.js";
import { getLogger } from "../utils/logger.js";

// ═══════════════════════════════════════════
// Types
// ═══════════════════════════════════════════

export type IssueSeverity = "error" | "warning" | "info";

export type IssueCategory =
  | "anti-pattern"
  | "strada-specific"
  | "complexity"
  | "naming"
  | "architecture";

export interface QualityIssue {
  severity: IssueSeverity;
  category: IssueCategory;
  rule: string;
  message: string;
  filePath: string;
  line: number;
  suggestion?: string;
}

export interface FileQualityReport {
  filePath: string;
  score: number; // 0-100
  issues: QualityIssue[];
  metrics: FileMetrics;
}

export interface FileMetrics {
  lineCount: number;
  classCount: number;
  methodCount: number;
  fieldCount: number;
  maxMethodBodyLines: number;
  maxConstructorParams: number;
  dependencyCount: number;
  inheritanceDepth: number;
}

/**
 * Thrown by `analyzeFile` when the parser did not read the file (over the
 * 1MB limit). A file that was never parsed has no score; returning one
 * (100/100, zero issues, zero classes) reported "not analyzed" as "clean".
 * Audited 2026-09-02.
 */
export class FileNotAnalyzedError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(`${filePath} not analyzed: ${reason}`);
    this.name = "FileNotAnalyzedError";
  }
}

function describeNotParsed(notParsed: NonNullable<CSharpAST["notParsed"]>): string {
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)}MB`;
  return `exceeds the ${mb(notParsed.limit)} (${notParsed.limit} bytes) parser limit at ${mb(notParsed.contentLength)}; no rules or metrics were computed`;
}

export interface ProjectQualityReport {
  /** 0-100 average over analyzed files; null when no file was analyzed (nothing was measured). */
  overallScore: number | null;
  fileReports: FileQualityReport[];
  summary: QualitySummary;
  topIssues: QualityIssue[];
}

export interface QualitySummary {
  totalFiles: number;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  /** Distribution of issue categories. */
  categoryBreakdown: Record<string, number>;
  /** Files with lowest scores. */
  worstFiles: Array<{ filePath: string; score: number }>;
  /**
   * Files that were found but NOT analyzed (oversized, unreadable), with the
   * reason. Always reported next to totalFiles so "Files Analyzed" never
   * stands alone. Audited 2026-09-02.
   */
  skippedFiles: Array<{ filePath: string; reason: string }>;
}

// ═══════════════════════════════════════════
// Thresholds (configurable)
// ═══════════════════════════════════════════

const THRESHOLDS = {
  /** Class is too large (lines). */
  godClassLines: 500,
  /** Class has too many methods. */
  godClassMethods: 20,
  /** Class has too many fields. */
  godClassFields: 15,
  /** Method body too long (lines). */
  longMethodLines: 50,
  /** Too many parameters in a method/constructor. */
  tooManyParams: 5,
  /** Constructor injection count suggesting class does too much. */
  tooManyDependencies: 6,
  /** Module with too many systems. */
  moduleSystemLimit: 10,
  /** Inheritance depth warning. */
  deepInheritance: 3,
};

/** Reference types that violate ECS component unmanaged constraint. */
const REFERENCE_TYPES = ["string", "object", "List", "Dictionary", "Array", "Action", "Func"];

// ═══════════════════════════════════════════
// Scoring weights (issue severity -> penalty)
// ═══════════════════════════════════════════

const SEVERITY_PENALTY: Record<IssueSeverity, number> = {
  error: 10,
  warning: 4,
  info: 1,
};

// ═══════════════════════════════════════════
// Analyzer
// ═══════════════════════════════════════════

/**
 * Analyze a single C# file for quality issues.
 */
export function analyzeFile(
  content: string,
  filePath: string
): FileQualityReport {
  const ast = parseDeep(content, filePath);
  if (ast.notParsed) {
    // Was: fell through with an empty AST and scored 100 - 0. Audited 2026-09-02.
    throw new FileNotAnalyzedError(filePath, describeNotParsed(ast.notParsed));
  }
  const issues: QualityIssue[] = [];
  const lines = content.split("\n");
  const lineCount = lines.length;

  // Run all rules
  checkGodClasses(ast, filePath, issues);
  checkLongMethods(ast, filePath, issues);
  checkTooManyParameters(ast, filePath, issues);
  checkDeepInheritance(ast, filePath, issues);
  checkEmptyCatchBlocks(content, filePath, issues);
  checkMagicNumbers(content, filePath, issues);
  checkNamingConventions(ast, filePath, issues);
  checkStradaAntiPatterns(ast, content, filePath, issues);
  checkArchitecturalIssues(ast, filePath, issues);

  // Compute metrics
  const classes = getClasses(ast);
  const structs = getStructs(ast);
  const allMethods = classes.flatMap((c) => getMethods(c));
  const allFields = classes.flatMap((c) => getFields(c));
  const allCtors = classes.flatMap((c) => getConstructors(c));

  const maxMethodBodyLines = allMethods.reduce(
    (max, m) => Math.max(max, m.bodyLineCount),
    0
  );
  const maxConstructorParams = allCtors.reduce(
    (max, c) => Math.max(max, c.parameters.length),
    0
  );
  const dependencyCount = classes.reduce(
    (sum, c) => sum + getDependencies(c).length,
    0
  );

  const metrics: FileMetrics = {
    lineCount,
    classCount: classes.length + structs.length,
    methodCount: allMethods.length,
    fieldCount: allFields.length,
    maxMethodBodyLines,
    maxConstructorParams,
    dependencyCount,
    inheritanceDepth: 0, // Would need cross-file analysis for accurate depth
  };

  // Calculate score
  const totalPenalty = issues.reduce(
    (sum, iss) => sum + SEVERITY_PENALTY[iss.severity],
    0
  );
  const score = Math.max(0, Math.min(100, 100 - totalPenalty));

  return { filePath, score, issues, metrics };
}

/**
 * Analyze an entire project directory.
 */
export async function analyzeProject(
  projectPath: string
): Promise<ProjectQualityReport> {
  const logger = getLogger();
  logger.info("Starting code quality analysis", { projectPath });

  const csFiles = await glob("**/*.cs", {
    cwd: projectPath,
    absolute: true,
    ignore: ["**/node_modules/**", "**/Library/**", "**/Temp/**", "**/obj/**", "**/bin/**"],
  });

  const fileReports: FileQualityReport[] = [];
  const skippedFiles: Array<{ filePath: string; reason: string }> = [];

  for (const filePath of csFiles) {
    const relPath = relative(projectPath, filePath);
    try {
      const content = await readFile(filePath, "utf-8");
      // Was: `continue` with no counter, so an oversized file vanished from the
      // report and "Files Analyzed: N" read as the whole project. Audited 2026-09-02.
      const report = analyzeFile(content, relPath);
      fileReports.push(report);
    } catch (err) {
      const reason =
        err instanceof FileNotAnalyzedError
          ? err.reason
          : `read/parse failed: ${err instanceof Error ? err.message : String(err)}`;
      skippedFiles.push({ filePath: relPath, reason });
      logger.debug(`Not analyzed: ${filePath} — ${reason}`);
    }
  }

  // Aggregate
  const allIssues = fileReports.flatMap((r) => r.issues);
  const errorCount = allIssues.filter((i) => i.severity === "error").length;
  const warningCount = allIssues.filter((i) => i.severity === "warning").length;
  const infoCount = allIssues.filter((i) => i.severity === "info").length;

  const categoryBreakdown: Record<string, number> = {};
  for (const issue of allIssues) {
    categoryBreakdown[issue.category] = (categoryBreakdown[issue.category] ?? 0) + 1;
  }

  // Was: `: 100` when nothing was analyzed — a project of only skipped files
  // scored perfect. No analyzed files means no score. Audited 2026-09-02.
  const overallScore =
    fileReports.length > 0
      ? Math.round(
          fileReports.reduce((sum, r) => sum + r.score, 0) / fileReports.length
        )
      : null;

  const worstFiles = fileReports
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((r) => ({ filePath: r.filePath, score: r.score }));

  const topIssues = allIssues
    .filter((i) => i.severity === "error" || i.severity === "warning")
    .slice(0, 20);

  return {
    overallScore,
    fileReports,
    summary: {
      totalFiles: fileReports.length,
      totalIssues: allIssues.length,
      errorCount,
      warningCount,
      infoCount,
      categoryBreakdown,
      worstFiles,
      skippedFiles,
    },
    topIssues,
  };
}

// ═══════════════════════════════════════════
// Rules
// ═══════════════════════════════════════════

function checkGodClasses(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  for (const cls of getClasses(ast)) {
    const methodCount = getMethods(cls).length;
    const fieldCount = getFields(cls).length + getProperties(cls).length;

    if (methodCount > THRESHOLDS.godClassMethods) {
      issues.push({
        severity: "warning",
        category: "anti-pattern",
        rule: "god-class-methods",
        message: `Class '${cls.name}' has ${methodCount} methods (threshold: ${THRESHOLDS.godClassMethods})`,
        filePath,
        line: cls.line,
        suggestion: `Split '${cls.name}' into smaller, focused classes using the Single Responsibility Principle`,
      });
    }

    if (fieldCount > THRESHOLDS.godClassFields) {
      issues.push({
        severity: "warning",
        category: "anti-pattern",
        rule: "god-class-fields",
        message: `Class '${cls.name}' has ${fieldCount} fields/properties (threshold: ${THRESHOLDS.godClassFields})`,
        filePath,
        line: cls.line,
        suggestion: `Extract related fields into separate data classes or components`,
      });
    }
  }
}

function checkLongMethods(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  for (const cls of getClasses(ast)) {
    for (const method of getMethods(cls)) {
      if (method.bodyLineCount > THRESHOLDS.longMethodLines) {
        issues.push({
          severity: "warning",
          category: "complexity",
          rule: "long-method",
          message: `Method '${cls.name}.${method.name}' has ${method.bodyLineCount} lines (threshold: ${THRESHOLDS.longMethodLines})`,
          filePath,
          line: method.line,
          suggestion: `Extract logic into smaller helper methods`,
        });
      }
    }
  }
}

function checkTooManyParameters(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  for (const cls of getClasses(ast)) {
    for (const method of getMethods(cls)) {
      if (method.parameters.length > THRESHOLDS.tooManyParams) {
        issues.push({
          severity: "info",
          category: "complexity",
          rule: "too-many-params",
          message: `Method '${cls.name}.${method.name}' has ${method.parameters.length} parameters (threshold: ${THRESHOLDS.tooManyParams})`,
          filePath,
          line: method.line,
          suggestion: `Group related parameters into a parameter object or use a builder pattern`,
        });
      }
    }

    for (const ctor of getConstructors(cls)) {
      if (ctor.parameters.length > THRESHOLDS.tooManyDependencies) {
        issues.push({
          severity: "warning",
          category: "anti-pattern",
          rule: "too-many-dependencies",
          message: `Constructor '${cls.name}' has ${ctor.parameters.length} dependencies (threshold: ${THRESHOLDS.tooManyDependencies})`,
          filePath,
          line: ctor.line,
          suggestion: `Class may have too many responsibilities. Consider splitting or using a facade service.`,
        });
      }
    }
  }
}

function checkDeepInheritance(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  // We can only check direct inheritance without cross-file resolution,
  // but we flag classes with many base types (multiple interface + base = complex)
  for (const cls of getClasses(ast)) {
    if (cls.baseTypes.length > THRESHOLDS.deepInheritance) {
      issues.push({
        severity: "info",
        category: "complexity",
        rule: "many-base-types",
        message: `Class '${cls.name}' implements ${cls.baseTypes.length} base types`,
        filePath,
        line: cls.line,
        suggestion: `Consider using composition over inheritance or splitting interfaces`,
      });
    }
  }
}

function checkEmptyCatchBlocks(
  content: string,
  filePath: string,
  issues: QualityIssue[]
): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Detect: catch { } or catch (Exception) { } followed by empty or whitespace-only block
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(trimmed)) {
      issues.push({
        severity: "warning",
        category: "anti-pattern",
        rule: "empty-catch",
        message: `Empty catch block swallows exceptions silently`,
        filePath,
        line: i + 1,
        suggestion: `At minimum, log the exception. Swallowing exceptions hides bugs.`,
      });
    }
  }
}

function checkMagicNumbers(
  content: string,
  filePath: string,
  issues: QualityIssue[]
): void {
  const lines = content.split("\n");
  // Skip enums, const declarations, and common values (0, 1, -1, 2)
  const magicRegex = /(?<![=<>!])(?<!\w)\b(\d+(?:\.\d+)?f?)\b(?![;,}\]])(?!.*(?:const|enum))/;
  const allowedNumbers = new Set(["0", "1", "2", "-1", "0f", "1f", "0.0f", "1.0f", "100"]);
  let magicCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Skip comments, declarations, const, enum lines
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    if (line.includes("const ") || line.includes("enum ")) continue;

    const match = magicRegex.exec(line);
    if (match && !allowedNumbers.has(match[1]!)) {
      magicCount++;
      if (magicCount <= 3) {
        // Only report first few to avoid noise
        issues.push({
          severity: "info",
          category: "anti-pattern",
          rule: "magic-number",
          message: `Magic number '${match[1]}' found`,
          filePath,
          line: i + 1,
          suggestion: `Extract into a named constant for readability`,
        });
      }
    }
  }
}

function checkNamingConventions(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  for (const cls of getClasses(ast)) {
    // Classes should be PascalCase
    if (cls.name[0] !== cls.name[0]!.toUpperCase()) {
      issues.push({
        severity: "warning",
        category: "naming",
        rule: "class-naming",
        message: `Class '${cls.name}' should use PascalCase`,
        filePath,
        line: cls.line,
      });
    }

    // Private fields should start with _
    for (const field of getFields(cls)) {
      if (
        field.modifiers.includes("private") &&
        !field.modifiers.includes("const") &&
        !field.modifiers.includes("static") &&
        !field.name.startsWith("_")
      ) {
        issues.push({
          severity: "info",
          category: "naming",
          rule: "private-field-prefix",
          message: `Private field '${field.name}' in '${cls.name}' should start with '_'`,
          filePath,
          line: field.line,
        });
      }
    }
  }
}

function checkStradaAntiPatterns(
  ast: CSharpAST,
  content: string,
  filePath: string,
  issues: QualityIssue[]
): void {
  const classes = getClasses(ast);
  const structs = getStructs(ast);

  // 1. Component with reference type fields (should be unmanaged struct)
  for (const s of structs) {
    if (deepImplements(s, "IComponent")) {
      for (const field of getFields(s)) {
        const refTypes = REFERENCE_TYPES;
        for (const rt of refTypes) {
          if (field.type.startsWith(rt)) {
            issues.push({
              severity: "error",
              category: "strada-specific",
              rule: "component-reference-type",
              message: `ECS Component '${s.name}' has reference type field '${field.name}' (${field.type})`,
              filePath,
              line: field.line,
              suggestion: `ECS components should be unmanaged structs. Use NativeArray or fixed buffers instead.`,
            });
          }
        }
      }
    }
  }

  // 2. System without EntityQuery (possibly dead system)
  for (const cls of classes) {
    if (
      deepInheritsFrom(cls, "SystemBase") ||
      deepInheritsFrom(cls, "JobSystemBase")
    ) {
      const hasQuery =
        content.includes("EntityQuery") ||
        content.includes("CreateQuery") ||
        content.includes("World.Get");

      if (!hasQuery) {
        issues.push({
          severity: "info",
          category: "strada-specific",
          rule: "system-no-query",
          message: `System '${cls.name}' has no EntityQuery — may not process any entities`,
          filePath,
          line: cls.line,
          suggestion: `Add an EntityQuery to filter and process entities, or convert to a regular service if not ECS-related`,
        });
      }
    }
  }

  // 3. ModuleConfig with too many systems
  for (const cls of classes) {
    if (
      deepInheritsFrom(cls, "ModuleConfig") ||
      cls.name.endsWith("ModuleConfig")
    ) {
      // Count system registrations in the content
      const systemRegex = /AddSystem|RegisterSystem/g;
      const systemCount = (content.match(systemRegex) ?? []).length;
      if (systemCount > THRESHOLDS.moduleSystemLimit) {
        issues.push({
          severity: "warning",
          category: "strada-specific",
          rule: "module-too-many-systems",
          message: `Module '${cls.name}' registers ${systemCount} systems (threshold: ${THRESHOLDS.moduleSystemLimit})`,
          filePath,
          line: cls.line,
          suggestion: `Split into multiple smaller modules for better separation of concerns`,
        });
      }
    }
  }

  // 4. Missing service interface
  for (const cls of classes) {
    // Check if service class has no interface
    if (
      cls.name.endsWith("Service") &&
      !cls.modifiers.includes("abstract") &&
      cls.baseTypes.every(
        (bt) => !bt.replace(/<[^>]+>/g, "").startsWith("I")
      )
    ) {
      issues.push({
        severity: "info",
        category: "strada-specific",
        rule: "service-no-interface",
        message: `Service '${cls.name}' has no interface — cannot be mocked or substituted in DI`,
        filePath,
        line: cls.line,
        suggestion: `Create 'I${cls.name}' interface and register it in the DI container`,
      });
    }
  }
}

function checkArchitecturalIssues(
  ast: CSharpAST,
  filePath: string,
  issues: QualityIssue[]
): void {
  const classes = getClasses(ast);
  const interfaces = getInterfaces(ast);

  // Multiple classes in one file (except nested)
  if (classes.length > 1) {
    issues.push({
      severity: "info",
      category: "architecture",
      rule: "multiple-classes-per-file",
      message: `File contains ${classes.length} top-level classes (${classes.map((c) => c.name).join(", ")})`,
      filePath,
      line: 1,
      suggestion: `Follow C# convention: one type per file`,
    });
  }

  // Interface with too many members (Interface Segregation Principle)
  for (const iface of interfaces) {
    const memberCount = iface.members.length;
    if (memberCount > 10) {
      issues.push({
        severity: "info",
        category: "architecture",
        rule: "fat-interface",
        message: `Interface '${iface.name}' has ${memberCount} members — consider splitting`,
        filePath,
        line: iface.line,
        suggestion: `Apply Interface Segregation Principle: split into smaller, focused interfaces`,
      });
    }
  }
}

// ═══════════════════════════════════════════
// Formatter
// ═══════════════════════════════════════════

/**
 * Format a project quality report as readable text for messaging.
 */
export function formatQualityReport(report: ProjectQualityReport): string {
  const lines: string[] = [];

  lines.push("Code Quality Analysis");
  lines.push("━".repeat(40));
  lines.push(
    report.overallScore === null
      ? `Overall Score: not measured (${report.summary.totalFiles} files analyzed)`
      : `Overall Score: ${report.overallScore}/100`
  );
  lines.push(`Files Analyzed: ${report.summary.totalFiles}`);
  const skipped = report.summary.skippedFiles ?? [];
  if (skipped.length > 0) {
    lines.push(`Files Skipped (not analyzed): ${skipped.length}`);
    for (const s of skipped.slice(0, 10)) {
      lines.push(`  ${s.filePath} — ${s.reason}`);
    }
    if (skipped.length > 10) lines.push(`  ... and ${skipped.length - 10} more`);
  }
  lines.push(
    `Issues: ${report.summary.errorCount} errors, ${report.summary.warningCount} warnings, ${report.summary.infoCount} info`
  );

  if (report.summary.worstFiles.length > 0) {
    lines.push("\nFiles Needing Attention:");
    for (const f of report.summary.worstFiles) {
      lines.push(`  ${f.filePath} — score: ${f.score}/100`);
    }
  }

  if (report.topIssues.length > 0) {
    lines.push("\nTop Issues:");
    for (const issue of report.topIssues.slice(0, 10)) {
      const icon =
        issue.severity === "error" ? "!!" : issue.severity === "warning" ? "!" : "i";
      lines.push(`  [${icon}] ${issue.message}`);
      lines.push(`      ${issue.filePath}:${issue.line}`);
      if (issue.suggestion) {
        lines.push(`      → ${issue.suggestion}`);
      }
    }
  }

  if (Object.keys(report.summary.categoryBreakdown).length > 0) {
    lines.push("\nIssue Categories:");
    for (const [cat, count] of Object.entries(report.summary.categoryBreakdown)) {
      lines.push(`  ${cat}: ${count}`);
    }
  }

  return lines.join("\n");
}
