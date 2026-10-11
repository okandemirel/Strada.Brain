/**
 * What a module's folders are is declared once, in Strada.Core.
 *
 * The framework's module layout holds the list the Unity generator builds from.
 * strada_create_module kept its own copy of that list, and the copy drifted: it
 * created Scripts/Mediators, which the framework never declared; it created
 * neither Scripts/Interfaces nor Scripts/Editor, which the framework does; and
 * it flattened Scripts/Data, which the framework splits into UnityObjects and
 * ValueObjects. Every one of those was invisible until a module built by the
 * agent was compared to one built in Unity.
 *
 * So read the declaration instead of restating it. When Strada.Core adds a
 * folder, the agent's modules get it with no change here.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

/** One folder entry of Strada.Core's module layout. */
export interface DeclaredFolder {
  /** Module-relative path, e.g. "Scripts/Services". */
  path: string;
  /** Created for every module, whatever components were selected. */
  mandatory: boolean;
  /** Created only when explicitly asked for. */
  optional: boolean;
  /** ComponentType name that turns this folder on, e.g. "Service". */
  component: string | null;
}

/** The layout an installed Strada.Core declares, and the file it came from. */
export interface DeclaredLayout {
  /** Absolute path of the file the folders were read from. */
  file: string;
  folders: DeclaredFolder[];
  /**
   * ComponentType → the ComponentType whose folder its files go into, for the
   * components that do not own one (Signals → Events). null is the module's
   * code root. Empty for a framework that declares no sharing.
   */
  folderOwners: ReadonlyMap<string, string | null>;
}

/** Where the installed framework lives. */
export const CORE_INSTALL_PATH = "Packages/Submodules/Strada.Core";

/**
 * The files inside it that may declare the layout, newest home first; the first
 * that lists any folder is the declaration. Strada.Core moved the list out of
 * DirectoryStructureConfig.cs into `ModuleLayout.DefaultEntries()` and left the
 * config with only a call to it, so reading the old file alone found nothing in
 * a framework that was plainly installed. Both are kept so a project pinned to
 * either Strada.Core works.
 */
export const LAYOUT_DECLARATION_FILES: readonly string[] = [
  "Editor/ModuleGenerator/Config/ModuleLayout.cs",
  "Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs",
];

// One `new FolderEntry { ... }` per line in the declaration. Anything the
// framework adds to an entry that we do not read is simply ignored, so a new
// field there does not break module creation here.
const ENTRY_RE = /new\s+FolderEntry\s*\{([^}]*)\}/g;
const PATH_RE = /Path\s*=\s*"([^"]+)"/;
const MANDATORY_RE = /IsMandatory\s*=\s*true/;
const OPTIONAL_RE = /IsOptional\s*=\s*true/;
const COMPONENT_RE = /RequiredComponent\s*=\s*ComponentType\.(\w+)/;

/** Parse the folder list out of a declaration source. */
export function parseDeclaredFolders(source: string): DeclaredFolder[] {
  const folders: DeclaredFolder[] = [];
  for (const match of source.matchAll(ENTRY_RE)) {
    const body = match[1] ?? "";
    const path = PATH_RE.exec(body)?.[1];
    if (!path) continue;
    const component = COMPONENT_RE.exec(body)?.[1] ?? null;
    folders.push({
      path,
      mandatory: MANDATORY_RE.test(body),
      optional: OPTIONAL_RE.test(body),
      // ComponentType.None is the enum's "not set" member, not a component.
      component: component && component !== "None" ? component : null,
    });
  }
  return folders;
}

// `ModuleLayout.FolderOwner(ComponentType)`: a switch whose arms send a
// component to the one whose folder it shares. Only that method's own body is
// read — the same file has other ComponentType switches (IsSelected) that say
// nothing about folders, and a switch with no `default:` used to run on into
// them. Both forms C# allows are read: statement arms (`case A: case B:` or
// `case A or B:`, then `return ComponentType.X;`) and expression arms
// (`A or B => ComponentType.X`). Read as statements only, a FolderOwner
// rewritten as a switch expression came back empty.
const OWNER_METHOD_RE = /\bFolderOwner\s*\(\s*ComponentType\s+\w+\s*\)/;
const STATEMENT_ARM_RE = /((?:case\s+[^:;{}]+:\s*)+)return\s+ComponentType\.(\w+)\s*;/g;
const EXPRESSION_ARM_RE = /((?:ComponentType\.\w+\s*(?:or\s+)?)+)=>\s*ComponentType\.(\w+)/g;
const CASE_RE = /ComponentType\.(\w+)/g;

