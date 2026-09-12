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
import { frameRateAnswersPlatform, gddPlatform, opensWithPlatformName, type GddPlatform } from "./gdd-platform.js";

export type ClaimKind = "fps" | "boot_seconds" | "level_load_seconds" | "session_seconds" | "level_count";

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

/**
 * The platform a claim's OWN sentence names, when it names one.
 *
 * A document may hold several platforms and several budgets — "Windows at
 * least 60 fps; Android at most 30 fps" — and reading the document-wide set
 * for every claim let a Windows measurement answer the Android sentence, and
 * applied both budgets to both targets (Codex 2026-09-12 AA#4).
 */
function platformOfClaim(text: string): GddPlatform | undefined {
  const named = gddPlatform(text);
  if (named.targets.length > 0 || named.handheld) return named;
  return undefined;
}

/**
 * A CLAUSE END, wherever it is. A semicolon or a sentence dot ends a clause
 * whether or not a space follows it: requiring "; " left
 * "Windows ≥60 fps;Android ≤30 fps" — a document written without the space,
 * which happens — as one fragment holding both platforms, so each claim was
 * judged against the other's platform (Codex 2026-09-12 AC J1). A dot between
 * two digits is a decimal point, not an end.
 */
function isClauseEnd(text: string, i: number): boolean {
  const c = text[i];
  if (c === ";") return true;
  // A COMMA BETWEEN TWO PLATFORMS' REQUIREMENTS ends a clause as a semicolon
  // does: "Windows at least 60 fps, Android at most 30 fps" gave both claims
  // a fragment holding both platforms (Codex 2026-09-13 AF#12).
  if (c === ",") return opensWithPlatformName(text.slice(i + 1, i + 32));
  if (c !== ".") return false;
  // A decimal point is not an end…
  if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) return false;
  // …and neither is the dot inside an abbreviation: "Windows (e.g. desktop)
  // at least 60 fps" lost "Windows" to the dot in "e.g." (AF#12). A sentence
  // ends where the next thing said starts anew.
  const after = text.slice(i + 1).match(/^\s*(\S)/u)?.[1];
  if (after === undefined) return true;
  return !/[a-zçğıöşü]/u.test(after);
}

/** A window of text around a number, one sentence at most. */
function fragment(text: string, index: number, length: number): string {
  // WITHIN ONE CLAUSE (Codex 2026-09-12 AB J2.2).
  let before = -1;
  for (let i = index - 1; i >= 0 && before < 0; i--) if (isClauseEnd(text, i)) before = i;
  const start = Math.max(0, text.lastIndexOf("\n", index), before + 1, index - 90);
  let end = text.indexOf("\n", index + length);
  if (end < 0) end = text.length;
  for (let i = index + length; i < end; i++) {
    if (isClauseEnd(text, i)) { end = i + 1; break; }
  }
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
  /\b(?:load(?:ing|s)?|boot(?:s|ing)?|start-?up|launch(?:es|ing)?|cold\s+start|time\s+to\s+(?:play|interactive|first\s+frame))\b[^.;\n]{0,60}?(?:\b(?:under|below|within|less\s+than|no\s+more\s+than|at\s+most|max(?:imum)?(?:\s+of)?)\b|<=?|≤)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|min(?:ute)?s?)\b/gi;
const BOOT_REVERSED_RE =
  /\b(?:under|below|within|less\s+than|no\s+more\s+than|at\s+most)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|min(?:ute)?s?)\b[^.;\n]{0,40}?\b(?:to\s+)?(?:load(?:ing)?|boot(?:ing)?|start-?up|launch|first\s+frame|interactive)\b/gi;
/**
 * A count with its separators and an optional "+": "20 levels", "3,000+
 * levels", "1.200 Level" — a four-digit catalogue used to match nothing at
 * all, so a document asking for 3,000 levels stated no level count and the
 * delivery was measured against whatever smaller number the prose held
 * (Codex 2026-09-12 U#F3).
 */
const LEVEL_COUNT_RE =
  /\b(\d{1,3}(?:[.,]\d{3})+|\d{1,5})\s*(\+|\s+or\s+(?:more|fewer|less))?\s+((?:(?!(?:of|per|in|for|across|with|and|to|from|between|by|over|after|before|than|each|about|up|complete[sd]?|completing|play(?:s|ed|ing)?|finish(?:es|ed|ing)?|unlock(?:s|ed|ing)?|clear(?:s|ed|ing)?|beat(?:s|en|ing)?|reach(?:es|ed|ing)?|attempt(?:s|ed|ing)?|skip(?:s|ped|ping)?)\b)[a-z][a-z-]{2,14}\s+){0,3})(?:levels|stages|rounds|puzzles|worlds|chapters|waves)\b/gi;
/**
 * The subject of the timing is a LEVEL opening, not the application starting.
 * Read on a window that reaches BEHIND the match, because the boot regex
 * starts at the verb: in "level load ≤ 1.5 s" the noun is not in the match.
 */
const LOADS_A_LEVEL_RE =
  /\b(?:level|stage|scene|round|puzzle|match|map)s?\b[^.\n]{0,12}?\b(?:load|open|enter|ready|transition)|\b(?:load|open|enter)(?:s|ing)?\b[^.\n]{0,12}?\b(?:level|stage|scene|round|puzzle|match|map)s?\b/i;
/** "at least 20 levels" is met by 21; "up to 20" is not (Codex 2026-09-12 U#F3). */
const COUNT_AT_LEAST_RE =
  /(?:\b(?:at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than|not\s+fewer\s+than|more\s+than|over|above|beyond)\b|>=|≥|>)\s*$/i;
const COUNT_AT_MOST_RE =
  /(?:\b(?:up\s+to|at\s+most|no\s+more\s+than|not\s+more\s+than|max(?:imum)?(?:\s+of)?|fewer\s+than|less\s+than|under|below)\b|<=|≤|<)\s*$/i;
