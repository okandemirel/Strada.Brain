/**
 * Whether a file the agent deleted in its workspace was the system's own.
 *
 * A commit declines every deletion — removing a user's file is not its call.
 * Measured 2026-09-07: four times in one day the declined list was the
 * campaign's own leftovers — Assets/Scripts/PlayfieldBuilder.cs (a duplicate
 * of the module copy, which the conformance gate forbids editing),
 * InitTestScene*.unity and Assembled*.unity (scaffolding the scene-hygiene
 * gate demands removed). Every attempt deleted them; every commit put them
 * back; the next attempt met the same duplicate definitions and the same
 * "NO ENTRY SCENE" refusal. Two gates demanded deletions a third refused.
 *
 * The evidence that a file is the system's own is measured, not assumed:
 * the delivery gate's scaffolding rule, or a git history in which every
 * commit that touched the path is a campaign/salvage commit. A file with any
 * other commit — or none, an untracked file that may be the user's WIP — is
 * still left in place.
 */

import { isScaffoldingScene } from "../../agents/autonomy/built-as-specified.js";

/** Subjects the campaign and the lease watchdog write. */
export const SYSTEM_COMMIT_SUBJECT_RE = /^campaign:|salvaged from lease|auto-watchdog/i;

export type CommandRunnerLike = (opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{ exitCode: number; stdout: string }>;

/** A reason the deletion may be applied, or undefined to leave the file in place. */
export async function systemOwnedDeletionReason(
  run: CommandRunnerLike,
  sourceRoot: string,
  rel: string,
): Promise<string | undefined> {
  const bare = rel.replace(/\.meta$/i, "");
  if (isScaffoldingScene(bare)) return "scaffolding scene by the delivery gate's own rule";
  try {
    const log = await run({ command: "git", args: ["log", "--format=%s", "--", rel], cwd: sourceRoot, timeoutMs: 15_000 });
    if (log.exitCode !== 0) return undefined;
    const subjects = log.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
    if (subjects.length === 0) return undefined;
    if (subjects.every((s) => SYSTEM_COMMIT_SUBJECT_RE.test(s))) {
      return `every commit that touched it was the system's own (${subjects.length})`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
