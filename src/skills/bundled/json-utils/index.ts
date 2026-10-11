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

const MAX_DIFF_DEPTH = 50;
const MAX_DIFF_COUNT = 1000;
const MAX_NAMED_DEEP_PATHS = 5;

/**
 * The differences a walk collected, and what its limits kept it from comparing.
 * Both limits used to end the walk silently, so nesting past depth 50 read as
 * "No differences found." and a capped list as the complete one.
 */
interface DiffWalk {
  diffs: Difference[];
  /** Pairs of unequal values past MAX_DIFF_DEPTH that were not compared. */
  deepSkipped: number;
  deepPaths: string[];
  /** The walk reached MAX_DIFF_COUNT with input still left to compare. */
  countCapped: boolean;
}

function record(walk: DiffWalk, diff: Difference): void {
  if (walk.diffs.length >= MAX_DIFF_COUNT) {
    walk.countCapped = true;
    return;
  }
  walk.diffs.push(diff);
}

/**
 * Recursively compare two values and collect differences.
 */
function diffValues(a: unknown, b: unknown, path: string, walk: DiffWalk, depth = 0): void {
  // Same value (handles primitives and null)
  if (a === b) return;

  // Guard against pathological input
  if (walk.diffs.length >= MAX_DIFF_COUNT) {
    walk.countCapped = true;
    return;
  }
  if (depth > MAX_DIFF_DEPTH) {
    walk.deepSkipped++;
    if (walk.deepPaths.length < MAX_NAMED_DEEP_PATHS) walk.deepPaths.push(path || "(root)");
    return;
  }

  // Type mismatch or one is null
  if (typeof a !== typeof b || a === null || b === null) {
    record(walk, { type: "changed", path: path || "(root)", oldValue: a, newValue: b });
    return;
  }

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      if (i >= a.length) {
        record(walk, { type: "added", path: itemPath, newValue: b[i] });
      } else if (i >= b.length) {
        record(walk, { type: "removed", path: itemPath, oldValue: a[i] });
      } else {
        diffValues(a[i], b[i], itemPath, walk, depth + 1);
      }
      if (walk.countCapped) return;
    }
    return;
  }

  // One is array, other is not
  if (Array.isArray(a) !== Array.isArray(b)) {
    record(walk, { type: "changed", path: path || "(root)", oldValue: a, newValue: b });
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
        record(walk, { type: "added", path: childPath, newValue: objB[key] });
      } else if (!(key in objB)) {
        record(walk, { type: "removed", path: childPath, oldValue: objA[key] });
      } else {
        diffValues(objA[key], objB[key], childPath, walk, depth + 1);
      }
      if (walk.countCapped) return;
    }
    return;
  }

  // Primitive values that differ
  record(walk, { type: "changed", path: path || "(root)", oldValue: a, newValue: b });
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
      return { content: "Error: json parameter is required.", isError: true };
    }

    const parsed = safeParse(raw);
    if (!parsed.ok) {
      return { content: `Error: ${parsed.error}`, isError: true };
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
      return { content: "Error: json parameter is required.", isError: true };
    }

    const path = typeof input["path"] === "string" ? input["path"] : "";
    if (!path) {
      return { content: "Error: path parameter is required.", isError: true };
    }

    const parsed = safeParse(raw);
    if (!parsed.ok) {
      return { content: `Error: ${parsed.error}`, isError: true };
    }

    const segments = parsePath(path);
    const result = traversePath(parsed.value, segments);
    if (!result.ok) {
      return { content: `Error: ${result.error}`, isError: true };
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
  description:
    "Compare two JSON objects and return a list of differences (added, removed, changed) with paths. " +
    `Lists at most ${MAX_DIFF_COUNT} differences and compares ${MAX_DIFF_DEPTH} levels deep; the result says when a limit was reached.`,
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
      return { content: "Error: a parameter is required.", isError: true };
    }

    const rawB = typeof input["b"] === "string" ? input["b"] : "";
    if (!rawB) {
      return { content: "Error: b parameter is required.", isError: true };
    }

    const parsedA = safeParse(rawA);
    if (!parsedA.ok) {
      return { content: `Error in a: ${parsedA.error}`, isError: true };
    }

    const parsedB = safeParse(rawB);
    if (!parsedB.ok) {
      return { content: `Error in b: ${parsedB.error}`, isError: true };
    }

    const walk: DiffWalk = { diffs: [], deepSkipped: 0, deepPaths: [], countCapped: false };
    diffValues(parsedA.value, parsedB.value, "", walk);

    const notes: string[] = [];
    if (walk.countCapped) {
      notes.push(`Listing stopped at ${MAX_DIFF_COUNT} differences; the rest of the input was not compared.`);
    }
    if (walk.deepSkipped > 0) {
      const more = walk.deepSkipped > walk.deepPaths.length ? ", ..." : "";
      notes.push(
        `${walk.deepSkipped} value pair(s) nested deeper than ${MAX_DIFF_DEPTH} levels were not compared, under: ${walk.deepPaths.join(", ")}${more}.`,
      );
    }
    const noteText = notes.map((note) => `\n\n[${note}]`).join("");

    if (walk.diffs.length === 0) {
      return {
        content: notes.length === 0
          ? "No differences found."
          : `Comparison incomplete: no differences in the part compared.${noteText}`,
      };
    }

    const lines = walk.diffs.map(formatDiff);
    const count = walk.countCapped ? `at least ${walk.diffs.length}` : `${walk.diffs.length}`;
    return { content: `Found ${count} difference(s):\n${lines.join("\n")}${noteText}` };
  },
};

export const tools = [jsonFormat, jsonQuery, jsonDiff];
export default tools;
