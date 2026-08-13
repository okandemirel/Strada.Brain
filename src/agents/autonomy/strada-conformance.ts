import { existsSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
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
  /** Absolute project root, needed to inspect a module directory on disk. */
  readonly projectPath?: string;
  /** Injected for tests; defaults to a real directory listing. */
  readonly listDir?: (dir: string) => string[];
}

/**
 * `Assets/Modules/<Name>/…` — the layout strada_create_module produces and the
 * one an agent imitates by hand.
 */
const MODULE_PATH_RE = /(^|\/)Modules\/([^/]+)\//i;

/**
 * A Strada module is not just a folder shape. strada_create_module emits a
 * `<Name>ModuleConfig` deriving from the framework's module-config base class
 * (Configure/Initialize/Shutdown) and an .asmdef referencing Strada.Core.
 * Without the first the module is never registered with the framework; without
 * the second the code cannot compile against it at all.
 *
 * Measured: a greenfield task produced 19 hand-written files under
 * Assets/Modules/GameModule/Scripts/{Domain,Models,Services} with neither. The
 * directory looked right and the module did not exist as far as Strada was
 * concerned.
 *
 * This checks the OUTCOME rather than which tool was used, so hand-writing
 * stays legitimate as long as the result is complete.
 */
/** Recursive listing, flattened to file names — the pieces we look for can sit
 *  at the module root or one level down. Missing directory reads as empty. */
function defaultListDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  const walk = (current: string, depth: number): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (depth > 0) walk(joinPath(current, entry.name), depth - 1);
        continue;
      }
      names.push(entry.name);
    }
  };
  walk(dir, 2);
  return names;
}

function moduleRootFor(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = MODULE_PATH_RE.exec(normalized);
  if (!match) return null;
  const idx = normalized.indexOf(match[0]);
  return normalized.slice(0, idx + match[0].length).replace(/\/$/, "");
}

export class StradaConformanceGuard {
  private touchedFrameworkCode = false;
  private consultedAuthoritativeSource = false;
  private usedFrameworkGenerator = false;
  /** Module roots this run wrote C# into, e.g. "Assets/Modules/GameModule". */
  private readonly touchedModuleRoots = new Set<string>();

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
          const moduleRoot = moduleRootFor(filePath);
          if (moduleRoot) this.touchedModuleRoots.add(moduleRoot);
        }
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

  /**
   * Module roots written to this run that are missing the pieces a Strada
   * module needs to exist: a *ModuleConfig.cs and an .asmdef.
   *
   * Read from disk rather than from what the agent wrote, so a module that
   * already had them does not get flagged.
   */
  private incompleteModules(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const listDir = this.opts?.listDir ?? defaultListDir;

    const incomplete: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const entries = listDir(joinPath(projectPath, moduleRoot));
      const missing: string[] = [];
      if (!entries.some((e: string) => /ModuleConfig\.cs$/i.test(e))) missing.push("a *ModuleConfig.cs");
      if (!entries.some((e: string) => /\.asmdef$/i.test(e))) missing.push("an .asmdef");
      if (missing.length > 0) incomplete.push(`${moduleRoot} (missing ${missing.join(" and ")})`);
    }
    return incomplete;
  }

  getPrompt(): string | null {
    const incomplete = this.incompleteModules();
    if (incomplete.length > 0) {
      return (
        "[STRADA MODULE INCOMPLETE] These module directories are missing what makes them a module: " +
        `${incomplete.join("; ")}. ` +
        "A module without a *ModuleConfig.cs is never registered with the framework, and without an " +
        ".asmdef it cannot compile against Strada.Core at all — the folder layout alone does nothing. " +
        "Create them (strada_create_module produces both) before declaring the task complete."
      );
    }

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
