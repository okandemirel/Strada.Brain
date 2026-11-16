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
 * What is left: the same call run again (any tool); the same path acted on
 * again by the writer that names one path; and, for a writer that creates a
 * file, the same file name written elsewhere only when the failed path cannot
 * exist, measured now: one of its directories is a file (golden run 4:
 * README.md is a file, so README.md/kappa.txt cannot be written). Anything
 * that cannot be read or measured is not an answer.
 */

import { statSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { isStrictlyInside } from "../../common/path-containment.js";
import type { StepResult } from "../agent-state.js";

/** A failed step and the later success that answered it. */
export interface FailureAnswer {
  readonly tool: string;
  /** The first line of what the failed step reported. */
  readonly error: string;
  /**
   * `rerun`: the same call, tool and input, succeeded later. `same-path`: the
   * same writer later acted on the path that failed. `same-name`: the path
   * that failed cannot exist (`blockedBy`), and the same writer later wrote a
   * file of that name in another directory.
   */
  readonly kind: "rerun" | "same-path" | "same-name";
  /** The path the failed call named, when it named one. */
  readonly failedTarget?: string;
  /** The path the answering call named (`same-path`, `same-name`). */
  readonly answerTarget?: string;
  /** What the answering call did to that path (`same-path`, `same-name`). */
  readonly action?: WriterAction;
  /** `same-name`: the failed path's directory that was measured to be a file, relative to the project root. */
  readonly blockedBy?: string;
}

/** What a writer that names one path does to it: the notice's verb. */
export type WriterAction = "write" | "edit" | "delete";

/** Writers whose call acts on the one path it names: a later success on that path answers a failure. */
const SINGLE_PATH_WRITERS: ReadonlyMap<string, WriterAction> = new Map([
  ["file_write", "write"],
  ["file_create", "write"],
  ["file_edit", "edit"],
  ["file_delete", "delete"],
  ["file_delete_directory", "delete"],
]);

/**
 * Which later success answers `step`, if any. `projectRoot` is the root the
 * run's tools write in, where a same-name answer is measured; without it, no
 * same-name answer counts.
 */
export function failureAnsweredBy(
  step: StepResult,
  later: readonly StepResult[],
  projectRoot: string | undefined,
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
  const action = SINGLE_PATH_WRITERS.get(step.toolName);
  if (action === undefined || step.targetPath === undefined) return null;
  const failed = pathSpelling(step.targetPath);
  const samePath = sameTool.find((next) => next.targetPath !== undefined && pathSpelling(next.targetPath) === failed);
  if (samePath) return { ...base, kind: "same-path", answerTarget: samePath.targetPath!, action };
  if (action !== "write") return null;
  const sameName = sameTool.find(
    (next) => next.targetPath !== undefined && posix.basename(pathSpelling(next.targetPath)) === posix.basename(failed),
  );
  if (!sameName) return null;
  const blockedBy = fileOnPath(projectRoot, step.targetPath);
  return blockedBy === null ? null : { ...base, kind: "same-name", answerTarget: sameName.targetPath!, action, blockedBy };
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
  const full = resolve(root, target);
  if (!isStrictlyInside(root, full)) return null;
  for (let dir = dirname(full); isStrictlyInside(root, dir); dir = dirname(dir)) {
    try {
      return statSync(dir).isDirectory() ? null : relative(root, dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
  }
  return null;
}
