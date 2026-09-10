/**
 * The GDD's own numbers, held against what was measured.
 *
 * A design document states targets in numbers — "60 fps", "loads in under
 * 3 seconds", "12 levels", "a round lasts 30–60 seconds" — and until
 * 2026-09-10 nothing in the delivery path ever read one of them back: the
 * planner's prompt repeated them and the gates measured compile, tests, scene
 * structure and a play-through, none of which is a number the GDD named.
 *
 * This module extracts such claims from the text and answers each one from
 * evidence the campaign already holds, or says plainly that it cannot. Three
 * outcomes, never a fourth: MET, NOT MET, or NOT MEASURABLE (with why). A
 * claim without a measurement is listed, not dropped — a report that is silent
 * about "60 fps" reads as if it were checked.
 *
 * What is measured today comes from the play-through verdict (Strada.MCP
 * unity_playthrough): boot time to services, average frame rate and the worst
 * frame during play, and the session length when the session ended. The
 * verdict names its medium — the editor in play mode under -batchmode — and
 * so does every line here: a frame rate from there is a floor for the player,
 * not the player's number, so a frame-rate shortfall is reported but does not
 * refuse delivery; a boot budget or a session length that is blown is.
 * Nothing here knows a game's own names.
 */
import type { PlaythroughEvidence } from "./types.js";

export type ClaimKind = "fps" | "boot_seconds" | "session_seconds" | "level_count";

export interface NumericClaim {
  readonly kind: ClaimKind;
  /** "min": measured must be at least `value`; "max": at most; "eq": exactly. */
  readonly comparator: "min" | "max" | "eq";
  readonly value: number;
  /** The GDD sentence fragment the number came from (trimmed, ≤ 140 chars). */
  readonly text: string;
}

export interface ClaimAssessment {
  readonly claim: NumericClaim;
  readonly status: "met" | "not_met" | "unmeasured";
  /** What was measured, in the claim's unit, when it was. */
  readonly measured?: number;
  /** Why it could not be measured, or which medium the measurement came from. */
  readonly note: string;
  /** True when a NOT MET should refuse delivery (the medium answers the claim). */
  readonly blocking: boolean;
}

const MAX_CLAIMS = 12;

/** A window of text around a number, one sentence at most. */
function fragment(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", index), text.lastIndexOf(". ", index) + 1, index - 90);
  let end = text.indexOf("\n", index + length);
  if (end < 0) end = text.length;
  const period = text.indexOf(". ", index + length);
  if (period >= 0 && period < end) end = period + 1;
  return text.slice(start, Math.min(end, index + length + 90)).replace(/\s+/g, " ").trim().slice(0, 140);
}

function toSeconds(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("ms") || u.startsWith("millis")) return value / 1000;
  if (u.startsWith("min")) return value * 60;
  return value;
}

const FPS_RE = /\b(\d{2,3})\s*(?:fps|frames?\s+per\s+second)\b/gi;
const BOOT_RE =
  /\b(?:load(?:ing|s)?|boot(?:s|ing)?|start-?up|launch(?:es|ing)?|cold\s+start|time\s+to\s+(?:play|interactive|first\s+frame))\b[^.\n]{0,60}?\b(?:under|below|within|less\s+than|no\s+more\s+than|at\s+most|max(?:imum)?(?:\s+of)?|<=?|≤)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|min(?:ute)?s?)\b/gi;
const BOOT_REVERSED_RE =
  /\b(?:under|below|within|less\s+than|no\s+more\s+than|at\s+most)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|min(?:ute)?s?)\b[^.\n]{0,40}?\b(?:to\s+)?(?:load(?:ing)?|boot(?:ing)?|start-?up|launch|first\s+frame|interactive)\b/gi;
const LEVEL_COUNT_RE = /\b(\d{1,3})\s+(?:levels|stages|rounds|puzzles|worlds|chapters|waves)\b/gi;
const SESSION_RE =
  /\b(?:each|every|per|a|one|single|average|typical)\s+(?:level|session|round|match|run|game|play\s+session|attempt)\b[^.\n]{0,50}?\b(\d+(?:\.\d+)?)(?:\s*(?:[-–~]|to)\s*(\d+(?:\.\d+)?))?\s*(ms|s|secs?|seconds?|min(?:ute)?s?)\b/gi;

