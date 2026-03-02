/**
 * Code quality analysis tool.
 * Allows the AI to proactively check code quality, detect anti-patterns,
 * and suggest refactoring for C# / Strata.Core projects.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { analyzeFile, analyzeProject, formatQualityReport } from "../../intelligence/code-quality.js";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { validatePath } from "../../security/path-guard.js";

export class CodeQualityTool implements ITool {
  readonly name = "code_quality";
  readonly description =
    "Analyze C# code quality: detect anti-patterns, Strata-specific issues, " +
    "compute quality scores, and suggest refactoring. " +
    "Use mode='file' for a single file or mode='project' for full project scan.";
  readonly inputSchema = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["file", "project"],
        description: "Analyze a single file or the entire project",
      },
      path: {
        type: "string",
        description: "File path (for mode='file') or directory (for mode='project', optional — defaults to project root)",
      },
    },
    required: ["mode"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const mode = String(input["mode"]);
    const pathArg = input["path"] ? String(input["path"]) : undefined;

    if (mode === "file") {
      return this.analyzeFileMode(pathArg, context);
    }

    if (mode === "project") {
      return this.analyzeProjectMode(pathArg, context);
    }

    return {
      content: `Unknown mode '${mode}'. Use 'file' or 'project'.`,
      isError: true,
    };
  }

  private async analyzeFileMode(
    pathArg: string | undefined,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (!pathArg) {
      return { content: "mode='file' requires a 'path' parameter", isError: true };
    }

    const absPath = resolve(context.projectPath, pathArg);
    const validation = await validatePath(context.projectPath, pathArg);
    if (!validation.valid) {
      return { content: `Access denied: ${validation.error}`, isError: true };
    }

    try {
      const content = await readFile(absPath, "utf-8");
      const relPath = relative(context.projectPath, absPath);
      const report = analyzeFile(content, relPath);

      const lines: string[] = [
        `File: ${relPath}`,
        `Score: ${report.score}/100`,
        `Issues: ${report.issues.length}`,
        "",
      ];

      if (report.issues.length === 0) {
        lines.push("No issues found — code looks clean!");
      } else {
        for (const issue of report.issues) {
          const icon =
            issue.severity === "error" ? "[ERROR]" :
            issue.severity === "warning" ? "[WARN]" : "[INFO]";
          lines.push(`${icon} ${issue.message}`);
          lines.push(`  Line ${issue.line} | Rule: ${issue.rule}`);
          if (issue.suggestion) {
            lines.push(`  → ${issue.suggestion}`);
          }
          lines.push("");
        }
      }

      lines.push("Metrics:");
      lines.push(`  Classes: ${report.metrics.classCount}`);
      lines.push(`  Methods: ${report.metrics.methodCount}`);
      lines.push(`  Fields: ${report.metrics.fieldCount}`);
      lines.push(`  Max method body: ${report.metrics.maxMethodBodyLines} lines`);
      lines.push(`  Dependencies: ${report.metrics.dependencyCount}`);

      return { content: lines.join("\n") };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: `Failed to analyze file: ${msg}`, isError: true };
    }
  }

  private async analyzeProjectMode(
    pathArg: string | undefined,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const targetPath = pathArg
      ? resolve(context.projectPath, pathArg)
      : context.projectPath;

    try {
      const report = await analyzeProject(targetPath);
      return { content: formatQualityReport(report) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: `Failed to analyze project: ${msg}`, isError: true };
    }
  }
}
