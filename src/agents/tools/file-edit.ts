import { readFile, writeFile } from "node:fs/promises";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

export class FileEditTool implements ITool {
  readonly name = "file_edit";
  readonly description =
    "Edit a file by replacing a specific string with a new string. " +
    "The old_string must match exactly (including whitespace and indentation). " +
    "Always read the file first to get the exact content to replace.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path from project root",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace (must be unique in the file)",
      },
      new_string: {
        type: "string",
        description: "The replacement string",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of just the first. Default: false",
      },
    },
    required: ["path", "old_string", "new_string"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: file editing is disabled in read-only mode",
        isError: true,
      };
    }

    const relPath = String(input["path"] ?? "");
    const oldString = String(input["old_string"] ?? "");
    const newString = String(input["new_string"] ?? "");
    const replaceAll = Boolean(input["replace_all"] ?? false);

    if (!relPath || !oldString) {
      return {
        content: "Error: 'path' and 'old_string' are required",
        isError: true,
      };
    }

    if (oldString === newString) {
      return {
        content: "Error: old_string and new_string are identical",
        isError: true,
      };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    try {
      const content = await readFile(pathCheck.fullPath, "utf-8");

      if (!content.includes(oldString)) {
        return {
          content: "Error: old_string not found in file. Make sure it matches exactly (including whitespace).",
          isError: true,
        };
      }

      if (!replaceAll) {
        const firstIndex = content.indexOf(oldString);
        const secondIndex = content.indexOf(oldString, firstIndex + 1);
        if (secondIndex !== -1) {
          return {
            content:
              "Error: old_string appears multiple times in the file. " +
              "Provide more surrounding context to make it unique, or use replace_all: true.",
            isError: true,
          };
        }
      }

      let newContent: string;
      let replacementCount: number;

      if (replaceAll) {
        const parts = content.split(oldString);
        replacementCount = parts.length - 1;
        newContent = parts.join(newString);
      } else {
        newContent = content.replace(oldString, newString);
        replacementCount = 1;
      }

      await writeFile(pathCheck.fullPath, newContent, "utf-8");

      return {
        content: `File edited: ${relPath} (${replacementCount} replacement${replacementCount > 1 ? "s" : ""} made)`,
        metadata: { path: relPath, replacementCount, originalContent: content.slice(0, 500_000) },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: file not found", isError: true };
      }
      return { content: "Error: could not edit file", isError: true };
    }
  }
}
