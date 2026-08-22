import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getLogger } from "../../utils/logger.js";
import { join as joinPath, resolve as resolvePath } from "node:path";

/**
 * Where a tracked module root actually lives on disk.
 *
 * Tool input carries whichever path shape the model produced. A relative one
 * joins onto the project; an absolute one is already the answer, and joining it
 * produces a path that exists nowhere — which read as "this module has no
 * ModuleConfig.cs and no .asmdef" and accused a correctly-built module of being
 * incomplete. resolve() is the one operation that is right for both.
 */
/** Every file under a directory, bounded so a stray Library folder cannot hang a check. */
function walkFiles(dir: string, budget = 4000): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < budget) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = joinPath(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/** Does any .asset under Assets point at this script's guid? */
function anyAssetReferences(assetsRoot: string, guid: string): boolean {
  for (const file of walkFiles(assetsRoot)) {
    if (!file.endsWith(".asset")) continue;
    try {
      if (readFileSync(file, "utf8").includes(guid)) return true;
    } catch {
      // Unreadable asset: cannot prove a reference, keep looking.
    }
  }
  return false;
}

function moduleDir(projectPath: string, moduleRoot: string): string {
  return resolvePath(projectPath, moduleRoot);
}
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { assessFrameworkBypass, assessSceneWiring, assessViewLayer } from "./scene-wiring.js";
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
  /** Every .cs under a directory with its line count, for the length rule. */
  readonly readSourceSizes?: (dir: string) => Array<{ path: string; lines: number }>;
  /** Contents of the .cs files under a test assembly's directory. */
  readonly readTestSources?: (dir: string) => string[];
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
/**
 * The assembly name Unity actually enforces.
 *
 * It is the `name` field inside the .asmdef, not the file name. Reading the file
 * name meant the duplicate check could not see the duplicates its own message
 * described — two files called Board.asmdef both declaring "Game.Board" is a
 * project Unity refuses to compile, and it read as two distinct assemblies.
 */
function assemblyNameOf(asmdefPath: string, fallback: string): string {
  try {
    const parsed = JSON.parse(readFileSync(asmdefPath, "utf8")) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim() !== "") return parsed.name.trim();
  } catch {
    // Unreadable or malformed: the file name is the best remaining guess.
  }
  return fallback;
}

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

/**
 * The C# sources under a test assembly's directory.
 *
 * Returns contents, not names: whether a folder is a test assembly or an empty
 * shell is a question about what is inside the files, and a directory listing
 * cannot answer it.
 */
function defaultTestSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const sources: string[] = [];
  const walk = (current: string, depth: number): void => {
    const entries = readdirSync(current, { withFileTypes: true });

    // Unity's ownership rule, which this walk had backwards: a folder with its
    // own .asmdef takes its sources OUT of the parent assembly. Counting them
    // credited an empty test assembly with a nested assembly's tests, so the
    // empty one — which Unity compiles and runs zero tests from — passed.
    if (current !== dir && entries.some((e) => e.isFile() && e.name.endsWith(".asmdef"))) return;

    for (const entry of entries) {
      const full = joinPath(current, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      try {
        sources.push(readFileSync(full, "utf8"));
      } catch {
        // Unreadable file: no evidence either way.
      }
    }
  };
  walk(dir, 3);
  return sources;
}

/** Every .cs under a directory, with its path and line count. */
function defaultSourceSizes(dir: string): Array<{ path: string; lines: number }> {
  if (!existsSync(dir)) return [];
  const sizes: Array<{ path: string; lines: number }> = [];
  const walk = (current: string, depth: number): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = joinPath(current, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      try {
        sizes.push({ path: entry.name, lines: readFileSync(full, "utf8").split("\n").length });
      } catch {
        // Unreadable file: no evidence either way.
      }
    }
  };
  walk(dir, 4);
  return sizes;
}

