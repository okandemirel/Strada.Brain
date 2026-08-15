/**
 * What a module's folders are is declared once, in Strada.Core.
 *
 * `Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs` holds the list the
 * Unity generator builds from. strada_create_module kept its own copy of that
 * list, and the copy drifted: it created Scripts/Mediators, which the framework
 * never declared; it created neither Scripts/Interfaces nor Scripts/Editor,
 * which the framework does; and it flattened Scripts/Data, which the framework
 * splits into UnityObjects and ValueObjects. Every one of those was invisible
 * until a module built by the agent was compared to one built in Unity.
 *
 * So read the declaration instead of restating it. When Strada.Core adds a
 * folder, the agent's modules get it with no change here.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** One entry of Strada.Core's DirectoryStructureConfig folder list. */
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

/** Where the installed framework lives, and where it declares the structure. */
export const CORE_INSTALL_PATH = "Packages/Submodules/Strada.Core";
const DECLARATION_PATH = "Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs";

export function declarationPathFor(projectPath: string): string {
  return join(projectPath, CORE_INSTALL_PATH, DECLARATION_PATH);
}

// One `new FolderEntry { ... }` per line in the declaration. Anything the
// framework adds to an entry that we do not read is simply ignored, so a new
// field there does not break module creation here.
const ENTRY_RE = /new\s+FolderEntry\s*\{([^}]*)\}/g;
const PATH_RE = /Path\s*=\s*"([^"]+)"/;
const MANDATORY_RE = /IsMandatory\s*=\s*true/;
const OPTIONAL_RE = /IsOptional\s*=\s*true/;
const COMPONENT_RE = /RequiredComponent\s*=\s*ComponentType\.(\w+)/;

/** Parse the folder list out of a DirectoryStructureConfig.cs source. */
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

/**
 * Read the declared structure from the Strada.Core installed in this project.
 *
 * Returns null when the framework is not installed. Callers must not invent a
 * structure in that case: a module whose shape the framework never agreed to is
 * the failure this module exists to prevent.
 */
export function readDeclaredModuleFolders(projectPath: string): DeclaredFolder[] | null {
  const declaration = declarationPathFor(projectPath);
  if (!existsSync(declaration)) return null;
  try {
    const folders = parseDeclaredFolders(readFileSync(declaration, "utf-8"));
    return folders.length > 0 ? folders : null;
  } catch {
    // An unreadable declaration is not a licence to guess.
    return null;
  }
}

/**
 * The folders a module gets, given which components it was asked for.
 *
 * - mandatory: always
 * - component-gated: when that component was selected
 * - optional: only when named in `optionalFolders`; naming a parent ("Art")
 *   selects everything declared beneath it ("Art/Models", "Art/Textures", …),
 *   because that is how an author thinks about an asset folder.
 */
export function foldersForModule(
  declared: DeclaredFolder[],
  selectedComponents: ReadonlySet<string>,
  optionalFolders: readonly string[] = [],
): string[] {
  const wanted = new Set(optionalFolders.map((f) => f.replace(/\/+$/, "")));
  const isWanted = (path: string): boolean =>
    wanted.has(path) || [...wanted].some((w) => path.startsWith(`${w}/`));

  const paths: string[] = [];
  for (const folder of declared) {
    if (folder.mandatory) paths.push(folder.path);
    else if (folder.component) {
      if (selectedComponents.has(folder.component)) paths.push(folder.path);
    } else if (folder.optional && isWanted(folder.path)) paths.push(folder.path);
  }
  return paths;
}

/** Declared optional folders, for telling an author what they may ask for. */
export function optionalFolderPaths(declared: DeclaredFolder[]): string[] {
  return declared.filter((f) => f.optional && !f.component).map((f) => f.path);
}
