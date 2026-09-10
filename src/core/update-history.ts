/**
 * Auto-update history — what the updater did, readable by `strada status`.
 *
 * Until 2026-09-10 the only record of an auto-update was a log line
 * ("Auto-update pulled" / "Auto-update rolling back"), so an operator asking
 * "did the daemon update last night, and did it roll back?" had to grep the
 * log. The updater now appends every outcome here; `strada status` prints the
 * last one. Kept short (last HISTORY_LIMIT events), written atomically.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type UpdateEventKind = "pulled" | "rolled-back" | "deferred" | "failed" | "rollback-refused";

export interface UpdateEvent {
  at: number;
  kind: UpdateEventKind;
  from?: string;
  to?: string;
  reason?: string;
}

export const UPDATE_HISTORY_FILE = "auto-update.json";
export const HISTORY_LIMIT = 20;

export function updateHistoryPath(installRoot: string): string {
  return path.join(installRoot, ".strada", UPDATE_HISTORY_FILE);
}

export function readUpdateHistory(installRoot: string): UpdateEvent[] {
  try {
    const raw = fs.readFileSync(updateHistoryPath(installRoot), "utf8");
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
export function recordUpdateEvent(installRoot: string, event: UpdateEvent): void {
  try {
    const file = updateHistoryPath(installRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const events = [...readUpdateHistory(installRoot), event].slice(-HISTORY_LIMIT);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(events, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* history is advisory */
  }
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