/** Does this source actually declare a test NUnit will run? */
function declaresTest(source: string): boolean {
  return /\[\s*(Test|UnityTest|TestCase|TestCaseSource)\b/.test(source);
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

/**
 * How many times a run is asked to start the game before the gate gives up.
 *
 * Three is enough to be heard and few enough that a project which cannot comply
 * still finishes and reports honestly.
 */
const NEVER_RUN_GATE_LIMIT = 3;

/**
 * Where a class stops being one thing.
 *
 * Not a style preference: Strada.Core's whole shape — commands, services,
 * models, systems — exists to divide work, and a file past this has usually
 * stopped using it.
 */
const MAX_SOURCE_LINES = 200;

/** Tools that actually run the game rather than inspect it. */
const PLAYMODE_VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  "unity_playmode_verify",
]);

/**
 * Every module root named anywhere in a block of text.
 *
 * Used on a generator's own report of what it created, which is the only
 * statement of the paths that cannot drift from the paths it actually wrote.
 */
/** Is this a file Unity will compile as part of the project? */
/** Debug-only: did any guard actually observe a project write this run? */
function logGuardWrite(toolName: string, filePath: string): void {
  debugLog("Conformance guard saw a project write", { toolName, filePath });
}

function isInsideAssets(filePath: string): boolean {
  return /(^|\/)Assets\//i.test(filePath.replace(/\\/g, "/"));
}

function moduleRootsIn(text: string): string[] {
  if (!text) return [];
  const roots = new Set<string>();
  for (const line of text.split(/[\s,;]+/u)) {
    const root = moduleRootFor(line);
    if (root) roots.add(root);
  }
  return [...roots];
}

function moduleRootFor(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = MODULE_PATH_RE.exec(normalized);
  if (!match) return null;
  const idx = normalized.indexOf(match[0]);
  return normalized.slice(0, idx + match[0].length).replace(/\/$/, "");
}

/**
 * Which tree the conformance rules should read.
 *
 * Tools are handed `workspacePath ?? projectPath` (orchestrator.ts:3981), so a
 * run holding a lease writes into a temp copy and the source root receives it
 * only at commit. A guard pointed at the source root therefore judges the state
 * the run started from for its whole life — it cannot see the module the run
 * just created, the test it just wrote, or the scene it just assembled, and
 * every rule keyed on those reads stale ground.
 *
 * The rule is simply: read where the writes go.
 */
export function conformanceProjectPath(
  leasePath: string | undefined,
  sourceRoot: string | undefined,
): string | undefined {
  return leasePath ?? sourceRoot;
}

/**
 * A diagnostic line that cannot be the reason something fails.
 *
 * getLogger() throws when no logger has been created, which is correct for code
 * that needs one and wrong for an observability line.
 */
function debugLog(message: string, meta: Record<string, unknown>): void {
  try {
    getLogger().debug(message, meta);
  } catch {
    // No logger in this context; the diagnostic is not worth an exception.
  }
}

export class StradaConformanceGuard {
  private touchedFrameworkCode = false;
  private consultedAuthoritativeSource = false;
  private usedFrameworkGenerator = false;
  /** Whether this run tried to run the game, not only to build it. */
  private attemptedPlaymodeVerification = false;
  /**
   * How many times the never-run gate has been raised.
   *
   * Any rule that depends on a tool being present has to be able to give up.
   * unity_playmode_verify reaches a project through its Strada.MCP submodule, so
   * a checkout that predates the tool cannot satisfy this gate however many
   * times it is told to — and a gate that cannot be cleared stops being a rule
   * and becomes a loop.
   */
  private neverRunGateRaised = 0;
  /**
   * Tool-call count when the never-run gate was last raised.
   *
   * getPrompt() is not called once per turn — it is called wherever a caller
   * wants to know whether a gate is open, and some of those calls discard the
   * text. Counting calls spent the three-ask budget on questions nobody asked
   * the agent, so the budget is spent per turn of actual work instead: the same
   * gate raised again with no tool call in between is the same asking.
   */
  private neverRunGateRaisedAtCall: number | null = null;
  private toolCallsSeen = 0;
  /** Module roots this run wrote C# into, e.g. "Assets/Modules/GameModule". */
  private readonly touchedModuleRoots = new Set<string>();
  /**
   * Whether this run wrote compilable code into the project at all.
   *
   * Separate from touchedModuleRoots on purpose. The module rules — is this a
   * module, does it have tests, are its assembly names unique — are about the
   * Modules/ convention and rightly key on it. Whether the run delivered a game
   * is not: nothing obliges an agent to put its code under Assets/Modules/, and
   * keying the scene and never-run gates on that folder made a game written
   * under Assets/Scripts/ exempt from every one of them.
   */
  private wroteProjectCode = false;

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
      this.toolCallsSeen += 1;