/** The body of the method whose signature ends at `from`: up to its closing brace or `;`. */
function methodBody(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(from, i + 1);
    else if (ch === ";" && depth === 0) return source.slice(from, i + 1);
  }
  return source.slice(from);
}

/** Parse which components file into another's folder; empty when none is declared. */
export function parseFolderOwners(source: string): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  const start = OWNER_METHOD_RE.exec(source);
  if (!start) return owners;
  const body = methodBody(source, start.index + start[0].length);
  for (const arm of [...body.matchAll(STATEMENT_ARM_RE), ...body.matchAll(EXPRESSION_ARM_RE)]) {
    const owner = arm[2] === "None" ? null : (arm[2] ?? null);
    for (const [, component] of (arm[1] ?? "").matchAll(CASE_RE)) {
      if (component && component !== owner) owners.set(component, owner);
    }
  }
  return owners;
}

/** File access, injectable so a notice can be tested without a project on disk. */
export interface LayoutFs {
  exists(path: string): boolean;
  read(path: string): string;
}
const NODE_FS: LayoutFs = { exists: existsSync, read: (path) => readFileSync(path, "utf-8") };

// "unreadable" is a framework that is there but whose layout this reader cannot
// follow; `reason` says what each candidate file lacked. "incomplete" is a
// framework directory holding none of the candidate files at all — what a
// clone made without --recursive leaves: an empty submodule directory.
// Calling that "installed" sent the agent looking for a layout format problem
// when the checkout had simply never happened.
export type LayoutLookup =
  | { status: "declared"; layout: DeclaredLayout }
  | { status: "not-installed" }
  | { status: "incomplete" }
  | { status: "unreadable"; reason: string };

/** Read the layout a Strada.Core checkout rooted at `coreRoot` declares. */
export function readLayoutAt(coreRoot: string, fs: LayoutFs = NODE_FS): LayoutLookup {
  if (!fs.exists(coreRoot)) return { status: "not-installed" };
  const problems: string[] = [];
  let anyFound = false;
  for (const relative of LAYOUT_DECLARATION_FILES) {
    const file = join(coreRoot, relative);
    if (!fs.exists(file)) {
      problems.push(`${relative}: not found`);
      continue;
    }
    anyFound = true;
    let source: string;
    try {
      source = fs.read(file);
    } catch {
      problems.push(`${relative}: could not be read`);
      continue;
    }
    const folders = parseDeclaredFolders(source);
    if (folders.length === 0) {
      problems.push(`${relative}: lists no folder entries`);
      continue;
    }
    return { status: "declared", layout: { file, folders, folderOwners: parseFolderOwners(source) } };
  }
  if (!anyFound) return { status: "incomplete" };
  return { status: "unreadable", reason: problems.join("; ") };
}

/** What to do about a framework directory whose checkout never finished. */
export const INCOMPLETE_CHECKOUT_HINT =
  `none of its module layout files (${LAYOUT_DECLARATION_FILES.map((f) => basename(f)).join(", ")}) ` +
  "are there, as with a submodule that was never checked out — run " +
  "`git submodule update --init --recursive` in the project";

/**
 * Read the layout the Strada.Core installed in this project declares.
 *
 * Callers must not invent a structure when it is not "declared": a module whose
 * shape the framework never agreed to is the failure this module exists to
 * prevent.
 */
export function readModuleLayout(projectPath: string, fs: LayoutFs = NODE_FS): LayoutLookup {
  return readLayoutAt(join(projectPath, CORE_INSTALL_PATH), fs);
}

/** The declared folders, or null when the framework is absent or its layout unreadable. */
export function readDeclaredModuleFolders(projectPath: string): DeclaredFolder[] | null {
  const lookup = readModuleLayout(projectPath);
  return lookup.status === "declared" ? lookup.layout.folders : null;
}

/** The file this project's layout is read from, or null when there is none to read. */
export function declarationPathFor(projectPath: string): string | null {
  const lookup = readModuleLayout(projectPath);
  return lookup.status === "declared" ? lookup.layout.file : null;
}

/**
 * The folder a component's files go into: its own, or the one its owner
 * declares. null when the layout has no folder for it at all.
 */
