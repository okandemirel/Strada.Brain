// ---------------------------------------------------------------------------
// Project-confined file access for the bundled file skills (SEC-2).
//
// `file-utils` and `unity-helpers` resolved their path argument against
// process.cwd() — the install directory, not the project — checked only the
// starting directory against a short list of their own, and then walked
// everything under it. Every path now goes through the path-guard the
// built-in file tools use (`validatePath`: confined to the session's project,
// realpath-checked, sensitive-file blocklist), the walk re-checks every entry
// it visits, and every read and walk is bounded.
// ---------------------------------------------------------------------------

import { constants as fsConstants } from "node:fs";
import { opendir, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { ToolContext } from "../agents/tools/tool.interface.js";
import { openNoFollow } from "../security/open-no-follow.js";
import { isSensitivePath, validatePath } from "../security/path-guard.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export type ProjectPathResult =
  | { readonly ok: true; readonly fullPath: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a tool's path argument inside the session's project, exactly as
 * file_read does: relative to the project root (never the process cwd),
 * realpath-confined, and refused when it matches the sensitive-file blocklist.
 */
export async function resolveProjectPath(context: ToolContext, input: string): Promise<ProjectPathResult> {
  const projectRoot = context.projectPath;
  if (typeof projectRoot !== "string" || projectRoot === "") {
    return { ok: false, error: "No project directory is set for this session." };
  }
  const check = await validatePath(projectRoot, input);
  if (!check.valid) return { ok: false, error: check.error ?? "Access to this path is not permitted." };
  // The blocklist names directories by what sits under them (`.ssh/…`), so a
  // directory argument is checked in that form too.
  if (isSensitivePath(check.fullPath + sep)) {
    return { ok: false, error: "Access to sensitive files is not permitted" };
  }
  return { ok: true, fullPath: check.fullPath };
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/** Budget for one walk. */
export interface ProjectWalkLimits {
  /** Directory levels descended below the starting directory. */
  readonly maxDepth: number;
  /** Directory entries examined in total (files, directories and anything else). */
  readonly maxEntries: number;
}

export const DEFAULT_PROJECT_WALK_LIMITS: ProjectWalkLimits = Object.freeze({ maxDepth: 20, maxEntries: 50_000 });

/** Progress of a walk: set when it stopped at a limit, so its results are partial. */
export interface ProjectWalk {
  truncated: boolean;
}

export interface ProjectFile {
  readonly fullPath: string;
  /** Relative to the directory the walk started from. */
  readonly relPath: string;
}

/**
 * Yield every regular file under `root` (a directory accepted by
 * {@link resolveProjectPath}). Entries are typed without following links, so
 * a symlink — to a file or a directory, inside or outside the project — is
 * never visited, and neither is a FIFO, socket or device. Every entry is
 * checked against the sensitive-file blocklist, directories included. The
 * walk stops at `limits` and records that in `walk.truncated`.
 */
export async function* walkProjectFiles(
  root: string,
  walk: ProjectWalk,
  limits: ProjectWalkLimits = DEFAULT_PROJECT_WALK_LIMITS,
): AsyncGenerator<ProjectFile> {
  let examined = 0;
  async function* visit(dir: string, depth: number): AsyncGenerator<ProjectFile> {
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      if (walk.truncated) return;
      if (++examined > limits.maxEntries) {
        walk.truncated = true;
        return;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isSensitivePath(fullPath + sep)) continue;
        if (depth >= limits.maxDepth) {
          walk.truncated = true;
          continue;
        }
        yield* visit(fullPath, depth + 1);
      } else if (entry.isFile() && !isSensitivePath(fullPath)) {
        yield { fullPath, relPath: relative(root, fullPath) };
      }
    }
  }
  yield* visit(root, 0);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * O_NONBLOCK where the platform has it (absent on Windows → 0). The final
 * symlink is refused by openNoFollow, which also covers Windows: it has no
 * O_NOFOLLOW, and a link swapped in after validation was read through.
 */
const READ_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

export type RegularFileRead =
  | { readonly kind: "text"; readonly text: string; readonly size: number }
  | { readonly kind: "too-large"; readonly size: number }
  | { readonly kind: "not-a-file" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Read a regular file of at most `maxBytes` as UTF-8. It is opened without
 * following a final symlink and without blocking on a FIFO, and what was
 * opened is checked with fstat, so only a regular file is ever read — and
 * never more than `maxBytes` of it.
 */
export async function readRegularFile(fullPath: string, maxBytes: number): Promise<RegularFileRead> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(fullPath, READ_FLAGS);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: "not-a-file" };
    if (st.size > maxBytes) return { kind: "too-large", size: st.size };
    const buffer = Buffer.alloc(st.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { kind: "text", text: buffer.subarray(0, filled).toString("utf-8"), size: st.size };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Regex search off the main thread
// ---------------------------------------------------------------------------

/** Longest pattern accepted (the built-in grep_search's limit). */
export const MAX_SEARCH_PATTERN_LENGTH = 500;
/** How long one search may run before it is abandoned. */
export const LINE_SEARCH_TIMEOUT_MS = 3_000;
/** Longest matching line returned, in characters. */
const MAX_MATCH_TEXT_CHARS = 400;

export interface LineMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchableText {
  readonly file: string;
  readonly text: string;
}

// The worker loads worker_threads via process.getBuiltinModule, not require():
// this package bans require( in source (src/no-require-in-esm.test.ts).
const LINE_SEARCH_WORKER = `
"use strict";
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { source, files, maxResults, maxChars } = workerData;
const regex = new RegExp(source);
const matches = [];
search: for (const { file, text } of files) {
  const lines = text.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    const trimmed = lines[i].trim();
    matches.push({ file, line: i + 1, text: trimmed.length > maxChars ? trimmed.slice(0, maxChars) + "..." : trimmed });
    if (matches.length >= maxResults) break search;
  }
}
parentPort.postMessage(matches);
`;

/**
 * Test a caller-supplied regex against every line of `files` in a worker
 * thread. A pattern that backtracks catastrophically then costs at most
 * `timeoutMs` and never blocks the event loop every channel shares; the
 * worker is terminated and the promise resolves `null`.
 */
export function searchLinesInWorker(
  source: string,
  files: readonly SearchableText[],
  maxResults: number,
  timeoutMs: number = LINE_SEARCH_TIMEOUT_MS,
): Promise<LineMatch[] | null> {
  return new Promise((resolveSearch, rejectSearch) => {
    const worker = new Worker(LINE_SEARCH_WORKER, {
      eval: true,
      workerData: { source, files, maxResults, maxChars: MAX_MATCH_TEXT_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    const timer = setTimeout(() => settle(() => resolveSearch(null)), timeoutMs);
    worker.once("message", (matches: LineMatch[]) => settle(() => resolveSearch(matches)));
    worker.once("error", (err) => settle(() => rejectSearch(err)));
    worker.once("exit", (code) => settle(() => rejectSearch(new Error(`search worker exited with code ${code}`))));
  });
}
