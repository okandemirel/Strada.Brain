// ---------------------------------------------------------------------------
// Unity Helpers bundled skill — file-based tools for Unity project analysis.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

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
    const files = await findFilesByExtension(directory, ".cs");
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
    const files = await findFilesByExtension(directory, ".unity");
    if (files.length === 0) {
      return { content: "No .unity scene files found." };
    }
    return { content: `Found ${files.length} scene(s):\n${files.join("\n")}` };
  },
};

export const tools = [unityFindScripts, unityListScenes];
export default tools;
