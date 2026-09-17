/**
 * Change review and undo for what a run published into the user's project.
 *
 * The portal could already show a diff and "accept" it, but the decision never
 * left the browser: `resolveDiff` (web-portal/src/stores/code-store.ts) mutated
 * a tab and nothing else, so what the user SAW and what could actually be put
 * back were two different things. There was no answer at all to "undo what that
 * run did" — the lease had copied its files into the project, replayed its
 * commits onto HEAD, and deleted the only other copy of the previous version
 * along with its workspace.
 *
 * This module is the missing half, and it deliberately reuses what the lease
 * machinery already does rather than keeping a history of its own:
 *
 *   - the WRITE PHASE of commitLease already copies every file it is about to
 *     overwrite (`<staging>/<token>.prev`) so a half-written pair can be put
 *     back. Those copies used to be deleted at the end of the commit; they are
 *     now kept under `<project>/.strada/lease-changes/<reviewId>/previous/<rel>`
 *     and they ARE the undo source. Byte-exact, and it works for untracked and
 *     gitignored files, which git cannot answer for.
 *   - applied deletions are already preserved under the lease's quarantine
 *     (`<quarantine>/deleted/<rel>`); the record points at those copies.
 *   - replayed commits are undone by moving HEAD back to the sha the replay
 *     started from, with git's own compare-and-swap on update-ref.
 *
 * Three rules, from the three things this has to get right:
 *
 *   1. A HUMAN EDITING THE SAME FILE while the run works must never lose that
 *      edit to an undo. Every published file carries the stat stamp AND the
 *      content hash of exactly what the run wrote; anything else on disk now is
 *      somebody else's change, and it is reported, not overwritten.
 *   2. The user SEES first: previewUndo() answers "what would be undone" with a
 *      per-path action and state, and never writes anything.
 *   3. NO HALF-REVERTED TREE. An undo either reverts everything it listed as
 *      ready or reverts nothing: a failure part-way through is rolled back from
 *      the copies taken on the way in, and the result reports `leftOver` —
 *      anything of the run's change still in the project after an undo that
 *      called itself complete.
 *
 * Rule 1 has a twin that matters just as much: a safety check that refuses a
 * legitimate undo is itself a defect. A stamp moves on a chmod, a touch, or a
 * Spotlight xattr without a byte changing, so the stamp only ever decides
 * whether the CONTENT is worth hashing — the hash decides.
 */

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { runProcess } from "../../utils/process-runner.js";
import { getLoggerSafe } from "../../utils/logger.js";
import type { WorkspaceCommandRunner } from "./workspace-lease-manager.js";

/** `<project>/.strada/lease-changes` — excluded from every lease walk (see BASE_FALLBACK_COPY_EXCLUDES). */
export const CHANGE_REVIEW_DIRNAME = join(".strada", "lease-changes");
const RECORD_FILE = "review.json";
/** Where the project's pre-run bytes are kept. */
const PREVIOUS_DIR = "previous";
/** Where an undo puts the version the RUN published, so the undo is itself recoverable. */
const UNDONE_DIR = "undone";
const STAGING_DIR = "staging";
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** What an undo would do to one path. */
export type UndoAction =
  /** The run overwrote a file the project already had: put the project's bytes back. */
  | "restore"
  /** The run created a file the project did not have: remove it. */
  | "delete"
  /** The run deleted a file the project had: put it back from the lease quarantine. */
  | "restore-deleted";

/**
 * A file stamp, structurally the lease's SeedStamp. Duplicated rather than
 * imported as a value so this module and the lease manager have no runtime
 * import cycle (the manager writes records through this module).
 */
export interface FileStamp {
  readonly m: number;
  readonly s: number;
  readonly c: number;
}

