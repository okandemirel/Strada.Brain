/**
 * Unity GUID Reference Safety
 *
 * Extracts GUIDs from .meta files and finds references to them across the project.
 * Used to warn before deleting files that are referenced by other assets.
 */

import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { join, relative, extname, resolve } from "node:path";
import { getLogger } from "../utils/logger.js";
import { UNITY_EXCLUDED_DIRS } from "../agents/tools/unity/meta-file-utils.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GuidReference {
  /** File containing the reference */
  filePath: string;
  /** Line number where the reference was found */
  lineNumber: number;
  /** The referenced GUID */
  guid: string;
}

export interface SafetyCheckResult {
  /** Whether it's safe to delete (no references found in the scanned roots) */
  safe: boolean;
  /** GUID of the file being checked */
  guid: string | null;
  /** Files that reference this GUID */
  references: GuidReference[];
  /** Warning message if not safe */
  warning?: string;
  /**
   * Project-relative roots the reference walk actually covered. `safe: true`
   * means "no reference found under these", nothing more. Audited 2026-09-02.
   */
  scannedRoots: string[];
}

/**
 * Roots that can hold GUID references to an asset. Unity keeps build-list
 * scenes in ProjectSettings/EditorBuildSettings.asset and default
 * materials/shaders in GraphicsSettings/QualitySettings; local packages under
 * Packages/ (e.g. Packages/Submodules/Strada.Core) ship real asset trees.
 * The walk used to cover Assets/ only. Audited 2026-09-02.
 */
export const GUID_SCAN_ROOTS = ["Assets", "ProjectSettings", "Packages"] as const;

// ─── GUID Extraction ───────────────────────────────────────────────────────

const GUID_PATTERN = /^guid:\s*([0-9a-f]{32})\s*$/m;

/**
 * Extract the GUID from a Unity .meta file.
 */
