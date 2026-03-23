// ---------------------------------------------------------------------------
// JSON Utils bundled skill — format, query, and diff JSON data.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string. Returns the parsed value or an error message.
 */
function safeParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }
}

/**
 * Parse a dot-path with bracket notation (e.g. "data.users[0].name") into
 * an array of string/number segments.
 */
function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const parts = path.split(".");

  for (const part of parts) {
    if (!part) continue;

    // Check for bracket notation: "users[0]" -> "users", 0
    const bracketMatch = part.match(/^([^[]*)\[(\d+)\]$/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      const index = parseInt(bracketMatch[2] as string, 10);
      if (key) segments.push(key);
      segments.push(index);
    } else {
      segments.push(part);
    }
  }

  return segments;
}

/**
 * Traverse an object/array by a list of path segments.
 */
function traversePath(obj: unknown, segments: (string | number)[]): { ok: true; value: unknown } | { ok: false; error: string } {
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return { ok: false, error: `Cannot access "${String(segment)}" on null/undefined` };
    }

    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return { ok: false, error: `Cannot index non-array with [${segment}]` };
      }
      if (segment < 0 || segment >= current.length) {
        return { ok: false, error: `Array index [${segment}] out of bounds (length: ${current.length})` };
      }
      current = current[segment];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) {
        return { ok: false, error: `Cannot access property "${segment}" on non-object` };
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return { ok: true, value: current };
}

interface Difference {
  type: "added" | "removed" | "changed";
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Recursively compare two values and collect differences.
 */
const MAX_DIFF_DEPTH = 50;
const MAX_DIFF_COUNT = 1000;

function diffValues(a: unknown, b: unknown, path: string, diffs: Difference[], depth = 0): void {
  // Guard against pathological input
  if (depth > MAX_DIFF_DEPTH || diffs.length >= MAX_DIFF_COUNT) return;

  // Same value (handles primitives and null)
  if (a === b) return;

  // Type mismatch or one is null
  if (typeof a !== typeof b || a === null || b === null) {
    diffs.push({ type: "changed", path: path || "(root)", oldValue: a, newValue: b });
    return;
  }

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      if (i >= a.length) {
        diffs.push({ type: "added", path: itemPath, newValue: b[i] });
      } else if (i >= b.length) {
        diffs.push({ type: "removed", path: itemPath, oldValue: a[i] });
      } else {
        diffValues(a[i], b[i], itemPath, diffs, depth + 1);
      }
    }
    return;
  }

  // One is array, other is not
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push({ type: "changed", path: path || "(root)", oldValue: a, newValue: b });
    return;
  }

  // Both objects
  if (typeof a === "object" && typeof b === "object") {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in objA)) {
        diffs.push({ type: "added", path: childPath, newValue: objB[key] });
      } else if (!(key in objB)) {
        diffs.push({ type: "removed", path: childPath, oldValue: objA[key] });
      } else {
        diffValues(objA[key], objB[key], childPath, diffs, depth + 1);
      }
    }
    return;
  }

  // Primitive values that differ
  diffs.push({ type: "changed", path: path || "(root)", oldValue: a, newValue: b });
}

/**
 * Format a diff entry into a human-readable line.
 */
function formatDiff(diff: Difference): string {
  switch (diff.type) {
    case "added":
      return `+ ${diff.path}: ${JSON.stringify(diff.newValue)}`;
    case "removed":
      return `- ${diff.path}: ${JSON.stringify(diff.oldValue)}`;
    case "changed":
      return `~ ${diff.path}: ${JSON.stringify(diff.oldValue)} -> ${JSON.stringify(diff.newValue)}`;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const jsonFormat: ITool = {
  name: "json_format",
  description: "Pretty-print or minify a JSON string.",
  inputSchema: {
    type: "object" as const,
    properties: {
      json: {
        type: "string",
        description: "The JSON string to format",
      },
      minify: {
        type: "boolean",
        description: "If true, minify instead of pretty-print (default: false)",
      },
    },
    required: ["json"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const raw = typeof input["json"] === "string" ? input["json"] : "";
    if (!raw) {
      return { content: "Error: json parameter is required." };
    }

    const parsed = safeParse(raw);
    if (!parsed.ok) {
      return { content: `Error: ${parsed.error}` };
    }

    const minify = typeof input["minify"] === "boolean" ? input["minify"] : false;
    const formatted = minify
      ? JSON.stringify(parsed.value)
      : JSON.stringify(parsed.value, null, 2);

    return { content: formatted };
  },
};

const jsonQuery: ITool = {
  name: "json_query",
  description: "Extract a value from JSON at a dot-path (supports bracket notation for arrays, e.g. 'data.users[0].name').",
  inputSchema: {
    type: "object" as const,
    properties: {
      json: {
        type: "string",
        description: "The JSON string to query",
      },
      path: {
        type: "string",
        description: "Dot-path to the value (e.g. 'data.users[0].name')",
      },
    },
    required: ["json", "path"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const raw = typeof input["json"] === "string" ? input["json"] : "";
    if (!raw) {
      return { content: "Error: json parameter is required." };
    }

    const path = typeof input["path"] === "string" ? input["path"] : "";
    if (!path) {
      return { content: "Error: path parameter is required." };
    }

    const parsed = safeParse(raw);
    if (!parsed.ok) {
      return { content: `Error: ${parsed.error}` };
    }

    const segments = parsePath(path);
    const result = traversePath(parsed.value, segments);
    if (!result.ok) {
      return { content: `Error: ${result.error}` };
    }

    const value = result.value;
    if (typeof value === "object" && value !== null) {
      return { content: JSON.stringify(value, null, 2) };
    }

    return { content: String(value) };
  },
};

const jsonDiff: ITool = {
  name: "json_diff",
  description: "Compare two JSON objects and return a list of differences (added, removed, changed) with paths.",
  inputSchema: {
    type: "object" as const,
    properties: {
      a: {
        type: "string",
        description: "First JSON string",
      },
      b: {
        type: "string",
        description: "Second JSON string",
      },
    },
    required: ["a", "b"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const rawA = typeof input["a"] === "string" ? input["a"] : "";
    if (!rawA) {
      return { content: "Error: a parameter is required." };
    }

    const rawB = typeof input["b"] === "string" ? input["b"] : "";
    if (!rawB) {
      return { content: "Error: b parameter is required." };
    }

    const parsedA = safeParse(rawA);
    if (!parsedA.ok) {
      return { content: `Error in a: ${parsedA.error}` };
    }

    const parsedB = safeParse(rawB);
    if (!parsedB.ok) {
      return { content: `Error in b: ${parsedB.error}` };
    }

    const diffs: Difference[] = [];
    diffValues(parsedA.value, parsedB.value, "", diffs);

    if (diffs.length === 0) {
      return { content: "No differences found." };
    }

    const lines = diffs.map(formatDiff);
    return { content: `Found ${diffs.length} difference(s):\n${lines.join("\n")}` };
  },
};

export const tools = [jsonFormat, jsonQuery, jsonDiff];
export default tools;