const COUNT_OR_MORE_AHEAD_RE = /^\s*(?:or\s+more|\+|and\s+up)\b/i;
/** "12 levels or fewer" — the qualifier sits after the noun (Codex 2026-09-12 W#7). */
const COUNT_OR_FEWER_AHEAD_RE = /^\s*(?:or\s+(?:fewer|less)|at\s+most)\b/i;

/** The text since the last clause boundary — a subject cannot be read across one. */
function clauseTail(before: string): string {
  // A DECIMAL POINT IS NOT A SENTENCE. "Each round lasts at least 1.5
  // seconds" had its "at least" cut away by the dot in 1.5, and the floor was
  // read as a ceiling — a half-second round then passed (Codex 2026-09-12
  // W#7). A sentence end is a dot NOT between two digits.
  let boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("\n"));
  for (let i = before.length - 1; i > boundary; i--) {
    if (before[i] !== ".") continue;
    const left = before[i - 1] ?? "";
    const right = before[i + 1] ?? "";
    if (/\d/.test(left) && /\d/.test(right)) continue;
    boundary = i;
    break;
  }
  return boundary >= 0 ? before.slice(boundary + 1) : before;
}

/**
 * A count of levels PLAYED is not a count of levels SHIPPED. "Most players
 * finish 30 levels" is a retention figure, and reading it as the catalogue
 * size held the delivery to a number the document never promised (Codex
 * 2026-09-12 W#7).
 */
const PLAYS_NOT_SHIPS_RE =
  /\b(?:complete[sd]?|completing|finish(?:es|ed|ing)?|play(?:s|ed|ing)?|clear(?:s|ed|ing)?|beat(?:s|en|ing)?|reach(?:es|ed|ing)?|unlock(?:s|ed|ing)?|attempt(?:s|ed|ing)?|replay(?:s|ed|ing)?)\s+$/i;

/** A number written with thousands separators: "3,000" and "3.000" are 3000. */
function countValue(digits: string): number {
  return Number(digits.replace(/[.,]/g, ""));
}

/**
 * WHICH WAY the document's count points, read from the words around it. The
 * reader used to call every count exact, so "ship at least 20 levels" was met
 * by exactly 20 and failed on 21 (Codex 2026-09-12 U#F3).
 */
export function countComparator(text: string, at: number, matched: string, qualifier: string): "min" | "max" | "eq" {
  // "3,000+", "3,000 or more" — the qualifier sits between the number and the
  // noun, so the count regex carries it.
  if (qualifier.includes("+") || /\bor\s+more\b/i.test(qualifier)) return "min";
  if (/\bor\s+(?:fewer|less)\b/i.test(qualifier)) return "max";
  const before = clauseTail(text.slice(Math.max(0, at - 40), at));
  const after = text.slice(at + matched.length, at + matched.length + 20);
  if (COUNT_OR_MORE_AHEAD_RE.test(after)) return "min";
  if (COUNT_OR_FEWER_AHEAD_RE.test(after)) return "max";
  if (COUNT_AT_MOST_RE.test(before)) return "max";
  if (COUNT_AT_LEAST_RE.test(before)) return "min";
  return "eq";
}

/**
 * A STRICT bound on a whole number is a bound on the next one: "more than 12
 * levels" is at least thirteen, "fewer than 12" is at most eleven. Read as
 * inclusive, a game with exactly twelve satisfied both (Codex 2026-09-12 V).
 */
const COUNT_STRICTLY_MORE_RE = /(?:\b(?:more\s+than|over|above|beyond)\b|>(?!=))\s*$/i;
const COUNT_STRICTLY_FEWER_RE = /(?:\b(?:fewer\s+than|less\s+than|under|below)\b|<(?!=))\s*$/i;

export function countBound(
  text: string,
  at: number,
  matched: string,
  qualifier: string,
  value: number,
): { comparator: "min" | "max" | "eq"; value: number } {
  const comparator = countComparator(text, at, matched, qualifier);
  const before = clauseTail(text.slice(Math.max(0, at - 40), at));
  if (comparator === "min" && COUNT_STRICTLY_MORE_RE.test(before)) return { comparator, value: value + 1 };
  if (comparator === "max" && COUNT_STRICTLY_FEWER_RE.test(before)) return { comparator, value: Math.max(0, value - 1) };
  return { comparator, value };
}
const CONTAINER_WORD_RE = /\b(?:worlds|chapters|acts|episodes|zones)\b/i;
const LEVEL_WORD_AHEAD_RE = /\b\d{1,3}\s+(?:levels|stages|rounds|puzzles|waves)\b/i;
/** "2 worlds with 12 levels each", "4 chapters of 10 stages each". */
const LEVEL_MULTIPLY_RE =
  /\b(\d{1,3})\s+(?:worlds|chapters|acts|episodes|zones)\b[^.\n]{0,20}?\b(?:each\s+(?:with|holding|containing|of)|with|of|holding|containing)\s+(\d{1,3})\s+(?:levels|stages|rounds|puzzles|waves)(?:\s+(?:each|per\s+\w+|apiece))?\b/gi;
const SESSION_RE =
  /\b(?:each|every|per|a|one|single|average|typical)\s+(?:level|session|round|match|run|game|play\s+session|attempt)\b[^.\n]{0,50}?\b(\d+(?:\.\d+)?)(?:\s*(?:[-–~]|to)\s*(\d+(?:\.\d+)?))?\s*(ms|s|secs?|seconds?|min(?:ute)?s?)\b/gi;

/**
 * Every numeric claim in the GDD this module knows how to read, in document
 * order, de-duplicated by kind+value, capped at MAX_CLAIMS (the cap is
 * reported by the caller through the returned `truncated` flag).
 */