/**
 * Every numeric claim in the GDD this module knows how to read, in document
 * order, de-duplicated by kind+value, capped at MAX_CLAIMS (the cap is
 * reported by the caller through the returned `truncated` flag).
 */
export function extractNumericClaims(gddText: string): { claims: NumericClaim[]; truncated: number } {
  const text = gddText ?? "";
  const found: NumericClaim[] = [];
  const seen = new Set<string>();
  const push = (c: NumericClaim) => {
    const key = `${c.kind}:${c.comparator}:${c.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(c);
  };
  for (const m of text.matchAll(FPS_RE)) {
    const value = Number(m[1]);
    if (value >= 10 && value <= 240) push({ kind: "fps", comparator: "min", value, text: fragment(text, m.index ?? 0, m[0].length) });
  }
  for (const re of [BOOT_RE, BOOT_REVERSED_RE]) {
    for (const m of text.matchAll(re)) {
      const value = toSeconds(Number(m[1]), m[2] ?? "s");
      if (value > 0 && value <= 600) push({ kind: "boot_seconds", comparator: "max", value, text: fragment(text, m.index ?? 0, m[0].length) });
    }
  }
  for (const m of text.matchAll(LEVEL_COUNT_RE)) {
    const value = Number(m[1]);
    if (value >= 1) push({ kind: "level_count", comparator: "eq", value, text: fragment(text, m.index ?? 0, m[0].length) });
  }
  for (const m of text.matchAll(SESSION_RE)) {
    const unit = m[3] ?? "s";
    const upper = toSeconds(Number(m[2] ?? m[1]), unit);
    if (upper > 0 && upper <= 4 * 3600) push({ kind: "session_seconds", comparator: "max", value: upper, text: fragment(text, m.index ?? 0, m[0].length) });
  }
  const truncated = Math.max(0, found.length - MAX_CLAIMS);
  return { claims: found.slice(0, MAX_CLAIMS), truncated };
}

/** Hold each claim against the play-through evidence. */
export function assessNumericClaims(
  claims: readonly NumericClaim[],
  playthrough: PlaythroughEvidence | undefined,
  /** The play-through inside the built player, when the campaign ran one — answers the frame rate. */
  player?: PlaythroughEvidence,
): ClaimAssessment[] {
  const perf = playthrough?.found ? playthrough.perf : undefined;
  const playerPerf = player?.found ? player.perf : undefined;
  const medium = perf?.medium === "editor-playmode-batch" ? "editor play mode, batch" : perf?.medium ?? "";
  const noRun = "no play-through of this build was observed (unity_playthrough leaves the timing)";
  return claims.map((claim): ClaimAssessment => {
    switch (claim.kind) {
      case "fps": {
        // The built player answers the claim (2026-09-10): real rendering,
        // vsync, the frame rate a person sees. Measured, and blocking.
        if (playerPerf?.avgFps !== undefined && playerPerf.medium === "player") {
          const met = playerPerf.avgFps >= claim.value;
          return {
            claim,
            status: met ? "met" : "not_met",
            measured: Number(playerPerf.avgFps.toFixed(1)),
            note:
              `${playerPerf.avgFps.toFixed(1)} fps average over ${playerPerf.playFrames} frames in the built player (real rendering)` +
              (playerPerf.worstFrameMs !== undefined ? `, worst frame ${playerPerf.worstFrameMs.toFixed(0)} ms` : ""),
            blocking: true,
          };
        }
        if (!perf || perf.avgFps === undefined) return { claim, status: "unmeasured", note: perf ? "the play-through recorded no frame timing" : noRun, blocking: false };
        // Measured live 2026-09-10: 184 689 frames in 42 s = 4390 "fps" in the
        // batch editor, which renders only at capture points. That number says
        // nothing about the player's frame rate in either direction, so the
        // claim stays NOT MEASURED with the figure disclosed; the worst frame
        // (a real hitch) is reported beside it.
        return {
          claim,
          status: "unmeasured",
          measured: Number(perf.avgFps.toFixed(1)),
          note:
            `${perf.avgFps.toFixed(1)} fps loop rate over ${perf.playFrames} frames in ${medium}, which renders only at capture points` +
            (perf.worstFrameMs !== undefined ? ` (worst frame ${perf.worstFrameMs.toFixed(0)} ms)` : "") +
            " — no evidence about the player's frame rate; a measurement inside the built player is the next rung",
          blocking: false,
        };
      }
      case "boot_seconds": {
        if (!perf || perf.bootSeconds === undefined) return { claim, status: "unmeasured", note: perf ? "the bootstrapper never published its services, so boot time has no end" : noRun, blocking: false };
        const met = perf.bootSeconds <= claim.value;
        return {
          claim,
          status: met ? "met" : "not_met",
          measured: Number(perf.bootSeconds.toFixed(2)),
          note: `scene load → services in ${perf.bootSeconds.toFixed(1)} s (${medium})`,
          blocking: true,
        };
      }
      case "session_seconds": {
        if (!playthrough?.found) return { claim, status: "unmeasured", note: noRun, blocking: false };
        if (!perf || playthrough.ok !== true || !playthrough.outcome || playthrough.outcome === "None") {
          return { claim, status: "unmeasured", note: "the session never reached an outcome, so its length is unknown", blocking: false };
        }
        const met = perf.playSeconds <= claim.value;
        return {
          claim,
          status: met ? "met" : "not_met",
          measured: Number(perf.playSeconds.toFixed(1)),
          note: `session ${playthrough.session ?? "?"} reached ${playthrough.outcome} after ${perf.playSeconds.toFixed(1)} s of driven play (${medium})`,
          blocking: true,
        };
      }
      case "level_count": {
        if (!playthrough?.found) return { claim, status: "unmeasured", note: noRun, blocking: false };
        if (playthrough.sessionCount === undefined) {
          return {
            claim,
            status: "unmeasured",
            note: "the game registers no Strada.Core.Play.ISessionCatalog, so its sessions cannot be counted",
            blocking: false,
          };
        }
        const met = playthrough.sessionCount === claim.value;
        const played = playthrough.sessions?.length ?? 0;
        const finished = playthrough.sessions?.filter((s) => s.outcome !== "None" && s.outcome !== "Refused").length ?? 0;
        return {
          claim,
          status: met ? "met" : "not_met",
          measured: playthrough.sessionCount,
          note: `the game's session catalog reports ${playthrough.sessionCount}${played > 0 ? `; ${finished} of ${played} played session(s) reached an outcome` : ""}`,
          blocking: true,
        };
      }
    }
  });
}

