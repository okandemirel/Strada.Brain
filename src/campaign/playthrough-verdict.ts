/**
 * The play-through verdict, read back from the project.
 *
 * `unity_playthrough` (Strada.MCP) plays the game headlessly through the one
 * contract every Strada.Core game registers, Strada.Core.Play.IPlaythroughDriver
 * — boots the entry scene, starts a session, acts until it ends, records
 * frames — and leaves `Recordings/playthrough/playthrough-verdict.json`. This module is the
 * campaign's side of that contract: it reads the file, refuses one older than
 * the sprint (a verdict earned by an earlier build says nothing about this
 * one), and turns it into the sentences the delivery gate and the delivery
 * report use.
 *
 * Measured 2026-09-10 on the test vehicle: the campaign delivered "green" on
 * compile, PlayMode tests and art counts while no scene had gone Home → play →
 * outcome under observation, and the entry scene idled after boot because
 * nothing at runtime starts a session. A verdict that says "the game reported
 * Won after 12 actions and the frames moved" is the evidence those gates never
 * had. Nothing here knows a game's own names: the driver contract is the only
 * vocabulary.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PlaythroughEvidence, PlaythroughPerf } from "./types.js";

export const PLAYTHROUGH_VERDICT_REL = join("Recordings", "playthrough", "playthrough-verdict.json");

interface VerdictFile {
  ok?: unknown;
  reasons?: unknown;
  record?: {
    outcome?: unknown;
    autoStarted?: unknown;
    actions?: unknown;
    session?: unknown;
    scene?: unknown;
    missing?: unknown;
  } | null;
  frames?: { count?: unknown; flat?: unknown; maxMotionShare?: unknown } | null;
  perf?: {
    medium?: unknown;
    bootSeconds?: unknown;
    playSeconds?: unknown;
    playFrames?: unknown;
    avgFps?: unknown;
    worstFrameMs?: unknown;
  } | null;
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
  const perf = parsed.perf ?? undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    found: true,
    ok: parsed.ok === true,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 8) : [],
    ...(record
      ? {
          outcome: str(record.outcome),
          autoStarted: record.autoStarted === true,
          actions: num(record.actions),
          session: num(record.session),
          scene: str(record.scene),
          missing: str(record.missing),
        }
      : {}),
    ...(frames
      ? { frames: { count: num(frames.count) ?? 0, flat: num(frames.flat) ?? 0, maxMotionShare: num(frames.maxMotionShare) ?? 0 } }
      : {}),
    ...(perf
      ? {
          perf: {
            medium: str(perf.medium) ?? "unknown",
            bootSeconds: num(perf.bootSeconds),
            playSeconds: num(perf.playSeconds) ?? 0,
            playFrames: num(perf.playFrames) ?? 0,
            avgFps: num(perf.avgFps),
            worstFrameMs: num(perf.worstFrameMs),
          },
        }
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
  const start = e.autoStarted === false && !e.missing ? "; the game does NOT start play by itself after boot (the driver's StartSession was called)" : "";
  const perf = e.perf ? `; ${describePerf(e.perf)}` : "";
  if (e.ok) {
    return `play-through OK${where}: session ${e.session ?? "?"} played to ${e.outcome ?? "an outcome"} in ${e.actions ?? "?"} actions${frames}${start}${perf}`;
  }
  return `play-through FAILED${where}: ${e.reasons && e.reasons.length > 0 ? e.reasons.join("; ") : "no reason recorded"}${frames}${start}${perf}`;
}

/** The timing, with its medium: a frame rate from the batch editor is a floor, not the player's. */
export function describePerf(p: PlaythroughPerf): string {
  const parts: string[] = [];
  if (p.bootSeconds !== undefined) parts.push(`boot ${p.bootSeconds.toFixed(1)} s`);
  if (p.avgFps !== undefined) parts.push(`${p.avgFps.toFixed(1)} fps average over ${p.playFrames} frames`);
  if (p.worstFrameMs !== undefined) parts.push(`worst frame ${p.worstFrameMs.toFixed(0)} ms`);
  const medium = p.medium === "editor-playmode-batch" ? "editor play mode, batch — not the shipped player" : p.medium;
  return `timing (${medium}): ${parts.length > 0 ? parts.join(", ") : "nothing recorded"}`;
}

/** What the final sprint is told when its play-through proof is missing or failed. */
export function playthroughDirective(e: PlaythroughEvidence | undefined): string {
  const why = !e || !e.found
    ? e?.stale
      ? "the only play-through verdict on disk is from BEFORE this sprint began"
      : "no play-through of the game as it now stands was observed"
    : `the last play-through FAILED: ${e.reasons && e.reasons.length > 0 ? e.reasons.join("; ") : "no reason recorded"}`;
  return (
    `PLAY-THROUGH REQUIRED: ${why}. Run unity_playthrough (it boots the entry scene, resolves the game's ` +
    "Strada.Core.Play.IPlaythroughDriver, starts a session, acts until it ends and judges the frames) and fix " +
    "whatever it names until its verdict is ok — no registered driver, a session that never ends, a screen " +
    "that never changes, or a driver that refuses to start is not a delivered game. Its verdict, not your " +
    "description of the game, is the proof."
  );
}
