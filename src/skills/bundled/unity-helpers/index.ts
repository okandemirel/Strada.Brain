// ---------------------------------------------------------------------------
// Unity Helpers bundled skill — file-based tools for Unity project analysis.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/**
 * Sensitive path prefixes that must never be walked, regardless of the
 * directory argument supplied by the LLM or user.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /[/\\]\.ssh[/\\]?$/i,
  /[/\\]\.gnupg[/\\]?$/i,
  /[/\\]\.aws[/\\]?$/i,
  /[/\\]\.config[/\\]?$/i,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect files matching the given extension under `dir`.
 * Returns paths relative to `dir`.
 */
async function findFilesByExtension(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // Directory unreadable — skip silently
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(ext)) {
        results.push(relative(dir, fullPath));
      }
    }
  }

  await walk(dir);
  return results.sort();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const unityFindScripts: ITool = {
  name: "unity_find_scripts",
  description: "Recursively find all C# (.cs) script files in a Unity project directory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: "Root directory to search for .cs files",
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
    const files = await findFilesByExtension(validation.resolved, ".cs");
    if (files.length === 0) {
      return { content: "No .cs files found." };
    }
    return { content: `Found ${files.length} script(s):\n${files.join("\n")}` };
  },
};

const unityListScenes: ITool = {
  name: "unity_list_scenes",
  description: "Recursively find all Unity scene (.unity) files in a project directory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: "Root directory to search for .unity scene files",
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
    const files = await findFilesByExtension(validation.resolved, ".unity");
    if (files.length === 0) {
      return { content: "No .unity scene files found." };
    }
    return { content: `Found ${files.length} scene(s):\n${files.join("\n")}` };
  },
};

export const tools = [unityFindScripts, unityListScenes];
export default tools;
