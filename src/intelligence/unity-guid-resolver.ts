/**
 * Unity GUID Reference Safety
 *
 * Extracts GUIDs from .meta files and finds references to them across the project.
 * Used to warn before deleting files that are referenced by other assets.
 */

import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { join, relative, extname, resolve } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";
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
  /**
   * Reasons the walk stopped early (depth cap, unreadable directory, result
   * cap). Non-empty means the verdict is unverified; `safe` is then false.
   * Audited 2026-09-02.
   */
  scanIncomplete?: string[];
}

/**
 * Deepest directory level under a scan root the walk will enter. Was 10,
 * silently ignoring anything deeper; now high enough for third-party asset
 * packs, and hitting it is reported rather than swallowed. Audited 2026-09-02.
 */
export const GUID_SCAN_MAX_DEPTH = 25;

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
  /**
   * Places the walk stopped early, one line each. Empty means every
   * directory under every scanned root was read. Audited 2026-09-02.
   */
  incomplete: string[];
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
  maxDepth = GUID_SCAN_MAX_DEPTH,
  maxResults = 100,
): Promise<GuidScanResult> {
  const references: GuidReference[] = [];
  const scannedRoots: string[] = [];
  const incomplete: string[] = [];

  // Resolve to real path to prevent symlink escapes
  let resolvedProject: string;
  try {
    resolvedProject = await realpath(resolve(projectPath));
  } catch (err) {
    incomplete.push(`project path could not be resolved: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    return { references, scannedRoots, incomplete };
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
    await scanDirectory(rootPath, resolvedProject, targetGuid, references, 0, maxDepth, maxResults, incomplete);
  }

  return { references, scannedRoots, incomplete };
}

/**
 * Find all references to a specific GUID across the project.
 * Thin wrapper over `scanGuidReferences` for callers that only want the list.
 */
export async function findGuidReferences(
  projectPath: string,
  targetGuid: string,
  maxDepth = GUID_SCAN_MAX_DEPTH,
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
  incomplete: string[],
): Promise<void> {
  // Was: three silent `return`s (depth cap, readdir failure, result cap) that
  // left the caller unable to tell "searched everything" from "stopped early".
  // Each early exit now records why. Audited 2026-09-02.
  const relDir = relative(projectPath, dirPath).replace(/\\/g, "/");
  if (depth > maxDepth) {
    incomplete.push(`depth cap ${maxDepth} reached; not read: ${relDir}/`);
    return;
  }
  if (references.length >= maxResults) {
    incomplete.push(`result cap ${maxResults} reached before ${relDir}/`);
    return;
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    incomplete.push(`unreadable directory ${relDir}/ (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (UNITY_EXCLUDED_DIRS.has(entry.name)) continue;
      if (references.length >= maxResults) {
        incomplete.push(`result cap ${maxResults} reached before ${relDir}/${entry.name}/`);
        return;
      }
      await scanDirectory(fullPath, projectPath, targetGuid, references, depth + 1, maxDepth, maxResults, incomplete);
    } else if (references.length >= maxResults) {
      if (SEARCHABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        incomplete.push(`result cap ${maxResults} reached before ${relDir}/${entry.name}`);
        return;
      }
    } else if (SEARCHABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
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
      } catch (err) {
        incomplete.push(`unreadable file ${relDir}/${entry.name} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
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
  // getLoggerSafe: getLogger() throws "Logger not initialized" before boot
  // and the caller swallowed that, silently skipping the whole check. Audited 2026-09-02.
  const logger = getLoggerSafe();
  const metaPath = join(projectPath, filePath + ".meta");

  // Extract GUID from the file's .meta
  const guid = await extractGuid(metaPath);
  if (!guid) {
    // No .meta file or no GUID — safe to delete (not a Unity-tracked asset)
    return { safe: true, guid: null, references: [], scannedRoots: [] };
  }

  // Was: maxResults=6, which capped the reported count at 5 external refs and
  // dropped the "... and N more" line for 20 referrers. Audited 2026-09-02.
  const { references, scannedRoots, incomplete } = await scanGuidReferences(projectPath, guid, GUID_SCAN_MAX_DEPTH, 100);

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

  const scanNote =
    incomplete.length > 0
      ? `\nReference scan did not finish (${incomplete.length} stop(s)):\n` +
        incomplete.slice(0, 5).map((r) => `  ${r}`).join("\n") +
        (incomplete.length > 5 ? `\n  ... and ${incomplete.length - 5} more` : "")
      : "";

  if (externalRefs.length > 0) {
    const refList = externalRefs
      .slice(0, 5)
      .map((r) => `  ${r.filePath}:${r.lineNumber}`)
      .join("\n");
    const extra = externalRefs.length > 5 ? `\n  ... and ${externalRefs.length - 5} more` : "";
    const countWord = incomplete.length > 0 ? `at least ${externalRefs.length}` : `${externalRefs.length}`;

    const warning =
      `WARNING: ${filePath} (GUID: ${guid}) is referenced by ${countWord} file(s):\n` +
      refList +
      extra +
      "\nDeleting this file may break asset references." +
      scanNote;

    logger.warn("GUID safety check: file has references", {
      filePath,
      guid,
      referenceCount: externalRefs.length,
      scanIncomplete: incomplete.length,
    });

    return {
      safe: false,
      guid,
      references: externalRefs,
      warning,
      scannedRoots,
      ...(incomplete.length > 0 ? { scanIncomplete: incomplete } : {}),
    };
  }

  if (incomplete.length > 0) {
    // Was: `safe: true` here too — an unfinished scan read exactly like a
    // clean one and the caller unlinked on it. Audited 2026-09-02.
    const warning =
      `WARNING: ${filePath} (GUID: ${guid}) — no reference found in the part of ` +
      `${scannedRoots.join("/, ")}/ that was read, but the scan did not finish, ` +
      `so this is not a verified all-clear. Not deleting on an unverified verdict.` +
      scanNote;
    logger.warn("GUID safety check: scan incomplete, refusing to call delete safe", {
      filePath,
      guid,
      scanIncomplete: incomplete.length,
    });
    return { safe: false, guid, references: [], warning, scannedRoots, scanIncomplete: incomplete };
  }

  return { safe: true, guid, references: [], scannedRoots };
}
