import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assessSpecScope } from "./spec-scope.js";
import { elementCodeTokens, extractScheduledElements, findDesignDoc } from "./spec-scope.js";
import { createHash } from "node:crypto";
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
/** Every file under a directory, bounded so a stray Library folder cannot hang a check.
 *  With `match`, the budget counts MATCHES, not every file seen — an imported
 *  asset pack must not make generated art invisible by exhausting the budget
 *  on files nobody asked about. Traversal itself stays hard-capped. */
function walkFiles(dir: string, budget = 4000, match?: (file: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && out.length < budget && visited < 60_000) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const full = joinPath(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!match || match(full)) out.push(full);
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
/** Same shape as the sibling above: ask three times, then say it is the last. */
const UNBOUND_PREFABS_GATE_LIMIT = 3;
/** Same shape again: ask three times, then say which was the last. */
const NOTHING_DRAWN_GATE_LIMIT = 3;

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

/** Tools that answer what art the user already owns, before any is made. */
const OWNED_ASSET_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "unity_my_assets",
]);

/**
 * Files that carry art rather than behaviour.
 *
 * Deliberately not `.prefab` or `.mat`: those compose art that already exists,
 * and a run that assembles a bought model into a prefab is doing the right
 * thing. What this catches is a source asset being *originated* — a sprite
 * written out pixel by pixel, a mesh generated — which is the moment the
 * question "does the user already have one of these" stops being answerable.
 */
const ART_SOURCE_EXT: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".tga", ".psd", ".bmp", ".gif", ".exr",
  ".fbx", ".obj", ".blend", ".dae", ".glb", ".gltf",
  ".wav", ".mp3", ".ogg", ".aiff",
]);

/**
 * Asked twice, not three times.
 *
 * The other gates name work the agent must do to clear them. This one names a
 * single read-only lookup, so a run that has heard it twice and still not run
 * it is not going to.
 */
const ASSETS_UNSOURCED_GATE_LIMIT = 2;

/**
 * Per-element art coverage: does every element the GDD schedules have a real
 * visual asset, and is that asset bound into a prefab. Asked twice, like the
 * sibling above — the fix it names is concrete and cheap to attempt.
 *
 * This is the gate for the measured "prefab yapısı sözde oluşturulsa bile
 * sahneler hep boş" failure (PixelFlow, 2026-08-26): code and even prefab
 * FILES existed while no element had art and nothing rendered. SPEC SCOPE
 * checks code against the schedule; this checks the schedule against ART.
 */
const ELEMENT_ASSET_COVERAGE_GATE_LIMIT = 2;

function isArtSourceFile(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  return dotIdx !== -1 && ART_SOURCE_EXT.has(filePath.slice(dotIdx).toLowerCase());
}

