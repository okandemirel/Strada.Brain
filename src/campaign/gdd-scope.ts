/**
 * The GDD's measured scope: what the ladder has to cover, and how big it
 * should be.
 *
 * Until 2026-09-10 every game got the same ladder bounds — "2 to 12
 * milestones" — whatever the document asked for: a long campaign with a deep
 * unlock schedule and a one-mechanic prototype were planned into the same range, and
 * nothing recorded which sections of the document a sprint claimed to cover,
 * so "was this section ever planned?" could only be answered by a later LLM
 * audit over titles. This module counts what is countable — headings,
 * scheduled elements, a level count, screens, and whether the document asks
 * for audio, saving, onboarding, settings, performance targets — and turns
 * that into (a) the inventory a plan is held against and (b) ladder bounds.
 * Deterministic, no model, nothing game-specific.
 */
import { extractScheduledElements } from "../agents/autonomy/spec-scope.js";
import { extractNumericClaims } from "./gdd-claims.js";

export interface GddAsks {
  readonly audio: boolean;
  readonly save: boolean;
  readonly onboarding: boolean;
  readonly settings: boolean;
  readonly performance: boolean;
  readonly build: boolean;
  readonly ui: boolean;
}

export interface GddScope {
  /** Section headings a plan must account for, in document order (trivial ones removed). */
  readonly headings: string[];
  readonly elements: number;
  readonly levels?: number;
  readonly screens: number;
  readonly asks: GddAsks;
  readonly minMilestones: number;
  readonly maxMilestones: number;
}

/**
 * Headings that are document apparatus, never work.
 *
 * The list named contents pages and glossaries but not the sections every
 * design document OPENS with — so the ladder's first milestone was
 * "INTRODUCTION" and a worker was asked to build one (measured live
 * 2026-09-12). Anchored at both ends: "Introduction Cinematic" and "Scope of
 * the Map Editor" are work, and only a heading that is ENTIRELY apparatus is
 * dropped.
 */
export const TRIVIAL_HEADING_RE =
  /^(?:about this document|acknowledg(?:e)?ments|appendix(?:\s+[a-z0-9])?|approvals?|bibliography|change ?log|competitive analysis|(?:comparable|competitor|reference) titles|confidentiality|contents|conventions|credits|disclaimer|document (?:control|conventions|history)|executive summary|glossary|index|introduction|legal|market (?:analysis|position(?:ing)?)(?: (?:and )?(?:comparable|competitor|reference) titles)?|overview of this document|prepared by|purpose(?: of this document)?|references|(?:revision|version) history|scope|sign off|summary|table of contents|terminology)$/i;

/**
 * A section ASKING for something, as opposed to describing it: an imperative
 * or an obligation. A bare verb list kept "This document describes the design
 * of the orchard" as work, because "design" is a noun far more often than a
 * verb in a design document.
 */
export const WORK_DEMAND_RE =
  /(?:^|[.:;!?]\s+|\bmust\s+|\bshall\s+|\bshould\s+|\bwill\s+)(?:build|implement|create|add|wire|bind|author|code|write|render|animate|spawn|show|display|present|play|unlock|award|grant|trigger|ship|support)\b/i;

/** Does the body under this heading ask for work, whatever the heading is called? */
export function sectionAsksForWork(lines: readonly string[], headingIndex: number): boolean {
  for (let i = headingIndex + 1; i < lines.length && i <= headingIndex + 12; i++) {
    const line = lines[i] ?? "";
    if (HEADING_RE.test(line) || NUMBERED_HEADING_RE.test(line)) break; // the next section
    if (WORK_DEMAND_RE.test(line)) return true;
  }
  return false;
}

const HEADING_RE = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;
/**
 * "3. Core Loop", "3.2 Scoring", "III. Art" as plain-text section lines
 * (converted documents). ANY capital opens one: with A-Z only, "3.2 Çiçeklenme
 * Takvimi" or "5. Écrans" was body text, and everything under it was read as
 * part of the section before.
 */