const KIND_LABEL: Record<ClaimKind, string> = {
  fps: "frame rate",
  boot_seconds: "boot time",
  session_seconds: "session length",
  level_count: "level count",
};

function unit(kind: ClaimKind): string {
  return kind === "fps" ? " fps" : kind === "level_count" ? "" : " s";
}

/** One line per claim for the delivery report; the header says how many there were. */
export function describeClaims(assessments: readonly ClaimAssessment[], truncated = 0): string[] {
  if (assessments.length === 0) return ["GDD numbers: none found (no frame-rate, load-time, level-count or session-length figure in the text)"];
  const lines = assessments.map((a) => {
    const target = `${a.claim.comparator === "min" ? "≥" : a.claim.comparator === "max" ? "≤" : "="} ${a.claim.value}${unit(a.claim.kind)}`;
    const head = `GDD ${KIND_LABEL[a.claim.kind]} ${target}`;
    if (a.status === "unmeasured") return `${head}: NOT MEASURED — ${a.note} (GDD: "${a.claim.text}")`;
    return `${head}: ${a.status === "met" ? "MET" : "NOT MET"} — ${a.note}`;
  });
  if (truncated > 0) lines.push(`GDD numbers: ${truncated} further claim(s) not listed`);
  return lines;
}

/** The refusal sentence when a claim the medium can answer is not met; undefined otherwise. */
export function claimsRefusal(assessments: readonly ClaimAssessment[]): string | undefined {
  const failed = assessments.filter((a) => a.status === "not_met" && a.blocking);
  if (failed.length === 0) return undefined;
  return (
    "THE GDD'S OWN NUMBERS ARE NOT MET: " +
    failed
      .map((a) => `${KIND_LABEL[a.claim.kind]} ${a.claim.comparator === "max" ? "≤" : a.claim.comparator === "min" ? "≥" : "="} ${a.claim.value}${unit(a.claim.kind)} measured ${a.measured}${unit(a.claim.kind)} (${a.note})`)
      .join("; ") +
    ". Fix the game until unity_playthrough measures the budget met; the GDD's number, not a description, is the target."
  );
}
