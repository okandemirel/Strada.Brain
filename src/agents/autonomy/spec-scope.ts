/**
 * Spec scope coverage — the system checks the DESIGN DOC against the CODE.
 *
 * Measured 2026-08-24 (PixelFlow): the GDD's section 4 schedules sixteen game
 * elements in a literal markdown table; runs kept delivering a subset and
 * calling it done, because every gate looked at CODE health and none compared
 * code against the SPEC. The decomposition could not carry this either — a
 * one-shot planner sees a summary, not all nineteen sections.
 *
 * This module makes the spec itself the checklist: scheduled elements are
 * parsed from the document's element-schedule table, then each is searched
 * for in the delivered source. What the spec promises and the code lacks is
 * named, verbatim, at delivery time.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ScheduledElement {
  /** Unlock level tag from the schedule table, e.g. "L36". */
  readonly unlock: string;
  /** Element name as the spec spells it, e.g. "Ice Block". */
  readonly name: string;
}

/** Strip formatting from a spec element name for code search. */
export function elementCodeTokens(name: string): string[] {
  const tokens = new Set<string>();
  // A PARENTHETICAL IS AN ANNOTATION, not part of the name. "Caged (Locked)
  // Pig" produced only CagedLockedPig/cagedlockedpig, so a project whose code
  // says `CagedPig` was reported as missing the element it had implemented —
  // the real two-element false refusal on the vehicle (Codex 2026-09-12 Y).
  // The annotated spelling stays a candidate: some code keeps it.
  const spellings = new Set<string>([name]);
  const withoutNotes = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (withoutNotes !== "" && withoutNotes !== name) spellings.add(withoutNotes);
  for (const spelling of spellings) {
    const words = spelling.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const pascalOf = (ws: readonly string[]): string =>
      ws.map((w) => (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase()).join("");
    tokens.add(pascalOf(words));
    tokens.add(words.join("").toLowerCase());
    // Common compound splits the code might choose instead ("LockAndKey" vs "LockKey").
    if (words.length > 1) tokens.add(pascalOf(words.slice(0, 2)));
  }
  return [...tokens];
}

/**
 * Parse an element-introduction schedule out of a design document.
 *
 * Recognizes markdown pipe tables whose rows start with an unlock tag
 * (e.g. `L21`) followed by an element name — the shape GDDs in this genre
 * use for their element schedule (PixelFlow §4.1).
 */
/** C# source with // and /* *\/ comments removed (strings are left as they are). */
/**
 * C# source with comments removed, strings kept. A regex that ignored string
 * literals cut `string sep="//";` and everything after it, and one that
 * skipped slashes after a colon kept `retry:// TODO Element` (Codex
 * 2026-09-11 C#30). This walks the source instead.
 */
export function stripCsComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '"' || c === "'") {
      const quote = c;
      const verbatim = quote === '"' && source[i - 1] === "@";
      out += c;
      i += 1;
      while (i < n) {
        const d = source[i]!;
        if (!verbatim && d === "\\") { out += d + (source[i + 1] ?? ""); i += 2; continue; }
        if (verbatim && d === '"' && source[i + 1] === '"') { out += '""'; i += 2; continue; }
        out += d;
        i += 1;
        if (d === quote) break;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Second-cell text that names a person or a role rather than a game element. */
const NOT_AN_ELEMENT_RE = /\((?:producer|designer|artist|engineer|programmer|lead|qa|pm|owner|manager)\b|\b(?:producer|designer|artist|engineer|programmer|lead|qa|manager)\s*$/i;

/** An unlock id in a schedule's first cell: "L21", "21", "E3", "Level 21". */
const UNLOCK_CELL_RE = /^(?:[A-Za-z][A-Za-z ]{0,9}\s*)?\d{1,4}(?:[.-]\d{1,4})?$/;
/** A header cell naming WHEN an element arrives, and one naming the element. */
const UNLOCK_HEADER_RE = /^(?:unlock(?:s|ed)?(?:\s+at)?|level|levels|introduced(?:\s+at)?|when|from|stage|arrives?)$/i;
const ELEMENT_HEADER_RE = /^(?:element|elements|name|mechanic|blocker|feature|item|obstacle|piece|content)$/i;

/**
 * A schedule table that lost its pipes.
 *
 * Documents converted out of Google Docs, Notion or PDF arrive as one cell per
 * LINE: a header block ("Unlock", "Element", "One-line pitch", "Side") and
 * then rows of that many lines. The pipe-table reader found nothing in the
 * real vehicle document, so its whole element schedule — every blocker and
 * special mechanic the game is made of — read as ZERO scheduled elements, and
 * zero suppresses the coverage check entirely (Codex 2026-09-12 W#12).
 */
export function extractFlattenedSchedule(docText: string): ScheduledElement[] {
  const found = new Map<string, ScheduledElement>();
  const raw = docText.split(/\r?\n/).map((l) => l.replace(/^[\s•\t|-]+|[\s|]+$/g, ""));
  // TAB-SEPARATED ROWS are the other converter shape: a whole row on one
  // line. Split those into cells first, so one reader serves both (Codex
  // 2026-09-12 Y#4).
  const lines: string[] = [];
  for (const line of raw) {
    const cells = line.split("\t").map((c) => c.trim());
    if (cells.length >= 2 && cells.filter((c) => c !== "").length >= 2) lines.push(...cells);
    else lines.push(line);
  }
  for (let at = 0; at < lines.length; at++) {
    if (!UNLOCK_HEADER_RE.test(lines[at] ?? "")) continue;
    // BLANK-SEPARATED CELLS: some converters leave an empty line between
    // every cell. Blanks are dropped only where that is the shape — deleting
    // them everywhere would merge genuinely empty cells (Y#4).
    const spaced = (lines[at + 1] ?? "") === "" && (lines[at + 2] ?? "") !== "";
    // Fold the blank separators FIRST when that is the shape, then work in
    // folded coordinates: the backward walk below stepped straight into a
    // blank, so a reversed column order and blank-separated cells worked
    // separately and failed together (Codex 2026-09-12 AB J2.5).
    const cells = spaced ? lines.filter((_cell, i) => i % 2 === 0) : lines;
    const here = spaced ? Math.floor(at / 2) : at;
    // THE HEADER BLOCK, which may begin BEFORE the unlock column: a document
    // whose table starts with Element then Unlock read nothing at all (Y#4).
    const short = (cell: string): boolean => cell !== "" && cell.length <= 30 && !/[.;:!?]$/.test(cell);
    let first = here;
    while (first > 0 && short(cells[first - 1] ?? "") && !UNLOCK_CELL_RE.test(cells[first - 1] ?? "")) {
      if (here - first >= 7) break;
      first -= 1;
    }
    const window = cells.slice(first);
    // THE WIDTH IS WHAT MAKES THE ROWS LINE UP. Reading the header until the
    // first unlock ID assumed the ID is a row's FIRST cell, which is only one
    // of the shapes: every width from two to eight is tried, and the narrowest
    // that actually parses a row wins (Codex 2026-09-12 Y#4).
    for (let width = 2; width <= 8; width++) {
      const header = window.slice(0, width);
      if (header.length < width || !header.every(short)) break;
      const nameAt = header.findIndex((h) => ELEMENT_HEADER_RE.test(h));
      const unlockAt = header.findIndex((h) => UNLOCK_HEADER_RE.test(h));
      if (nameAt < 0 || unlockAt < 0) continue;
      const rows: ScheduledElement[] = [];
      for (let row = width; row + width <= window.length; row += width) {
        let block = window.slice(row, row + width);
        // A BLANK LINE BETWEEN ROWS is a separator, not the end of the table:
        // it ended the parse and every later row vanished from coverage while
        // the rows already read certified the schedule as complete (Codex
        // 2026-09-12 AB J2.6). One separator is stepped over.
        if (block[0] === "" && row + width + 1 <= window.length) {
          row += 1;
          block = window.slice(row, row + width);
        }
        if (!UNLOCK_CELL_RE.test(block[unlockAt] ?? "")) break;
        const name = (block[nameAt] ?? "").trim();
        if (name === "" || name.length > 60 || NOT_AN_ELEMENT_RE.test(name)) continue;
        rows.push({ unlock: block[unlockAt]!, name });
      }
      if (rows.length === 0) continue;
      for (const el of rows) {
        const key = el.name.toLowerCase();
        if (!found.has(key)) found.set(key, el);
      }
      break;
    }
  }
  return [...found.values()];
}

/**
 * Does the document LOOK like it holds a schedule table, whether or not this
 * reader could parse its rows?
 *
 * Zero parsed elements suppressed the whole coverage check, so an unreadable
 * schedule was indistinguishable from a document that schedules nothing
 * (Codex 2026-09-12 Y#4). The caller can then say "present but unreadable"
 * instead of "no requirements".
 */
export function scheduleLooksPresent(docText: string): boolean {
  const lines = docText.split(/\r?\n/).map((l) => l.replace(/^[\s•\t|-]+|[\s|]+$/g, ""));
  for (let i = 0; i < lines.length; i++) {
    if (!UNLOCK_HEADER_RE.test(lines[i] ?? "")) continue;
    const near = lines.slice(Math.max(0, i - 7), i + 8);
    if (near.some((l) => ELEMENT_HEADER_RE.test(l))) return true;
  }
  // A header ROW on one line, whatever separates its cells (pipes, tabs).
  for (const line of docText.split(/\r?\n/)) {
    const cells = line.split(/[|\t]/).map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2) continue;
    if (cells.some((c) => UNLOCK_HEADER_RE.test(c)) && cells.some((c) => ELEMENT_HEADER_RE.test(c))) return true;
  }
  return false;
}

export function extractScheduledElements(docText: string): ScheduledElement[] {
  const found = new Map<string, ScheduledElement>();
  const lines = docText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Any unlock id in the first cell: L21, 21, E3, W1-3, "Level 21",
    // "Chapter 1" — one GDD's "L<number>" was the only shape recognized
    // (Codex 2026-09-11 B#18, C#29).
    const m = /^\s*\|\s*((?:[A-Za-z][A-Za-z ]{0,9}\s*)?\d{1,4}(?:[.-]\d{1,4})?)\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]!);
    if (!m) continue;
    const name = m[2]!.trim();
    if (!name || /^(element|unlock|name)$/i.test(name)) continue;
    // A table of PEOPLE is not a table of game elements: a row whose second
    // cell reads like a person with a role was read as a scheduled element
    // (Codex 2026-09-11 C#29).
    if (NOT_AN_ELEMENT_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, { unlock: m[1]!, name });
  }
  // …and the same table with its pipes stripped by a document converter.
  for (const el of extractFlattenedSchedule(docText)) {
    const key = el.name.toLowerCase();
    if (!found.has(key)) found.set(key, el);
  }
  return [...found.values()];
}

