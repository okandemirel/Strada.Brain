import { unlink, rename, stat, readdir, rm } from "node:fs/promises";
import { dirname, basename, relative } from "node:path";
import { validatePath } from "../../security/path-guard.js";
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

    try {
      const fileStat = await stat(pathCheck.fullPath);
      if (!fileStat.isFile()) {
        return { content: "Error: target is not a file. Use file_delete_directory for directories.", isError: true };
      }

      await unlink(pathCheck.fullPath);
      return {
        content: `Deleted: ${relPath}`,
        metadata: { path: relPath },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: file not found", isError: true };
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
      const fileStat = await stat(oldCheck.fullPath);
      if (!fileStat.isFile()) {
        return { content: "Error: source is not a file", isError: true };
      }
    } catch {
      return { content: "Error: source file not found", isError: true };
    }

    // Check destination doesn't already exist
    try {
      await stat(newCheck.fullPath);
      return { content: "Error: destination already exists", isError: true };
    } catch {
      // Good — destination doesn't exist
    }

    try {
      await rename(oldCheck.fullPath, newCheck.fullPath);
      return {
        content: `Renamed: ${oldPath} → ${newPath}`,
        metadata: { oldPath, newPath },
      };
    } catch (error) {
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