export async function extractGuid(metaFilePath: string): Promise<string | null> {
  try {
    const content = await readFile(metaFilePath, "utf-8");
    const match = GUID_PATTERN.exec(content);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Extract GUID from .meta content string (synchronous).
 */
export function extractGuidFromContent(content: string): string | null {
  const match = GUID_PATTERN.exec(content);
  return match ? match[1]! : null;
}

// ─── Reference Finding ─────────────────────────────────────────────────────

const GUID_REF_PATTERN = /guid:\s*([0-9a-f]{32})/g;
const SEARCHABLE_EXTENSIONS = new Set([
  ".prefab", ".unity", ".asset", ".mat", ".controller",
  ".anim", ".overrideController", ".meta", ".playable",
  ".mask", ".flare", ".renderTexture", ".cubemap",
  ".spriteatlas", ".lighting", ".terrainlayer",
]);

export interface GuidScanResult {
  references: GuidReference[];
  /** Project-relative roots that existed and were walked. */
  scannedRoots: string[];
}

/**
 * Find all references to a specific GUID across the project's Assets/,
 * ProjectSettings/ and Packages/ directories, reporting which of those roots
 * were actually walked. Searches .prefab, .unity, .asset, .mat and other Unity
 * serialized files.
 */
export async function scanGuidReferences(
  projectPath: string,
  targetGuid: string,
  maxDepth = 10,
  maxResults = 100,
): Promise<GuidScanResult> {
  const references: GuidReference[] = [];
  const scannedRoots: string[] = [];

  // Resolve to real path to prevent symlink escapes
  let resolvedProject: string;
  try {
    resolvedProject = await realpath(resolve(projectPath));
  } catch {
    return { references, scannedRoots };
  }

  // Was: `join(resolvedProject, "Assets")` alone, so ProjectSettings/ and
  // Packages/ were structurally invisible. Audited 2026-09-02.
  for (const rootName of GUID_SCAN_ROOTS) {
    const rootPath = join(resolvedProject, rootName);
    try {
      const st = await stat(rootPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue; // Root absent in this project
    }
    scannedRoots.push(rootName);
    await scanDirectory(rootPath, resolvedProject, targetGuid, references, 0, maxDepth, maxResults);
  }

  return { references, scannedRoots };
}

/**
 * Find all references to a specific GUID across the project.
 * Thin wrapper over `scanGuidReferences` for callers that only want the list.
 */
export async function findGuidReferences(
  projectPath: string,
  targetGuid: string,
  maxDepth = 10,
  maxResults = 100,
): Promise<GuidReference[]> {
  return (await scanGuidReferences(projectPath, targetGuid, maxDepth, maxResults)).references;
}

async function scanDirectory(
  dirPath: string,
  projectPath: string,
  targetGuid: string,
  references: GuidReference[],
  depth: number,
  maxDepth: number,
  maxResults: number,
): Promise<void> {
  if (depth > maxDepth || references.length >= maxResults) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (UNITY_EXCLUDED_DIRS.has(entry.name)) continue;
      if (references.length >= maxResults) return;
      await scanDirectory(fullPath, projectPath, targetGuid, references, depth + 1, maxDepth, maxResults);
    } else if (references.length < maxResults && SEARCHABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const relPath = relative(projectPath, fullPath);
        const lines = content.split("\n");

        for (let i = 0; i < lines.length && references.length < maxResults; i++) {
          GUID_REF_PATTERN.lastIndex = 0;
          let match;
          while ((match = GUID_REF_PATTERN.exec(lines[i]!)) !== null) {
            if (match[1] === targetGuid) {
              references.push({
                filePath: relPath,
                lineNumber: i + 1,
                guid: targetGuid,
              });
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}

// ─── Safety Check ──────────────────────────────────────────────────────────

/**
 * Check if it's safe to delete a file by looking for GUID references.
 * Returns a SafetyCheckResult with references if any are found.
 *
 * @param projectPath - Root project path
 * @param filePath - Relative path of the file to check
 */
export async function checkSafeToDelete(
  projectPath: string,
  filePath: string,
): Promise<SafetyCheckResult> {
  const logger = getLogger();
  const metaPath = join(projectPath, filePath + ".meta");

  // Extract GUID from the file's .meta
  const guid = await extractGuid(metaPath);
  if (!guid) {
    // No .meta file or no GUID — safe to delete (not a Unity-tracked asset)
    return { safe: true, guid: null, references: [], scannedRoots: [] };
  }

  // Was: maxResults=6, which capped the reported count at 5 external refs and
  // dropped the "... and N more" line for 20 referrers. Audited 2026-09-02.
  const { references, scannedRoots } = await scanGuidReferences(projectPath, guid, 10, 100);

  // Filter out self-references (the file's own .meta). Normalize separators
  // before comparing: `ref.filePath` comes from `path.relative()` (native
  // separators — `\` on Windows) while `filePath` is the caller-supplied
  // relative path, which may use `/`. A raw `!==` would fail to match a file's
  // own `.meta` on Windows, falsely reporting a self-reference and blocking a
  // safe delete.
  const normalizeSep = (p: string): string => p.replace(/\\/g, "/");
  const selfPath = normalizeSep(filePath);
  const selfMetaPath = selfPath + ".meta";
  const externalRefs = references.filter((ref) => {
    const refPath = normalizeSep(ref.filePath);
    return refPath !== selfPath && refPath !== selfMetaPath;
  });

  if (externalRefs.length > 0) {
    const refList = externalRefs
      .slice(0, 5)
      .map((r) => `  ${r.filePath}:${r.lineNumber}`)
      .join("\n");
    const extra = externalRefs.length > 5 ? `\n  ... and ${externalRefs.length - 5} more` : "";

    const warning =
      `WARNING: ${filePath} (GUID: ${guid}) is referenced by ${externalRefs.length} file(s):\n` +
      refList +
      extra +
      "\nDeleting this file may break asset references.";

    logger.warn("GUID safety check: file has references", {
      filePath,
      guid,
      referenceCount: externalRefs.length,
    });

    return { safe: false, guid, references: externalRefs, warning, scannedRoots };
  }

  return { safe: true, guid, references: [], scannedRoots };
}
