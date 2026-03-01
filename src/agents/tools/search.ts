import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { glob } from "glob";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

/**
 * Reject glob patterns that could escape the project directory.
 */
function isSafeGlobPattern(pattern: string): boolean {
  // Reject patterns with path traversal
  if (pattern.includes("..")) return false;
  // Reject absolute paths
  if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) return false;
  return true;
}

const MAX_RESULTS = 50;
const MAX_CONTENT_RESULTS = 20;
const MAX_REGEX_LENGTH = 500;
const MAX_GREP_FILE_SIZE = 1024 * 1024; // 1MB per file for grep
const SEARCHABLE_EXTENSIONS = new Set([
  ".cs", ".shader", ".compute", ".hlsl", ".cginc",
  ".json", ".xml", ".yaml", ".yml", ".txt", ".md",
  ".asmdef", ".asmref", ".asset", ".prefab", ".unity",
]);

/**
 * Glob-based file search tool.
 */
export class GlobSearchTool implements ITool {
  readonly name = "glob_search";
  readonly description =
    "Find files by name pattern in the Unity project. " +
    "Returns matching file paths. Use patterns like '**/*.cs', 'Assets/Modules/**/*.cs'.";

  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern (e.g., '**/*.cs', 'Assets/**/ModuleConfig.cs', '**/I*.cs' for interfaces)",
      },
    },
    required: ["pattern"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const pattern = String(input["pattern"] ?? "");
    if (!pattern) {
      return { content: "Error: 'pattern' is required", isError: true };
    }

    if (!isSafeGlobPattern(pattern)) {
      return { content: "Error: pattern must not contain '..' or absolute paths", isError: true };
    }

    try {
      const matches = await glob(pattern, {
        cwd: context.projectPath,
        nodir: true,
        maxDepth: 20,
      });

      const limited = matches.slice(0, MAX_RESULTS);
      if (limited.length === 0) {
        return { content: `No files found matching pattern: ${pattern}` };
      }

      const result = limited.join("\n");
      const suffix =
        matches.length > MAX_RESULTS
          ? `\n\n... and ${matches.length - MAX_RESULTS} more files`
          : "";

      return {
        content: `Found ${matches.length} file(s) matching '${pattern}':\n${result}${suffix}`,
      };
    } catch {
      return { content: "Error: search failed", isError: true };
    }
  }
}

/**
 * Content search (grep-like) tool.
 */
export class GrepSearchTool implements ITool {
  readonly name = "grep_search";
  readonly description =
    "Search for text or regex patterns within files in the Unity project. " +
    "Returns matching lines with file paths and line numbers. " +
    "Use this to find class definitions, method usages, DI registrations, etc.";

  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Text or regex pattern to search for (e.g., 'class PlayerSystem', 'Register<I', 'EventBus.Publish')",
      },
      file_pattern: {
        type: "string",
        description:
          "Optional glob pattern to filter which files to search (e.g., '**/*.cs'). Default: all code files.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether the search is case-sensitive. Default: true.",
      },
    },
    required: ["pattern"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const pattern = String(input["pattern"] ?? "");
    const filePattern = String(input["file_pattern"] ?? "**/*");
    const caseSensitive = input["case_sensitive"] !== false;

    if (!pattern) {
      return { content: "Error: 'pattern' is required", isError: true };
    }

    if (pattern.length > MAX_REGEX_LENGTH) {
      return { content: "Error: pattern too long (max 500 characters)", isError: true };
    }

    if (!isSafeGlobPattern(filePattern)) {
      return { content: "Error: file_pattern must not contain '..' or absolute paths", isError: true };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
    } catch {
      return { content: "Error: invalid regex pattern", isError: true };
    }

    try {
      const files = await glob(filePattern, {
        cwd: context.projectPath,
        nodir: true,
        maxDepth: 20,
      });

      const results: string[] = [];

      for (const file of files) {
        if (!SEARCHABLE_EXTENSIONS.has(extname(file).toLowerCase())) continue;

        // Validate each file path to prevent directory traversal
        const pathCheck = await validatePath(context.projectPath, file);
        if (!pathCheck.valid) continue;

        const fullPath = pathCheck.fullPath;
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_GREP_FILE_SIZE) continue;

          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (regex.test(line)) {
              results.push(`${file}:${i + 1}: ${line.trim()}`);
              regex.lastIndex = 0;
            }
            if (results.length >= MAX_CONTENT_RESULTS) break;
          }
        } catch {
          // Skip unreadable files
        }

        if (results.length >= MAX_CONTENT_RESULTS) break;
      }

      if (results.length === 0) {
        return { content: `No matches found for pattern: ${pattern}` };
      }

      return {
        content: `Found ${results.length} match(es):\n${results.join("\n")}`,
      };
    } catch {
      return { content: "Error: search failed", isError: true };
    }
  }
}

/**
 * List directory contents tool.
 */
export class ListDirectoryTool implements ITool {
  readonly name = "list_directory";
  readonly description =
    "List the contents of a directory in the Unity project. " +
    "Shows files and subdirectories with their types and sizes.";

  readonly inputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative directory path from project root. Default: '.' (project root)",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const relPath = String(input["path"] ?? ".");

    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    try {
      const entries = await readdir(pathCheck.fullPath, { withFileTypes: true });
      const lines: string[] = [];

      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted) {
        if (entry.isDirectory()) {
          lines.push(`  [DIR]  ${entry.name}/`);
        } else {
          try {
            const fileStat = await stat(resolve(pathCheck.fullPath, entry.name));
            const sizeKb = Math.round(fileStat.size / 1024);
            lines.push(`  [FILE] ${entry.name} (${sizeKb}KB)`);
          } catch {
            lines.push(`  [FILE] ${entry.name}`);
          }
        }
      }

      if (lines.length === 0) {
        return { content: `Directory is empty.` };
      }

      return {
        content: `Contents of '${relPath}' (${entries.length} items):\n${lines.join("\n")}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "Error: directory not found", isError: true };
      }
      return { content: "Error: could not list directory", isError: true };
    }
  }
}
