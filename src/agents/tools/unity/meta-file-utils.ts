/**
 * Unity .meta file management utilities.
 * Handles GUID generation, .meta file creation, and Unity project detection.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/** The importers the generation tools write for their own asset kinds. */
export type AssetImporter = "TextureImporter" | "ModelImporter" | "AudioImporter";

/**
 * Write a generated asset's .meta without discarding what a person authored.
 *
 * Audit A5 / D56 (Codex #14): every regeneration rewrote the whole .meta from
 * the tool's template. The guid survived (reuseOrMintGuid), but a sprite's
 * spritePixelsToUnits, custom pivot and slices, a mesh's scale and collider
 * settings, an audio clip's load type — anything set in the Inspector since
 * the first generation — were silently reset to the template on every
 * re-draw.
 *
 * If a .meta exists and already carries the right importer, it is KEPT as
 * is; for a TextureImporter only `textureType: 8` (Sprite) is enforced, so a
 * regenerated sprite still imports as a sprite while every other setting
 * stays authored. A missing meta, or one of the WRONG importer type (a plain
 * DefaultImporter left by an earlier tool, a texture meta on what is now a
 * mesh), is replaced by the template — with the existing guid, so bindings
 * never churn.
 */
export interface ImporterMetaOptions {
  /**
   * The regenerated image's dimensions. A kept sprite sheet whose slice rects
   * no longer fit inside them would import as broken sprites (Codex
   * 2026-09-17); such a meta is re-templated instead, and `reason` says so.
   */
  image?: { width: number; height: number };
}

export interface ImporterMetaResult {
  guid: string;
  /** The existing meta was kept (possibly with textureType/spriteMode corrected). */
  kept: boolean;
  /** Why an existing meta of the right importer was re-templated anyway. */
  reason?: string;
}

/** Every slice rect in a TextureImporter meta's spriteSheet. */
function spriteSliceRects(meta: string): Array<{ x: number; y: number; width: number; height: number }> {
  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  const re = /^[ \t]+rect:[ \t]*\{x:[ \t]*(-?[\d.]+),[ \t]*y:[ \t]*(-?[\d.]+),[ \t]*width:[ \t]*([\d.]+),[ \t]*height:[ \t]*([\d.]+)\}/gm;
  for (const m of meta.matchAll(re)) {
    rects.push({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) });
  }
  return rects;
}

export function writeImporterMeta(
  metaFilePath: string,
  importer: AssetImporter,
  template: (guid: string) => string,
  opts: ImporterMetaOptions = {},
): ImporterMetaResult {
  let existing: string | undefined;
  try {
    existing = readFileSync(metaFilePath, "utf8");
  } catch {
    existing = undefined;
  }
  const guidMatch = existing !== undefined ? /guid:\s*([0-9a-f]{32})/i.exec(existing) : null;
  const guid = guidMatch ? guidMatch[1]!.toLowerCase() : generateUnityGuid();
  const sameImporter = existing !== undefined && new RegExp(`^${importer}:\\s*$`, "m").test(existing);

  if (existing !== undefined && guidMatch && sameImporter) {
    if (importer === "TextureImporter") {
      // Only what makes the file a usable Sprite: textureType 8 and a sprite
      // mode that is not "none" (0 → Single, or Multiple when slices exist).
      // A meta without the lines at all is not one this tool understands, so
      // it gets the template.
      const typeLine = /^([ \t]+textureType:[ \t]*)(\d+)[ \t]*$/m;
      const modeLine = /^([ \t]+spriteMode:[ \t]*)(\d+)[ \t]*$/m;
      if (!typeLine.test(existing) || !modeLine.test(existing)) {
        writeFileSync(metaFilePath, template(guid), "utf8");
        return { guid, kept: false, reason: "the existing TextureImporter meta has no textureType/spriteMode line" };
      }
      const slices = spriteSliceRects(existing);
      if (opts.image) {
        const { width, height } = opts.image;
        const outside = slices.filter((r) => r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height);
        if (outside.length > 0) {
          writeFileSync(metaFilePath, template(guid), "utf8");
          return {
            guid,
            kept: false,
            reason: `${outside.length} of ${slices.length} sprite-sheet slices no longer fit the regenerated ${width}×${height} image`,
          };
        }
      }
      let enforced = existing.replace(typeLine, (_m, prefix: string) => `${prefix}8`);
      enforced = enforced.replace(modeLine, (_m, prefix: string, mode: string) => (mode === "0" ? `${prefix}${slices.length > 0 ? 2 : 1}` : `${prefix}${mode}`));
      if (enforced !== existing) writeFileSync(metaFilePath, enforced, "utf8");
    }
    return { guid, kept: true };
  }

  writeFileSync(metaFilePath, template(guid), "utf8");
  return { guid, kept: false };
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