/** The guid out of a Unity .meta file, or undefined when unreadable/missing. */
function readGuidFromMeta(metaPath: string): string | undefined {
  try {
    const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(readFileSync(metaPath, "utf8"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

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
  private nothingDrawnRaised = 0;
  private nothingDrawnRaisedAtCall: number | null = null;
  private unboundPrefabsRaised = 0;
  private unboundPrefabsRaisedAtCall: number | null = null;
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
  /** Whether this run asked what art the user already owns. */
  private searchedOwnedAssets = false;
  /** Art files this run originated inside Assets/, newest last. */
  private readonly authoredArtFiles = new Set<string>();
  private assetsUnsourcedRaised = 0;
  private assetsUnsourcedRaisedAtCall: number | null = null;
  private elementAssetCoverageRaised = 0;
  private elementAssetCoverageRaisedAtCall: number | null = null;
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

      if (OWNED_ASSET_SEARCH_TOOLS.has(executedTool.toolName)) {
        // Tracked whether it matched anything or not. "The user owns nothing
        // that fits" is a real answer and clears this gate; the rule asks that
        // the question was put, not that it was answered favourably.
        this.searchedOwnedAssets = true;
      }

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
        if (filePath && isInsideAssets(filePath) && isArtSourceFile(filePath)) {
          this.authoredArtFiles.add(filePath.replace(/\\/g, "/"));
          logGuardWrite(executedTool.toolName, filePath);
        }
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
  /**
   * References in a module's assets that resolve to nothing.
   *
   * Measured 2026-08-22: RenderingModuleConfig.asset carried
   * `_prefabs: {guid: 6813063e...}` while the prefab config it meant to point
   * at had a different guid. The C# turned the resulting null into an empty
   * ScriptableObject — `_prefabs != null ? _prefabs : CreateInstance<...>()` —
   * so the spawner received no prefabs, nothing was logged, and a suite of 44
   * passing tests sat over a game that drew an empty sky.
   *
   * Unity's built-in guids (the all-zero forms carried by every prefab) and
   * anything a package owns are not dangling. Flagging those would bury the one
   * that matters.
   */
  /**
   * Has anything ever been seen on screen?
   *
   * Frames are captured by unity_playmode_verify into <project>/Recordings.
   * Measured across a full session: 120 of them, every one byte-for-byte
   * identical and all of them empty sky, while the suite grew from 33 tests to
   * 54 and reported green throughout. Tests prove the simulation; only a frame
   * proves the game, and nothing here had ever asked for one.
   */
  /**
   * The design document is the checklist. Measured 2026-08-24 (PixelFlow):
   * the GDD schedules sixteen elements in a literal table; runs delivered a
   * subset and called it done because no gate compared code against spec.
   * Fires only after real code exists (module roots touched) so early boots
   * are not nagged.
   */
  private specScopePrompt(): string | null {
    if (this.touchedModuleRoots.size === 0) return null;
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return null;
    if (!existsSync(joinPath(projectPath, "Assets"))) return null;
    try {
      const report = assessSpecScope(projectPath);
      if (report.scheduled === 0 || report.missing.length === 0) return null;
      const names = report.missing
        .slice(0, 8)
        .map((m) => `${m.name} (${m.unlock})`)
        .join(", ");
      const rest = report.missing.length > 8 ? ` — and ${report.missing.length - 8} more` : "";
      return (
        `[STRADA SPEC SCOPE] The design document schedules ${report.scheduled} elements; ` +
        `${report.missing.length} have no implementation in this project: ${names}${rest}. ` +
        `The spec is the contract — a delivery that omits scheduled elements is partial, ` +
        `not done. Implement each in the sim module with its R-rule interactions and a ` +
        `level that showcases it.`
      );
    } catch {
      return null;
    }
  }

  private nothingDrawnReason(): string | null {
    if (this.touchedModuleRoots.size === 0) return null;
    // A game that was never run cannot have frames, and the gate for that says
    // so far better. Only ask about the picture once someone has tried to make
    // one.
    if (!this.attemptedPlaymodeVerification) return null;
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return null;

    const recordings = joinPath(projectPath, "Recordings");
    if (!existsSync(recordings)) return "no frame has ever been captured";
    const frames = walkFiles(recordings, 400).filter((f) => f.endsWith(".png"));
    if (frames.length === 0) return "no frame has ever been captured";

    const digests = new Set<string>();
    for (const frame of frames.slice(0, 60)) {
      try {
        digests.add(createHash("sha1").update(readFileSync(frame)).digest("hex"));
      } catch {
        // An unreadable frame proves nothing either way.
      }
    }
    if (digests.size === 0) return null;
    if (digests.size === 1) return `all ${frames.length} captured frames are identical`;

    // Two ways a game can fake "drawing", both measured on PixelFlow:
    //   1. HUD-only variation — sixty frames differed ONLY by the progress bar
    //      filling over an empty sky (8 distinct of 60 = 13%).
    //   2. Scene-census gaming — a runtime-construction project keeps the scene
    //      YAML minimal by design (the playfield spawns from code), so a bare
    //      renderer census false-flags the architecture itself.
    // The rule that survives both: sampled frames must differ SUBSTANTIVELY
    // (>= 25% distinct digests) AND, when the scene is too sparse to explain
    // that variety, the sparsity is named instead of silently accepted.
    const sampled = Math.min(frames.length, 60);
    const distinctRatio = digests.size / sampled;
    if (distinctRatio >= 0.25) return null;
    const census = countSceneRenderersImpl(projectPath);
    return (
      `frames vary too little to prove drawing: ${digests.size}/${sampled} distinct ` +
      `(${Math.round(distinctRatio * 100)}%); the scene instantiates ` +
      `${census.gameObjects} GameObject(s) and ${census.renderers} renderer(s) — ` +
      `a playfield (board cubes, tray, conveyor, pigs) was never added to what the camera sees`
    );
  }

  /**
   * Census of renderers across the project's scenes (build-included first).
   *
   * Counts MeshRenderer/SpriteRenderer occurrences and top-level GameObjects
   * in scene YAML. Cheap text census, not a Unity import — enough to tell a
   * playfield from a skybox with a progress bar on it.
   */

  private danglingAssetReferences(): string[] {
    if (this.touchedModuleRoots.size === 0) return [];
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return [];
    const assetsRoot = joinPath(projectPath, "Assets");
    if (!existsSync(assetsRoot)) return [];

    const known = new Set<string>();
    for (const base of [assetsRoot, joinPath(projectPath, "Packages")]) {
      if (!existsSync(base)) continue;
      for (const file of walkFiles(base)) {
        if (!file.endsWith(".meta")) continue;
        try {
          const g = /guid:\s*([a-f0-9]{32})/u.exec(readFileSync(file, "utf8"))?.[1];
          if (g) known.add(g);
        } catch {
          // Unreadable meta: cannot learn its guid, so cannot judge it.
        }
      }
    }
    if (known.size === 0) return [];

    const out: string[] = [];
    for (const moduleRoot of this.touchedModuleRoots) {
      const root = moduleDir(projectPath, moduleRoot);
      if (!existsSync(root)) continue;
      for (const file of walkFiles(root)) {
        if (!file.endsWith(".asset")) continue;
        let body: string;
        try {
          body = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const missing = new Set<string>();
        for (const m of body.matchAll(/guid:\s*([a-f0-9]{32})/gu)) {
          const g = m[1]!;
          // Unity's built-in resources use an all-zero guid with one nibble set.
          if (/^0{16}[0-9a-f]0{15}$/u.test(g)) continue;
          if (!known.has(g)) missing.add(g);
        }
        if (missing.size > 0) {
          const name = file.split(/[/\\]/u).pop()?.replace(/\.asset$/u, "") ?? file;
          out.push(`${name} -> ${[...missing].map((g) => g.slice(0, 8)).join(", ")}`);
        }
      }
    }
    return out;
  }

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

  /**
   * Conditions that must hold before this work counts as delivered, and do not.
   *
   * Separate from getPrompt() on purpose. A gate is an ASK, and an ask has to be
   * able to give up — three refusals and it goes quiet, or it stops being a rule
   * and becomes a loop. Going quiet was then read as satisfied: measured on run
   * 52, [STRADA NOTHING DRAWN] fired three times, fell silent on the fourth, and
   * the run finished `failed: false` with a 123-character success message for a
   * game whose sixty captured frames were identical. The gate's own last words
   * are "say the game does not render rather than reporting it as delivered",
   * and nothing checked whether that happened.
   *
   * So the budget governs how often the agent is ASKED, and this governs what
   * may be CLAIMED. It never goes quiet, and it costs no extra turn — it is read
   * once, where a run would otherwise report success.
   */
  /**
   * Why this run should look at what the user already owns, if it should.
   *
   * The first version of this gate keyed on art being ORIGINATED — a sprite
   * written out, a mesh generated — on the theory that the moment to ask "does
   * the user already have one of these" is just before making one.
   *
   * Run 52 showed that theory is half the problem. The agent originated no art
   * at all: it wrote fifteen C# files, seven assembly definitions, six
   * ScriptableObjects, a scene, and zero sprites, zero prefabs, zero meshes.
   * Then it played the game and captured sixty identical frames. The gate never
   * fired, because nothing triggered it, and both the silence and the empty
   * scene looked correct.
   *
   * So there are two ways to arrive here and only one was covered. The second —
   * a game that has been assembled and run and has nothing in it to draw — is
   * the one that actually happened, and it is the one [STRADA NOTHING DRAWN]
   * reports the symptom of without ever naming the cause.
   */
  private assetsUnsourcedReason(): string | null {
    if (this.searchedOwnedAssets) return null;

    if (this.authoredArtFiles.size > 0) {
      const made = [...this.authoredArtFiles];
      return (
        `this run originated ${made.length} art file(s) without ever asking what the user ` +
        `already owns: ${made.slice(0, 5).join(", ")}` +
        (made.length > 5 ? `, and ${made.length - 5} more` : "")
      );
    }

    // Only once the game has been assembled AND run. Before that the missing art
    // is not yet a finding — a project mid-build is allowed to have nothing in
    // it, and the gates for "not assembled" and "never run" say that better.
    if (!this.wroteProjectCode || !this.attemptedPlaymodeVerification) return null;
    if (this.projectVisualAssetCount() > 0) return null;

    return (
      "this game has been assembled and played, and contains no art whatsoever — " +
      "no sprite, no mesh, no prefab — so there is nothing in it to draw"
    );
  }

  /**
   * Per-element art coverage against the design document's element schedule.
   *
   * For every scheduled element: (1) an art source file under Assets/ whose
   * name matches the element, (2) a prefab/asset/scene file that references
   * that art file's guid — the binding chain without which the sprite sits on
   * disk and draws nothing. Returns the gap list, or null when covered (or
   * when the run is too early to judge: no code yet, or never run).
   */
  private elementAssetCoverageReason(): string | null {
    if (!this.wroteProjectCode || !this.attemptedPlaymodeVerification) return null;
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return null;

    let elements;
    try {
      const docPath = findDesignDoc(projectPath);
      if (!docPath) return null;
      elements = extractScheduledElements(readFileSync(docPath, "utf8"));
    } catch {
      return null;
    }
    if (elements.length === 0) return null;

    const assetsRoot = joinPath(projectPath, "Assets");
    if (!existsSync(assetsRoot)) return elements.length > 0 ? `no Assets/ folder exists, so none of the ${elements.length} scheduled elements has art` : null;

    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const BIND_TARGET_RE = /\.(prefab|asset|unity|mat|controller|playable)$/i;
    // ONE budgeted walk, filtered inside so the budget counts relevant files —
    // an imported Asset Store pack must not hide generated art behind the cap.
    const relevantFiles = walkFiles(
      assetsRoot,
      12_000,
      (f) => isArtSourceFile(f) || BIND_TARGET_RE.test(f),
    );
    const artFiles = relevantFiles.filter((f) => isArtSourceFile(f));
    const artNames = artFiles.map((f) => {
      const base = f.replace(/\\/g, "/").split("/").pop() ?? f;
      return norm(base.replace(/\.[^.]+$/, ""));
    });
    const bindTargets = relevantFiles.filter((f) => BIND_TARGET_RE.test(f));

    // Every guid any bind target references, read ONCE — the old code re-read
    // every prefab/asset/scene in full for every element (O(elements × files)
    // of synchronous I/O per turn).
    const referencedGuids = new Set<string>();
    for (const file of bindTargets) {
      try {
        for (const m of readFileSync(file, "utf8").matchAll(/guid: ([0-9a-f]{32})/gi)) {
          referencedGuids.add(m[1]!.toLowerCase());
        }
      } catch {
        // Unreadable bind target says nothing.
      }
    }
    const artGuids = new Set(
      artFiles
        .map((f) => readGuidFromMeta(`${f}.meta`)?.toLowerCase())
        .filter((g): g is string => Boolean(g)),
    );

    const missingArt: string[] = [];
    const unboundArt: string[] = [];
    for (const el of elements) {
      const tokens = elementCodeTokens(el.name).map(norm).filter(Boolean);
      const matchIdx = artNames.findIndex((n) => tokens.some((t) => n.includes(t)));
      if (matchIdx === -1) {
        // No art file NAMED after the element — but sourced (purchased) art
        // rarely is: an element "Pig" satisfied by Boar_cub_IP.fbx matches no
        // token. Before accusing, check whether a prefab/scene NAMED after the
        // element references ANY art guid: bound art under a different name
        // is coverage, not a gap.
        const elementBindTargets = bindTargets.filter((f) => {
          const base = norm((f.replace(/\\/g, "/").split("/").pop() ?? f).replace(/\.[^.]+$/, ""));
          return tokens.some((t) => base.includes(t));
        });
        const boundViaGuid = elementBindTargets.some((file) => {
          try {
            const text = readFileSync(file, "utf8");
            for (const m of text.matchAll(/guid: ([0-9a-f]{32})/gi)) {
              if (artGuids.has(m[1]!.toLowerCase())) return true;
            }
          } catch {
            // Unreadable — no evidence either way.
          }
          return false;
        });
        if (!boundViaGuid) missingArt.push(el.name);
        continue;
      }
      const guid = readGuidFromMeta(`${artFiles[matchIdx]!}.meta`);
      if (!guid) continue; // Unreadable meta: cannot prove unbound, do not accuse.
      if (!referencedGuids.has(guid.toLowerCase())) unboundArt.push(el.name);
    }

    if (missingArt.length === 0 && unboundArt.length === 0) return null;
    const parts: string[] = [];
    if (missingArt.length > 0) {
      parts.push(
        `${missingArt.length} scheduled element(s) have NO art asset at all: ${missingArt.slice(0, 8).join(", ")}` +
          (missingArt.length > 8 ? ` and ${missingArt.length - 8} more` : ""),
      );
    }
    if (unboundArt.length > 0) {
      parts.push(
        `${unboundArt.length} element(s) have art that no prefab/asset/scene references (it draws nothing): ${unboundArt.slice(0, 8).join(", ")}` +
          (unboundArt.length > 8 ? ` and ${unboundArt.length - 8} more` : ""),
      );
    }
    return parts.join("; ");
  }

  /**
   * Art the project can actually render: source images and meshes, plus the
   * prefabs that place them.
   *
   * Counted under Assets/ only. The framework packages under Packages/ ship
   * their own art, and counting it would let a project with an empty Assets/
   * folder claim it has something to show.
   */
  private projectVisualAssetCount(): number {
    const projectPath = this.opts?.projectPath;
    if (!projectPath) return 1; // Unknown project: never accuse it of being empty.

    const assets = joinPath(projectPath, "Assets");
    if (!existsSync(assets)) return 0;
    return walkFiles(assets, 4000).filter(
      (f) => isArtSourceFile(f) || f.toLowerCase().endsWith(".prefab"),
    ).length;
  }

  unmetDeliveryConditions(): readonly string[] {
    const unmet: string[] = [];
    const notDrawn = this.nothingDrawnReason();
    if (notDrawn !== null) {
      unmet.push(`the game has never been observed to render: ${notDrawn}`);
    }
    return unmet;
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
    // A reference that resolves to nothing, before the broader complaints. The
    // config exists and looks assigned; only the guid says otherwise.
    const dangling = this.danglingAssetReferences();
    if (dangling.length > 0) {
      return (
        "[STRADA REFERENCE DANGLING] These assets reference a guid that no asset in this " +
        `project has: ${dangling.join("; ")}. Unity resolves such a field to null, and a config ` +
        "written as `_field != null ? _field : CreateInstance<...>()` turns that null into an " +
        "empty object silently — no error, no warning, and nothing spawned at run time. Point the " +
        "field at the asset that exists, or create the asset the guid names. Measured: a project " +
        "with 44 of 44 tests passing drew an empty sky because one reference pointed at a guid " +
        "that had never existed."
      );
    }


    const unbound = this.unboundPrefabConfigs();
    if (unbound.length > 0 && this.unboundPrefabsRaised < UNBOUND_PREFABS_GATE_LIMIT) {
      if (this.unboundPrefabsRaisedAtCall !== this.toolCallsSeen) {
        this.unboundPrefabsRaised += 1;
        this.unboundPrefabsRaisedAtCall = this.toolCallsSeen;
      }
      const lastAsk = this.unboundPrefabsRaised === UNBOUND_PREFABS_GATE_LIMIT;
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
          "same empty sky." +
          (lastAsk
            ? " This is the last time this is asked. If it is still unbound when you finish, the " +
              "game does not render and must be reported that way rather than as delivered."
            : "")
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

    // Before the outcome gates, because this one is cheapest to clear and the
    // only one whose window closes: once the art exists, the question of whether
    // the user already had it has stopped being worth asking.
    const unsourced = this.assetsUnsourcedReason();
    if (unsourced !== null && this.assetsUnsourcedRaised < ASSETS_UNSOURCED_GATE_LIMIT) {
      if (this.assetsUnsourcedRaisedAtCall !== this.toolCallsSeen) {
        this.assetsUnsourcedRaised += 1;
        this.assetsUnsourcedRaisedAtCall = this.toolCallsSeen;
      }
      const lastAsk = this.assetsUnsourcedRaised === ASSETS_UNSOURCED_GATE_LIMIT;
      return (
        `[STRADA ASSETS UNSOURCED] ${unsourced}. ` +
        "Run unity_my_assets — it searches the Asset Store packages already downloaded on this " +
        "machine, needs no Editor, no login and no network, and reports what is inside each " +
        "package rather than only its name. A model the user bought beats one that has to be " +
        "made, and measured on this project an owned 3D vehicle package holding two .fbx meshes " +
        "sat unread on disk while the scene shipped empty." +
        (lastAsk
          ? " This is the last time this is asked. If the tool is not among the ones you have, " +
            "this project's Strada.MCP submodule predates it — say so rather than shipping a " +
            "scene with nothing in it."
          : "")
      );
    }

    // Per-element art coverage: a run can clear "assets sourced" and "frames
    // differ" while its scheduled elements have no sprites at all — measured
    // (PixelFlow, 2026-08-26): prefab structures existed on paper, scenes
    // stayed empty, and no gate ever forced the target game's own assets to
    // exist. SPEC SCOPE checks code against the schedule; this gate checks
    // the schedule against ART — each element needs a sprite that exists AND
    // is bound into something that renders it.
    const coverage = this.elementAssetCoverageReason();
    if (coverage !== null && this.elementAssetCoverageRaised < ELEMENT_ASSET_COVERAGE_GATE_LIMIT) {
      if (this.elementAssetCoverageRaisedAtCall !== this.toolCallsSeen) {
        this.elementAssetCoverageRaised += 1;
        this.elementAssetCoverageRaisedAtCall = this.toolCallsSeen;
      }
      const lastAsk = this.elementAssetCoverageRaised === ELEMENT_ASSET_COVERAGE_GATE_LIMIT;
      return (
        `[STRADA ELEMENT ASSETS MISSING] ${coverage}. ` +
        "The design's element schedule is the contract for what must be VISIBLE, not only " +
        "implemented. For each named element: first run unity_my_assets for art the user " +
        "already owns; when nothing fits, generate with the tool that matches the element's " +
        "layer — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for " +
        "dimensional ones (the GDD's 'softly rendered dimensional stages' and 'plump, glossy " +
        "3D-feel' characters are NOT sprites) — then bind the asset into the element's prefab " +
        "(a SpriteRenderer's sprite field, a MeshFilter's mesh, a config asset's reference). " +
        "An asset on disk that nothing references is the same as no asset." +
        (lastAsk
          ? " This is the last time this is asked. If elements still have no bound art when " +
            "you finish, report the game as partially delivered and say which elements are invisible."
          : "")
      );
    }

    // Last, because it is the least specific complaint: every gate above names
    // something to fix, while this one only knows the outcome. Placed earlier it
    // shadowed all of them.
    const notDrawn = this.nothingDrawnReason();
    if (notDrawn !== null && this.nothingDrawnRaised < NOTHING_DRAWN_GATE_LIMIT) {
      if (this.nothingDrawnRaisedAtCall !== this.toolCallsSeen) {
        this.nothingDrawnRaised += 1;
        this.nothingDrawnRaisedAtCall = this.toolCallsSeen;
      }
      const lastAsk = this.nothingDrawnRaised === NOTHING_DRAWN_GATE_LIMIT;
      return (
        this.specScopePrompt() ??
        `[STRADA NOTHING DRAWN] This game has never been observed to render: ${notDrawn}. ` +
        "A passing suite proves the simulation, not the picture — measured on this project, 54 " +
        "tests went green while all 120 captured frames were the same empty sky. Run " +
        "unity_playmode_verify with captureFrames set, then read what came back: frames that are " +
        "all identical, or one flat colour, mean nothing is being drawn however many tests pass. " +
        "Start a level the design describes, capture, and check the frames differ from each other." +
        (lastAsk
          ? " This is the last time this is asked. If no frame has differed by the time you " +
            "finish, say the game does not render rather than reporting it as delivered."
          : "")
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

/** A believable playfield instantiates at least this many renderers. */
export const MIN_PLAYFIELD_RENDERERS = 6;

/** Text census of renderers across a project's scenes. Exported for tests. */
export function countSceneRenderersImpl(projectPath: string): {
  scenes: number;
  gameObjects: number;
  renderers: number;
} {
  const scenesDir = joinPath(projectPath, "Assets", "Scenes");
  const files = existsSync(scenesDir)
    ? walkFiles(scenesDir).filter((f) => f.endsWith(".unity"))
    : [];
  let gameObjects = 0;
  let renderers = 0;
  let scenes = 0;
  for (const scene of files.slice(0, 6)) {
    try {
      const body = readFileSync(scene, "utf8");
      scenes += 1;
      gameObjects += (body.match(/^--- !u!1 &/gm) ?? []).length;
      renderers += (body.match(/^--- !u!(?:212|23) &/gm) ?? []).length;
    } catch {
      // Unreadable scene: not evidence of anything.
    }
  }
  return { scenes, gameObjects, renderers };
}
