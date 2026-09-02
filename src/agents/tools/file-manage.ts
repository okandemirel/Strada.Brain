import { unlink, rename, stat, readdir, rm, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { validatePath } from "../../security/path-guard.js";
import { checkSafeToDelete } from "../../intelligence/unity-guid-resolver.js";
import { metaPathFor, shouldGenerateMeta } from "./unity/meta-file-utils.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

/**
 * The project-relative form of a path validatePath already accepted.
 *
 * validatePath returns the realpath'd full path for an existing file, while the
 * project root may be given un-realpath'd (macOS /var vs /private/var), so both
 * spellings of the root are tried. Falls back to the full path only if neither
 * contains it, which validatePath has already ruled out.
 */
async function toProjectRelative(projectPath: string, fullPath: string): Promise<string> {
  const roots = [resolve(projectPath)];
  try {
    roots.push(await realpath(projectPath));
  } catch {
    /* an unreadable root already failed validatePath */
  }
  for (const root of roots) {
    const rel = relative(root, fullPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return fullPath;
}

// ─── file_delete ──────────────────────────────────────────────────────────────

export class FileDeleteTool implements ITool {
  readonly name = "file_delete";
  readonly description =
    "Delete a file from the Unity project. " +
    "Only single files can be deleted (not directories). " +
    "Use with caution — this operation cannot be undone.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path from project root to the file to delete.",
      },
    },
    required: ["path"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: file deletion is disabled in read-only mode", isError: true };
    }

    const relPath = String(input["path"] ?? "").trim();
    if (!relPath) {
      return { content: "Error: 'path' is required", isError: true };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    // GUID safety check: warn if file is referenced by other assets.
    // Audited 2026-09-02: the check was handed the RAW input. validatePath
    // accepts an in-project absolute path, but checkSafeToDelete joins its
    // argument onto the project root, so an absolute path became
    // <project>/<project>/X.meta, found no GUID, and answered "safe" — a
    // referenced prefab was deleted with a bare "Deleted:" that read exactly
    // like a passed check (a "./" prefix likewise made the file's own .meta
    // count as an external reference). The check now gets the same normalised
    // project-relative path the delete uses, and a check that could not run
    // says so in the result instead of vanishing.
    let checkNote = "";
    try {
      const checkRel = await toProjectRelative(context.projectPath, pathCheck.fullPath);
      const safetyCheck = await checkSafeToDelete(context.projectPath, checkRel);
      if (!safetyCheck.safe && safetyCheck.warning) {
        return {
          content: safetyCheck.warning,
          isError: true,
          metadata: { guid: safetyCheck.guid, referenceCount: safetyCheck.references.length },
        };
      }
    } catch (error) {
      // Was: swallowed and proceeded, so a check that never ran read exactly
      // like a check that passed. A delete on an unverified verdict is refused
      // and says why. Audited 2026-09-02.
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content:
          `Error: the asset-reference safety check for ${relPath} could not run (${msg}); ` +
          "not deleting on an unverified verdict.",
        isError: true,
      };
    }

    try {
      await unlink(pathCheck.fullPath);

      // Also delete the companion .meta file if it exists
      if (shouldGenerateMeta(pathCheck.fullPath, context.projectPath)) {
        try {
          await unlink(metaPathFor(pathCheck.fullPath));
        } catch {
          // .meta may not exist — non-fatal
        }
      }

      return {
        content: `Deleted: ${relPath}${checkNote}`,
        metadata: { path: relPath },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { content: "Error: file not found", isError: true };
      }
      if (code === "EPERM" || code === "EISDIR") {
        return { content: "Error: target is not a file. Use file_delete_directory for directories.", isError: true };
      }
      return { content: "Error: could not delete file", isError: true };
    }
  }
}

// ─── file_rename ──────────────────────────────────────────────────────────────

export class FileRenameTool implements ITool {
  readonly name = "file_rename";
  readonly description =
    "Rename or move a file within the Unity project. " +
    "Can move files between directories. Parent directories are NOT created automatically.";

