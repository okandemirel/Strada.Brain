/**
 * Unity .meta file management utilities.
 * Handles GUID generation, .meta file creation, and Unity project detection.
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { normalize, relative, sep } from "node:path";

/**
 * Generate a Unity-compatible GUID (32 lowercase hex characters).
 * Uses crypto.randomUUID() and strips dashes.
 */
export function generateUnityGuid(): string {
  return randomUUID().replaceAll("-", "").toLowerCase();
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
 * Check if a file path is inside Assets/ and should have a .meta file.
 * Only files inside Assets/ need .meta files.
 * Excludes .meta files themselves and files inside Library/, Temp/, Logs/, etc.
 */
export function shouldGenerateMeta(filePath: string, projectPath: string): boolean {
  const normalizedFile = normalize(filePath);
  const normalizedProject = normalize(projectPath);
  const rel = relative(normalizedProject, normalizedFile);

  // Must be inside the project (no ../ traversal)
  if (rel.startsWith("..") || rel === "") {
    return false;
  }

  // Never generate .meta for .meta files
  if (normalizedFile.endsWith(".meta")) {
    return false;
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
