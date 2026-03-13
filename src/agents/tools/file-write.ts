import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { validatePath } from "../../security/path-guard.js";
import {
  generateUnityGuid,
  generateMetaContent,
  metaPathFor,
  shouldGenerateMeta,
} from "./unity/meta-file-utils.js";
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

      // Generate .meta file for new Unity assets (atomic: wx flag prevents overwriting existing)
      let metaGenerated = false;
      if (shouldGenerateMeta(pathCheck.fullPath, context.projectPath)) {
        const metaPath = metaPathFor(pathCheck.fullPath);
        try {
          const guid = generateUnityGuid();
          const ext = extname(relPath);
          const metaContent = generateMetaContent(guid, ext);
          await writeFile(metaPath, metaContent, { encoding: "utf-8", flag: "wx" });
          metaGenerated = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
            // Unexpected error — log but don't fail the main write
          }
          // EEXIST: .meta already exists — skip silently
        }
      }

      const lineCount = content.split("\n").length;
      const metaMsg = metaGenerated ? " (+.meta)" : "";
      return {
        content: `File written: ${relPath} (${lineCount} lines, ${byteLength} bytes)${metaMsg}`,
        metadata: { path: relPath, lineCount, byteLength, metaGenerated },
      };
    } catch {
      return { content: "Error: could not write file", isError: true };
    }
  }
}
