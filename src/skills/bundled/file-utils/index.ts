// ---------------------------------------------------------------------------
// File Utils bundled skill — file analysis tools for stats, large files, and search.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/**
 * Sensitive path prefixes that must never be walked, regardless of the
 * directory argument supplied by the LLM or user.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /[/\\]\.ssh([/\\]|$)/i,
  /[/\\]\.gnupg([/\\]|$)/i,
  /[/\\]\.aws([/\\]|$)/i,
  /[/\\]\.config([/\\]|$)/i,
  /^\/etc(\/|$)/,
  /^\/root(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
];

/**
 * Resolve and validate the directory path. Rejects null bytes, symlink
 * escapes to non-existent ancestors, and sensitive system directories.
 */
async function resolveAndValidateDir(directory: string): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  if (directory.includes("\0")) {
    return { ok: false, error: "Directory path contains invalid characters." };
  }

  const normalized = resolve(directory);

  // Resolve symlinks so a symlink pointing to /etc cannot bypass the check
  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    // Path does not exist yet or is unreadable — use normalize without realpath
    resolved = normalized;
  }

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      return { ok: false, error: "Access to this directory is not permitted." };
    }
  }

  return { ok: true, resolved };
}

/**
 * Validate a file path for security: no null bytes, resolve realpath,
 * reject sensitive paths.
 */
async function resolveAndValidateFile(filePath: string): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  if (filePath.includes("\0")) {
    return { ok: false, error: "File path contains invalid characters." };
  }

  const normalized = resolve(filePath);

  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    resolved = normalized;
  }

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      return { ok: false, error: "Access to this file is not permitted." };
    }
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileWithSize {
  path: string;
  sizeBytes: number;
}

/**
 * Recursively collect files and their sizes under `dir`.
 * Returns paths relative to `dir`.
 */
async function findFilesWithSizes(dir: string, minSizeBytes: number): Promise<FileWithSize[]> {
  const results: FileWithSize[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        try {
          const st = await stat(fullPath);
          if (st.size >= minSizeBytes) {
            results.push({ path: relative(dir, fullPath), sizeBytes: st.size });
          }
        } catch {
          // File unreadable — skip
        }
      }
    }
  }

  await walk(dir);
  return results;
}

interface LineMatch {
  file: string;
  line: number;
  text: string;
}

/**
 * Search for a regex pattern in all files under `dir`.
 * Returns matching file:line pairs.
 */
async function searchFilesForPattern(dir: string, pattern: RegExp, maxResults: number): Promise<LineMatch[]> {
  const results: LineMatch[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        try {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) return;
            const line = lines[i] ?? "";
            if (pattern.test(line)) {
              results.push({
                file: relative(dir, fullPath),
                line: i + 1,
                text: line.trim(),
              });
            }
          }
        } catch {
          // File unreadable (binary, permissions, etc.) — skip
        }
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Format byte sizes into human-readable strings.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const fileStats: ITool = {
  name: "file_stats",
  description: "Get file statistics: line count, word count, character count, and file size.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Path to the file to analyze",
      },
    },
    required: ["path"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const filePath = typeof input["path"] === "string" ? input["path"] : "";
    if (!filePath) {
      return { content: "Error: path parameter is required." };
    }

    const validation = await resolveAndValidateFile(filePath);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    try {
      const [content, fileStat] = await Promise.all([
        readFile(validation.resolved, "utf-8"),
        stat(validation.resolved),
      ]);

      if (!fileStat.isFile()) {
        return { content: "Error: path is not a file." };
      }

      const lines = content.split("\n");
      const lineCount = lines.length;
      const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
      const charCount = content.length;
      const sizeBytes = fileStat.size;

      return {
        content: [
          `File: ${validation.resolved}`,
          `Lines: ${lineCount}`,
          `Words: ${wordCount}`,
          `Characters: ${charCount}`,
          `Size: ${formatBytes(sizeBytes)}`,
        ].join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: ${message}` };
    }
  },
};

const fileFindLarge: ITool = {
  name: "file_find_large",
  description: "Find files larger than a given threshold in a directory. Returns up to 20 results sorted by size (largest first).",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: "Root directory to search",
      },
      minSizeKb: {
        type: "number",
        description: "Minimum file size in KB (default: 1024 = 1MB)",
      },
    },
    required: ["directory"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const directory = typeof input["directory"] === "string" ? input["directory"] : "";
    if (!directory) {
      return { content: "Error: directory parameter is required." };
    }

    const validation = await resolveAndValidateDir(directory);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    const minSizeKb = typeof input["minSizeKb"] === "number" ? input["minSizeKb"] : 1024;
    const minSizeBytes = minSizeKb * 1024;
    const maxResults = 20;

    const files = await findFilesWithSizes(validation.resolved, minSizeBytes);

    if (files.length === 0) {
      return { content: `No files larger than ${formatBytes(minSizeBytes)} found.` };
    }

    // Sort by size descending and take top results
    files.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const top = files.slice(0, maxResults);

    const lines = top.map((f) => `${formatBytes(f.sizeBytes).padStart(10)}  ${f.path}`);
    return {
      content: `Found ${files.length} file(s) larger than ${formatBytes(minSizeBytes)}:\n${lines.join("\n")}`,
    };
  },
};

const fileLineSearch: ITool = {
  name: "file_line_search",
  description: "Search for a regex pattern in files within a directory. Returns matching file:line pairs (max 50 results).",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: "Root directory to search",
      },
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
    },
    required: ["directory", "pattern"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const directory = typeof input["directory"] === "string" ? input["directory"] : "";
    if (!directory) {
      return { content: "Error: directory parameter is required." };
    }

    const patternStr = typeof input["pattern"] === "string" ? input["pattern"] : "";
    if (!patternStr) {
      return { content: "Error: pattern parameter is required." };
    }

    const validation = await resolveAndValidateDir(directory);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    let regex: RegExp;
    try {
      // Reject obviously dangerous patterns that may cause catastrophic backtracking (ReDoS)
      if (/(\+\+|\*\*|\{\d{3,}\})/.test(patternStr)) {
        return { content: "Pattern rejected: potentially unsafe regex", isError: true };
      }
      regex = new RegExp(patternStr);
    } catch (e) {
      return { content: `Error: Invalid regex: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    const maxResults = 50;
    const matches = await searchFilesForPattern(validation.resolved, regex, maxResults);

    if (matches.length === 0) {
      return { content: `No matches found for pattern "${patternStr}".` };
    }

    const lines = matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
    const suffix = matches.length >= maxResults ? `\n\n[Results limited to ${maxResults} matches]` : "";
    return {
      content: `Found ${matches.length} match(es) for "${patternStr}":\n${lines.join("\n")}${suffix}`,
    };
  },
};

export const tools = [fileStats, fileFindLarge, fileLineSearch];
export default tools;
