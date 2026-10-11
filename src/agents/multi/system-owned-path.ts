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

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { isScaffoldingScene } from "../../agents/autonomy/built-as-specified.js";
import { findModuleTwin } from "../../agents/orchestrator.js";
import { ACCEPTANCE_DIR } from "../../campaign/scope-types.js";

/**
 * Every path a lease commit ever wrote into this project, one per line. This
 * is the only evidence that a file is the SYSTEM's: git history cannot tell a
 * user's uncommitted file swept into a "campaign:" envelope commit from the
 * campaign's own output (review 2026-09-07 — such a file was deleted as
 * "every commit that touched it was the system's own"). A project without
 * the ledger (from before this existed) falls back to the history rule; the
 * ledger starts at that project's next lease commit.
 */
export const LEASE_WRITTEN_LEDGER = join(".strada", "lease-written.log");

export function readLeaseLedger(sourceRoot: string): Set<string> | undefined {
  const file = join(sourceRoot, LEASE_WRITTEN_LEDGER);
  if (!existsSync(file)) return undefined;
  try {
    return new Set(readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== ""));
  } catch {
    return undefined;
  }
}

export function appendLeaseLedger(sourceRoot: string, rels: readonly string[]): void {
  if (rels.length === 0) return;
  const file = join(sourceRoot, LEASE_WRITTEN_LEDGER);
  try {
    const known = readLeaseLedger(sourceRoot) ?? new Set<string>();
    const fresh = rels.map((r) => r.replace(/\\/g, "/")).filter((r) => !known.has(r));
    if (fresh.length === 0 && known.size > 0) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, fresh.map((r) => `${r}\n`).join(""));
  } catch {
    /* a ledger that cannot be written leaves the history rule in force */
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

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
  const ledger = readLeaseLedger(sourceRoot);
  // Present but unreadable: the one record of what the system wrote cannot be
  // consulted, so nothing that depends on it may call a file the system's.
  const ledgerUnreadable = ledger === undefined && existsSync(join(sourceRoot, LEASE_WRITTEN_LEDGER));
  // The scaffolding rule is about SCENES. Review 2026-09-07: applied to every
  // path, it called any file under Assets/Editor/ or Assets/Tests/ (the
  // user's own build pipeline, their own tests) a scaffolding scene and
  // deleted it from the project.
  if (/\.unity$/i.test(bare) && isScaffoldingScene(bare)) return "scaffolding scene by the delivery gate's own rule";
  // A loose script the framework-paths wall itself calls non-canonical,
  // with its module twin in place. Measured 2026-09-07 15:58: after the
  // "campaign commits only" rule, Assets/Scripts/PlayfieldBuilder.cs — history
  // "feat: construct PlayfieldBuilder runtime" — came back on every attempt
  // while Assets/Modules/PresentationModule/Scripts/PlayfieldBuilder.cs held
  // the real one and the refusal told the agent to delete the loose copy.
  const normalized = bare.replace(/\\/g, "/");
  if (/\.cs$/i.test(normalized) && /^Assets\//i.test(normalized) && !/^Assets\/(Modules|Editor|Tests|Plugins)\//i.test(normalized)) {
    const twin = findModuleTwin(sourceRoot, normalized);
    // A twin is a DUPLICATE when the bytes match, or when the loose file is
    // measurably the system's (a lease wrote it). Review 2026-09-07: the
    // basename alone deleted a user's Assets/Scripts/Utils.cs because some
    // module held an unrelated Utils.cs.
    // NO LEDGER IS NOT "THE SYSTEM WROTE IT": a project has none until its
    // first lease commit that writes a file finishes, so the very first
    // publication deleted that same Utils.cs. Without one, the history rule
    // below decides, as the ledger's own contract says.
    if (twin) {
      if (sameBytes(join(sourceRoot, bare), join(sourceRoot, twin))) {
        return `loose duplicate of ${twin} by the framework-paths rule's own definition`;
      }
      if (ledger?.has(normalized)) {
        return `loose duplicate of ${twin} by the framework-paths rule's own definition (written by a lease)`;
      }
    }
  }
  if (ledgerUnreadable) return undefined;
  // With a ledger, the history rule needs the ledger to agree: an envelope
  // commit makes a user's file look system-authored, the ledger does not.
  if (ledger !== undefined && !ledger.has(normalized) && !ledger.has(rel.replace(/\\/g, "/"))) return undefined;
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

export { ACCEPTANCE_DIR };

const ACCEPTANCE_SEGMENTS = ACCEPTANCE_DIR.toLowerCase().split("/");

/**
 * Whether `path` is one of the campaign's acceptance checks: the folder, a
 * file under it, or the folder's .meta. A worker's lease may read and run
 * them, never write or delete them (GDD-drift plan W07).
 *
 * A project-relative path is judged by its spelling — separators, `..` and
 * letter case do not change the answer, since APFS and NTFS are
 * case-insensitive by default. With `projectRoot`, the path is ALSO judged by
 * its real name against the root's real name: leases live under /var/folders,
 * which is /private/var, and a comparison that mixed the two forms judged
 * lease paths "outside the project" three times before. A link inside the
 * project that leads into the folder is the folder. Without a root, an
 * absolute path is the system's when it runs through an Assets/StradaAcceptance
 * folder.
 */
export function isSystemOwnedCheckPath(path: string, projectRoot?: string): boolean {
  if (path === "") return false;
  if (!isAbsolute(path) && insideAcceptanceDir(path)) return true;
  if (projectRoot === undefined) return isAbsolute(path) && runsThroughAcceptanceDir(path);
  const full = resolve(projectRoot, path);
  const roots = [resolve(projectRoot), realpathOfNearest(projectRoot)];
  const fulls = [full, realpathOfNearest(full)];
  return roots.some((root) => fulls.some((candidate) => insideAcceptanceDir(relative(root, candidate))));
}

function insideAcceptanceDir(projectRelative: string): boolean {
  if (projectRelative === "" || isAbsolute(projectRelative) || /^[A-Za-z]:/.test(projectRelative)) return false;
  const segments = posix
    .normalize(projectRelative.replace(/\\/g, "/"))
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  const [top, folder] = ACCEPTANCE_SEGMENTS as [string, string];
  if (segments[0] !== top) return false;
  return segments[1] === folder || (segments.length === 2 && segments[1] === `${folder}.meta`);
}

function runsThroughAcceptanceDir(absolute: string): boolean {
  const spelled = `${posix.normalize(absolute.replace(/\\/g, "/")).toLowerCase()}/`;
  const folder = `/${ACCEPTANCE_SEGMENTS.join("/")}`;
  return spelled.includes(`${folder}/`) || spelled.endsWith(`${folder}.meta/`);
}

/** The real path of `p`, or of its nearest existing ancestor with the rest re-attached. */
function realpathOfNearest(p: string): string {
  const rest: string[] = [];
  for (let current = resolve(p); ; ) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}
