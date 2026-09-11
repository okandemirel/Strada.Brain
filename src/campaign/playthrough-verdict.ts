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
import type { PlaythroughEvidence, PlaythroughPerf, RuntimeSceneDump } from "./types.js";

export const PLAYTHROUGH_VERDICT_REL = join("Recordings", "playthrough", "playthrough-verdict.json");
/** The same verdict shape, written by unity_run_player after playing INSIDE the built player. */
export const PLAYER_PLAYTHROUGH_VERDICT_REL = join("Recordings", "player-playthrough", "playthrough-verdict.json");

interface VerdictFile {
  /* loose: written by unity_playthrough / PlayerPlaythroughRunner */
  ok?: unknown;
  reasons?: unknown;
  record?: {
    outcome?: unknown;
    reachedOutcome?: unknown;
    startAccepted?: unknown;
    autoStarted?: unknown;
    actions?: unknown;
    session?: unknown;
    scene?: unknown;
    missing?: unknown;
    sessionCount?: unknown;
    sessions?: unknown;
    runtime?: unknown;
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
export function readPlaythroughVerdict(projectRoot: string, sinceMs: number, rel: string = PLAYTHROUGH_VERDICT_REL): PlaythroughEvidence {
  const path = join(projectRoot, rel);
  if (!existsSync(path)) return { found: false };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { found: false };
  }
  // Two milliseconds of tolerance: Node's utimes path truncates the fractional
  // second to microseconds, so a file touched in the SAME millisecond the sprint
  // started reads 0.001 ms older than it and was called stale (Codex 2026-09-11
  // B#25 — CI coverage job, ~2 of 5 runs).
  if (mtimeMs + 2 < sinceMs) return { found: false, stale: true };
  let parsed: VerdictFile;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    // `null`, a number, an array: JSON.parse accepts all of them, and the
    // first property read THREW out of this reader into the settlement chain,
    // which logged it after the milestone had already been persisted green —
    // campaign executing, zero submissions, no recovery timer, and the same
    // exception on every boot (Codex 2026-09-11 F#4).
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { found: false, unreadable: true };
    }
    parsed = raw as VerdictFile;
  } catch {
    return { found: false, unreadable: true };
  }
  const record = parsed.record ?? undefined;
  const frames = parsed.frames ?? undefined;
  const perf = parsed.perf ?? undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  // `ok` is a claim; the record and the frames are the evidence. A file that
  // says {"ok":true} with no outcome reached and no frame captured was accepted
  // as a played game (Codex 2026-09-11 B#3).
  // WHAT PLAY LEAVES BEHIND: actions the driver made and frames that were
  // captured. An outcome is NOT required — an endless or sandbox game has no
  // terminal state (Codex 2026-09-11 C#14) — but a session the game REFUSED
  // to start is not play whatever the file claims (C#11).
  // Whole counts: 0.5 actions and 0.5 frames are impossible records, and they
  // authenticated a play-through (Codex 2026-09-11 D#30).
  const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 0;
  const actionsTaken = whole(record?.actions);
  const framesCaptured = whole(frames?.count);
  const refused = record !== undefined && (record.startAccepted === false || str(record.outcome) === "Refused" || str(record.missing) !== undefined);
  const evidenced = actionsTaken && framesCaptured && !refused;
  // Only STRINGS: `reasons.map(String)` threw "Cannot convert object to
  // primitive value" on `[{"toString":null}]`, outside the guarded parse and
  // into a settlement path that had already persisted the milestone green
  // (Codex 2026-09-11 H#12).
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((r): r is string => typeof r === "string").slice(0, 8)
    : [];
  if (parsed.ok === true && !evidenced) {
    reasons.push(refused
      ? "the verdict claims ok but the game refused to start the session"
      : !actionsTaken
      ? "the verdict claims ok but the driver took no action"
      : "the verdict claims ok but records no captured frame");
  }
  return {
    found: true,
    ok: parsed.ok === true && evidenced,
    reasons,
    ...(record
      ? {
          outcome: str(record.outcome),
          autoStarted: record.autoStarted === true,
          actions: num(record.actions),
          session: num(record.session),
          scene: str(record.scene),
          missing: str(record.missing),
          ...(typeof record.sessionCount === "number" && record.sessionCount >= 0 ? { sessionCount: record.sessionCount } : {}),
          ...(record.runtime && typeof record.runtime === "object" ? { runtime: parseRuntime(record.runtime as Record<string, unknown>) } : {}),
          ...(Array.isArray(record.sessions) && record.sessions.length > 0
            ? {
                sessions: record.sessions.slice(0, 24).map((s) => {
                  const r = (s ?? {}) as Record<string, unknown>;
                  // An ABSENT index is not index 0 and an absent action count
                  // is not zero actions — inventing either made a record with
                  // neither read as "level 0, played" (Codex 2026-09-11 E#7).
                  return {
                    ...(num(r.index) !== undefined ? { index: num(r.index) } : {}),
                    outcome: r.startAccepted === false ? "Refused" : str(r.outcome) ?? "None",
                    ...(num(r.actions) !== undefined ? { actions: num(r.actions) } : {}),
                    seconds: num(r.seconds) ?? 0,
                  };
                }),
              }
            : {}),
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

function parseRuntime(r: Record<string, unknown>): RuntimeSceneDump {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // Only STRINGS: `map(String)` threw on `[{"toString":null}]` here too, the
  // same wedge one field over (Codex 2026-09-11 I#12).
  const names = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 40) : [];
  return {
    renderers: n(r.renderers),
    worldRenderers: n(r.worldRenderers),
    spriteRenderers: n(r.spriteRenderers),
    meshRenderers: n(r.meshRenderers),
    canvases: n(r.canvases),
    particleSystems: n(r.particleSystems),
    audioSources: n(r.audioSources),
    audioPlaying: n(r.audioPlaying),
    sprites: names(r.sprites),
    meshes: names(r.meshes),
    primitiveMeshes: n(r.primitiveMeshes),
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
  const catalog = e.sessionCount !== undefined ? `; catalog ${e.sessionCount} session(s)` : "; no session catalog (level count not measurable)";
  const played =
    e.sessions && e.sessions.length > 1
      ? `; played ${e.sessions.length}: ${e.sessions.map((s) => `#${s.index} ${s.outcome} in ${s.actions}`).join(", ")}`
      : "";
  if (e.ok) {
    return `play-through OK${where}: session ${e.session ?? "?"} played to ${e.outcome ?? "an outcome"} in ${e.actions ?? "?"} actions${played}${frames}${start}${perf}${catalog}`;
  }
  return `play-through FAILED${where}: ${e.reasons && e.reasons.length > 0 ? e.reasons.join("; ") : "no reason recorded"}${played}${frames}${start}${perf}${catalog}`;
}

/** The timing, with its medium: a frame rate from the batch editor is a floor, not the player's. */
export function describePerf(p: PlaythroughPerf): string {
  const parts: string[] = [];
  if (p.bootSeconds !== undefined) parts.push(`boot ${p.bootSeconds.toFixed(1)} s`);
  if (p.avgFps !== undefined) parts.push(`${p.avgFps.toFixed(1)} fps average over ${p.playFrames} frames`);
  if (p.worstFrameMs !== undefined) parts.push(`worst frame ${p.worstFrameMs.toFixed(0)} ms`);
  const medium = p.medium === "editor-playmode-batch" ? "editor play mode, batch — not the shipped player" : p.medium === "player" ? "built player, real rendering" : p.medium;
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
    "Strada.Core.Play.IPlaythroughDriver, starts a session, acts until it ends and judges the frames; register a " +
    "Strada.Core.Play.ISessionCatalog too and pass sessions: \"all\" so every level is played and counted) and fix " +
    "whatever it names until its verdict is ok — no registered driver, a session that never ends, a screen " +
    "that never changes, or a driver that refuses to start is not a delivered game. Its verdict, not your " +
    "description of the game, is the proof."
  );
}