/** Find the likeliest design-doc file inside the project (largest docs markdown). */
export function findDesignDoc(projectPath: string): string | null {
  const roots = [join(projectPath, "docs"), join(projectPath, "Docsets"), projectPath];
  let best: { path: string; size: number } | null = null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root)) {
        void entry;
      }
    } catch {
      /* unreadable root — skip */
    }
    break;
  }
  // Walk docs/ for markdown files; pick the largest (the GDD dwarfs notes).
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry);
      try {
        const st = statSafe(p);
        if (st === null) continue;
        if (st.isDirectory()) walk(p);
        else if (/\.md$/i.test(entry)) {
          const size = st.size;
          if (!best || size > best.size) best = { path: p, size };
        }
      } catch { /* skip */ }
    }
  };
  walk(join(projectPath, "docs"));
  if (best === null) {
    // Fall back to a single top-level GDD-style markdown beside the project root.
    for (const entry of safeReaddir(projectPath)) {
      if (/gdd|design.*doc/i.test(entry) && /\.md$/i.test(entry)) {
        return join(projectPath, entry);
      }
    }
    return null;
  }
  return best!.path;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

function statSafe(path: string): { size: number; isDirectory(): boolean } | null {
  try {
    const st = statSync(path);
    return { size: st.size, isDirectory: () => st.isDirectory() };
  } catch {
    return null;
  }
}

