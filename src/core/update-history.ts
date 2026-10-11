/**
 * Auto-update history — what the updater did, readable by `strada status`.
 *
 * Until 2026-09-10 the only record of an auto-update was a log line
 * ("Auto-update pulled" / "Auto-update rolling back"), so an operator asking
 * "did the daemon update last night, and did it roll back?" had to grep the
 * log. The updater now appends every outcome here; `strada status` prints the
 * last one. Kept short (last HISTORY_LIMIT events), written atomically.
 *
 * Every function takes the root whose `.strada/` holds the files: a git
 * checkout's own root, a package install's writable config root
 * (AutoUpdater.getUpdateRecordsRoot()).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type UpdateEventKind = "pulled" | "rolled-back" | "deferred" | "failed" | "rollback-refused";

/**
 * What became of the checkout (or install) after an update failed: put back,
 * left as it was because putting it back would discard someone's work, a
 * rollback that broke off, or nothing to put back.
 */
export type RollbackOutcome = "rolled-back" | "refused" | "incomplete" | "none";

const ROLLBACK_NOTES: Record<RollbackOutcome, string> = {
  "rolled-back": "and was rolled back",
  refused: "and was NOT rolled back: the rollback was refused, so the checkout still holds it",
  incomplete: "and the rollback did not complete",
  none: "and nothing was rolled back",
};

/** " and was rolled back", or what happened instead; "" for a hold that does not say. */
export function describeRollback(outcome: RollbackOutcome | undefined): string {
  return outcome ? ` ${ROLLBACK_NOTES[outcome]}` : "";
}

export interface UpdateEvent {
  at: number;
  kind: UpdateEventKind;
  from?: string;
  to?: string;
  reason?: string;
}

export const UPDATE_HISTORY_FILE = "auto-update.json";
export const HISTORY_LIMIT = 20;

export function updateHistoryPath(root: string): string {
  return path.join(root, ".strada", UPDATE_HISTORY_FILE);
}

export function readUpdateHistory(root: string): UpdateEvent[] {
  try {
    const raw = fs.readFileSync(updateHistoryPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is UpdateEvent => typeof e === "object" && e !== null
        && typeof (e as UpdateEvent).at === "number" && typeof (e as UpdateEvent).kind === "string",
    );
  } catch {
    return [];
  }
}

/** Append one event; never throws (a history write must not fail an update). */
export function recordUpdateEvent(root: string, event: UpdateEvent): void {
  try {
    const file = updateHistoryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const events = [...readUpdateHistory(root), event].slice(-HISTORY_LIMIT);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(events, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* history is advisory */
  }
}

/**
 * What the last failed update holds back (2026-09-18 .. 09-20: seven cycles
 * pulled, timed out in `npm run build` and reset, every 6 h, because nothing
 * remembered the previous failure). The scheduled check never attempts
 * `target` again, and attempts nothing newer before `retryAfter`; a
 * successful update deletes the file.
 */
export interface UpdateHold {
  /** The commit (git) or version (npm) that failed. */
  target: string;
  step: string;
  /** The end of the failing command's output. */
  cause: string;
  at: number;
  /** Consecutive failed updates, whatever their target. */
  failures: number;
  retryAfter: number;
  /** Absent in holds written before 2026-10-11. */
  rollback?: RollbackOutcome;
}

export const UPDATE_HOLD_FILE = "auto-update-hold.json";

function updateHoldPath(root: string): string {
  return path.join(root, ".strada", UPDATE_HOLD_FILE);
}

export function readUpdateHold(root: string): UpdateHold | null {
  try {
    const hold = JSON.parse(fs.readFileSync(updateHoldPath(root), "utf8")) as UpdateHold;
    return typeof hold?.target === "string" && typeof hold.retryAfter === "number" ? hold : null;
  } catch {
    return null;
  }
}

/**
 * Never throws: a hold that cannot be written must not mask the failure
 * itself. Returns whether it was written, so nobody reports a hold that is
 * not there.
 */
export function writeUpdateHold(root: string, hold: UpdateHold): boolean {
  try {
    const file = updateHoldPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hold, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function clearUpdateHold(root: string): void {
  try {
    fs.rmSync(updateHoldPath(root), { force: true });
  } catch {
    /* advisory */
  }
}

export function describeUpdateHold(hold: UpdateHold, now: number): string {
  const cause = hold.cause.split("\n", 1)[0]!.slice(0, 160);
  const failures = hold.failures === 1 ? "1 failure" : `${hold.failures} failures in a row`;
  const next = hold.retryAfter > now ? `a newer one not before ${describeWhen(hold.retryAfter, now)}` : "a newer one at the next check";
  const rollback = hold.rollback === "rolled-back" ? "" : describeRollback(hold.rollback);
  return `Auto-update held back: ${hold.target.slice(0, 8)} failed at ${hold.step} ${describeAgo(now - hold.at)}${rollback} — ${cause} (${failures}; never retrying it automatically, ${next}; \`strada update\` retries now)`;
}

export function describeUpdateEvent(event: UpdateEvent | undefined, now: number): string {
  if (!event) return "Last auto-update: none recorded";
  const ago = describeAgo(now - event.at);
  const shas = event.from && event.to ? ` ${event.from.slice(0, 8)} → ${event.to.slice(0, 8)}` : "";
  const reason = event.reason ? ` (${event.reason})` : "";
  return `Last auto-update: ${event.kind}${shas} ${ago}${reason}`;
}

/** "in 15 min" for a future instant, "3 min ago" for a past one. */
export function describeWhen(target: number, now: number): string {
  return describeAgo(now - target);
}

export function describeAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 0) return `in ${describeSpan(-ms)}`;
  return `${describeSpan(ms)} ago`;
}

export function describeSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h} h ${rem} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
