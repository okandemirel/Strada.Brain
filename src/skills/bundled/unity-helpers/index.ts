// ---------------------------------------------------------------------------
// Unity Helpers bundled skill — file-based tools for Unity project analysis.
//
// SEC-2: the directory is resolved inside the session's project through the
// same path-guard as the built-in file tools, and the walk visits only
// regular files, skips sensitive paths entry by entry and is bounded (see
// ../../project-files.ts).
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { resolveProjectPath, walkProjectFiles, type ProjectWalk } from "../../project-files.js";

const PATH_HINT = "relative to the project root (an absolute path must be inside the project)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect regular files with the given extension under `dir`.
 * Returns paths relative to `dir`.
 */
async function findFilesByExtension(dir: string, ext: string, walk: ProjectWalk): Promise<string[]> {
  const results: string[] = [];
  for await (const file of walkProjectFiles(dir, walk)) {
    if (file.relPath.endsWith(ext)) results.push(file.relPath);
  }
  return results.sort();
}

/** Resolve the `directory` argument inside the project and list the files with `ext` under it. */
async function listFilesByExtension(
  input: Record<string, unknown>,
  context: ToolContext,
  ext: string,
  found: (count: number) => string,
  none: string,
): Promise<ToolExecutionResult> {
  const directory = typeof input["directory"] === "string" ? input["directory"] : "";
  if (!directory) {
    return { content: "Error: directory parameter is required." };
  }
  const validation = await resolveProjectPath(context, directory);
  if (!validation.ok) {
    return { content: `Error: ${validation.error}` };
  }
  const walk: ProjectWalk = { truncated: false };
  const files = await findFilesByExtension(validation.fullPath, ext, walk);
  const truncatedNote = walk.truncated ? "\n\n[Scan limit reached — the list may be incomplete; narrow the directory]" : "";
  if (files.length === 0) {
    return { content: `${none}${truncatedNote}` };
  }
  return { content: `${found(files.length)}:\n${files.join("\n")}${truncatedNote}` };
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
        description: `Root directory to search for .cs files, ${PATH_HINT}`,
      },
    },
    required: ["directory"],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return listFilesByExtension(input, context, ".cs", (n) => `Found ${n} script(s)`, "No .cs files found.");
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
        description: `Root directory to search for .unity scene files, ${PATH_HINT}`,
      },
    },
    required: ["directory"],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return listFilesByExtension(input, context, ".unity", (n) => `Found ${n} scene(s)`, "No .unity scene files found.");
  },
};

export const tools = [unityFindScripts, unityListScenes];
export default tools;