export interface ReviewedChange {
  /** Project-relative path, native separators — the same form WorkspaceCommitResult reports. */
  readonly path: string;
  readonly action: UndoAction;
  /** sha256 of the bytes the run published. Absent for `restore-deleted` (the run removed the file). */
  readonly publishedHash?: string;
  /** Stat of the published file, taken right after it landed. The cheap first question only. */
  readonly publishedStamp?: FileStamp;
  /** Absolute path of the project's pre-run bytes; required for `restore` / `restore-deleted`. */
  readonly previousPath?: string;
  readonly previousHash?: string;
  readonly previousBytes?: number;
  /** Set when this change cannot be undone at all, with the reason a person can read. */
  readonly unrecoverable?: string;
}

/** The project commits the lease replay made, and the sha it built them on. */
export interface ReviewedHistory {
  readonly base: string;
  readonly head: string;
  readonly commits: readonly string[];
  /** Paths the replay staged, in git's own form — what an undo resets in the index. */
  readonly paths: readonly string[];
}

export type ChangeReviewStatus = "open" | "kept" | "undone" | "partially-undone";

export interface ChangeReviewRecord {
  readonly version: 1;
  readonly reviewId: string;
  readonly projectRoot: string;
  readonly leaseId: string;
  readonly label?: string;
  readonly taskId?: string;
  readonly createdAt: number;
  readonly changes: readonly ReviewedChange[];
  readonly history?: ReviewedHistory;
  readonly status: ChangeReviewStatus;
  readonly resolvedAt?: number;
}

export type UndoEntryState =
  /** Ready to be undone. */
  | "ready"
  /** Someone changed this path after the run published it — their version is not ours to discard. */
  | "changed-since"
  /** Nothing to do: the path is already back to its pre-run state. */
  | "already-undone"
  /** The pre-run bytes are not available, so this path cannot be put back. */
  | "unrecoverable";

export interface UndoEntryPreview {
  readonly path: string;
  readonly action: UndoAction;
  readonly state: UndoEntryState;
  readonly detail?: string;
  /** Bytes the undo would write (a restore) or remove (a delete). */
  readonly bytes?: number;
}

export interface UndoHistoryPreview {
  readonly base: string;
  readonly head: string;
  readonly commits: number;
  readonly state: "ready" | "already-undone" | "moved-on" | "unreadable";
  readonly detail?: string;
}

export interface UndoPreview {
  readonly reviewId: string;
  readonly status: ChangeReviewStatus;
  readonly label?: string;
  readonly createdAt: number;
  readonly entries: readonly UndoEntryPreview[];
  readonly ready: number;
  readonly changedSince: number;
  readonly unrecoverable: number;
  readonly alreadyUndone: number;
  readonly history: UndoHistoryPreview | null;
  /**
   * True when an undo with the default options would put the project back
   * exactly as it was. False means something is in the way, and `entries` /
   * `history` say what — the user sees it BEFORE deciding.
   */
  readonly complete: boolean;
}

export interface UndoResult {
  readonly reviewId: string;
  readonly status: "undone" | "partially-undone" | "refused";
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  /** Left exactly as they are, because someone edited them after the run. */
  readonly kept: readonly string[];
  readonly failed: readonly string[];
  readonly historyMoved: boolean;
  /** Why nothing (or not everything) was undone. */
  readonly reason?: string;
  /**
   * Anything of the run's change still in the project after this undo claimed
   * to be complete. On a `status: "undone"` this MUST be empty — it is the
   * "no half-reverted tree" measure, checked rather than assumed.
   */
  readonly leftOver: readonly string[];
}

export interface UndoOptions {
  readonly runner?: WorkspaceCommandRunner;
  readonly timeoutMs?: number;
  /**
   * What to do about paths that are not `ready`:
   *   "refuse" (default) — change nothing at all, and say why. A partial undo
   *     is the half-reverted tree measure 3 forbids.
   *   "skip" — undo everything that IS ready, leave the rest untouched, and
   *     report them in `kept` / `failed`. The status says partially-undone.
   */
  readonly onBlocked?: "refuse" | "skip";
}

// Record storage

/**
 * A review id names a directory inside the project. It reaches this module from
 * a checkpoint row, a portal request and a lease basename, so it is checked
 * rather than trusted: `..` or a separator in it would point every read and
 * every restore outside the review root.
 */
const REVIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isReviewId(value: string): boolean {
  return REVIEW_ID_RE.test(value) && !value.includes("..");
}

export function changeReviewRoot(projectRoot: string): string {
  return join(resolve(projectRoot), CHANGE_REVIEW_DIRNAME);
}

export function changeReviewDir(projectRoot: string, reviewId: string): string {
  if (!isReviewId(reviewId)) throw new Error(`Not a change review id: ${reviewId}`);
  return join(changeReviewRoot(projectRoot), reviewId);
}

/** Where the pre-run copy of `rel` belongs for this review. */
export function previousCopyPath(projectRoot: string, reviewId: string, rel: string): string {
  return join(changeReviewDir(projectRoot, reviewId), PREVIOUS_DIR, rel);
}

/** sha256 of a file's bytes; undefined when it cannot be read. */
export async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await fsp.readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

export function hashBufferHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Write the record, atomically. A reader must never see half a manifest: the
 * record is the only thing that says where a user's previous bytes are kept.
 */
export function writeChangeReview(record: ChangeReviewRecord): void {
  const dir = changeReviewDir(record.projectRoot, record.reviewId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, RECORD_FILE);
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, target);
}

export function readChangeReview(projectRoot: string, reviewId: string): ChangeReviewRecord | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(changeReviewDir(projectRoot, reviewId), RECORD_FILE), "utf8"),
    ) as Partial<ChangeReviewRecord>;
    if (raw.version !== 1 || typeof raw.reviewId !== "string" || !Array.isArray(raw.changes)) return undefined;
    return {
      version: 1,
      reviewId: raw.reviewId,
      // The record travels with the project directory; trust the CALLER's root
      // over the one recorded, so a moved or renamed project still reviews.
      projectRoot: resolve(projectRoot),
      leaseId: typeof raw.leaseId === "string" ? raw.leaseId : raw.reviewId,
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      changes: raw.changes.filter((c): c is ReviewedChange => typeof c?.path === "string"),
      ...(raw.history && typeof raw.history.base === "string" && typeof raw.history.head === "string"
        ? { history: raw.history }
        : {}),
      status: isStatus(raw.status) ? raw.status : "open",
      ...(typeof raw.resolvedAt === "number" ? { resolvedAt: raw.resolvedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function isStatus(value: unknown): value is ChangeReviewStatus {
  return value === "open" || value === "kept" || value === "undone" || value === "partially-undone";
}

/** Every review this project holds, newest first. */
export function listChangeReviews(projectRoot: string): ChangeReviewRecord[] {
  let names: string[];
  try {
    names = readdirSync(changeReviewRoot(projectRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => isReviewId(name))
    .map((name) => readChangeReview(projectRoot, name))
    .filter((r): r is ChangeReviewRecord => r !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * "Keep what the run did." The record stays — keeping is not a promise never to
 * change your mind, and the previous copies are what would make a later undo
 * possible — so this only records the decision.
 */
export function keepChanges(projectRoot: string, reviewId: string): ChangeReviewRecord | undefined {
  const record = readChangeReview(projectRoot, reviewId);
  if (!record) return undefined;
  const kept: ChangeReviewRecord = { ...record, status: "kept", resolvedAt: Date.now() };
  writeChangeReview(kept);
  return kept;
}

/**
 * Drop a review and everything it keeps. Only for a review nobody can act on
 * any more; the caller decides that, not this function.
 */
export function discardChangeReview(projectRoot: string, reviewId: string): void {
  rmSync(changeReviewDir(projectRoot, reviewId), { recursive: true, force: true });
}

/**
 * How many runs' worth of undo material a project keeps.
 *
 * Each review holds a copy of every file its run overwrote, so this is real
 * disk in the user's project — the same shape of problem capture retention was
 * measured with (1.2 GB of Recordings nobody read). A review older than the
 * last twenty runs is not going to be undone; keeping it would be a leak
 * dressed up as a feature.
 */
export const MAX_CHANGE_REVIEWS = 20;

/** Retire the oldest reviews beyond `keep`, with the copies they hold. */
export function pruneChangeReviews(projectRoot: string, keep: number = MAX_CHANGE_REVIEWS): number {
  const reviews = listChangeReviews(projectRoot);
  if (reviews.length <= keep) return 0;
  let removed = 0;
  for (const review of reviews.slice(keep)) {
    try {
      discardChangeReview(projectRoot, review.reviewId);
      removed += 1;
    } catch {
      // A review that cannot be removed is not worth failing anything over.
    }
  }
  if (removed > 0) {
    getLoggerSafe().info("Retired old change reviews", { removed, kept: Math.min(reviews.length, keep) });
  }
  return removed;
}

// Preview

/** Did anything at all happen to this file since we wrote it? Cheap question. */
function stampMoved(stamp: FileStamp | undefined, now: { mtimeMs: number; size: number; ctimeMs: number }): boolean {
  if (stamp === undefined) return true; // nothing recorded answers nothing — ask the bytes
  if (stamp.m !== now.mtimeMs || stamp.s !== now.size) return true;
  return !Number.isNaN(stamp.c) && stamp.c !== now.ctimeMs;
}

async function statOrUndefined(path: string): Promise<{ mtimeMs: number; size: number; ctimeMs: number } | undefined> {
  try {
    const st = await fsp.stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs };
  } catch {
    return undefined;
  }
}

/** Is the pre-run copy still there, and still the bytes the record describes? */
async function previousUsable(change: ReviewedChange): Promise<{ ok: true; bytes: number } | { ok: false; why: string }> {
  if (change.previousPath === undefined) {
    return { ok: false, why: "the project's previous version was not preserved when the run published" };
  }
  const st = await statOrUndefined(change.previousPath);
  if (!st) return { ok: false, why: `the preserved copy is gone (${change.previousPath})` };
  if (change.previousHash !== undefined) {
    const hash = await hashFile(change.previousPath);
    if (hash !== change.previousHash) {
      return { ok: false, why: `the preserved copy no longer matches what was recorded (${change.previousPath})` };
    }
  }
  return { ok: true, bytes: st.size };
}

async function entryPreview(record: ChangeReviewRecord, change: ReviewedChange): Promise<UndoEntryPreview> {
  const target = join(record.projectRoot, change.path);
  const base = { path: change.path, action: change.action };
  if (change.unrecoverable !== undefined) {
    return { ...base, state: "unrecoverable", detail: change.unrecoverable };
  }
  const now = await statOrUndefined(target);

  /**
   * Is what is on disk still the run's own work? The stamp asks first because
   * it is a stat; only a moved stamp is worth a full read. A chmod, a touch or
   * an xattr moves the stamp without changing a byte, and refusing an undo
   * over that would be a safety rule turning into a defect of its own.
   */
  const stillOurs = async (): Promise<boolean> => {
    if (now === undefined) return false;
    if (!stampMoved(change.publishedStamp, now)) return true;
    if (change.publishedHash === undefined) return false; // nothing to compare: assume someone else's
    return (await hashFile(target)) === change.publishedHash;
  };
  const backToPrevious = async (): Promise<boolean> => {
    if (now === undefined || change.previousHash === undefined) return false;
    return (await hashFile(target)) === change.previousHash;
  };

  if (change.action === "delete") {
    if (now === undefined) return { ...base, state: "already-undone", detail: "the file is no longer in the project" };
    if (await stillOurs()) return { ...base, state: "ready", bytes: now.size };
    return { ...base, state: "changed-since", detail: "someone changed this file after the run created it" };
  }

  // restore / restore-deleted both need the preserved bytes.
  const usable = await previousUsable(change);

  if (change.action === "restore-deleted") {
    if (now === undefined) {
      return usable.ok
        ? { ...base, state: "ready", bytes: usable.bytes }
        : { ...base, state: "unrecoverable", detail: usable.why };
    }
    if (await backToPrevious()) {
      return { ...base, state: "already-undone", detail: "the file is back in the project with its previous bytes" };
    }
    return { ...base, state: "changed-since", detail: "a different version of this file is in the project now" };
  }

  // restore
  if (now === undefined) {
    // Putting it back would resurrect a file somebody deleted on purpose —
    // exactly the decision the lease commit refuses to overrule.
    return { ...base, state: "changed-since", detail: "the file was removed after the run published it" };
  }
  if (await stillOurs()) {
    return usable.ok
      ? { ...base, state: "ready", bytes: usable.bytes }
      : { ...base, state: "unrecoverable", detail: usable.why };
  }
  if (await backToPrevious()) {
    return { ...base, state: "already-undone", detail: "the file already holds its pre-run bytes" };
  }
  return { ...base, state: "changed-since", detail: "someone changed this file after the run published it" };
}

async function historyPreview(
  record: ChangeReviewRecord,
  runner: WorkspaceCommandRunner,
  timeoutMs: number,
): Promise<UndoHistoryPreview | null> {
  const history = record.history;
  if (!history) return null;
  const head = await runner({
    command: "git",
    args: ["-C", record.projectRoot, "rev-parse", "--verify", "HEAD"],
    cwd: record.projectRoot,
    timeoutMs,
  });
  const common = { base: history.base, head: history.head, commits: history.commits.length };
  if (head.exitCode !== 0) {
    return { ...common, state: "unreadable", detail: "the project's HEAD could not be read" };
  }
  const at = head.stdout.trim();
  if (at === history.head) return { ...common, state: "ready" };
  if (at === history.base) return { ...common, state: "already-undone", detail: "HEAD is already back at the base commit" };
  return {
    ...common,
    state: "moved-on",
    detail: `HEAD is at ${at.slice(0, 12)}, not the commit this run left (${history.head.slice(0, 12)}) — something committed after the run`,
  };
}

/**
 * What an undo would do. Reads only — measure 2 is that the user can see this
 * before anything moves.
 */
export async function previewUndo(
  projectRoot: string,
  reviewId: string,
  opts: UndoOptions = {},
): Promise<UndoPreview | undefined> {
  const record = readChangeReview(projectRoot, reviewId);
  if (!record) return undefined;
  return previewRecord(record, opts);
}

export async function previewRecord(record: ChangeReviewRecord, opts: UndoOptions = {}): Promise<UndoPreview> {
  const runner = opts.runner ?? runProcess;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const entries: UndoEntryPreview[] = [];
  for (const change of record.changes) {
    entries.push(await entryPreview(record, change));
  }
  const history = await historyPreview(record, runner, timeoutMs);
  const count = (state: UndoEntryState): number => entries.filter((e) => e.state === state).length;
  const changedSince = count("changed-since");
  const unrecoverable = count("unrecoverable");
  return {
    reviewId: record.reviewId,
    status: record.status,
    ...(record.label !== undefined ? { label: record.label } : {}),
    createdAt: record.createdAt,
    entries,
    ready: count("ready"),
    changedSince,
    unrecoverable,
    alreadyUndone: count("already-undone"),
    history,
    complete:
      changedSince === 0 &&
      unrecoverable === 0 &&
      (history === null || history.state === "ready" || history.state === "already-undone"),
  };
}

// Undo

interface AppliedStep {
  readonly change: ReviewedChange;
  readonly kind: "restored" | "removed" | "recreated";
  /** Copy of the version the RUN published, kept so this step can be put back. */
  readonly publishedCopy?: string;
}

/**
 * Put the project back the way it was before the run.
 *
 * All-or-nothing by default: anything not `ready` refuses the whole undo, and a
 * failure part-way through is rolled back from the copies taken on the way in.
 * `onBlocked: "skip"` is the deliberate escape — it undoes what it can, says
 * what it left, and reports `partially-undone`, never silence.
 */
export async function applyUndo(
  projectRoot: string,
  reviewId: string,
  opts: UndoOptions = {},
): Promise<UndoResult> {
  const record = readChangeReview(projectRoot, reviewId);
  if (!record) {
    return {
      reviewId,
      status: "refused",
      restored: [],
      deleted: [],
      kept: [],
      failed: [],
      historyMoved: false,
      reason: `no change review named ${reviewId} in this project`,
      leftOver: [],
    };
  }
  const runner = opts.runner ?? runProcess;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const onBlocked = opts.onBlocked ?? "refuse";
  const preview = await previewRecord(record, opts);
  const byPath = new Map(record.changes.map((c) => [c.path, c]));

  const blocked = preview.entries.filter((e) => e.state === "changed-since" || e.state === "unrecoverable");
  const historyBlocked = preview.history !== null && (preview.history.state === "moved-on" || preview.history.state === "unreadable");

  // NOTHING IS TOUCHED before this decision. A refusal that had already written
  // half the tree would be the very thing measure 3 forbids.
  if (onBlocked === "refuse" && (blocked.length > 0 || historyBlocked)) {
    const reasons: string[] = [];
    for (const entry of blocked.slice(0, 20)) reasons.push(`${entry.path}: ${entry.detail ?? entry.state}`);
    if (historyBlocked) reasons.push(`git history: ${preview.history?.detail ?? preview.history?.state}`);
    return {
      reviewId,
      status: "refused",
      restored: [],
      deleted: [],
      kept: blocked.filter((b) => b.state === "changed-since").map((b) => b.path),
      failed: blocked.filter((b) => b.state === "unrecoverable").map((b) => b.path),
      historyMoved: false,
      reason:
        `nothing was undone: ${blocked.length} path(s)${historyBlocked ? " and the git history" : ""} are not in the state this run left them in. ` +
        `Pass onBlocked: "skip" to undo the rest and keep them. (${reasons.join("; ")})`,
      leftOver: [],
    };
  }

  const dir = changeReviewDir(record.projectRoot, record.reviewId);
  const undoneRoot = join(dir, UNDONE_DIR);
  const stagingRoot = join(dir, STAGING_DIR, randomUUID().slice(0, 8));
  const applied: AppliedStep[] = [];
  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];
  const kept = blocked.filter((b) => b.state === "changed-since").map((b) => b.path);
  for (const b of blocked) if (b.state === "unrecoverable") failed.push(`${b.path} (${b.detail ?? "cannot be put back"})`);

  /** Keep the run's own version before undoing it — an undo must be undoable too. */
  const keepPublished = async (rel: string, from: string): Promise<string | undefined> => {
    const to = join(undoneRoot, rel);
    try {
      await fsp.mkdir(dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      return to;
    } catch {
      return undefined;
    }
  };

  const restoreFile = async (change: ReviewedChange): Promise<boolean> => {
    const target = join(record.projectRoot, change.path);
    const staged = join(stagingRoot, `${randomUUID().slice(0, 8)}.part`);
    const existed = existsSync(target);
    let publishedCopy: string | undefined;
    try {
      if (existed) {
        publishedCopy = await keepPublished(change.path, target);
        if (publishedCopy === undefined) {
          throw new Error("the version this run published could not be preserved, so the undo could not be made reversible");
        }
      }
      await fsp.mkdir(stagingRoot, { recursive: true });
      await fsp.mkdir(dirname(target), { recursive: true });
      // Stage, then rename: a copy straight onto the destination that fails
      // half-way leaves neither version whole.
      await fsp.copyFile(change.previousPath!, staged);
      await fsp.rename(staged, target);
      applied.push({ change, kind: existed ? "restored" : "recreated", ...(publishedCopy ? { publishedCopy } : {}) });
      restored.push(change.path);
      return true;
    } catch (err) {
      try { await fsp.unlink(staged); } catch { /* nothing staged */ }
      failed.push(`${change.path} (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  };

  const deleteFile = async (change: ReviewedChange): Promise<boolean> => {
    const target = join(record.projectRoot, change.path);
    try {
      const publishedCopy = await keepPublished(change.path, target);
      if (publishedCopy === undefined) {
        throw new Error("the version this run published could not be preserved, so the undo could not be made reversible");
      }
      await fsp.rm(target, { force: true });
      applied.push({ change, kind: "removed", publishedCopy });
      deleted.push(change.path);
      return true;
    } catch (err) {
      failed.push(`${change.path} (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  };

  /** Put every applied step back, so a failed undo leaves the tree as it found it. */
  const rollback = async (): Promise<string[]> => {
    const problems: string[] = [];
    for (const step of [...applied].reverse()) {
      const target = join(record.projectRoot, step.change.path);
      try {
        if (step.kind === "recreated") {
          await fsp.rm(target, { force: true });
        } else if (step.publishedCopy !== undefined) {
          await fsp.mkdir(dirname(target), { recursive: true });
          await fsp.copyFile(step.publishedCopy, target);
        } else {
          problems.push(`${step.change.path} (no preserved copy to put back)`);
        }
      } catch (err) {
        problems.push(`${step.change.path} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    applied.length = 0;
    restored.length = 0;
    deleted.length = 0;
    return problems;
  };

  let aborted: string | undefined;
  for (const entry of preview.entries) {
    if (entry.state !== "ready") continue;
    const change = byPath.get(entry.path);
    if (!change) continue;
    const ok = change.action === "delete" ? await deleteFile(change) : await restoreFile(change);
    if (ok) continue;
    if (onBlocked === "refuse") {
      aborted = `the undo stopped at ${entry.path} and was rolled back`;
      break;
    }
  }

  if (aborted !== undefined) {
    const problems = await rollback();
    await pruneStaging(stagingRoot);
    return {
      reviewId,
      status: "refused",
      restored: [],
      deleted: [],
      kept,
      failed: [...failed, ...problems.map((p) => `rollback: ${p}`)],
      historyMoved: false,
      reason: problems.length > 0
        ? `${aborted}, but the rollback did not finish — see failed`
        : `${aborted}; the project is as it was before the undo`,
      leftOver: problems,
    };
  }

  // The history moves LAST and only on git's own compare-and-swap, so a HEAD
  // that moved between the preview and here cannot be clobbered.
  let historyMoved = false;
  if (record.history && preview.history?.state === "ready") {
    const moved = await runner({
      command: "git",
      args: [
        "-C", record.projectRoot,
        "update-ref", "-m", `strada change-review undo: ${record.reviewId}`,
        "HEAD", record.history.base, record.history.head,
      ],
      cwd: record.projectRoot,
      timeoutMs,
    });
    if (moved.exitCode !== 0) {
      const problems = await rollback();
      await pruneStaging(stagingRoot);
      return {
        reviewId,
        status: "refused",
        restored: [],
        deleted: [],
        kept,
        failed: [...failed, ...problems.map((p) => `rollback: ${p}`)],
        historyMoved: false,
        reason: `the project's HEAD could not be moved back to ${record.history.base.slice(0, 12)} (${moved.stderr.trim().slice(0, 200)}); the files were put back as they were`,
        leftOver: problems,
      };
    }
    historyMoved = true;
    // The index still describes the replayed content for these paths; point it
    // at the restored HEAD for exactly them, never the user's other staged work.
    const paths = [...new Set([...restored, ...deleted].map((p) => p.split(sep).join("/")))];
    for (let i = 0; i < paths.length; i += 200) {
      await runner({
        command: "git",
        args: ["-C", record.projectRoot, "reset", "-q", "HEAD", "--", ...paths.slice(i, i + 200)],
        cwd: record.projectRoot,
        timeoutMs,
      });
    }
  }

  // Directories the run created and this undo emptied are part of "nothing left
  // over": an empty Assets/Generated is still a change to the project.
  for (const rel of deleted) await pruneEmptyParents(record.projectRoot, rel);
  await pruneStaging(stagingRoot);

  // VERIFY, do not assume. Every path this undo claims to have reverted is
  // re-inspected; anything that does not read as pre-run is leftOver.
  const leftOver: string[] = [];
  for (const rel of restored) {
    const change = byPath.get(rel);
    if (!change?.previousHash) continue;
    const hash = await hashFile(join(record.projectRoot, rel));
    if (hash !== change.previousHash) leftOver.push(`${rel} (not the pre-run bytes after the undo)`);
  }
  for (const rel of deleted) {
    if (existsSync(join(record.projectRoot, rel))) leftOver.push(`${rel} (still in the project after the undo)`);
  }

  const partial = kept.length > 0 || failed.length > 0 || leftOver.length > 0 || (preview.history !== null && !historyMoved && preview.history.state !== "already-undone");
  const status: UndoResult["status"] = partial ? "partially-undone" : "undone";
  writeChangeReview({ ...record, status, resolvedAt: Date.now() });
  if (leftOver.length > 0) {
    getLoggerSafe().error("Change-review undo left something behind", { reviewId, leftOver: leftOver.slice(0, 10) });
  }
  getLoggerSafe().info("Change-review undo applied", {
    reviewId,
    restored: restored.length,
    deleted: deleted.length,
    kept: kept.length,
    failed: failed.length,
    historyMoved,
  });
  return {
    reviewId,
    status,
    restored,
    deleted,
    kept,
    failed,
    historyMoved,
    ...(partial
      ? {
          reason:
            `undone except: ${kept.length} path(s) someone changed after the run` +
            `${failed.length > 0 ? `, ${failed.length} that could not be put back` : ""}` +
            `${preview.history !== null && !historyMoved ? `, and the git history (${preview.history.state})` : ""}`,
        }
      : {}),
    leftOver,
  };
}

async function pruneStaging(stagingRoot: string): Promise<void> {
  try {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    await fsp.rmdir(dirname(stagingRoot));
  } catch {
    /* another undo is still staging there, or nothing was staged */
  }
}

/** Remove directories the undo just emptied, never one that still holds anything. */
async function pruneEmptyParents(projectRoot: string, rel: string): Promise<void> {
  let dir = dirname(join(projectRoot, rel));
  const root = resolve(projectRoot);
  for (let depth = 0; depth < 64; depth++) {
    if (dir === root || !dir.startsWith(`${root}${sep}`)) return;
    try {
      await fsp.rmdir(dir); // fails when non-empty — exactly the guard we want
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

// Recording (called by the lease commit)

export interface RecordChangeReviewInput {
  readonly projectRoot: string;
  readonly reviewId: string;
  readonly leaseId: string;
  readonly label?: string;
  readonly taskId?: string;
  readonly changes: readonly ReviewedChange[];
  readonly history?: ReviewedHistory;
}

/**
 * Persist what a commit published. Returns the record, or undefined when there
 * was nothing to review — an empty record would offer an undo that does nothing.
 */
export function recordChangeReview(input: RecordChangeReviewInput): ChangeReviewRecord | undefined {
  if (input.changes.length === 0 && (input.history?.commits.length ?? 0) === 0) return undefined;
  const record: ChangeReviewRecord = {
    version: 1,
    reviewId: input.reviewId,
    projectRoot: resolve(input.projectRoot),
    leaseId: input.leaseId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    createdAt: Date.now(),
    changes: input.changes,
    ...(input.history ? { history: input.history } : {}),
    status: "open",
  };
  try {
    writeChangeReview(record);
    // The previous copies are disk in the user's project; the window is bounded
    // here rather than left to grow for the life of the project.
    pruneChangeReviews(input.projectRoot);
  } catch (err) {
    // A record that cannot be written must not fail a commit whose files
    // already landed — but it is the difference between an undoable run and an
    // unreviewable one, so it is said loudly.
    getLoggerSafe().error("Change review could not be recorded — this run's changes cannot be undone from the portal", {
      reviewId: input.reviewId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  return record;
}

/** Relative path of `abs` inside the project, in the form the record uses. */
export function projectRelative(projectRoot: string, abs: string): string {
  return relative(resolve(projectRoot), resolve(abs));
}
