/**
 * SWE-Sharp-Bench dataset decoding.
 *
 * The FAIL_TO_PASS and PASS_TO_PASS columns are not JSON. They are Python repr
 * strings, single-quoted:
 *
 *   "['Clean.Architecture.FunctionalTests.ControllerApis.ProjectCreate.CreateProject']"
 *
 * JSON.parse throws on those, and a parser that swallows the throw and returns
 * an empty list is worse than one that crashes: a task with no required tests
 * scores as trivially resolved, so every task passes and the benchmark reports
 * a perfect score while measuring nothing at all. That is the failure this
 * module exists to prevent, which is why parsing is strict and separately
 * tested rather than inlined into the fetch script.
 */

import path from "node:path";
import { z } from "zod";

/**
 * Parses a Python repr list of strings.
 *
 * Throws on anything it does not fully understand. The caller must not paper
 * over that — an unparseable test list means the task cannot be scored, and
 * pretending otherwise silently inflates the result.
 */
export function parsePythonStringList(raw: string): string[] {
  const text = raw.trim();
  if (text === "") return [];
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new Error(`Not a list literal: ${truncate(text)}`);
  }

  const body = text.slice(1, -1).trim();
  if (body === "") return [];

  const out: string[] = [];
  let i = 0;

  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length) break;

    const quote = body[i];
    if (quote !== "'" && quote !== '"') {
      throw new Error(`Expected a quoted string at index ${i}: ${truncate(body)}`);
    }
    i++;

    let value = "";
    let closed = false;
    while (i < body.length) {
      const ch = body[i]!;
      if (ch === "\\") {
        // Python escapes that can appear in a test name; anything else keeps
        // its literal backslash rather than being silently dropped.
        const next = body[i + 1];
        if (next === undefined) throw new Error(`Trailing escape in: ${truncate(body)}`);
        value += ESCAPES[next] ?? `\\${next}`;
        i += 2;
        continue;
      }
      if (ch === quote) {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    if (!closed) throw new Error(`Unterminated string in: ${truncate(body)}`);
    out.push(value);
  }

  return out;
}

const ESCAPES: Record<string, string> = {
  "'": "'",
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
};

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/**
 * Accepts either shape the column can arrive in — a real array (some exports)
 * or the Python repr string (the HTTP rows API) — and never returns an empty
 * list to signal failure.
 */
export function decodeTestList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return parsePythonStringList(value);
  throw new Error(`Unsupported test-list value of type ${typeof value}`);
}

export interface SweSharpTask {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
  /** Reference solution. Scoring context and gold-patch control runs only —
   *  feeding it to the agent under evaluation would measure nothing. */
  readonly goldPatch: string;
  readonly testPatch: string;
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

// ─── Validation (CMP-3) ────────────────────────────────────────────────────────
//
// A task row is external data: `--tasks <file>` and fetch-tasks.mjs take rows
// from a remote dataset. Its fields reach `git` argv, a clone URL, directory
// names and `fs.rmSync`, so every row is validated before any of that happens.

/** The files a unified diff touches (both sides), `/dev/null` excluded. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const both = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (both) {
      paths.add(both[1]!);
      paths.add(both[2]!);
      continue;
    }
    const minus = /^--- a\/(.+)$/.exec(line);
    if (minus) paths.add(minus[1]!);
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus) paths.add(plus[1]!);
  }
  paths.delete("/dev/null");
  return [...paths].sort();
}

/**
 * A path that stays inside a checkout on every platform: relative (no root, no
 * drive), no `..` segment under either separator, nothing inside `.git`, and
 * no leading `:` that git would read as pathspec magic.
 */
export function isSafeRepoRelativePath(rel: string): boolean {
  if (rel.length === 0 || rel.includes("\0") || rel.startsWith(":")) return false;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split(/[\\/]+/).some((segment) => segment === ".." || segment.toLowerCase() === ".git");
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const isDotName = (s: string): boolean => s === "." || s === "..";

const SweSharpTaskSchema = z.object({
  // Becomes a directory name under the cache: a plain name, never a path.
  instanceId: z.string().max(200).regex(SAFE_NAME).refine((s) => !isDotName(s), "must not be . or .."),
  // owner/name on GitHub — the clone URL is built from it (repoCloneUrl).
  repo: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
    .refine((s) => !s.split("/").some(isDotName), "owner and name must not be . or .."),
  // A commit id, and nothing git could read as an option.
  baseCommit: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "must be a 7-40 character hex commit id"),
  problemStatement: z.string(),
  goldPatch: z.string(),
  testPatch: z.string().superRefine((patch, ctx) => {
    const unsafe = patchPaths(patch).filter((rel) => !isSafeRepoRelativePath(rel));
    if (unsafe.length > 0) {
      ctx.addIssue({ code: "custom", message: `touches paths outside the checkout: ${unsafe.slice(0, 3).join(", ")}` });
    }
  }),
  failToPass: z.array(z.string()),
  passToPass: z.array(z.string()),
});

/** Validates one task row. Throws naming the row and the field that is wrong. */
export function parseSweSharpTask(row: unknown, label = "task"): SweSharpTask {
  const parsed = SweSharpTaskSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  const id = typeof (row as { instanceId?: unknown } | null)?.instanceId === "string"
    ? ` ${truncate(String((row as { instanceId: string }).instanceId))}`
    : "";
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(row)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}${id}: ${issues}`);
}

/** Validates a whole task list; the first invalid row stops it. */
export function parseSweSharpTasks(rows: unknown): SweSharpTask[] {
  if (!Array.isArray(rows)) throw new Error("tasks must be an array");
  return rows.map((row, index) => parseSweSharpTask(row, `task #${index}`));
}

/** The https clone URL for a validated `owner/name`. */
export function repoCloneUrl(repo: string): string {
  const url = new URL(`https://github.com/${repo}.git`);
  if (url.protocol !== "https:" || url.host !== "github.com" || url.pathname !== `/${repo}.git`) {
    throw new Error(`Refusing clone URL for repo ${truncate(repo)}`);
  }
  return url.href;
}

/**
 * Picks a fixed-size subset spread across repositories.
 *
 * Sorting by instance id and slicing looks deterministic and is — but it also
 * clusters: the first 50 ids of this dataset come from only 3 of its
 * repositories, so the "50-task subset" would measure three codebases and
 * generalise to nothing. Round-robin over repos keeps the determinism and
 * spends the budget on breadth.
 */
export function selectSubset<T extends { instanceId: string; repo: string }>(
  tasks: readonly T[],
  count: number,
): T[] {
  const byRepo = new Map<string, T[]>();
  for (const task of [...tasks].sort((a, b) => a.instanceId.localeCompare(b.instanceId))) {
    const list = byRepo.get(task.repo);
    if (list) list.push(task);
    else byRepo.set(task.repo, [task]);
  }

  // Repo order is sorted, not insertion order, so the result does not depend on
  // the order the API happened to return rows in.
  const repos = [...byRepo.keys()].sort();
  const picked: T[] = [];
  for (let round = 0; picked.length < count; round++) {
    let addedThisRound = false;
    for (const repo of repos) {
      const task = byRepo.get(repo)![round];
      if (!task) continue;
      picked.push(task);
      addedThisRound = true;
      if (picked.length === count) break;
    }
    if (!addedThisRound) break; // every repo exhausted
  }
  return picked;
}
