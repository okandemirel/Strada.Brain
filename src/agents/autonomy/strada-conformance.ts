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
  /**
   * Every .asmdef under a module, as paths relative to that module.
   * Injected for tests; defaults to a real recursive walk.
   */
  readonly listAsmdefs?: (dir: string) => string[];
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
/** Every .asmdef under `dir`, as paths relative to it. */
function defaultListAsmdefs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string, prefix: string, depth: number): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth > 0) walk(joinPath(current, entry.name), rel, depth - 1);
        continue;
      }
      if (/\.asmdef$/i.test(entry.name)) found.push(rel);
    }
  };
  walk(dir, "", 4);
  return found;
}

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
  /**
   * Code assemblies in a touched module that nothing tests.
   *
   * A module split into several assemblies is several compilation units, and a
   * single test assembly referencing all of them defeats the split: a Domain
   * test can reach Presentation, no layer can be tested in isolation, and a
   * change anywhere rebuilds everything.
   *
   * Measured: a PixelFlow module with five code assemblies — Domain (22 files),
   * Application (9), Infrastructure (8), Presentation (2), Core (1) — carried
   * one Tests assembly at the module root that referenced all five. Four of the
   * five assemblies had no test of their own.
   *
   * Pairing is by name, which is what the generator produces and what Unity
   * shows in the Test Runner: assembly `X` is tested by `X.Tests` or
   * `X.Editor.Tests`. A single-assembly module is satisfied by its own
   * Tests/Runtime + Tests/Editor pair, so this only speaks up when a module
   * really has grown extra assemblies.
   */
  /**
   * Assembly names claimed by more than one .asmdef in a touched module.
   *
   * Unity requires assembly names to be unique across the whole project and
   * refuses to compile when two .asmdef files claim the same one — every
   * assembly in the project fails, not just the pair. Nothing else here catches
   * it: the JSON is valid, the C# is valid, and script_validate is a syntax
   * check, so the first sign is a project that will not build.
   *
   * Measured: asked to add tests, an agent created the framework's
   * Tests/Runtime + Tests/Editor pair AND kept its own habit of a Tests/ root
   * assembly, ending with Tests/YourGame.PixelFlow.Tests.asmdef and
   * Tests/Runtime/YourGame.PixelFlow.Tests.asmdef claiming one name — plus six
   * test files at the Tests root, belonging to neither mode.
   */
  private duplicateAssemblyNames(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const listAsmdefs = this.opts?.listAsmdefs ?? defaultListAsmdefs;

    const duplicates: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const paths = listAsmdefs(joinPath(projectPath, moduleRoot));
      const byName = new Map<string, string[]>();
      for (const path of paths) {
        const normalized = path.replace(/\\/g, "/");
        const name = normalized.split("/").pop()!.replace(/\.asmdef$/i, "");
        byName.set(name, [...(byName.get(name) ?? []), `${moduleRoot}/${normalized}`]);
      }
      for (const [name, locations] of byName) {
        if (locations.length > 1) {
          duplicates.push(`${name} (${locations.join(" and ")})`);
        }
      }
    }
    return duplicates;
  }

  private untestedAssemblies(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const listAsmdefs = this.opts?.listAsmdefs ?? defaultListAsmdefs;

    const untested: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const paths = listAsmdefs(joinPath(projectPath, moduleRoot));
      if (paths.length === 0) continue;

      const names = paths.map((p) => p.replace(/\\/g, "/").split("/").pop()!.replace(/\.asmdef$/i, ""));
      const testNames = new Set(names.filter((n) => /\.(Editor\.)?Tests$/i.test(n)));
      const codeNames = names.filter((n) => !/\.(Editor\.)?Tests$/i.test(n));

      for (const code of codeNames) {
        const tested = testNames.has(`${code}.Tests`) || testNames.has(`${code}.Editor.Tests`);
        if (!tested) untested.push(`${code} (in ${moduleRoot})`);
      }
    }
    return untested;
  }

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

    // Ahead of the coverage gate: a duplicate name means nothing in the project
    // compiles at all, which makes any advice about test coverage moot.
    const duplicates = this.duplicateAssemblyNames();
    if (duplicates.length > 0) {
      return (
        "[STRADA DUPLICATE ASSEMBLY] Two .asmdef files claim the same assembly name: " +
        `${duplicates.join("; ")}. ` +
        "Unity requires assembly names to be unique across the project and refuses to " +
        "compile ANY assembly while a duplicate exists. Delete the one that does not belong " +
        "or rename it, and make sure each test file sits under the assembly meant to compile " +
        "it — a .cs beside a Tests/ root .asmdef belongs to neither Tests/Runtime nor " +
        "Tests/Editor."
      );
    }

    const untested = this.untestedAssemblies();
    if (untested.length > 0) {
      return (
        "[STRADA MODULE TESTS MISSING] These assemblies have no test assembly of their own: " +
        `${untested.join("; ")}. ` +
        "Each assembly is its own compilation unit, so each needs its own tests — " +
        "`<Assembly>.Tests` under Tests/Runtime for play-mode and `<Assembly>.Editor.Tests` " +
        "under Tests/Editor for edit-mode, each referencing only the assembly it tests. " +
        "One shared test assembly referencing every layer defeats the split: no layer can be " +
        "tested in isolation and a change anywhere rebuilds everything."
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
