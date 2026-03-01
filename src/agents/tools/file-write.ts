import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const MAX_WRITE_SIZE = 256 * 1024; // 256KB max write

export class FileWriteTool implements ITool {
  readonly name = "file_write";
  readonly description =
    "Create or overwrite a file in the Unity project. " +
    "Use this to create new C# scripts, ScriptableObjects, or other files following Strada conventions. " +
    "IMPORTANT: Always read a file first before overwriting it.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative path from project root (e.g., 'Assets/Modules/Combat/CombatSystem.cs')",
      },
      content: {
        type: "string",
        description: "The complete file content to write",
      },
    },
    required: ["path", "content"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: file writing is disabled in read-only mode",
        isError: true,
      };
    }

    const relPath = String(input["path"] ?? "");
    const content = String(input["content"] ?? "");

    if (!relPath) {
      return { content: "Error: 'path' is required", isError: true };
    }

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    // Size check
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_WRITE_SIZE) {
      return {
        content: `Error: content too large (${Math.round(byteLength / 1024)}KB). Max: ${MAX_WRITE_SIZE / 1024}KB`,
        isError: true,
      };
    }

    try {
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFile(pathCheck.fullPath, content, "utf-8");

      const lineCount = content.split("\n").length;
      return {
        content: `File written: ${relPath} (${lineCount} lines, ${byteLength} bytes)`,
        metadata: { path: relPath, lineCount, byteLength },
      };
    } catch {
      return { content: "Error: could not write file", isError: true };
    }
  }
}
