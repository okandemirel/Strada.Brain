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