      if (PLAYMODE_VERIFICATION_TOOLS.has(executedTool.toolName)) {
        // Tracked whether it passed or failed. A failed verification is the
        // agent's problem to solve and it already sees the error; this rule only
        // asks that the game was run at all, so that a failing attempt can never
        // trap the run in a gate it has no way to clear.
        this.attemptedPlaymodeVerification = true;
      }

      if (STRADA_GENERATOR_TOOLS.has(executedTool.toolName)) {
        this.touchedFrameworkCode = true;
        if (!executedTool.isError) {
          this.usedFrameworkGenerator = true;
          // The generator is the RECOMMENDED way to make a module, and this
          // branch used to `continue` straight past the module-root recording
          // below — so a run that followed the advice recorded no module roots,
          // and every rule keyed on them went silent. The rules were inert on
          // the primary path and only fired for hand-written modules.
          //
          // Read the roots out of what the tool reports it created, rather than
          // rebuilding its naming convention here and drifting from it.
          for (const root of moduleRootsIn(executedTool.output)) {
            this.touchedModuleRoots.add(root);
          }
          this.wroteProjectCode = true;
        }
        continue;
      }

      if (!executedTool.isError && MUTATION_TOOLS.has(executedTool.toolName)) {
        const filePath = extractFilePath(executedTool.input);
        if (filePath && isCompilableFile(filePath)) {
          const moduleRoot = moduleRootFor(filePath);
          if (moduleRoot) this.touchedModuleRoots.add(moduleRoot);
          if (isInsideAssets(filePath)) this.wroteProjectCode = true;
          logGuardWrite(executedTool.toolName, filePath);
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

    // Collected across every touched module, not per module: the constraint the
    // message states is project-wide, and rebuilding the map inside the loop
    // meant the same assembly name in two modules — the case that stops Unity
    // compiling anything at all — never collided.
    const byName = new Map<string, string[]>();
    for (const moduleRoot of this.touchedModuleRoots) {
      const root = moduleDir(projectPath, moduleRoot);
      for (const path of listAsmdefs(root)) {
        const normalized = path.replace(/\\/g, "/");
        const fileName = normalized.split("/").pop()!.replace(/\.asmdef$/i, "");
        const name = assemblyNameOf(joinPath(root, normalized), fileName);
        byName.set(name, [...(byName.get(name) ?? []), `${moduleRoot}/${normalized}`]);
      }
    }

    const duplicates: string[] = [];
    for (const [name, locations] of byName) {
      if (locations.length > 1) duplicates.push(`${name} (${locations.join(" and ")})`);
    }
    return duplicates;
  }

  /**
   * Test assemblies whose directory holds no test.
   *
   * Only reports what it could actually read: a directory that is not on disk
   * yields no sources and no accusation, in line with every other rule here.
   */
  /**
   * Configs that hold prefabs and that nothing ever instantiated.
   *
   * A ScriptableObject declaring GameObject fields is how prefabs reach run
   * time. Writing the class is half of it; the other half is the .asset that
   * holds the references, and without it every field is null and nothing
   * spawns. Unity records the link by script guid — the .cs.meta names the
   * guid, an .asset points back at it — so that is what this follows rather
   * than the class name, which appears nowhere in the asset.
   *
   * Measured 2026-08-22: twenty-five prefabs, a config with three GameObject
   * fields, zero assets pointing at its guid, and a project whose entire
   * PlayMode suite passed while every captured frame was empty sky.
   */
  private unboundPrefabConfigs(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];

    const assetsRoot = joinPath(projectPath, "Assets");
    if (!existsSync(assetsRoot)) return [];

    const out: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const root = moduleDir(projectPath, moduleRoot);
      if (!existsSync(root)) continue;

      for (const script of walkFiles(root)) {
        if (!script.endsWith(".cs")) continue;
        let source: string;
        try {
          source = readFileSync(script, "utf8");
        } catch {
          continue; // Unreadable: absence of evidence.
        }

        const prefabFields = source.match(
          /\[SerializeField\][^;]{0,120}\bGameObject\b[^;]{0,80};/gu,
        );
        if (!prefabFields || prefabFields.length === 0) continue;

        let guid: string | undefined;
        try {
          guid = /guid:\s*([a-f0-9]{32})/u.exec(readFileSync(`${script}.meta`, "utf8"))?.[1];
        } catch {
          continue; // No .meta yet: Unity has not imported it, so say nothing.
        }
        if (!guid) continue;

        if (!anyAssetReferences(assetsRoot, guid)) {
          const name = script.split(/[/\\]/u).pop()?.replace(/\.cs$/u, "") ?? script;
          out.push(`${name} (${prefabFields.length} prefab field(s), no .asset instance)`);
        }
      }
    }
    return out;
  }

  private emptyTestAssemblies(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const listAsmdefs = this.opts?.listAsmdefs ?? defaultListAsmdefs;
    const readSources = this.opts?.readTestSources ?? defaultTestSources;

    const empty: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const root = moduleDir(projectPath, moduleRoot);
      // listAsmdefs answers relative to the directory it was given, so the
      // assembly's own folder has to be resolved back against that root.
      for (const asmdefPath of listAsmdefs(root)) {
        const normalized = asmdefPath.replace(/\\/g, "/");
        const fileName = normalized.split("/").pop()!.replace(/\.asmdef$/i, "");
        const name = assemblyNameOf(joinPath(root, normalized), fileName);
        if (!/\.(Editor\.)?Tests$/i.test(name)) continue;

        const slash = normalized.lastIndexOf("/");
        // An .asmdef sitting at the module root would otherwise be credited with
        // the module's entire production code as its "test sources".
        if (slash === -1) continue;
        const dir = joinPath(root, normalized.slice(0, slash));
        if (!existsSync(dir)) continue;

        const sources = readSources(dir);
        if (!sources.some(declaresTest)) empty.push(`${name} (in ${moduleRoot})`);
      }
    }
    return empty;
  }

  /**
   * Module sources past the line limit, worst first.
   *
   * Reads what is on disk, and stays silent when there is nothing to read —
   * the same evidence rule every other check here follows.
   */
  private oversizedSources(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const readSizes = this.opts?.readSourceSizes ?? defaultSourceSizes;

    const oversized: Array<{ label: string; lines: number }> = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const dir = moduleDir(projectPath, moduleRoot);
      if (!existsSync(dir)) continue;

      for (const source of readSizes(dir)) {
        if (source.lines > MAX_SOURCE_LINES) {
          oversized.push({ label: `${source.path} (${source.lines} lines)`, lines: source.lines });
        }
      }
    }

    return oversized
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 5)
      .map((entry) => entry.label);
  }

  private untestedAssemblies(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const listAsmdefs = this.opts?.listAsmdefs ?? defaultListAsmdefs;

    const untested: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const paths = listAsmdefs(moduleDir(projectPath, moduleRoot));
      if (paths.length === 0) continue;

      const root = moduleDir(projectPath, moduleRoot);
      const names = paths.map((p) => {
        const normalized = p.replace(/\\/g, "/");
        const fileName = normalized.split("/").pop()!.replace(/\.asmdef$/i, "");
        return assemblyNameOf(joinPath(root, normalized), fileName);
      });
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
      const entries = listDir(moduleDir(projectPath, moduleRoot));
      // Nothing there is not proof of an incomplete module: a run that deletes
      // a module records its root the same way a run that writes one does, and
      // the only action that clears this gate would be re-creating what the
      // user asked to remove. Every sibling rule here refuses to accuse on
      // absent evidence; this one used to be the exception.
      if (entries.length === 0) continue;

      const missing: string[] = [];
      if (!entries.some((e: string) => /ModuleConfig\.cs$/i.test(e))) missing.push("a *ModuleConfig.cs");
      if (!entries.some((e: string) => /\.asmdef$/i.test(e))) missing.push("an .asmdef");
      if (missing.length > 0) incomplete.push(`${moduleRoot} (missing ${missing.join(" and ")})`);
    }
    return incomplete;
  }

  /**
   * Whether this run left behind a runnable game, or only code.
   *
   * Returns null when the question does not arise: no module code was written,
   * the guard is disabled, or there is no project path to read.
   */
  private assessWiring(): ReturnType<typeof assessSceneWiring> | null {
    if (this.opts?.enabled === false) return null;
    if (!this.wroteProjectCode) return null;
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return null;
    // No Assets directory on disk means there is nothing to read, not that the
    // game is unassembled. The tracked module path came from tool input, which
    // can name a path that was never written — an absent project is the absence
    // of evidence, and this rule accuses only on evidence.
    if (!existsSync(joinPath(projectPath, "Assets"))) return null;
    try {
      return assessSceneWiring(projectPath);
    } catch {
      // An unreadable project is not evidence that the game is unwired.
      return null;
    }
  }

  /**
   * The other gates standing open, named but not spelled out.
   *
   * getPrompt returns one gate, so a run hears about the second problem only
   * after the first closes. Measured 2026-08-21: an agent told to stop
   * reimplementing spent that time building a fourth service-and-system pair
   * for rendering — it never heard that nothing in the project could render at
   * all, because that gate was behind this one.
   */
  private alsoOpen(): string {
    // Only one direction is reachable: the rendering gate is returned first, so
    // a run reaches the reimplementation gate only once views exist and there is
    // nothing left to mention. The reverse — reimplementation still open while
    // nothing renders — is the case measured on 2026-08-21, when an agent told
    // to stop reimplementing spent that time building a fourth
    // service-and-system pair for rendering, never having heard that nothing in
    // the project could render at all.
    return this.assessBypass().length === 0
      ? ""
      : " Also still true, and not fixed by adding views: this project reimplements " +
        "subsystems Strada.Core provides.";
  }

  private assessBypass(): ReturnType<typeof assessFrameworkBypass> {
    if (this.opts?.enabled === false) return [];
    if (!this.wroteProjectCode) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    if (!existsSync(joinPath(projectPath, "Assets"))) return [];
    try {
      return assessFrameworkBypass(projectPath);
    } catch {
      return [];
    }
  }

  private assessViews(): ReturnType<typeof assessViewLayer> | null {
    if (this.opts?.enabled === false) return null;
    if (!this.wroteProjectCode) return null;
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return null;
    if (!existsSync(joinPath(projectPath, "Assets"))) return null;
    try {
      return assessViewLayer(projectPath);
    } catch {
      return null;
    }
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

    // A run that wrote module code and produced no scene delivered a library.
    // Measured: nine modules, fifty C# files and sixteen test assemblies, all
    // compiling, with no .unity, no ScriptableObject asset and no bootstrapper —
    // and it reported success. Every rule above passed, because they all read
    // the shape of code. This one reads the artifacts.
    //
    // Only when the run actually wrote module code: a question about the project
    // owes nobody a scene.
    // A game that is assembled and renders nothing. Measured 2026-08-21 on a
    // delivered project: 85 C# files, 25 prefabs, 44 passing play-mode tests,
    // and zero MonoBehaviours, zero uses of Strada.Core's view layer, one
    // GameObject in the scene. Every service was correct and a player would
    // have seen an empty screen. The tests passed because they call services
    // directly and never go through a scene, so nothing above this line could
    // have caught it.
    const views = this.assessViews();
    // Ahead of the view question: a scene with no camera draws nothing at all,
    // so views would not help. Measured 2026-08-21: every prefab carried a
    // SpriteRenderer and the only scene held one GameObject and no Camera.
    if (views && views.camerslessScenes.length > 0) {
      return (
        "[STRADA NO CAMERA] " +
        `${views.camerslessScenes.join(", ")} holds no Camera, so nothing in it is drawn — ` +
        "not the prefabs, not a view layer, nothing. Every prefab in this project already " +
        "carries a renderer, so this is the first thing between the game and a picture. Add a " +
        "camera to the scene spec you pass to unity_scene_build." +
        this.alsoOpen()
      );
    }
    if (views && !views.hasViews) {
      return (
        "[STRADA NOTHING RENDERS] This project has " +
        `${views.prefabCount} prefab(s) and ${views.scriptCount} script(s), and not one of those ` +
        "scripts derives from MonoBehaviour or touches Strada.Core's view layer. Nothing can put " +
        "a prefab on screen, so nothing is playable — passing tests do not change that, because " +
        "they call services directly and never go through a scene. Strada.Core provides this " +
        "bridge and it is the supported way: Strada.Core.Sync.EntityView (a MonoBehaviour on the " +
        "prefab), EntityMediator and MediatorRegistry to bind an entity to its view, ViewRegistry " +
        "and ViewPool for spawning, ViewSyncRunner to drive them, and Strada.Core.Patterns.View / " +
        "IView for plain non-entity views. Services and systems are deliberately NOT " +
        "MonoBehaviours — do not make them one; add views that observe them. Read the framework " +
        "before writing this: the types above are in Packages/Submodules/Strada.Core/Runtime/Sync " +
        "and Runtime/Patterns." +
        this.alsoOpen()
      );
    }

    // Written its own version of something the framework ships. Measured
    // 2026-08-21: 22 hand-rolled public events against 0 uses of Communication,
    // 37 Debug.Log calls against 0 uses of StradaLog — 6 of Strada.Core's 194
    // public types used at all. The project took SystemBase for a tick,
    // [Inject] for wiring, a ModuleConfig for registration, and wrote a plain
    // C# game inside the shell. Every rule here passed, because none of them
    // asked what the framework was for.
    const bypasses = this.assessBypass();
    if (bypasses.length > 0) {
      return (
        "[STRADA REIMPLEMENTED] This project built its own version of things Strada.Core " +
        "already provides: " +
        bypasses.map((b) => `${b.count} ${b.what} (use ${b.instead})`).join("; ") +
        ". This is not a style note — a hand-rolled equivalent misses what the framework's " +
        "version is wired into: its logging carries module categories and levels the editor " +
        "tools read, its bus is what the module graph and the dependency views are built on. " +
        "Read the subsystem before replacing it; if it genuinely does not fit, say why rather " +
        "than working around it silently." +
        ""
      );
    }

    // Before the broad "not assembled" complaint, the specific one: prefabs that
    // exist and that nothing can reach. It names the file to fix, which the
    // general gate cannot.
    const unbound = this.unboundPrefabConfigs();
    if (unbound.length > 0) {
      return (
        "[STRADA PREFABS UNBOUND] These configs declare prefab fields and no asset instance " +
        `exists for them: ${unbound.join(", ")}. Unity resolves a config to its data through ` +
        "an .asset that points at the script's guid; with no such asset every field is null at " +
        "run time and no prefab will ever be spawned, however many prefabs sit in the project. " +
        "unity_scene_build creates it: its spec takes assets as {id, type, path, fields}, and a " +
        "field of kind \"prefab\" resolves to a saved prefab asset rather than a scene instance. " +
        "Create the asset, assign every prefab field, and give the scene something that reads it. " +
        "Measured: twenty-five prefabs, three GameObject fields, no asset instance, a PlayMode " +
        "suite of 44 passing tests, and one hundred and twenty captured frames that were all the " +
        "same empty sky."
      );
    }

    const wiring = this.assessWiring();
    if (wiring && !wiring.wired) {
      return (
        "[STRADA GAME NOT ASSEMBLED] This run wrote game code but the project is not a " +
        `runnable game: ${wiring.problems.map((p) => p.detail).join("; ")}. ` +
        "A ModuleConfig class does nothing until a ModuleConfig ASSET exists for it, and " +
        "nothing runs until a scene holds a GameBootstrapper whose _gameConfig points at a " +
        "GameBootstrapperConfig listing those assets. Use unity_scene_build with a scene spec; it " +
        "needs no Unity Editor open. The spec must carry three things or it assembles an empty " +
        "scene: an asset of type Strada.Core.Bootstrap.GameBootstrapperConfig, an object with a " +
        "Strada.Core.Bootstrap.GameBootstrapper component, and that component's _gameConfig field " +
        "with kind \"reference\" pointing at the asset id. Measured: a run called the tool twice " +
        "and produced a scene containing no bootstrapper at all, because its spec named neither. " +
        "Anything the game spawns at runtime belongs in the same spec as an object with a " +
        "prefabPath and keepInScene: false. If that tool is not among the ones you have, this " +
        "project's Strada.MCP submodule predates it: say so plainly rather than reporting the " +
        "task complete, because the project still only compiles."
      );
    }

    // A test assembly that contains no test satisfies every rule above: the
    // .asmdef exists, its name matches its module, and the coverage rule is
    // looking for exactly that name. Measured on two full runs — sixteen test
    // assemblies each, and thirty-two of thirty-two directories held zero .cs
    // files. The headless PlayMode run over one of them executed 0 tests and
    // Unity still wrote result="Passed", because nothing failed.
    //
    // Counting the container rather than its contents is the same mistake as
    // counting compile errors without checking that anything compiled.
    const empty = this.emptyTestAssemblies();
    if (empty.length > 0) {
      return (
        "[STRADA TEST ASSEMBLY EMPTY] These test assemblies contain no test at all: " +
        `${empty.join("; ")}. ` +
        "An .asmdef with no [Test] or [UnityTest] beside it compiles to an empty assembly, " +
        "reports zero failures because it runs nothing, and makes the coverage rule pass while " +
        "covering nothing. Write the tests, or delete the assembly and stop claiming it."
      );
    }

    // Strada.Core exists so work can be split — commands, services, models,
    // systems — and a file that outgrows that is a file that stopped using the
    // framework. The limit is a smell threshold, not a style rule: past it, a
    // class is almost always doing several jobs that the pattern set already has
    // homes for.
    const oversized = this.oversizedSources();
    if (oversized.length > 0) {
      return (
        "[STRADA FILE TOO LONG] These files are past " + `${MAX_SOURCE_LINES} lines: ` +
        `${oversized.join("; ")}. ` +
        "Split them the way the framework already divides work: a command per action, a service " +
        "for state and collaboration, a model for data, a system for per-frame work. A command is " +
        "usually the cheapest cut — it takes one action out whole, with its own test."
      );
    }

    const untested = this.untestedAssemblies();
    if (untested.length > 0) {
      return (
        "[STRADA MODULE TESTS MISSING] These assemblies have no test assembly of their own: " +
        `${untested.join("; ")}. ` +
        "Each assembly is its own compilation unit, so each needs its own tests — " +
        "`<Assembly>.Tests` for play-mode and `<Assembly>.Editor.Tests` for edit-mode, each " +
        "referencing only the assembly it tests. Unity allows ONE .asmdef per folder, so give " +
        "each its own directory (Tests/Runtime/<Assembly>/ and Tests/Editor/<Assembly>/); " +
        "several .asmdef files in one folder makes the whole project fail to build. " +
        "One shared test assembly referencing every layer defeats the split: no layer can be " +
        "tested in isolation and a change anywhere rebuilds everything."
      );
    }

    // Assembled, tested and never run. The scene YAML can be perfectly wired
    // and the game still throw on its first frame — measured: breaking a single
    // reference to {fileID: 0} leaves a scene that opens fine and a bootstrapper
    // that logs "No configuration assigned!" the moment it starts.
    //
    // Only asked once the project is actually assembled, because a play-mode run
    // of an unassembled project has nothing to load.
    if (
      !this.attemptedPlaymodeVerification &&
      wiring?.wired === true &&
      this.neverRunGateRaised < NEVER_RUN_GATE_LIMIT
    ) {
      if (this.neverRunGateRaisedAtCall !== this.toolCallsSeen) {
        this.neverRunGateRaised += 1;
        this.neverRunGateRaisedAtCall = this.toolCallsSeen;
      }
      const last = this.neverRunGateRaised === NEVER_RUN_GATE_LIMIT;
      return (
        "[STRADA GAME NEVER RUN] The scene is assembled and wired, but this run never started " +
        "the game. A wired scene is not a running one: a bootstrapper can initialize into a " +
        "module that throws on its first frame, and the scene file reads identically either way. " +
        "Run unity_playmode_verify — it enters play mode with no Editor open and fails on a " +
        "failing test, an exception logged during play, or a run in which nothing executed." +
        (last
          ? " This is the last time this is asked: if the tool is not among the ones you have, " +
            "this project's Strada.MCP submodule predates it, and you should report the game as " +
            "assembled but unverified rather than as done."
          : "")
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
