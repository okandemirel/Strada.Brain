import { unlink, rename, stat, readdir, rm } from "node:fs/promises";
import { validatePath } from "../../security/path-guard.js";
import { checkSafeToDelete } from "../../intelligence/unity-guid-resolver.js";
import { metaPathFor, shouldGenerateMeta } from "./unity/meta-file-utils.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

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

    // GUID safety check: warn if file is referenced by other assets
    try {
      const safetyCheck = await checkSafeToDelete(context.projectPath, relPath);
      if (!safetyCheck.safe && safetyCheck.warning) {
        return {
          content: safetyCheck.warning,
          isError: true,
          metadata: { guid: safetyCheck.guid, referenceCount: safetyCheck.references.length },
        };
      }
    } catch {
      // Non-fatal: proceed with delete if safety check fails
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
        content: `Deleted: ${relPath}`,
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

    const newCheck = await validatePath(context.projectPath, newPath);
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

async function countFiles(dir: string, count = 0): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = count;
  for (const entry of entries) {
    if (total > 50) return total; // Short-circuit at limit
    if (entry.isDirectory()) {
      total = await countFiles(`${dir}/${entry.name}`, total);
    } else {
      total++;
    }
  }
  return total;
}
