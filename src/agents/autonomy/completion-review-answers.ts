/**
 * Which later success answers a failed step, as recorded and measured.
 *
 * A failure answered by a later success no longer needs a repair, only a
 * verification; the unverifiable-failure exit (verifier-pipeline-unverifiable.ts)
 * closes it when nothing here can verify. So an answer counted here that is
 * not one lets a broken result through. Each rule below exists because QA of
 * #41 measured the looser one letting a failure through:
 * - 2026-11-15: any later success of the same tool. `node main.js` crashed, a
 *   file was edited, `ls` succeeded, and the crash read as re-run.
 * - 2026-11-16: any later write of the same writer. notes/alpha.txt failed,
 *   notes/beta.txt was written, and alpha, never written, read as redone.
 * - 2026-11-16: any later write of a file with the same name. packages/a/index.js
 *   failed, packages/b/index.js was written; a deletion of services/a/config.json
 *   failed, services/b/config.json was deleted, and both read as answered.
 *
 * What is left, each read from the record or measured on disk:
 * - any tool: the same call, tool and input, run again and succeeding;
 * - a writer that creates a file (file_write, file_create): the same path
 *   written later; or a file of the same name written later in another
 *   directory, only when the failed path cannot exist, measured now: one of
 *   its directories is a file in the project root (golden run 4: README.md is
 *   a file, so README.md/kappa.txt cannot be written). The name alone answers
 *   nothing (packages/a/index.js); the measurement alone does not either
 *   (README.md/alpha.txt failed and only notes/beta.txt was written). Two
 *   more facts must hold, or the record cannot say the failed path was
 *   impossible before the run touched it, or that the task wanted only one
 *   file of that name (QA of #41 and #88, 2026-11-16):
 *   - the blocking file was not made by this run: no successful step named
 *     it, and no successful writer ran that names no path (shell_exec may
 *     make any file), since then the record cannot tell;
 *   - the task names no other path with that file name that no step wrote
 *     ("Create notes/alpha.txt and docs/alpha.txt": docs/alpha.txt written
 *     answers nothing for notes/alpha.txt).
 * Every other tool, the deletions, edits, renames and generators among the
 * writers included, is answered only by the same call. Anything that cannot be
 * read or measured is not an answer.
 */

import { statSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { isStrictlyInside } from "../../common/path-containment.js";
import type { StepResult } from "../agent-state.js";
import { MUTATION_TOOLS } from "./constants.js";

/** A failed step and the later success that answered it. */
export interface FailureAnswer {
  readonly tool: string;
  /** The first line of what the failed step reported. */
  readonly error: string;
  /**
   * `rerun`: the same call, tool and input, succeeded later. `same-path`: the
   * same file-creating writer later wrote the path that failed. `same-name`:
   * the path that failed cannot exist (`blockedBy`), and the same writer later
   * wrote a file of that name in another directory.
   */
  readonly kind: "rerun" | "same-path" | "same-name";
  /** The path the failed call named, when it named one. */
  readonly failedTarget?: string;
  /** The path the answering write named (`same-path`, `same-name`). */
  readonly answerTarget?: string;
  /** `same-name`: the failed path's directory that was measured to be a file, relative to the project root. */
  readonly blockedBy?: string;
}

/** Writers that create the file they name: the only tools a write of the path, or of its name, may answer. */
const FILE_CREATING_WRITERS: ReadonlySet<string> = new Set(["file_write", "file_create"]);

/** The run a failure belongs to: every step it recorded, and the task it was given. */
export interface FailureRun {
  readonly steps: readonly StepResult[];
  readonly task: string;
}

/**
 * Which later success answers `step`, if any. `projectRoot` is the root the
 * run's tools write in, where a same-name answer is measured; without it, no
 * same-name answer counts.
 */
export function failureAnsweredBy(
  step: StepResult,
  later: readonly StepResult[],
  projectRoot: string | undefined,
  run: FailureRun,
): FailureAnswer | null {
  const base = {
    tool: step.toolName,
    error: step.summary.split("\n")[0]!.trim(),
    ...(step.targetPath !== undefined ? { failedTarget: step.targetPath } : {}),
  };
  const sameTool = later.filter((next) => next.success && next.toolName === step.toolName);
  if (step.inputSignature !== undefined && sameTool.some((next) => next.inputSignature === step.inputSignature)) {
    return { ...base, kind: "rerun" };
  }
  if (!FILE_CREATING_WRITERS.has(step.toolName) || step.targetPath === undefined) return null;
  const failed = pathSpelling(step.targetPath);
  const samePath = sameTool.find((next) => next.targetPath !== undefined && pathSpelling(next.targetPath) === failed);
  if (samePath) return { ...base, kind: "same-path", answerTarget: samePath.targetPath! };
  const sameName = sameTool.find(
    (next) => next.targetPath !== undefined && posix.basename(pathSpelling(next.targetPath)) === posix.basename(failed),
  );
  if (!sameName) return null;
  const blockedBy = fileOnPath(projectRoot, step.targetPath);
  if (blockedBy === null || madeByTheRun(blockedBy, run.steps, projectRoot!)) return null;
  if (taskNamesAnotherUnwritten(posix.basename(failed), run, projectRoot!)) return null;
  return { ...base, kind: "same-name", answerTarget: sameName.targetPath!, blockedBy };
}

/** The same file under `root`, however each side was spelled. */
function samePlace(root: string, a: string, b: string): boolean {
  return resolve(root, pathSpelling(a)) === resolve(root, pathSpelling(b));
}

/**
 * The run may have made `blocker`: a successful step named it, or a
 * successful writer that names no path ran (shell_exec), so the record
 * cannot tell.
 */
function madeByTheRun(blocker: string, steps: readonly StepResult[], root: string): boolean {
  return steps.some((s) => s.success && (s.targetPath === undefined
    ? MUTATION_TOOLS.has(s.toolName)
    : samePlace(root, s.targetPath, blocker)));
}

/** Paths the task text names: a token with a file extension, with or without directories. */
const TASK_PATH_RE = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]+)(?![\w/-])/gu;

/**
 * The task names a path with this file name that no successful step wrote.
 * A bare name ("Create kappa.txt") counts as the root path: what the task
 * meant by it is not in the record.
 */
function taskNamesAnotherUnwritten(name: string, run: FailureRun, root: string): boolean {
  const written = run.steps.flatMap((s) => (s.success && s.targetPath !== undefined ? [s.targetPath] : []));
  return [...run.task.matchAll(TASK_PATH_RE)]
    .map((m) => m[1]!)
    .filter((path) => posix.basename(pathSpelling(path)) === name)
    .some((path) => !written.some((w) => samePlace(root, w, path)));
}

/** One spelling for a path a tool was given: forward slashes, no "./", no "a/../". */
function pathSpelling(path: string): string {
  return posix.normalize(path.trim().replace(/\\/g, "/"));
}

/**
 * The directory of `target` that is a file, measured now under `projectRoot`,
 * relative to it: why `target` cannot exist. Null when every directory of it
 * that exists is a directory, and whenever it cannot be measured: no root, a
 * target outside the root, or a stat that fails other than "not there".
 */
export function fileOnPath(projectRoot: string | undefined, target: string): string | null {
  if (!projectRoot) return null;
  const root = resolve(projectRoot);
  // Only directories strictly inside the root are measured: a target outside it has none.
  for (let dir = dirname(resolve(root, target)); isStrictlyInside(root, dir); dir = dirname(dir)) {
    try {
      return statSync(dir).isDirectory() ? null : relative(root, dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
  }
  return null;
}
