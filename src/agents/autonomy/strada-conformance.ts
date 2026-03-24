import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { COMPILABLE_EXT, MUTATION_TOOLS, extractFilePath } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";

const STRADA_GENERATOR_TOOLS: ReadonlySet<string> = new Set([
  "strada_create_module",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_system",
]);

const AUTHORITATIVE_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  "file_read",
  "grep_search",
  "glob_search",
  "code_search",
  "shell_exec",
]);

function hasAuthoritativeSource(deps?: StradaDepsStatus): boolean {
  return Boolean(deps?.coreInstalled || deps?.modulesInstalled || deps?.mcpInstalled);
}

function isCompilableFile(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  return dotIdx !== -1 && COMPILABLE_EXT.has(filePath.slice(dotIdx));
}

function stringifyInput(input: Record<string, unknown>): string {
  return JSON.stringify(input).toLowerCase();
}

export interface ConformanceGuardOptions {
  readonly enabled?: boolean;
  readonly frameworkPathsOnly?: boolean;
}

export class StradaConformanceGuard {
  private touchedFrameworkCode = false;
  private consultedAuthoritativeSource = false;
  private usedFrameworkGenerator = false;

  constructor(
    private readonly deps?: StradaDepsStatus,
    private readonly opts?: ConformanceGuardOptions,
  ) {}

  trackPrompt(_prompt: string): void {}

  trackToolCall(
    toolName: string,
    input: Record<string, unknown>,
    isError = false,
    output = "",
  ): void {
    if (!hasAuthoritativeSource(this.deps)) {
      return;
    }

    for (const executedTool of expandExecutedToolCalls(toolName, input, {
      toolCallId: "strada-conformance",
      content: output,
      isError,
    })) {
      if (STRADA_GENERATOR_TOOLS.has(executedTool.toolName)) {
        this.touchedFrameworkCode = true;
        if (!executedTool.isError) {
          this.usedFrameworkGenerator = true;
        }
        continue;
      }

      if (!executedTool.isError && MUTATION_TOOLS.has(executedTool.toolName)) {
        const filePath = extractFilePath(executedTool.input);
        if (filePath && isCompilableFile(filePath)) {
          if (this.opts?.frameworkPathsOnly === false || isInsideFrameworkPath(filePath, this.deps)) {
            this.touchedFrameworkCode = true;
          }
        }
      }

      if (executedTool.isError || !AUTHORITATIVE_SOURCE_TOOLS.has(executedTool.toolName)) {
        continue;
      }

      const normalizedInput = stringifyInput(executedTool.input);
      const authoritativeHints = [
        this.deps?.corePath?.toLowerCase(),
        this.deps?.modulesPath?.toLowerCase(),
        this.deps?.mcpPath?.toLowerCase(),
        "strada.core",
        "strada.modules",
        "strada.mcp",
      ].filter((value): value is string => Boolean(value));

      if (authoritativeHints.some((hint) => normalizedInput.includes(hint))) {
        this.consultedAuthoritativeSource = true;
      }
    }
  }

  needsConformanceReview(): boolean {
    if (this.opts?.enabled === false) return false;
    return (
      hasAuthoritativeSource(this.deps) &&
      this.touchedFrameworkCode &&
      !this.usedFrameworkGenerator &&
      !this.consultedAuthoritativeSource
    );
  }

  getPrompt(): string | null {
    if (!this.needsConformanceReview()) {
      return null;
    }

    return (
      "[STRADA CONFORMANCE REQUIRED] Before declaring the task complete, inspect the installed " +
      "Strada.Core/Strada.Modules/Strada.MCP authoritative sources for the touched APIs or patterns, " +
      "confirm the implementation matches their real contracts/conventions, then continue."
    );
  }
}

function isInsideFrameworkPath(filePath: string, deps?: StradaDepsStatus): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, "/");
  const frameworkPaths = [
    deps?.corePath,
    deps?.modulesPath,
    deps?.mcpPath,
  ]
    .filter((p): p is string => Boolean(p))
    .map((p) => p.toLowerCase().replace(/\\/g, "/"));

  if (frameworkPaths.length === 0) return false;
  return frameworkPaths.some((fp) => normalized.includes(fp));
}