  readonly inputSchema = {
    type: "object",
    properties: {
      old_path: {
        type: "string",
        description: "Current relative path from project root.",
      },
      new_path: {
        type: "string",
        description: "New relative path from project root.",
      },
    },
    required: ["old_path", "new_path"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: file renaming is disabled in read-only mode", isError: true };
    }

    const oldPath = String(input["old_path"] ?? "").trim();
    const newPath = String(input["new_path"] ?? "").trim();

    if (!oldPath) return { content: "Error: 'old_path' is required", isError: true };
    if (!newPath) return { content: "Error: 'new_path' is required", isError: true };

    const oldCheck = await validatePath(context.projectPath, oldPath);
    if (!oldCheck.valid) {
      return { content: `Error (old_path): ${oldCheck.error}`, isError: true };
    }

    // The rename TARGET may point into a directory that does not exist yet;
    // oldPath above must still resolve to something real.
    const newCheck = await validatePath(context.projectPath, newPath, {
      allowMissingParents: true,
    });
    if (!newCheck.valid) {
      return { content: `Error (new_path): ${newCheck.error}`, isError: true };
    }

    try {
      await rename(oldCheck.fullPath, newCheck.fullPath);

      // Also rename the companion .meta file if it exists
      if (shouldGenerateMeta(oldCheck.fullPath, context.projectPath)) {
        try {
          await rename(metaPathFor(oldCheck.fullPath), metaPathFor(newCheck.fullPath));
        } catch {
          // .meta may not exist — non-fatal
        }
      }

      return {
        content: `Renamed: ${oldPath} → ${newPath}`,
        metadata: { oldPath, newPath },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { content: "Error: source file not found", isError: true };
      }
      if (code === "ENOTDIR" || code === "EISDIR") {
        return { content: "Error: source is not a file", isError: true };
      }
      return {
        content: `Error: could not rename file — ${(error as Error).message}`,
        isError: true,
      };
    }
  }
}

// ─── file_delete_directory ────────────────────────────────────────────────────

export class FileDeleteDirectoryTool implements ITool {
  readonly name = "file_delete_directory";
  readonly description =
    "Delete a directory and all its contents from the Unity project. " +
    "USE WITH EXTREME CAUTION — this recursively deletes all files and subdirectories. " +
    "The directory must contain fewer than 50 files as a safety limit.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path from project root to the directory to delete.",
      },
    },
    required: ["path"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: directory deletion is disabled in read-only mode", isError: true };
    }

    const relPath = String(input["path"] ?? "").trim();
    if (!relPath) {
      return { content: "Error: 'path' is required", isError: true };
    }

    // Block deleting project root
    if (relPath === "." || relPath === "/" || relPath === "") {
      return { content: "Error: cannot delete the project root", isError: true };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    // Prevent deleting the project root itself
    if (pathCheck.fullPath === context.projectPath) {
      return { content: "Error: cannot delete the project root", isError: true };
    }

    try {
      const dirStat = await stat(pathCheck.fullPath);
      if (!dirStat.isDirectory()) {
        return { content: "Error: target is not a directory. Use file_delete for files.", isError: true };
      }

      // Safety: count files
      const fileCount = await countFiles(pathCheck.fullPath);
      if (fileCount > 50) {
        return {
          content: `Error: directory contains ${fileCount} files (limit: 50). ` +
            "Delete files individually or increase the safety limit.",
          isError: true,
        };
      }

      await rm(pathCheck.fullPath, { recursive: true });
      return {
        content: `Deleted directory: ${relPath} (${fileCount} files removed)`,
        metadata: { path: relPath, fileCount },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: directory not found", isError: true };
      }
      return { content: "Error: could not delete directory", isError: true };
    }
  }
}

async function countFiles(dir: string, count = 0, visited = new Set<string>()): Promise<number> {
  const resolved = resolve(dir);
  if (visited.has(resolved)) return count; // Symlink cycle guard
  visited.add(resolved);

  const entries = await readdir(dir, { withFileTypes: true });
  let total = count;
  for (const entry of entries) {
    if (total > 50) return total; // Short-circuit at limit
    if (entry.isDirectory()) {
      total = await countFiles(`${dir}/${entry.name}`, total, visited);
    } else {
      total++;
    }
  }
  return total;
}
