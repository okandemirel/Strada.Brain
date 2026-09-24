import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, extname, relative, isAbsolute, sep } from "node:path";
import { glob, type Path } from "glob";
import { validatePath } from "../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { nearbyNames } from "./nearby-names.js";
import { RegexTimeoutError, WorkerLineMatcher, type LineMatchResult } from "./regex-line-matcher.js";

/**
 * Reject glob patterns that could escape the project directory.
 *
 * A fast, readable refusal for the obvious cases only: glob expands braces
 * AFTER this check, so an alternative can still be absolute or assemble a
 * `..` from pieces. Containment is enforced on what glob walks and returns
 * (see globInsideProject), not here.
 */
function isSafeGlobPattern(pattern: string): boolean {
  // Reject patterns with path traversal
  if (pattern.includes("..")) return false;
  // Reject absolute paths
  if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) return false;
  return true;
}

/** Does `candidate` (absolute or relative to `root`) resolve outside `root`? The root itself is not outside. */
function isOutsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(root, candidate));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Glob confined to the project root: directories outside it are never
 * walked, and a match outside it is never returned, whatever the pattern
 * expands to.
 */
async function globInsideProject(pattern: string, projectPath: string): Promise<string[]> {
  const root = resolve(projectPath);
  const outside = (p: Path): boolean => isOutsideRoot(root, p.fullpath());
  const matches = await glob(pattern, {
    cwd: projectPath,
    nodir: true,
    maxDepth: 20,
    ignore: { ignored: outside, childrenIgnored: outside },
  });
  return matches.filter((match) => !isOutsideRoot(root, match));
}

const MAX_RESULTS = 50;
const MAX_CONTENT_RESULTS = 20;
const MAX_REGEX_LENGTH = 500;
const MAX_GREP_FILE_SIZE = 1024 * 1024; // 1MB per file for grep
/**
 * Time one file's matching may take. An ordinary pattern needs milliseconds
 * for a whole 1MB file; only a backtracking blow-up comes near this.
 */
const GREP_FILE_MATCH_TIMEOUT_MS = 2_000;
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
      const matches = await globInsideProject(pattern, context.projectPath);

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
  private readonly matchTimeoutMs: number;

  constructor(options: { readonly matchTimeoutMs?: number } = {}) {
    this.matchTimeoutMs = options.matchTimeoutMs ?? GREP_FILE_MATCH_TIMEOUT_MS;
  }

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
          "Optional glob pattern to filter which files to search (e.g., '**/*.cs'). Default: '**/*'. " +
          `Only text source/asset files are opened (${[...SEARCHABLE_EXTENSIONS].join(", ")}); ` +
          "files with other extensions are counted and reported as not searched.",
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

    // Matching runs off the main thread under a per-file time limit (see
    // regex-line-matcher.ts): a pathological pattern used to freeze the
    // whole process, not just this call.
    const matcher = new WorkerLineMatcher(regex.source, regex.flags, this.matchTimeoutMs);
    try {
      const files = await globInsideProject(filePattern, context.projectPath);

      const results: string[] = [];
      // Audited 2026-09-02: the cap broke out of the file loop and the result
      // read "Found 20 match(es):" with no suffix — indistinguishable from a
      // genuine 20-match result, so an agent enumerating call sites treated
      // the capped slice as the full set. Glob and vault_search in this repo
      // both disclose truncation; grep did not. Track whether scanning
      // stopped and how far it got, and say so in the result.
      let filesScanned = 0;
      let capReached = false;
      let stoppedMidFile = false;
      // Audited 2026-09-02: files the extension filter dropped were never
      // counted, so grep_search{file_pattern:"**/*.mat"} answered "No matches
      // found" about files it never opened — an absence claim indistinguishable
      // from a genuine miss. Count them and say so.
      let skippedByExtension = 0;

      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const file = files[fileIndex]!;
        if (!SEARCHABLE_EXTENSIONS.has(extname(file).toLowerCase())) {
          skippedByExtension += 1;
          continue;
        }

        // Validate each file path to prevent directory traversal
        const pathCheck = await validatePath(context.projectPath, file);
        if (!pathCheck.valid) continue;

        const fullPath = pathCheck.fullPath;
        let content: string;
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_GREP_FILE_SIZE) continue;

          content = await readFile(fullPath, "utf-8");
        } catch {
          // Skip unreadable files
          continue;
        }
        filesScanned += 1;

        let matched: LineMatchResult;
        try {
          matched = await matcher.match(content, MAX_CONTENT_RESULTS - results.length);
        } catch (error) {
          if (!(error instanceof RegexTimeoutError)) throw error;
          return {
            content:
              `Error: the regex was stopped after running ${this.matchTimeoutMs / 1000}s on ${file} without finishing ` +
              `(${results.length} match(es) found before it). Nested or overlapping quantifiers such as (a+)+ or ` +
              "(\\w+\\s?)* can take exponential time on long lines; simplify the pattern and retry.",
            isError: true,
          };
        }
        for (const [i, line] of matched.hits) {
          results.push(`${file}:${i + 1}: ${line.trim()}`);
        }
        if (results.length >= MAX_CONTENT_RESULTS) {
          // The cap only makes the count non-exhaustive when something
          // was left unscanned: lines below the last hit, or files after it.
          const lastHit = matched.hits[matched.hits.length - 1]![0];
          stoppedMidFile = lastHit < matched.lineCount - 1;
          capReached = stoppedMidFile || fileIndex < files.length - 1;
          break;
        }
      }

      const skippedNote = skippedByExtension > 0
        ? `${skippedByExtension} of ${files.length} file(s) matching '${filePattern}' were NOT searched: ` +
          `their extension is outside the searchable set (${[...SEARCHABLE_EXTENSIONS].join(", ")}).`
        : "";

      if (results.length === 0) {
        if (filesScanned === 0 && skippedByExtension > 0) {
          return {
            content: `No files were searched for pattern: ${pattern} — ${skippedNote}`,
          };
        }
        return {
          content: `No matches found for pattern: ${pattern} in the ${filesScanned} file(s) searched.` +
            (skippedNote ? `\n${skippedNote}` : ""),
        };
      }

      const capNote = capReached
        ? ` (limit reached — scanning stopped after ${filesScanned} of ${files.length} files` +
          `${stoppedMidFile ? ", mid-file" : ""}; narrow file_pattern or the regex to see the rest)`
        : "";

      return {
        content: `Found ${results.length} match(es)${capNote}:\n${results.join("\n")}` +
          (skippedNote ? `\n(${skippedNote})` : ""),
      };
    } catch {
      return { content: "Error: search failed", isError: true };
    } finally {
      await matcher.close();
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
        // file_read has answered a miss with the names beside it since 2026-08-20;
        // listing a directory is the same question and was still answered with
        // four words that do not even repeat the path back. Measured 2026-08-21,
        // 12:12, mid-run: "Error: directory not found", and nothing to try next.
        return {
          content: `Error: directory not found: ${relPath}${await nearbyNames(pathCheck.fullPath)}`,
          isError: true,
        };
      }
      return { content: "Error: could not list directory", isError: true };
    }
  }
}