export function folderForComponent(
  layout: Pick<DeclaredLayout, "folders" | "folderOwners">,
  component: string,
): string | null {
  const owner = layout.folderOwners.has(component)
    ? (layout.folderOwners.get(component) ?? null)
    : component;
  const entry =
    owner === null
      ? layout.folders.find((f) => f.mandatory)
      : layout.folders.find((f) => f.component === owner);
  return entry?.path ?? null;
}

/**
 * The folders a module gets, given which components it was asked for.
 *
 * - mandatory: always
 * - component-gated: when that component, or one that files into its folder,
 *   was selected
 * - optional: only when named in `optionalFolders`; naming a parent ("Art")
 *   selects everything declared beneath it ("Art/Models", "Art/Textures", …),
 *   because that is how an author thinks about an asset folder.
 */
export function foldersForModule(
  declared: DeclaredFolder[],
  selectedComponents: ReadonlySet<string>,
  optionalFolders: readonly string[] = [],
  folderOwners: ReadonlyMap<string, string | null> = new Map(),
): string[] {
  const wanted = new Set(optionalFolders.map((f) => f.replace(/\/+$/, "")));
  const isWanted = (path: string): boolean =>
    wanted.has(path) || [...wanted].some((w) => path.startsWith(`${w}/`));
  // Selecting Signals where the layout files them with Events needs the Events
  // folder; without this, asking for signals created nothing.
  const needed = new Set<string>();
  for (const component of selectedComponents) {
    const owner = folderOwners.has(component) ? folderOwners.get(component) : component;
    if (owner) needed.add(owner);
  }

  const paths: string[] = [];
  for (const folder of declared) {
    if (folder.mandatory) paths.push(folder.path);
    else if (folder.component) {
      if (needed.has(folder.component)) paths.push(folder.path);
    } else if (folder.optional && isWanted(folder.path)) paths.push(folder.path);
  }
  return paths;
}

/** Declared optional folders, for telling an author what they may ask for. */
export function optionalFolderPaths(declared: DeclaredFolder[]): string[] {
  return declared.filter((f) => f.optional && !f.component).map((f) => f.path);
}

/**
 * One-line framework-presence status for startup notices.
 *
 * Measured 2026-08-23 (PixelFlow run): nothing told a run AT START that the
 * target was a Strada.Core project — the agent discovered the framework only
 * by tripping over strada_create_module's error, and one earlier run built a
 * vanilla dotnet project beside it instead. The runtime knows this fact the
 * moment it resolves UNITY_PROJECT_PATH; now it says so, on every channel.
 *
 * It reads the layout the same way strada_create_module does, so the notice
 * cannot announce a framework the tool then refuses to build modules in.
 *
 * Returns null when there is no Unity project configured.
 */
export function describeFrameworkInstall(
  projectPath: string | undefined,
  fs: LayoutFs = NODE_FS,
): string | null {
  if (!projectPath) return null;
  const lookup = readModuleLayout(projectPath, fs);
  if (lookup.status === "declared") {
    return (
      "Strada.Core framework detected at " + CORE_INSTALL_PATH +
      " — this is a Strada project: build game code as Strada modules with the " +
      "strada_create_* tools, and read the framework's Runtime/ sources before " +
      "writing anything a framework subsystem already provides."
    );
  }
  // Only module creation is blocked by an unreadable layout; the framework is
  // there, and building beside it instead of on it is what this notice exists
  // to prevent — so the guidance stays.
  if (lookup.status === "unreadable") {
    return (
      "Strada.Core is installed at " + CORE_INSTALL_PATH +
      " — this is a Strada project: build game code as Strada modules, and read the framework's " +
      "Runtime/ sources before writing anything a framework subsystem already provides. Its module " +
      "layout could not be read (" + lookup.reason + "), so strada_create_module will refuse until it can be."
    );
  }
  if (lookup.status === "incomplete") {
    return (
      "Strada.Core directory present at " + CORE_INSTALL_PATH + ", but the framework checkout is incomplete: " +
      INCOMPLETE_CHECKOUT_HINT + ". Even so, this is a Strada project: complete the checkout before " +
      "building game code, since the game is built on the framework and strada_create_module refuses until then."
    );
  }
  return (
    "No Strada.Core at " + CORE_INSTALL_PATH + " — strada_create_module and friends will refuse " +
    "until the framework is installed there."
  );
}
