/**
 * Unity .meta file management utilities.
 * Handles GUID generation, .meta file creation, and Unity project detection.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, relative, sep } from "node:path";

/**
 * Generate a Unity-compatible GUID (32 lowercase hex characters).
 * Uses crypto.randomUUID() and strips dashes.
 */
export function generateUnityGuid(): string {
  return randomUUID().replaceAll("-", "").toLowerCase();
}

/**
 * Reuse the guid of an existing .meta, or mint a fresh one.
 *
 * Regenerating an asset must NOT change its guid: guids are Unity's identity,
 * and a fresh one on every write silently orphaned every prefab/scene binding
 * to the previous version — the asset coverage gate then accused the agent of
 * never binding art it had bound.
 */
export function reuseOrMintGuid(metaFilePath: string): string {
  try {
    const match = /guid:\s*([0-9a-f]{32})/i.exec(readFileSync(metaFilePath, "utf8"));
    if (match) return match[1]!.toLowerCase();
  } catch {
    // No existing meta — mint below.
  }
  return generateUnityGuid();
}

/** Get the .meta file path for a given file or directory path. */
export function metaPathFor(filePath: string): string {
  return filePath + ".meta";
}

/**
 * Check if a directory looks like a Unity project.
 * A Unity project has both Assets/ and ProjectSettings/ directories.
 */
export async function isUnityProject(projectPath: string): Promise<boolean> {
  const assetsPath = normalize(projectPath + sep + "Assets");
  const projectSettingsPath = normalize(projectPath + sep + "ProjectSettings");

  try {
    await Promise.all([access(assetsPath), access(projectSettingsPath)]);
    return true;
  } catch {
    return false;
  }
}

/** Directories inside a Unity project that should be skipped during asset scanning. */
export const UNITY_EXCLUDED_DIRS = new Set(["Library", "Temp", "Logs", "obj", "Builds"]);

/**
 * The roots a project path can appear under: as given, and resolved through
 * symlinks. Measured 2026-09-08 03:54 in a workspace lease under macOS's
 * temp directory: validatePath hands back the REAL path (/private/var/…)
 * while the tool context carries the lexical one (/var/…), so a plain
 * `relative()` began with ".." and every file the agent wrote in a lease
 * was judged "outside the project" — no .meta on write, the .meta left
 * behind on delete (eleven orphaned scene metas), none moved on rename.
 */
function projectRoots(projectPath: string): string[] {
  const lexical = normalize(projectPath);
  try {
    const real = normalize(realpathSync.native(projectPath));
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

/** The real form of a path that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
function realFileForm(filePath: string): string {
  let existing = filePath;
  let rest = "";
  while (true) {
    try {
      const real = realpathSync.native(existing);
      return rest === "" ? normalize(real) : normalize(real + sep + rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return filePath;
      rest = rest === "" ? basename(existing) : basename(existing) + sep + rest;
      existing = parent;
    }
  }
}

/**
 * Check if a file path is inside Assets/ and should have a .meta file.
 * Only files inside Assets/ need .meta files.
 * Excludes .meta files themselves and files inside Library/, Temp/, Logs/, etc.
 * `filePath` may be the lexical or the real form of the path; both roots are tried.
 */
export function shouldGenerateMeta(filePath: string, projectPath: string): boolean {
  const normalizedFile = normalize(filePath);

  // Never generate .meta for .meta files
  if (normalizedFile.endsWith(".meta")) {
    return false;
  }

  const roots = projectRoots(projectPath);
  const files = [normalizedFile];
  const realFile = realFileForm(normalizedFile);
  if (realFile !== normalizedFile) files.push(realFile);

  for (const root of roots) for (const file of files) {
    const rel = relative(root, file);
    // Must be inside the project (no ../ traversal)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      continue;
    }
    const segments = rel.split(sep);
    // Must be inside Assets/
    if (segments[0] !== "Assets") {
      return false;
    }
    // Exclude known non-asset directories
    for (const segment of segments) {
      if (UNITY_EXCLUDED_DIRS.has(segment)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Generate .meta file content for a regular file.
 * Uses the appropriate importer based on file extension:
 * - .cs files: MonoImporter
 * - .asmdef / .asmref files: DefaultImporter
 * - .shader / .cginc / .hlsl files: ShaderImporter
 * - Everything else: DefaultImporter
 */
export function generateMetaContent(guid: string, fileExtension: string): string {
  const ext = fileExtension.startsWith(".") ? fileExtension.toLowerCase() : `.${fileExtension.toLowerCase()}`;

  if (ext === ".cs") {
    return [
      "fileFormatVersion: 2",
      `guid: ${guid}`,
      "MonoImporter:",
      "  externalObjects: {}",
      "  serializedVersion: 2",
      "  defaultReferences: []",
      "  executionOrder: 0",
      "  icon: {instanceID: 0}",
      "  userData: ",
      "  assetBundleName: ",
      "  assetBundleVariant: ",
      "",
    ].join("\n");
  }

  if (ext === ".shader" || ext === ".cginc" || ext === ".hlsl") {
    return [
      "fileFormatVersion: 2",
      `guid: ${guid}`,
      "ShaderImporter:",
      "  externalObjects: {}",
      "  defaultTextures: []",
      "  nonModifiableTextures: []",
      "  preprocessorOverride: 0",
      "  userData: ",
      "  assetBundleName: ",
      "  assetBundleVariant: ",
      "",
    ].join("\n");
  }

  // DefaultImporter for .asmdef, .asmref, .json, .txt, .xml, and everything else
  return [
    "fileFormatVersion: 2",
    `guid: ${guid}`,
    "DefaultImporter:",
    "  externalObjects: {}",
    "  userData: ",
    "  assetBundleName: ",
    "  assetBundleVariant: ",
    "",
  ].join("\n");
}

/**
 * Generate .meta file content for a folder.
 */
export function generateFolderMetaContent(guid: string): string {
  return [
    "fileFormatVersion: 2",
    `guid: ${guid}`,
    "folderAsset: yes",
    "DefaultImporter:",
    "  externalObjects: {}",
    "  userData: ",
    "  assetBundleName: ",
    "  assetBundleVariant: ",
    "",
  ].join("\n");
}
