/**
 * The compaction A/B report: one row per arm, then what the replay read,
 * guessed and left out. A shape replay says so in its first line, because its
 * content is invented and only its sizes are measured.
 */

import type { SkeletonStats } from "./log-skeleton.js";
import type { ArmResult, Fidelity, HeadChurn } from "./replay.js";
import type { ReplaySource } from "./transcript.js";

export interface ReplayReport {
  readonly source: ReplaySource;
  /** The files read, as given. */
  readonly inputs: readonly string[];
  readonly contextWindow: number;
  /** The unit a cost is in, e.g. "USD (1.20 / 0.024 per Mtok)" or "relative". */
  readonly priceNote: string;
  readonly arms: readonly ArmResult[];
  readonly fidelity: Fidelity;
  readonly churn: HeadChurn;
  /** Shape replay only. */
  readonly skeleton?: SkeletonStats;
}

export const NOT_MEASURED = [
  "how often the model re-fetches what a stub replaced (needs a live run)",
  "solve rate and latency",
  "cache expiry, the provider's cache block size, and hits across sessions",
  "the live message-cap trim, which rewrites the head of the history as well; leaving it out flatters the cached share of \"current\"",
];

const n = (v: number): string => Math.round(v).toLocaleString("en-US");
const pct = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");
const delta = (v: number, base: number | undefined): string =>
  base === undefined || base === 0 ? "-" : `${v >= base ? "+" : ""}${((100 * (v - base)) / base).toFixed(1)}%`;
const cost = (v: number): string => (Math.abs(v) >= 100 ? n(v) : v.toFixed(4));

function armTable(arms: readonly ArmResult[]): string[] {
  const base = arms.find((a) => a.kind === "current");
  const header = [
    "arm", "events", "backstops", "input tokens", "median call", "p90 call", "max call",
    "cached (stable head)", "cost (stable head)", "vs current", "cached (head as logged)", "cost (head as logged)", "vs current",
  ];
  const rows = arms.map((a) => [
    a.arm,
    n(a.events),
    a.kind === "cliff" ? n(a.backstops) : "-",
    n(a.inputTokens),
    n(a.requestMedian),
    n(a.requestP90),
    n(a.requestMax),
    pct(a.cachedStableHead, a.inputTokens),
    cost(a.costStableHead),
    delta(a.costStableHead, base?.costStableHead),
    pct(a.cachedLoggedHead, a.inputTokens),
    cost(a.costLoggedHead),
    delta(a.costLoggedHead, base?.costLoggedHead),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const render = (cells: readonly string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [render(header), ...rows.map(render)];
}

function skeletonLines(s: SkeletonStats): string[] {
  return [
    `turn lines: ${n(s.turnLines)} read; dropped: ${n(s.turnsWithoutChat)} without a chatId, ${n(s.turnsWithoutCounts)} without their counts, ` +
      `${n(s.interleavedTurns)} lone call(s) of another session between a session's calls, and ${n(s.turnsWithUnknownStart)} in ` +
      `${n(s.sessionsWithUnknownStart)} session(s) whose start the log does not show`,
    `tool results: ${n(s.resultsLogged)} sized from their "Tool call" line, ${n(s.resultsInferred)} inferred from the input's growth, ` +
      `${n(s.resultsDefaulted)} given the session's median; ${n(s.toolLinesUnused)} of ${n(s.toolLines)} tool lines matched no replayed call`,
    `transitions: ${n(s.calibratedTransitions)} calibrated on the provider's count, ${n(s.uncalibratedTransitions)} not; ` +
      `the live loop cut a history ${n(s.liveHistoryDrops)} time(s) and resent the same history ${n(s.retriedTurns)} time(s)`,
  ];
}

export function formatReport(r: ReplayReport): string {
  const calls = r.arms[0]?.calls ?? 0;
  const out = [
    r.source === "shape"
      ? "Compaction A/B, offline: SHAPE REPLAY, NOT CONTENT. Sizes come from the daemon log; the content is placeholder text, " +
        "so the failure-line and re-fetch rules ran on invented content."
      : "Compaction A/B, offline: transcript replay (recorded content).",
    `input: ${r.inputs.join(", ")}`,
    `${n(r.arms[0]?.sessions ?? 0)} session(s), ${n(calls)} call(s); context window ${n(r.contextWindow)}; cost unit: ${r.priceNote}`,
    "",
    ...armTable(r.arms),
    "",
    'events = history rewrites by the strategy; backstops = compactSession runs the live window forced after the cliff; "vs current" compares cost.',
    "stable head: the system prompt and tool schemas never change, so only the strategy breaks the prefix (upper bound on caching).",
    "head as logged: a call whose prompt or tool-schema length differs from the previous call's misses entirely (lower bound).",
    `head churn: the prompt length changed on ${pct(r.churn.promptChanged, r.churn.transitions)} and the tool-schema length on ` +
      `${pct(r.churn.toolsChanged, r.churn.transitions)} of ${n(r.churn.transitions)} consecutive calls.`,
  ];
  if (r.skeleton) out.push("", "what the rebuild read:", ...skeletonLines(r.skeleton).map((l) => `  ${l}`));
  const f = r.fidelity;
  out.push(
    "",
    f.medianAbsError === null || f.p90AbsError === null
      ? "fidelity: not measured (no call with a logged input before a live cut)"
      : `fidelity: the append-only rebuild against the provider's count on ${n(f.calls)} call(s) before any live cut: ` +
        `median |error| ${(100 * f.medianAbsError).toFixed(1)}%, p90 ${(100 * f.p90AbsError).toFixed(1)}%` +
        (r.source === "shape" ? " (the sizes were fitted to these numbers: this checks the rebuild, not the content)" : ""),
    "",
    "not measured here:",
    ...NOT_MEASURED.map((l) => `  - ${l}`),
  );
  return out.join("\n");
}
