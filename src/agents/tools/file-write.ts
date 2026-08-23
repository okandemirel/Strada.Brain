import { mkdir, stat, open, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { sameNameElsewhere } from "./nearby-names.js";
import { dirname, extname, sep } from "node:path";
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

    // allowMissingParents: this tool creates the directory chain itself
    // (mkdir recursive, below). Without it the guard refused every write into a
    // directory that did not already exist, so no tool could lay out a new
    // folder structure.
    const pathCheck = await validatePath(context.projectPath, relPath, {
      allowMissingParents: true,
    });
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
      // Asked before the write, because afterwards every path exists.
      const isNewFile = !(await pathExists(pathCheck.fullPath));
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFileInsideRoot(context.projectPath, pathCheck.fullPath, content);

      // Generate .meta file for new Unity assets (atomic: ex flag prevents overwriting existing)
      let metaGenerated = false;
      if (shouldGenerateMeta(pathCheck.fullPath, context.projectPath)) {
        const metaPath = metaPathFor(pathCheck.fullPath);
        try {
          const guid = generateUnityGuid();
          const ext = extname(relPath);
          const metaContent = generateMetaContent(guid, ext);
          await writeFileInsideRoot(context.projectPath, metaPath, metaContent, { exclusive: true });
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
      // Measured 2026-08-21, 12:25: an agent that could not find
      // IInputService.cs where it looked wrote its own copy, and this tool
      // said "File written" and nothing else. Twenty-five compile errors
      // later it grepped, found both, and deleted one. Creating a second file
      // under a name the project already uses is worth one sentence at the
      // moment it happens.
      const twin = isNewFile ? await sameNameElsewhere(context.projectPath, pathCheck.fullPath) : [];
      const twinMsg = twin.length > 0 ? ` — note: that filename also exists at: ${twin.join(", ")}` : "";
      return {
        content: `File written: ${relPath} (${lineCount} lines, ${byteLength} bytes)${metaMsg}${twinMsg}`,
        metadata: { path: relPath, lineCount, byteLength, metaGenerated },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      return { content: `Error: could not write file${code ? ` (${code})` : ""}`, isError: true };
    }
  }
}

/** Whether a path is already there — asked before a write, never after. */
async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

/** O_NOFOLLOW where the platform has it (absent on Windows → 0, harmless there). */
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/**
 * TOCTOU-contained write (measured 2026-08-23): `validatePath` resolves symlinks
 * at CHECK time, but a plain writeFile follows whatever sits at the path at WRITE
 * time — a symlink swapped in between escapes the project root. Two defenses:
 *   1. The parent directory is re-derived via realpath AFTER mkdir and must still
 *      sit inside the (real) project root — closes intermediate-component swaps.
 *   2. The file itself is opened with O_NOFOLLOW, so a swapped final component
 *      fails with ELOOP instead of being written through.
 * Exported for direct testing: the race it defends against cannot be staged
 * through execute() deterministically, because validatePath runs first.
 */
export async function writeFileInsideRoot(
  rootPath: string,
  targetPath: string,
  content: string,
  opts?: { exclusive?: boolean },
): Promise<void> {
  const [realParent, realRoot] = await Promise.all([
    realpath(dirname(targetPath)),
    realpath(rootPath),
  ]);
  if (!(realParent === realRoot || realParent.startsWith(realRoot + sep))) {
    throw new Error("parent directory escaped the project root");
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW_FLAG
    | (opts?.exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
  const handle = await open(targetPath, flags, 0o644);
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
}
