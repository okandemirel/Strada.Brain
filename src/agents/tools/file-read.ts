import { readFile, stat } from "node:fs/promises";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { FILE_LIMITS } from "../../common/constants.js";

const MAX_FILE_SIZE = FILE_LIMITS.MAX_FILE_SIZE;
const MAX_LINES = FILE_LIMITS.MAX_LINES;

export class FileReadTool implements ITool {
  readonly name = "file_read";
  readonly description =
    "Read the contents of a file in the Unity project. Returns the file content with line numbers. " +
    "Use this to understand existing code before making changes.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative path from the project root (e.g., 'Assets/Scripts/PlayerController.cs')",
      },
      offset: {
        type: "number",
        description: "Starting line number (1-based). Optional.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return. Default: 2000.",
      },
    },
    required: ["path"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const relPath = String(input["path"] ?? "");
    const offset = Math.max(1, Number(input["offset"] ?? 1));
    const limit = Math.min(MAX_LINES, Math.max(1, Number(input["limit"] ?? MAX_LINES)));

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
        return { content: "Error: target is not a file", isError: true };
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        return {
          content: `Error: file too large (${Math.round(fileStat.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use offset/limit.`,
          isError: true,
        };
      }

      const content = await readFile(pathCheck.fullPath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const selectedLines = lines.slice(offset - 1, offset - 1 + limit);

      const numbered = selectedLines
        .map((line, i) => `${String(offset + i).padStart(5)} | ${line}`)
        .join("\n");

      const header = `File: ${relPath} (${totalLines} lines total, showing ${offset}-${Math.min(offset + limit - 1, totalLines)})`;

      return { content: `${header}\n${numbered}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: file not found", isError: true };
      }
      return { content: "Error: could not read file", isError: true };
    }
  }
}
