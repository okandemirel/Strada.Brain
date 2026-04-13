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

    // Input context for error messages (truncated to first 200 chars)
    const inputPreview = summarizeInput(input);

    // Explicit type + presence validation BEFORE String() coercion.
    // String(undefined) silently yields "undefined" which masks missing fields.
    const pathResult = requireNonEmptyString(input, "path", inputPreview);
    if (!pathResult.ok) return pathResult.error;
    const oldResult = requireNonEmptyString(input, "old_string", inputPreview);
    if (!oldResult.ok) return oldResult.error;
    const newResult = requireString(input, "new_string", inputPreview);
    if (!newResult.ok) return newResult.error;

    const relPath = pathResult.value;
    const oldString = oldResult.value;
    const newString = newResult.value;
    const replaceAll = Boolean(input["replace_all"] ?? false);

    if (oldString === newString) {
      return {
        content: `Error: old_string and new_string are identical. Received input: ${inputPreview}`,
        isError: true,
      };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return {
        content: `Error: ${pathCheck.error} (path="${relPath}")`,
        isError: true,
      };
    }

    try {
      const content = await readFile(pathCheck.fullPath, "utf-8");

      if (!content.includes(oldString)) {
        return {
          content:
            `Error: old_string not found in ${relPath}. Make sure it matches exactly (including whitespace). ` +
            `First 80 chars of old_string: "${oldString.slice(0, 80).replace(/\n/g, "\\n")}"`,
          isError: true,
        };
      }

      if (!replaceAll) {
        const firstIndex = content.indexOf(oldString);
        const secondIndex = content.indexOf(oldString, firstIndex + 1);
        if (secondIndex !== -1) {
          return {
            content:
              `Error: old_string appears multiple times in ${relPath}. ` +
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
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          content: `Error: file not found (path="${relPath}", fullPath="${pathCheck.fullPath}")`,
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: could not edit file (path="${relPath}", code=${err.code ?? "unknown"}): ${msg}`,
        isError: true,
      };
    }
  }
}

// ─── Input validation helpers ─────────────────────────────────────────────────

const INPUT_PREVIEW_MAX = 200;

type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolExecutionResult };

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input);
    return s.length > INPUT_PREVIEW_MAX ? `${s.slice(0, INPUT_PREVIEW_MAX)}…(truncated)` : s;
  } catch {
    return "[unserializable input]";
  }
}

/** Require the field to be present AND a string (may be empty). */
function requireString(
  input: Record<string, unknown>,
  field: string,
  preview: string,
): FieldResult<string> {
  const raw = input[field];
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      error: {
        content: `Error: '${field}' is required. Received input: ${preview}`,
        isError: true,
      },
    };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: {
        content: `Error: '${field}' must be a string, got ${typeof raw}. Received input: ${preview}`,
        isError: true,
      },
    };
  }
  return { ok: true, value: raw };
}

/** Like requireString but also rejects empty strings. */
function requireNonEmptyString(
  input: Record<string, unknown>,
  field: string,
  preview: string,
): FieldResult<string> {
  const result = requireString(input, field, preview);
  if (!result.ok) return result;
  if (result.value.length === 0) {
    return {
      ok: false,
      error: {
        content: `Error: '${field}' is required (must be a non-empty string). Received input: ${preview}`,
        isError: true,
      },
    };
  }
  return result;
}