const NUMBERED_HEADING_RE = /^\s{0,3}(?:\d{1,2}(?:\.\d{1,2}){0,2}\.?|[IVX]{1,4}\.)\s+(\p{Lu}[^\n]{2,70})$/u;
const SECTION_NUMBER_RE = /^\s*(\d{1,3}(?:\.\d{1,3})*)\.?(?=\s)/;

export interface HeadingLine {
  /** The heading as the document spells it, its number removed. */
  readonly title: string;
  /** "3.2" for "3.2 Scoring" or "## 3.2 Scoring"; absent for an unnumbered heading. */
  readonly number?: string;
  /** Nesting depth: the number's components for a plain numbered line, the hashes for markdown. */
  readonly level: number;
  /** Where the title starts in the line. */
  readonly titleAt: number;
}

/** The heading on one line, read by the same rules `extractHeadings` uses; undefined for body text. */
export function parseHeadingLine(line: string): HeadingLine | undefined {
  const markdown = HEADING_RE.exec(line);
  if (markdown !== null) {
    const raw = markdown[2]!;
    const numbered = SECTION_NUMBER_RE.exec(raw);
    const title = numbered === null ? raw : raw.slice(numbered[0].length).trim();
    return {
      title,
      ...(numbered === null ? {} : { number: numbered[1]! }),
      level: markdown[1]!.length,
      titleAt: line.indexOf(raw) + raw.indexOf(title),
    };
  }
  const plain = NUMBERED_HEADING_RE.exec(line);
  if (plain === null) return undefined;
  const title = plain[1]!.trim();
  const number = SECTION_NUMBER_RE.exec(line)?.[1];
  return {
    title,
    ...(number === undefined ? {} : { number }),
    level: number === undefined ? 1 : number.split(".").length,
    titleAt: line.lastIndexOf(title),
  };
}

export function normalizeHeading(h: string): string {
  return h
    // THE NUMBERING FIRST, as a TOKEN. Lowercasing before stripping left
    // "I. Introduction" with its numeral, so it slipped past every apparatus
    // rule (Codex 2026-09-12 P#13) — and a character class that merely listed
    // the numerals ate the leading "I" of "INTRODUCTION" itself.
    .replace(/^\s*(?:\d{1,3}(?:\.\d{1,3})*\.?|[ivxlc]{1,6}\.(?=\s))[\s).-]*/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractHeadings(gddText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = gddText.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const m = HEADING_RE.exec(raw) ?? NUMBERED_HEADING_RE.exec(raw);
    if (!m) continue;
    const title = (m.length > 2 ? m[2] : m[1])!.trim();
    if (title.length < 3 || title.length > 90) continue;
    // AN APPARATUS NAME OVER A SECTION THAT ASKS FOR WORK IS WORK. The
    // denylist dropped "## Credits\nBuild an interactive credits screen." and
    // the requirement vanished from the ladder entirely (Codex 2026-09-12
    // P#13). What the section SAYS decides.
    if (TRIVIAL_HEADING_RE.test(normalizeHeading(title)) && !sectionAsksForWork(lines, index)) continue;
    const key = normalizeHeading(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= 80) break;
  }
  return out;
}

const SCREEN_RE = /\b(?:main menu|title screen|home screen|level select|pause menu|settings screen|shop screen|results? screen|win screen|lose screen|game over screen|hud|inventory screen|map screen|leaderboard)\b/gi;

