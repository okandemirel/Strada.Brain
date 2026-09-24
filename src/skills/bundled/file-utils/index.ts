// ---------------------------------------------------------------------------
// File Utils bundled skill — file analysis tools for stats, large files, and search.
//
// SEC-2: every path is resolved inside the session's project through the
// same path-guard as the built-in file tools, walks visit only regular files
// and skip sensitive paths entry by entry, reads and walks are bounded, and
// the caller's regex runs in a worker with a timeout (see ../../project-files.ts).
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { lstat } from "node:fs/promises";
import {
  MAX_SEARCH_PATTERN_LENGTH,
  readRegularFile,
  resolveProjectPath,
  searchLinesInWorker,
  walkProjectFiles,
  type ProjectWalk,
  type SearchableText,
} from "../../project-files.js";

/** Largest file `file_stats` reads. */
const MAX_STATS_FILE_BYTES = 16 * 1024 * 1024;
/** Largest single file `file_line_search` reads (the built-in grep's limit). */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Total bytes `file_line_search` reads in one call. */
const MAX_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024;

const PATH_HINT = "relative to the project root (an absolute path must be inside the project)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileWithSize {
  path: string;
  sizeBytes: number;
}

/**
 * Collect regular files of at least `minSizeBytes` under `dir`.
 * Returns paths relative to `dir`.
 */
async function findFilesWithSizes(dir: string, minSizeBytes: number, walk: ProjectWalk): Promise<FileWithSize[]> {
  const results: FileWithSize[] = [];
  for await (const file of walkProjectFiles(dir, walk)) {
    try {
      const st = await lstat(file.fullPath);
      if (st.isFile() && st.size >= minSizeBytes) {
        results.push({ path: file.relPath, sizeBytes: st.size });
      }
    } catch {
      // File vanished or unreadable — skip
    }
  }
  return results;
}

/** The text of the files under `dir`, within the per-file and total byte budgets. */
async function collectSearchableText(
  dir: string,
  walk: ProjectWalk,
): Promise<{ files: SearchableText[]; skippedLarge: number }> {
  const files: SearchableText[] = [];
  let totalBytes = 0;
  let skippedLarge = 0;
  for await (const file of walkProjectFiles(dir, walk)) {
    const read = await readRegularFile(file.fullPath, MAX_SEARCH_FILE_BYTES);
    if (read.kind === "too-large") {
      skippedLarge += 1;
      continue;
    }
    if (read.kind !== "text") continue;
    if (totalBytes + read.size > MAX_SEARCH_TOTAL_BYTES) {
      walk.truncated = true;
      break;
    }
    totalBytes += read.size;
    files.push({ file: file.relPath, text: read.text });
  }
  return { files, skippedLarge };
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

const TRUNCATED_NOTE = "\n\n[Scan limit reached — results may be incomplete; narrow the directory]";

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
        description: `Path to the file to analyze, ${PATH_HINT}`,
      },
    },
    required: ["path"],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const filePath = typeof input["path"] === "string" ? input["path"] : "";
    if (!filePath) {
      return { content: "Error: path parameter is required." };
    }

    const validation = await resolveProjectPath(context, filePath);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    const read = await readRegularFile(validation.fullPath, MAX_STATS_FILE_BYTES);
    if (read.kind === "error") {
      return { content: `Error: ${read.message}` };
    }
    if (read.kind === "not-a-file") {
      return { content: "Error: path is not a file." };
    }
    if (read.kind === "too-large") {
      return { content: `Error: file is too large to analyze (${formatBytes(read.size)}; limit ${formatBytes(MAX_STATS_FILE_BYTES)}).` };
    }

    const content = read.text;
    const lineCount = content.split("\n").length;
    const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
    const charCount = content.length;

    return {
      content: [
        `File: ${validation.fullPath}`,
        `Lines: ${lineCount}`,
        `Words: ${wordCount}`,
        `Characters: ${charCount}`,
        `Size: ${formatBytes(read.size)}`,
      ].join("\n"),
    };
  },
};

const fileFindLarge: ITool = {
  name: "file_find_large",
  description: "Find files larger than a given threshold in a project directory. Returns up to 20 results sorted by size (largest first).",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: `Root directory to search, ${PATH_HINT}`,
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
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const directory = typeof input["directory"] === "string" ? input["directory"] : "";
    if (!directory) {
      return { content: "Error: directory parameter is required." };
    }

    const validation = await resolveProjectPath(context, directory);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    const minSizeKb = typeof input["minSizeKb"] === "number" ? input["minSizeKb"] : 1024;
    const minSizeBytes = minSizeKb * 1024;
    const maxResults = 20;

    const walk: ProjectWalk = { truncated: false };
    const files = await findFilesWithSizes(validation.fullPath, minSizeBytes, walk);
    const truncatedNote = walk.truncated ? TRUNCATED_NOTE : "";

    if (files.length === 0) {
      return { content: `No files larger than ${formatBytes(minSizeBytes)} found.${truncatedNote}` };
    }

    // Sort by size descending and take top results
    files.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const top = files.slice(0, maxResults);

    const lines = top.map((f) => `${formatBytes(f.sizeBytes).padStart(10)}  ${f.path}`);
    return {
      content: `Found ${files.length} file(s) larger than ${formatBytes(minSizeBytes)}:\n${lines.join("\n")}${truncatedNote}`,
    };
  },
};

const fileLineSearch: ITool = {
  name: "file_line_search",
  description: "Search for a regex pattern in files within a project directory. Returns matching file:line pairs (max 50 results).",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: `Root directory to search, ${PATH_HINT}`,
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
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const directory = typeof input["directory"] === "string" ? input["directory"] : "";
    if (!directory) {
      return { content: "Error: directory parameter is required." };
    }

    const patternStr = typeof input["pattern"] === "string" ? input["pattern"] : "";
    if (!patternStr) {
      return { content: "Error: pattern parameter is required." };
    }
    if (patternStr.length > MAX_SEARCH_PATTERN_LENGTH) {
      return { content: `Error: pattern too long (max ${MAX_SEARCH_PATTERN_LENGTH} characters)`, isError: true };
    }
    try {
      // Compiling is safe on this thread; only matching can run away.
      new RegExp(patternStr);
    } catch (e) {
      return { content: `Error: Invalid regex: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    const validation = await resolveProjectPath(context, directory);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    const maxResults = 50;
    const walk: ProjectWalk = { truncated: false };
    const { files, skippedLarge } = await collectSearchableText(validation.fullPath, walk);
    let matches;
    try {
      matches = await searchLinesInWorker(patternStr, files, maxResults);
    } catch (e) {
      return { content: `Error: search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    if (matches === null) {
      return { content: "Error: the pattern took too long to evaluate and was stopped; simplify the regex.", isError: true };
    }

    const notes =
      (skippedLarge > 0 ? `\n\n[${skippedLarge} file(s) over ${formatBytes(MAX_SEARCH_FILE_BYTES)} were not searched]` : "") +
      (walk.truncated ? TRUNCATED_NOTE : "");

    if (matches.length === 0) {
      return { content: `No matches found for pattern "${patternStr}".${notes}` };
    }

    const lines = matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
    const suffix = matches.length >= maxResults ? `\n\n[Results limited to ${maxResults} matches]` : "";
    return {
      content: `Found ${matches.length} match(es) for "${patternStr}":\n${lines.join("\n")}${suffix}${notes}`,
    };
  },
};

export const tools = [fileStats, fileFindLarge, fileLineSearch];
export default tools;