export interface SpecCoverageReport {
  readonly scheduled: number;
  readonly missing: ScheduledElement[];
  readonly gddPath: string | null;
  /**
   * Set when the document plainly HOLDS a schedule table and this reader
   * could not parse a single row of it. Zero elements used to suppress the
   * whole coverage check, so an unreadable schedule was indistinguishable
   * from a document that schedules nothing (Codex 2026-09-12 Y#4).
   */
  readonly scheduleUnreadable?: boolean;
}

/**
 * Which spec-scheduled elements have NO implementation signal in Assets code?
 * An element counts as present when any of its code-token shapes appears in
 * any .cs file (class/enum/identifier/comment) — the bar is deliberately low:
 * this names what the SPEC still owes, and the deeper quality gates judge the
 * rest.
 */
export function assessSpecScope(
  projectPath: string,
  gddPath?: string,
  listFiles?: (assetsRoot: string) => string[],
  readFile?: (path: string) => string,
): SpecCoverageReport {
  const doc = gddPath ?? findDesignDoc(projectPath);
  if (!doc || !existsSync(doc)) return { scheduled: 0, missing: [], gddPath: null };
  let text: string;
  try {
    text = readFile?.(doc) ?? readFileSync(doc, "utf8");
  } catch {
    return { scheduled: 0, missing: [], gddPath: doc };
  }
  const elements = extractScheduledElements(text);
  if (elements.length === 0) {
    return {
      scheduled: 0,
      missing: [],
      gddPath: doc,
      ...(scheduleLooksPresent(text) ? { scheduleUnreadable: true } : {}),
    };
  }

  const assetsRoot = join(projectPath, "Assets");
  const files = (listFiles?.(assetsRoot) ?? walkCs(assetsRoot)).filter((f) => f.endsWith(".cs"));
  const corpus = files
    .map((f) => {
      try {
        // Comments are not an implementation: a TODO naming every element
        // satisfied this gate (Codex 2026-09-11 B#18).
        return stripCsComments(readFile?.(f) ?? readFileSync(f, "utf8")).toLowerCase();
      } catch {
        return "";
      }
    })
    .join("\n");

  // A long token anywhere in the code is a signal; a short one ("Cube",
  // "Pig", "Tray") only as a whole identifier word — as a substring it would
  // match "cubemap" or "pigment", but ignoring it outright reported every
  // short-named element as missing (measured 2026-09-10: "Cube" with a
  // `public class Cube` in the tree).
  // A TOKEN TWO ELEMENTS SHARE PROVES NEITHER. "Gate (one-way)" and "Gate
  // (two-way)" both strip to "Gate", so one `class Gate` covered both
  // scheduled variants (Codex 2026-09-12 Z#8). A shared candidate is dropped
  // from both; each variant is then judged by the spelling that is its own.
  const tokensFor = new Map(elements.map((el) => [el.name, elementCodeTokens(el.name)]));
  const timesUsed = new Map<string, number>();
  for (const tokens of tokensFor.values()) {
    for (const tok of new Set(tokens.map((t) => t.toLowerCase()))) {
      timesUsed.set(tok, (timesUsed.get(tok) ?? 0) + 1);
    }
  }
  const missing = elements.filter((el) => {
    const own = (tokensFor.get(el.name) ?? []).filter((tok) => (timesUsed.get(tok.toLowerCase()) ?? 0) === 1);
    return !own.some((tok) => {
      const needle = tok.toLowerCase();
      if (needle.length >= 5) return corpus.includes(needle);
      if (needle.length < 3) return false;
      return new RegExp(`(?<![a-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`).test(corpus);
    });
  });
  return { scheduled: elements.length, missing, gddPath: doc };
}

function walkCs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry);
      const st = statSafe(p);
      if (st === null) continue;
      if (st.isDirectory()) stack.push(p);
      else if (/\.cs$/i.test(entry)) out.push(p);
    }
  }
  return out;
}