export function measureGddScope(gddText: string): GddScope {
  const text = gddText ?? "";
  const headings = extractHeadings(text);
  const elements = extractScheduledElements(text).length;
  const levelClaim = extractNumericClaims(text).claims.find((c) => c.kind === "level_count");
  const levels = levelClaim?.value;
  const screens = new Set([...text.matchAll(SCREEN_RE)].map((m) => m[0].toLowerCase())).size;
  const asks: GddAsks = {
    audio: /\b(?:music|soundtrack|sfx|sound effects?|audio)\b/i.test(text),
    save: /\b(?:sav(?:e|ed|es|ing)\b[^.\n]{0,30}\b(?:game|progress|state|cloud|slot)|cloud\s+save|autosave|persist(?:ence|ent)|player ?prefs)\b/i.test(text),
    onboarding: /\b(?:tutorial|onboarding|ftue|first[- ]time user)\b/i.test(text),
    settings: /\b(?:settings|options menu|accessibility)\b/i.test(text),
    performance: /\b\d{2,3}\s*fps\b|\b(?:load(?:s|ing)?|boot|start-?up)\b[^.\n]{0,40}\b(?:under|within|less than|<)\s*\d/i.test(text),
    build: /\b(?:android|ios|apk|ipa|aab|steam|standalone|webgl|itch\.io|app store|play store|platform)\b/i.test(text),
    ui: screens > 0 || /\b(?:ui flow|screen flow|menu flow|user interface)\b/i.test(text),
  };
  // Ladder size from what is counted: foundations + integration are always
  // two; every four scheduled elements, every twenty-five levels, and each
  // non-code area the document asks for is a sprint of its own.
  let estimate = 2;
  estimate += Math.ceil(elements / 4);
  if (levels !== undefined) estimate += Math.ceil(levels / 25);
  if (asks.ui || screens >= 2) estimate += 1;
  if (asks.audio) estimate += 1;
  if (asks.save || asks.onboarding || asks.settings) estimate += 1;
  if (elements === 0 && levels === undefined) estimate += 1; // a design with no schedule still has mechanics
  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
  const minMilestones = clamp(estimate - 1, 3, 20);
  const maxMilestones = clamp(estimate + 3, minMilestones + 1, 24);
  return { headings, elements, ...(levels !== undefined ? { levels } : {}), screens, asks, minMilestones, maxMilestones };
}

/**
 * Headings no milestone claims. A claim covers a heading when, normalized,
 * one contains the other (a plan says "Core Loop" for "3. Core Loop —
 * merging"). Short claims (< 4 chars) never match anything.
 */
export function uncoveredSections(headings: readonly string[], covered: readonly string[]): string[] {
  return headings.filter((h) => normalizeHeading(h).length >= 4 && !headingClaimedBy(h, covered));
}

/**
 * Does any claim cover this heading? The coverage inventory and requirement
 * row ownership ask the same question, so they share one answer.
 */
export function headingClaimedBy(heading: string, claims: readonly string[]): boolean {
  const key = normalizeHeading(heading);
  if (key.length < 4) return false;
  return claims
    .map(normalizeHeading)
    .some((c) => c.length >= 4 && (c === key || c.includes(key) || key.includes(c)));
}

/**
 * The screen the document says the game OPENS ON, when it names one.
 *
 * The system told every final sprint to "wire the GDD's entry flow so a person
 * who opens the entry scene is playing, not staring at an idle screen", and
 * the delivery report called an idle first screen a defect. That is one game
 * shape imposed on all of them: a document may specify a home, menu or lobby
 * as its first screen, and real documents do — they say which screen the game
 * opens on (Codex 2026-09-12 V, Job 3.9). What must be proven then is not auto-start
 * but the ROUTE from that screen into play.
 */
const BOOTS_TO_SCREEN_RE =
  /\b(?:cold\s+)?(?:boots?|booting|launch(?:es|ing)?|starts?|opens?|resumes?)\b[^.\n;]{0,30}?\b(?:to|into|at|on)\s+(?:the\s+)?(home|main\s+menu|menu|title(?:\s+screen)?|start\s+screen|lobby|hub|dashboard|map)\b/i;
const ENTRY_SCREEN_RE =
  /\b(home|main\s+menu|title\s+screen|start\s+screen|lobby|hub)\b[^.\n]{0,24}?\b(?:is\s+the\s+(?:entry|first|landing)|screen\s+is\s+(?:the\s+)?(?:entry|first))/i;

export function entryScreenInDocument(gddText: string | undefined): string | undefined {
  const text = gddText ?? "";
  const named = BOOTS_TO_SCREEN_RE.exec(text)?.[1] ?? ENTRY_SCREEN_RE.exec(text)?.[1];
  if (named === undefined) return undefined;
  return named.replace(/\s+/g, " ").trim();
}
