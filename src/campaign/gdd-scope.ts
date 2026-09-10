/**
 * The GDD's measured scope: what the ladder has to cover, and how big it
 * should be.
 *
 * Until 2026-09-10 every game got the same ladder bounds — "2 to 12
 * milestones" — whatever the document asked for: a 100-level, 16-element
 * design and a one-mechanic prototype were planned into the same range, and
 * nothing recorded which sections of the document a sprint claimed to cover,
 * so "was section 7 ever planned?" could only be answered by a later LLM
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

/** Headings that are document apparatus, never work. */
const TRIVIAL_HEADING_RE =
  /^(?:table of contents|contents|appendix(?:\s+[a-z0-9])?|glossary|references|bibliography|changelog|change log|revision history|version history|document history|index|acknowledg(?:e)?ments|about this document|overview of this document)\b/i;

const HEADING_RE = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;
/** "3. Core Loop", "3.2 Scoring", "III. Art" as plain-text section lines (converted documents). */
const NUMBERED_HEADING_RE = /^\s{0,3}(?:\d{1,2}(?:\.\d{1,2}){0,2}\.?|[IVX]{1,4}\.)\s+([A-Z][^\n]{2,70})$/;

export function normalizeHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/^[\d.\s)IVX-]+/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractHeadings(gddText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of gddText.split(/\r?\n/)) {
    const m = HEADING_RE.exec(raw) ?? NUMBERED_HEADING_RE.exec(raw);
    if (!m) continue;
    const title = (m.length > 2 ? m[2] : m[1])!.trim();
    if (title.length < 3 || title.length > 90) continue;
    if (TRIVIAL_HEADING_RE.test(normalizeHeading(title))) continue;
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
  const claims = covered.map(normalizeHeading).filter((c) => c.length >= 4);
  return headings.filter((h) => {
    const key = normalizeHeading(h);
    if (key.length < 4) return false;
    return !claims.some((c) => c === key || c.includes(key) || key.includes(c));
  });
}