export function extractNumericClaims(gddText: string): {
  claims: NumericClaim[];
  truncated: number;
  /** The other level counts the document names, largest first — see below. */
  otherLevelCounts: number[];
} {
  const text = gddText ?? "";
  const found: Array<NumericClaim & { at: number }> = [];

  const seen = new Map<string, NumericClaim & { at: number }>();
  const push = (c: NumericClaim, at = 0) => {
    // …AND THE PLATFORM ITS CLAUSE NAMES. "Windows at least 60 fps. Android
    // at least 60 fps." deduplicated to one claim, so a 10 fps Android player
    // failed nothing (Codex 2026-09-12 AB J2.3). Equal numbers on different
    // platforms are different requirements.
    const key = `${c.kind}:${c.comparator}:${c.value}:${platformOfClaim(c.text)?.targets.join("/") ?? ""}`;
    const already = seen.get(key);
    if (already !== undefined) {
      // The same requirement written twice keeps its EARLIEST position: the
      // reversed boot regex matched the later sentence first, so the first
      // occurrence was dropped and the claim sorted last into the cap
      // (Codex 2026-09-11 C#25).
      // Position: the earliest wins (so the cap keeps it). Text: a MANDATORY
      // phrasing wins over a soft one, whichever came first — otherwise "a
      // typical round lasts 30-60 s" hid a later "unskippable timer of
      // 30-60 s" (Codex 2026-09-11 D#24).
      const takeText = isMandatoryFloor(c.text) && !isMandatoryFloor(already.text);
      if (at < already.at || takeText) {
        const i = found.indexOf(already);
        const merged = {
          ...c,
          at: Math.min(at, already.at),
          text: takeText ? c.text : already.text,
        };
        seen.set(key, merged);
        if (i >= 0) found[i] = merged;
      }
      return;
    }
    const entry = { ...c, at };
    seen.set(key, entry);
    found.push(entry);
  };
  for (const m of text.matchAll(FPS_RE)) {
    const value = Number(m[1]);
    if (value < 10 || value > 240) continue;
    // A frame-rate figure is a FLOOR unless the document says otherwise: "at
    // most 30 fps" (a cap, to save battery) was read as a demand for at least
    // thirty (Codex 2026-09-12 V).
    const capped = COUNT_AT_MOST_RE.test(clauseTail(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)));
    push(
      { kind: "fps", comparator: capped ? "max" : "min", value, text: fragment(text, m.index ?? 0, m[0].length) },
      m.index ?? 0,
    );
  }
  for (const re of [BOOT_RE, BOOT_REVERSED_RE]) {
    for (const m of text.matchAll(re)) {
      const value = toSeconds(Number(m[1]), m[2] ?? "s");
      if (value <= 0 || value > 600) continue;
      // A LEVEL LOAD IS NOT A COLD BOOT. "Cold boot ≤ 6 s; level load ≤ 1.5 s"
      // produced two boot claims, and the stricter one won: the boot gate then
      // demanded that the whole game start in the time one level may take to
      // open (Codex 2026-09-12 U#F3, U#F10). They are separate intervals, and
      // only the producer can separate them.
      const at = m.index ?? 0;
      // WITHIN THE CLAUSE. The lookbehind reached across the sentence before
      // it, so "Map loads fast; boot under 6 s" read the only boot budget in
      // the document as a level-load figure and stopped measuring it (Codex
      // 2026-09-12 V, a regression in my own U#F3 fix).
      const subject = clauseTail(text.slice(Math.max(0, at - 20), at)) + m[0];
      const kind: ClaimKind = LOADS_A_LEVEL_RE.test(subject) ? "level_load_seconds" : "boot_seconds";
      push({ kind, comparator: "max", value, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
    }
  }
  // "2 worlds with 12 levels each" is 24 levels, not two claims that contradict
  // each other against one session count (Codex 2026-09-11 B#19). The spans the
  // multiplication consumed are not read again below.
  const multiplied: Array<[number, number]> = [];
  for (const m of text.matchAll(LEVEL_MULTIPLY_RE)) {
    const outer = Number(m[1]);
    const inner = Number(m[2]);
    const total = outer * inner;
    // "each"/"per"/"apiece" anywhere in the phrase means PER container; "in
    // total" means the inner number IS the total (Codex 2026-09-11 D#22).
    const distributive = /\b(?:each|per\s+\w+|apiece)\b/i.test(m[0]) && !/\bin total\b/i.test(m[0]);
    if (distributive && outer >= 1 && inner >= 1 && total <= 999) {
      multiplied.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
      push({ kind: "level_count", comparator: "eq", value: total, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
    }
  }
  const insideMultiplication = (at: number): boolean => multiplied.some(([from, to]) => at >= from && at < to);
  for (const m of text.matchAll(LEVEL_COUNT_RE)) {
    if (insideMultiplication(m.index ?? 0)) continue;
    // "2 worlds with 12 levels in total" is 12 levels: the CONTAINER count is
    // not a level count when the sentence goes on to give one (Codex
    // 2026-09-11 C#23).
    if (CONTAINER_WORD_RE.test(m[0]) && LEVEL_WORD_AHEAD_RE.test(text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40))) continue;
    const before = clauseTail(text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0));
    if (PLAYS_NOT_SHIPS_RE.test(before)) continue;
    const bound = countBound(text, m.index ?? 0, m[0], m[2] ?? "", countValue(m[1] ?? ""));
    if (bound.value >= 1 && bound.value <= 100_000) {
      push(
        { kind: "level_count", comparator: bound.comparator, value: bound.value, text: fragment(text, m.index ?? 0, m[0].length) },
        m.index ?? 0,
      );
    }
  }
  for (const m of text.matchAll(SESSION_RE)) {
    const unit = m[3] ?? "s";
    const upper = toSeconds(Number(m[2] ?? m[1]), unit);
    // "Each round lasts AT LEAST 90 seconds" is a floor, and reading it as a
    // ceiling failed every round that honoured it (Codex 2026-09-12 V). The
    // clause's own words decide; a range still carries both bounds.
    const clause = clauseTail(text.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + m[0].length));
    const floorOnly = m[2] === undefined && /(?:\b(?:at\s+least|minimum(?:\s+of)?|no\s+shorter\s+than|no\s+less\s+than|more\s+than)\b|>=|≥)/i.test(clause);
    // "EXACTLY 30 seconds" is neither a floor nor a ceiling: read as a
    // maximum, two 20-second rounds satisfied it (Codex 2026-09-12 Z).
    const exactly = m[2] === undefined && /\b(?:exactly|precisely|always)\b/i.test(clause);
    if (exactly) {
      if (upper > 0 && upper <= 4 * 3600) {
        push({ kind: "session_seconds", comparator: "eq", value: upper, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
      }
      continue;
    }
    if (floorOnly) {
      if (upper > 0 && upper <= 4 * 3600) {
        push({ kind: "session_seconds", comparator: "min", value: upper, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
      }
      continue;
    }
    if (upper > 0 && upper <= 4 * 3600) push({ kind: "session_seconds", comparator: "max", value: upper, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
    // "a round lasts 30–60 seconds" has a FLOOR as well: only the ceiling was
    // read, so a one-second round met the claim (Codex 2026-09-11 B#19).
    if (m[2] !== undefined) {
      const lower = toSeconds(Number(m[1]), unit);
      if (lower > 0 && lower < upper) push({ kind: "session_seconds", comparator: "min", value: lower, text: fragment(text, m.index ?? 0, m[0].length) }, m.index ?? 0);
    }
  }
  // ONE LEVEL COUNT, THE LARGEST. Every level_count claim is measured against
  // the same session catalog, so a document that says "12 levels" in one
  // place and "the optional tutorial contains 3 puzzles" in another produced
  // two claims no catalog size could satisfy at once — a delivery that could
  // never pass (Codex 2026-09-11 F#2). The largest is the game's own count;
  // the smaller ones describe parts of it.
  const levelCounts = found.filter((c) => c.kind === "level_count");
  const otherLevelCounts: number[] = [];
  if (levelCounts.length > 1) {
    const biggest = levelCounts.reduce((max, c) => (c.value > max.value || (c.value === max.value && c.at < max.at) ? c : max));
    for (const claim of levelCounts) {
      if (claim !== biggest) {
        // NOT SILENTLY DROPPED. A document names its counts by release phase
        // — an MVP, a launch, a live target — and taking the largest is a
        // choice of release, not a reading of the document. The others are
        // carried so the delivery report can name them and a person can see
        // which one this delivery is being held to (Codex 2026-09-12 V).
        otherLevelCounts.push(claim.value);
        found.splice(found.indexOf(claim), 1);
      }
    }
  }
  otherLevelCounts.sort((a, b) => b - a);
  // DOCUMENT ORDER, then the cap: the claims were collected kind by kind, so
  // the cap dropped whole later categories rather than the tail of the
  // document (Codex 2026-09-11 B#19).
  found.sort((a, b) => a.at - b.at);
  const truncated = Math.max(0, found.length - MAX_CLAIMS);
  return { claims: found.slice(0, MAX_CLAIMS).map(({ at: _at, ...c }) => c), truncated, otherLevelCounts };
}

/**
 * The actions one session may take, when the document states them: "up to 60
 * taps per session", "30 moves per level".
 *
 * Not a claim — nothing measures a game against its input count — but a
 * BUDGET the play-through runner needs: its default stopped the session after
 * sixty actions whatever the document asked for, so a scenario that needs
 * more could not finish and the level reported no outcome (Codex 2026-09-12
 * U#3). Returns the largest stated figure, or undefined.
 */
const ACTION_BUDGET_RE =
  /\b(\d{1,4})\s+(?:taps|clicks|moves|actions|swipes|inputs|turns|drags|placements)\b[^.\n]{0,24}?\b(?:per|a|each|in\s+a|in\s+each)\s+(?:session|level|round|match|run|game|stage|puzzle)\b/gi;

export function extractActionBudget(gddText: string): number | undefined {
  let most = 0;
  for (const m of (gddText ?? "").matchAll(ACTION_BUDGET_RE)) {
    const value = Number(m[1]);
    if (Number.isFinite(value) && value > 0 && value <= 5000) most = Math.max(most, value);
  }
  return most > 0 ? most : undefined;
}

/**
 * The longest a single session may take, for the RUN'S ALLOWANCE — not for a
 * gate.
 *
 * The vehicle's document states its durations in a label/value table
 * ("Median level duration" / "60–150 s (Normal), 150–300 s (Hard)"), which no
 * prose pattern can see, so `playerRunSpec` derived no deadline and the
 * producer's 45-second default cut a legal 150-second round short as
 * unfinished (Codex 2026-09-12 AB, Job 3.6). A MEDIAN is not an every-level
 * ceiling, so this is deliberately not a claim: it only tells the run how long
 * it may keep playing.
 */
const DURATION_LABEL_RE =
  /^(?:median|average|typical|target|max(?:imum)?|expected)?\s*(?:level|session|round|match|run|puzzle|stage)\s*(?:duration|length|time)\b/i;
const DURATION_VALUE_RE =
  /(\d+(?:\.\d+)?)\s*(?:[-–~]|to)\s*(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|min(?:ute)?s?)\b|(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|min(?:ute)?s?)\b/gi;

/**
 * The longest ONE RUN may spend on ONE session, whatever the document says.
 *
 * Not a statement about how long a game's sessions may be: it bounds the
 * run's own budget so a figure about a day or a week cannot turn one
 * play-through into an afternoon (Codex 2026-09-13 AF#13).
 */
export const MAX_SESSION_ALLOWANCE_SECONDS = 3600;

export function extractSessionAllowanceSeconds(gddText: string): number | undefined {
  const text = gddText ?? "";
  let longest = 0;
  // What the prose already states, ceilings and floors alike.
  for (const c of extractNumericClaims(text).claims) {
    if (c.kind === "session_seconds") longest = Math.max(longest, c.value);
  }
  // …and what a label/value table states, on the line the label introduces or
  // the next one.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[\s•\t|-]+|[\s|]+$/g, ""));
  for (let i = 0; i < lines.length; i++) {
    if (!DURATION_LABEL_RE.test(lines[i] ?? "")) continue;
    // WITHIN THE CLAUSE THE LABEL INTRODUCES. "Session length | Levels of 1–4
    // minutes; ~10 sessions and ~60 minutes of play per DAU per day" gave an
    // hour-long session allowance, because the sentence goes on to talk about
    // a DAY (measured on the vehicle's document).
    // …AND EVERY CLAUSE THAT IS STILL ABOUT A SESSION. "60–150 s (Normal);
    // 150–300 s (Hard)" lost Hard mode to the first semicolon, so the run cut
    // a legal 300-second round short (Codex 2026-09-13 AF#13). A clause that
    // changes the subject — to a DAY, a WEEK, a SITTING — ends the read.
    const OTHER_SUBJECT_RE = /\b(?:per\s+(?:day|week|month|dau|user|player)|daily|weekly|sitting|session\s+count|retention)\b/i;
    const clauseOf = (line: string): string =>
      line
        .split(";")
        .reduce<string[]>((kept, clause) => (OTHER_SUBJECT_RE.test(clause) ? kept : [...kept, clause]), [])
        .join(";");
    // A LABEL AND ITS VALUE MAY BE SEPARATED BY BLANK LINES: a converter that
    // leaves two of them hid the value entirely (AF#13).
    const nearby: string[] = [];
    for (let j = i, seen = 0; j < lines.length && seen < 3; j++) {
      const line = lines[j] ?? "";
      if (j > i && line.trim() === "") continue;
      nearby.push(clauseOf(line));
      seen += 1;
    }
    for (const candidate of nearby) {
      DURATION_VALUE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = DURATION_VALUE_RE.exec(candidate)) !== null) {
        const unit = m[3] ?? m[5] ?? "s";
        const upper = toSeconds(Number(m[2] ?? m[1] ?? m[4]), unit);
        if (upper > 0 && upper <= 4 * 3600) {
          longest = Math.max(longest, upper);
          found = true;
        }
      }
      if (found) break;
    }
  }
  // A SESSION IS NOT A SITTING: a stray figure about a DAY must not let one
  // run keep playing for hours. The bound is about what ONE RUN may spend on
  // ONE session, not about how long a game may be — a ten-minute ceiling was
  // a judgement about the games this framework builds, and it cut a legal
  // 30-minute session short (Codex 2026-09-13 AF#13).
  const bounded = Math.min(longest, MAX_SESSION_ALLOWANCE_SECONDS);
  return bounded > 0 ? bounded : undefined;
}

/** Hold each claim against the play-through evidence. */
/**
 * The DISTINCT sessions a play-through actually finished.
 *
 * Three records of one index are one level played three times (Codex
 * 2026-09-11 C#22); an index the catalog does not hold, or a session that took
 * no whole action, is not a level played (D#21, E#7); and the indices are
 * ONE-based, the contract Strada.Core states — "the first session is 1" — so
 * counting 0…catalog-1 rejected the last valid session of every game (R#3).
 */
export function finishedSessionIndices(
  playthrough: {
    sessionCount?: number;
    sessions?: ReadonlyArray<{
      index?: number;
      outcome?: string;
      actions?: number;
      reachedOutcome?: boolean;
      identityVerified?: boolean;
      observedIndex?: number;
    }>;
  } | undefined,
): number[] {
  const catalog = playthrough?.sessionCount ?? 0;
  const seen = new Set<number>();
  for (const session of playthrough?.sessions ?? []) {
    // AN OUTCOME IT REACHED, stated. Excluding only "None" and "Refused" let a
    // record with no outcome at all — an empty string, a missing field — count
    // as a level played to the end (Codex 2026-09-12 S#11).
    if (session.reachedOutcome === false) continue;
    // A SESSION WHOSE CONTENT NOBODY COULD IDENTIFY certifies no level. The
    // run adopts a session the game started by itself, and the record used to
    // carry the index the run had asked for: an auto-started level 1 counted
    // as level 7 played (Codex 2026-09-12 X). Records that do not report
    // identity at all are read exactly as before.
    if (session.identityVerified !== true) continue;
    // …AND CONSISTENT WITH ITSELF. A record can claim verification while
    // naming a different session as the one that was running; that is a
    // contradiction, not a level played (Codex 2026-09-12 Z#5). A malformed
    // flag ("false", null) is not a verification either — the check above
    // requires the boolean true.
    if (
      typeof session.observedIndex === "number"
      && session.observedIndex > 0
      && session.observedIndex !== session.index
    ) {
      continue;
    }
    const outcome = (session.outcome ?? "").trim();
    if (outcome === "" || outcome === "None" || outcome === "Refused") continue;
    if (!Number.isInteger(session.index) || session.index! < 1 || session.index! > Math.max(catalog, 1)) continue;
    if (!Number.isInteger(session.actions) || session.actions! <= 0) continue;
    seen.add(session.index!);
  }
  return [...seen].sort((a, b) => a - b);
}

export function assessNumericClaims(
  claims: readonly NumericClaim[],
  playthrough: PlaythroughEvidence | undefined,
  /** The play-through inside the built player, when the campaign ran one — answers the frame rate. */
  player?: PlaythroughEvidence,
  /** The GDD's platform and the target the player was actually built for. */
  opts?: { platform?: GddPlatform; builtTarget?: string },
): ClaimAssessment[] {
  const perf = playthrough?.found ? playthrough.perf : undefined;
  const playerPerf = player?.found ? player.perf : undefined;
  const nameOfMedium = (m?: string): string => (m === "editor-playmode-batch" ? "editor play mode, batch" : m ?? "");
  const medium = nameOfMedium(perf?.medium);
  // THE SHIPPED ARTIFACT ANSWERS FIRST. Only the frame rate consumed the
  // built player's evidence, so a player whose boot took 12 s and whose only
  // level ran 120 s was judged MET against a 6 s boot and a 60 s round —
  // measured in the editor, where neither number is the product's (Codex
  // 2026-09-12 Z). When the player ran and carries the measurement, it is the
  // one that counts; otherwise the editor's stands, named as before.
  const bootFrom = playerPerf?.bootSeconds !== undefined ? playerPerf : perf;
  const bootMedium = nameOfMedium(playerPerf?.bootSeconds !== undefined ? playerPerf.medium : perf?.medium);
  const timedRun =
    player?.found === true && (player.perf !== undefined || (player.sessions?.length ?? 0) > 0)
      ? player
      : playthrough;
  const timedMedium = nameOfMedium(timedRun === player ? playerPerf?.medium ?? "player" : perf?.medium);
  const countedRun = player?.found === true && player.sessionCount !== undefined ? player : playthrough;
  const noRun = "no play-through of this build was observed (unity_playthrough leaves the timing)";
  // A CLAUSE THAT NAMES ITS OWN PLATFORM is about that platform, whatever it
  // measures. Only the frame rate asked, so an Android player's 4-second boot
  // failed "boot under 2 s on Windows" outright — while the next sentence of
  // the same document allowed Android 6 s (Codex 2026-09-12 AC J4.2). A
  // measurement taken where the claim is not about answers "unmeasured for
  // this target", never "not met".
  const wrongPlatform = (text: string, fromPlayer: boolean): GddPlatform | undefined => {
    if (!opts) return undefined;
    const named = platformOfClaim(text);
    const scope = named ?? opts.platform;
    if (!scope) return undefined;
    // THE EDITOR IS NOT A PLATFORM. A clause that names one is not answered
    // by a measurement taken in the editor: an editor boot of 1.2 s passed
    // BOTH "under 2 s on Windows" and "under 6 s on Android" while no player
    // had been booted at all (Codex 2026-09-13 AF#7).
    if (!fromPlayer) return named ?? undefined;
    return frameRateAnswersPlatform(scope, opts.builtTarget) ? undefined : scope;
  };
  const builtFor = (): string => `a player built for ${opts?.builtTarget ?? "the project's own target"}`;
  const answerItThere = (scope: GddPlatform): string =>
    `this requirement is for ${scope.targets.length > 0 ? scope.targets.join("/") : "a handheld"}` +
    `${scope.evidence ? ` ("${scope.evidence.slice(0, 80)}")` : ""} — build for that target and play it there to answer this`;
  return claims.map((claim): ClaimAssessment => {
    switch (claim.kind) {
      case "fps": {
        // The built player answers the claim (2026-09-10): real rendering,
        // vsync, the frame rate a person sees. Measured, and blocking.
        if (playerPerf?.avgFps !== undefined && playerPerf.medium === "player") {
          // A frame rate measured on the wrong device answers nothing: a
          // desktop build used to satisfy "60 fps on mid-range phones"
          // (Codex 2026-09-11 B#11).
          // A CLAUSE THAT NAMES ITS OWN PLATFORM is about that platform: "at
          // least 60 fps on Android" was answered by a Windows player,
          // because the document-wide platform set was what the check saw
          // (Codex 2026-09-12 AA#4). The claim's own sentence wins when it
          // names one; otherwise the document's platforms stand.
          // …when the caller told us what it built. With no platform context
          // at all the provenance is unknown, and this reads exactly as
          // before.
          const scope = opts ? platformOfClaim(claim.text) ?? opts.platform : undefined;
          if (scope && !frameRateAnswersPlatform(scope, opts?.builtTarget)) {
            return {
              claim,
              status: "unmeasured",
              measured: Number(playerPerf.avgFps.toFixed(1)),
              note:
                `${playerPerf.avgFps.toFixed(1)} fps in a player built for ${opts?.builtTarget ?? "the project's own target"}, ` +
                `but this requirement is for ${scope.targets.length > 0 ? scope.targets.join("/") : "a handheld"}` +
                `${scope.evidence ? ` ("${scope.evidence.slice(0, 80)}")` : ""} — ` +
                "build for that target and play it there to answer this",
              blocking: false,
            };
          }
          // The comparator the document stated: a cap ("at most 30 fps", to
          // save battery) is met by staying under it (Codex 2026-09-12 V).
          const met = claim.comparator === "max" ? playerPerf.avgFps <= claim.value : playerPerf.avgFps >= claim.value;
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
        if (!bootFrom || bootFrom.bootSeconds === undefined) {
          return {
            claim,
            status: "unmeasured",
            note: bootFrom ? "the bootstrapper never published its services, so boot time has no end" : noRun,
            blocking: false,
          };
        }
        const elsewhere = wrongPlatform(claim.text, playerPerf?.bootSeconds !== undefined);
        if (elsewhere) {
          return {
            claim,
            status: "unmeasured",
            measured: Number(bootFrom.bootSeconds.toFixed(2)),
            note: `${bootFrom.bootSeconds.toFixed(1)} s to boot ${builtFor()}, but ${answerItThere(elsewhere)}`,
            blocking: false,
          };
        }
        const met = bootFrom.bootSeconds <= claim.value;
        return {
          claim,
          status: met ? "met" : "not_met",
          measured: Number(bootFrom.bootSeconds.toFixed(2)),
          note: `scene load → services in ${bootFrom.bootSeconds.toFixed(1)} s (${bootMedium})`,
          blocking: true,
        };
      }
      case "session_seconds": {
        // THE SHIPPED ARTIFACT'S SESSIONS when it ran them (Codex 2026-09-12
        // Z): an editor batch's play time is not the product's.
        const timed = timedRun;
        const timedPerf = timed === player ? playerPerf : perf;
        if (!timed?.found) return { claim, status: "unmeasured", note: noRun, blocking: false };
        if (!timedPerf || timed.ok !== true || !timed.outcome || timed.outcome === "None") {
          return { claim, status: "unmeasured", note: "the session never reached an outcome, so its length is unknown", blocking: false };
        }
        const elsewhere = wrongPlatform(claim.text, timed === player);
        if (elsewhere) {
          return {
            claim,
            status: "unmeasured",
            measured: Number(timedPerf.playSeconds.toFixed(1)),
            note: `driven play measured in ${builtFor()}, but ${answerItThere(elsewhere)}`,
            blocking: false,
          };
        }
        // PER SESSION, when the run played more than one. `perf.playSeconds`
        // is the whole run's play time, so three 40-second levels measured 120
        // seconds against "each level lasts 30–60 s" and failed a game that
        // met the requirement exactly (Codex 2026-09-12 T#7). An aggregate
        // number answers only a single-session run.
        // A ZERO-SECOND SESSION IS A MEASUREMENT, and a failing one against
        // any floor. Dropping every non-positive number meant two sessions of
        // [0 s, 30 s] were judged as the one that passed, and the report
        // described a single session (Codex 2026-09-12 AC J4.3). A session
        // NOBODY TIMED stays unknown and is disclosed, never judged.
        const counted = (timed.sessions ?? []).filter((x) => x.outcome !== "None" && x.outcome !== "Refused");
        const perSession = counted
          .map((x) => x.seconds)
          .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);
        const untimed = counted.length - perSession.length;
        // AN EXACT DURATION is met within a stated tolerance: a driven run's
        // clock is not a stopwatch, and "exactly 30 seconds" read as a
        // maximum was satisfied by twenty (Codex 2026-09-12 Z).
        const holds = (seconds: number): boolean =>
          claim.comparator === "min"
            ? seconds >= claim.value
            : claim.comparator === "eq"
            ? Math.abs(seconds - claim.value) <= Math.max(1, claim.value * EXACT_DURATION_TOLERANCE)
            : seconds <= claim.value;
        // A SESSION'S OWN CLOCK, whenever there is one. Requiring MORE THAN
        // ONE meant a single 90-second round was judged by the run's sampled
        // play time of 20 s and passed a 60-second ceiling (Codex 2026-09-12
        // AB J4.3). The aggregate answers only a run that recorded no session
        // durations at all.
        const met = perSession.length > 0 ? perSession.every(holds) : holds(timedPerf.playSeconds);
        const measured = perSession.length > 0
          ? Number(Math.max(...perSession).toFixed(1))
          : Number(timedPerf.playSeconds.toFixed(1));
        const partly = untimed > 0 ? ` — ${untimed} further session(s) carry no clock, so this covers only what was timed` : "";
        // A REQUIREMENT ABOUT EVERY SESSION IS NOT MET BY THE TIMED ONES. A
        // run of [30 s, no clock] was reported MET against "each round must
        // last at least 30 seconds" with the gap merely noted (Codex
        // 2026-09-13 AF#7): what is unknown is unmeasured, not met.
        if (untimed > 0 && met) {
          return {
            claim,
            status: "unmeasured",
            measured,
            note:
              `${perSession.length} session(s) held the requirement${partly} — the untimed ones cannot be judged, so ` +
              "the game is not measured against this requirement yet",
            blocking: false,
          };
        }
        return {
          claim,
          status: met ? "met" : "not_met",
          measured,
          note: perSession.length > 0
            ? `${perSession.length} session(s) reached an outcome, each ${Math.min(...perSession).toFixed(1)}–${Math.max(...perSession).toFixed(1)} s of driven play (${timedMedium})${partly}`
            : `session ${timed.session ?? "?"} reached ${timed.outcome} after ${timedPerf.playSeconds.toFixed(1)} s of driven play (${timedMedium})${partly}`,
          // A driven play-through is faster than a person's, so a range's floor
          // is disclosed — UNLESS the document makes it mandatory (an
          // unskippable timer is wall-clock, not skill; Codex 2026-09-11 C#24).
          blocking: claim.comparator !== "min" || isMandatoryFloor(claim.text),
        };
      }
      case "level_load_seconds": {
        // NOBODY RECORDS IT YET. Core's play-through stops its clock when the
        // bootstrap services exist, and records no level-ready checkpoint, so
        // the document's level-load figure has no measurement to hold it
        // against (Codex 2026-09-12 U#F10). Named, never waived by silence —
        // and not blocking, because no run on any machine could answer it.
        return {
          claim,
          status: "unmeasured",
          note:
            "no producer records when a level becomes interactive — Strada.Core must emit a level-ready checkpoint " +
            "(level-request → level-interactive) for unity_playthrough to report it",
          blocking: false,
        };
      }
      case "level_count": {
        // THE CATALOGUE THE SHIPPED ARTIFACT REPORTS when it ran (Z): the
        // editor's catalogue is the project's, not the product's.
        const counted = countedRun;
        if (!counted?.found) return { claim, status: "unmeasured", note: noRun, blocking: false };
        if (counted.sessionCount === undefined) {
          return {
            claim,
            status: "unmeasured",
            note: "the game registers no Strada.Core.Play.ISessionCatalog, so its sessions cannot be counted",
            blocking: false,
          };
        }
        // THE COMPARATOR THE DOCUMENT STATED. Every count was read as exact,
        // so "ship at least 20 levels" was met by 20 and failed on 21 — a
        // game that shipped MORE than it promised was not delivered (Codex
        // 2026-09-12 U#F3).
        const catalogMatches =
          claim.comparator === "min"
            ? counted.sessionCount >= claim.value
            : claim.comparator === "max"
            ? counted.sessionCount <= claim.value
            : counted.sessionCount === claim.value;
        const played = counted.sessions?.length ?? 0;
        // DISTINCT sessions: three records of index 0 are one level played
        // three times (Codex 2026-09-11 C#22).
        // A session index must be a real catalog entry and the session must
        // have DONE something: {index:-1, actions:0} counted as a played
        // level (Codex 2026-09-11 D#21).
        const finished = finishedSessionIndices(counted).length;
        // A catalog of N is a claim; N sessions played to an outcome is the
        // measurement (Codex 2026-09-11 B#10). The play-through plays at most
        // PLAYED_SESSIONS_PER_RUN per run: past that the shortfall is named,
        // not hidden — and not held against the delivery, since no single run
        // can answer it.
        // Blocking unless the SHORTFALL is only what one run could not reach:
        // a 13-level game with one session played used to be waived entirely
        // because 13 > 12 (Codex 2026-09-11 C#21).
        // The waiver is for what ONE RUN cannot reach, so it applies only when
        // the run actually played its full share: a 13-level game with one
        // session played was waived entirely (Codex 2026-09-11 C#21).

        // A SHORTFALL IS NOT A PASS. `met` used to be true once the run had
        // played its own share, so a 24-level game reported status "met" with
        // twelve levels never played (Codex 2026-09-12 S#11). The status is
        // the truth; only the BLOCKING stays lifted for what one run cannot
        // reach, because no single run can answer it.
        // How many levels must be played to an outcome: the catalogue's own
        // size when the document set a floor and the game shipped more, and
        // the document's number otherwise.
        // THE CATALOGUE THE GAME SHIPS, not the number the document permits:
        // "at most 12 levels" with eight shipped and all eight played
        // demanded twelve played levels and refused the delivery (Codex
        // 2026-09-12 V).
        const mustPlay = catalogMatches ? counted.sessionCount : claim.value;
        const beyondOneRun = mustPlay > PLAYED_SESSIONS_PER_RUN && finished >= PLAYED_SESSIONS_PER_RUN;
        const everyLevelPlayed = catalogMatches && finished >= mustPlay;
        return {
          claim,
          status: everyLevelPlayed ? "met" : "not_met",
          measured: counted.sessionCount,
          note:
            `the game's session catalog reports ${counted.sessionCount}; ${finished} of ${played} played session(s) reached an outcome` +
            (beyondOneRun ? ` (one run plays at most ${PLAYED_SESSIONS_PER_RUN}; ${claim.value - Math.min(finished, claim.value)} of ${claim.value} levels are NOT yet played to an outcome)` : ""),
          blocking: !catalogMatches || !beyondOneRun,
        };
      }
    }
  });
}

/**
 * How far a measured duration may sit from an EXACT one and still be met.
 * A driven play-through's clock is not a stopwatch: frames, capture stalls
 * and the driver's own pace move it by a few per cent (Codex 2026-09-12 Z).
 */
export const EXACT_DURATION_TOLERANCE = 0.1;

/** unity_playthrough's per-run session cap (MAX_SESSIONS_PER_RUN in Strada.MCP). */
export const PLAYED_SESSIONS_PER_RUN = 12;

/** Wording that makes a minimum duration a rule of the game, not a pace. */
const MANDATORY_FLOOR_RE = /\b(?:unskippable|mandatory|must last|at least|no shorter than|minimum(?:\s+(?:of|duration|length))?|timer)\b/i;
/** …unless the sentence denies it: "with no mandatory timer" (Codex 2026-09-11 D#23). */
const MANDATORY_NEGATED_RE = /\b(?:no|not|never|without|skippable)\b[^.\n]{0,24}\b(?:unskippable|mandatory|minimum|timer|must last)\b/i;

export function isMandatoryFloor(text: string): boolean {
  if (MANDATORY_NEGATED_RE.test(text)) return false;
  return MANDATORY_FLOOR_RE.test(text);
}

const KIND_LABEL: Record<ClaimKind, string> = {
  fps: "frame rate",
  boot_seconds: "boot time",
  level_load_seconds: "level load time",
  session_seconds: "session length",
  level_count: "level count",
};

function unit(kind: ClaimKind): string {
  return kind === "fps" ? " fps" : kind === "level_count" ? "" : " s";
}

/** One line per claim for the delivery report; the header says how many there were. */
export function describeClaims(
  assessments: readonly ClaimAssessment[],
  truncated = 0,
  otherLevelCounts: readonly number[] = [],
): string[] {
  if (assessments.length === 0) return ["GDD numbers: none found (no frame-rate, load-time, level-count or session-length figure in the text)"];
  const lines = assessments.map((a) => {
    const target = `${a.claim.comparator === "min" ? "≥" : a.claim.comparator === "max" ? "≤" : "="} ${a.claim.value}${unit(a.claim.kind)}`;
    const head = `GDD ${KIND_LABEL[a.claim.kind]} ${target}`;
    if (a.status === "unmeasured") return `${head}: NOT MEASURED — ${a.note} (GDD: "${a.claim.text}")`;
    return `${head}: ${a.status === "met" ? "MET" : "NOT MET"} — ${a.note}`;
  });
  if (otherLevelCounts.length > 0) {
    // WHICH RELEASE THIS IS. The largest count wins so that one catalog can
    // satisfy every mention, but a document that names 200 for an MVP and
    // 3,000 for a live target is naming release PHASES — and choosing one of
    // those silently is choosing what to ship (Codex 2026-09-12 V).
    const chosen = assessments.find((a) => a.claim.kind === "level_count")?.claim.value;
    lines.push(
      `GDD level count: measured against ${chosen ?? "the largest"}; the document also names ` +
      `${otherLevelCounts.slice(0, 6).join(", ")} — say which release this delivery is if it is not the largest`,
    );
  }
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

/**
 * Does this document require a session to END?
 *
 * A producer cannot know a game's win condition and refused every endless or
 * sandbox session as "never ended" — a verdict no correct implementation could
 * satisfy (Codex 2026-09-13 AG#3). A document that states a win or lose
 * condition is asking for a terminal outcome; one that describes an endless
 * game, a sandbox or a creative mode is not.
 */
const WIN_LOSE_RE =
  /\b(?:win(?:s|ning)?\s+condition|lose\s+condition|loss\s+condition|fail(?:ure)?\s+(?:condition|state)|game\s+over|victory|defeat|you\s+win|you\s+lose|complete\s+the\s+level|clear\s+the\s+(?:level|stage|board)|reach\s+the\s+(?:goal|exit)|kazanma\s+koşulu|kaybetme\s+koşulu|oyun\s+bitti)\b/i;
const ENDLESS_RE =
  /\b(?:endless|infinite|never\s+ends|sandbox|free\s*play|creative\s+mode|no\s+(?:win|lose|fail)\s+(?:state|condition)|sonsuz|serbest\s+mod)\b/i;

export function documentRequiresAnOutcome(gddText: string | undefined): boolean {
  const text = gddText ?? "";
  if (text.trim() === "") return false;
  // An explicit endless statement wins: a document may describe a win
  // condition for one mode and an endless one for another, and the run must
  // not fail the endless mode for lacking an ending it never claimed.
  if (ENDLESS_RE.test(text)) return false;
  return WIN_LOSE_RE.test(text);
}
