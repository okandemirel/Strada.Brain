/**
 * The play-through verdict, read back from the project.
 *
 * `unity_playthrough` (Strada.MCP) plays the game headlessly — boots the entry
 * scene, starts a level, taps until it ends, captures frames — and leaves
 * `Recordings/playthrough/playthrough-verdict.json`. This module is the
 * campaign's side of that contract: it reads the file, refuses one older than
 * the sprint (a verdict earned by an earlier build says nothing about this
 * one), and turns it into the sentences the delivery gate and the delivery
 * report use.
 *
 * Measured 2026-09-10: the campaign delivered "green" on compile, PlayMode
 * tests and art counts while no scene had gone Home → level → win/fail under
 * observation, and the entry scene idled after boot because nothing at runtime
 * calls StartLevel. A verdict that says "the game reported LevelWon after 12
 * taps and the frames moved" is the evidence those gates never had.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PlaythroughEvidence } from "./types.js";

export const PLAYTHROUGH_VERDICT_REL = join("Recordings", "playthrough", "playthrough-verdict.json");

interface VerdictFile {
  ok?: unknown;
  reasons?: unknown;
  record?: {
    terminalState?: unknown;
    autoStarted?: unknown;
    tapsDriven?: unknown;
    level?: unknown;
    scene?: unknown;
  } | null;
  frames?: { count?: unknown; flat?: unknown; maxMotionShare?: unknown } | null;
  measuredAt?: unknown;
}

/**
 * The verdict for THIS sprint: found only when the file exists, parses, and
 * was written at or after `sinceMs`. An older file is reported as stale so the
 * gate can say "you have a verdict, but from before this sprint's changes".
 */
export function readPlaythroughVerdict(projectRoot: string, sinceMs: number): PlaythroughEvidence {
  const path = join(projectRoot, PLAYTHROUGH_VERDICT_REL);
  if (!existsSync(path)) return { found: false };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { found: false };
  }
  if (mtimeMs < sinceMs) return { found: false, stale: true };
  let parsed: VerdictFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as VerdictFile;
  } catch {
    return { found: false, unreadable: true };
  }
  const record = parsed.record ?? undefined;
  const frames = parsed.frames ?? undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    found: true,
    ok: parsed.ok === true,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 8) : [],
    ...(record
      ? {
          terminalState: str(record.terminalState),
          autoStarted: record.autoStarted === true,
          tapsDriven: num(record.tapsDriven),
          level: num(record.level),
          scene: str(record.scene),
        }
      : {}),
    ...(frames
      ? { frames: { count: num(frames.count) ?? 0, flat: num(frames.flat) ?? 0, maxMotionShare: num(frames.maxMotionShare) ?? 0 } }
      : {}),
    measuredAt: str(parsed.measuredAt),
  };
}

/** One sentence for the delivery report and the structural findings. */
export function describePlaythrough(e: PlaythroughEvidence | undefined): string {
  if (!e || !e.found) {
    return e?.stale
      ? "play-through: the only verdict on disk predates this sprint — the game as delivered was never played"
      : e?.unreadable
      ? "play-through: the verdict file is unreadable — the game as delivered was never judged"
      : "play-through: NOT observed — nobody played the game as delivered (unity_playthrough never ran)";
  }
  const where = e.scene ? ` in ${e.scene}` : "";
  const frames = e.frames ? `; ${e.frames.count} frames, ${e.frames.flat} flat, max motion ${(e.frames.maxMotionShare * 100).toFixed(1)}%` : "";
  const start = e.autoStarted === false ? "; the game does NOT start a level by itself after boot (the test called StartLevel)" : "";
  if (e.ok) {
    return `play-through OK${where}: level ${e.level ?? "?"} played to ${e.terminalState ?? "a terminal state"} in ${e.tapsDriven ?? "?"} taps${frames}${start}`;
  }
  return `play-through FAILED${where}: ${e.reasons && e.reasons.length > 0 ? e.reasons.join("; ") : "no reason recorded"}${frames}${start}`;
}

/** What the final sprint is told when its play-through proof is missing or failed. */
export function playthroughDirective(e: PlaythroughEvidence | undefined): string {
  const why = !e || !e.found
    ? e?.stale
      ? "the only play-through verdict on disk is from BEFORE this sprint began"
      : "no play-through of the game as it now stands was observed"
    : `the last play-through FAILED: ${e.reasons && e.reasons.length > 0 ? e.reasons.join("; ") : "no reason recorded"}`;
  return (
    `PLAY-THROUGH REQUIRED: ${why}. Run unity_playthrough (it boots the entry scene, starts a level, ` +
    "taps through it and judges the frames) and fix whatever it names until its verdict is ok — a level " +
    "that never ends, a screen that never changes, or a flow service that refuses to start is not a " +
    "delivered game. Its verdict, not your description of the game, is the proof."
  );
}
