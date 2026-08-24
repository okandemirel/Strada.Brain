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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ScheduledElement {
  /** Unlock level tag from the schedule table, e.g. "L36". */
  readonly unlock: string;
  /** Element name as the spec spells it, e.g. "Ice Block". */
  readonly name: string;
}

/** Strip formatting from a spec element name for code search. */
export function elementCodeTokens(name: string): string[] {
  const words = name.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const pascal = words.map((w) => (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase()).join("");
  const tokens = new Set<string>([pascal, words.join("").toLowerCase()]);
  // Common compound splits the code might choose instead ("LockAndKey" vs "LockKey").
  if (words.length > 1) {
    tokens.add(words.map((w) => (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase()).slice(0, 2).join(""));
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
export function extractScheduledElements(docText: string): ScheduledElement[] {
  const found = new Map<string, ScheduledElement>();
  const lines = docText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\|\s*(L\d{1,4})\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]!);
    if (!m) continue;
    const name = m[2]!.trim();
    if (!name || /^(element|unlock|name)$/i.test(name)) continue;
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, { unlock: m[1]!, name });
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
      for (const entry of require("node:fs").readdirSync(root)) {
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
    return require("node:fs").readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

function statSafe(path: string): { size: number; isDirectory(): boolean } | null {
  try {
    const st = require("node:fs").statSync(path);
    return { size: st.size, isDirectory: () => st.isDirectory() };
  } catch {
    return null;
  }
}

export interface SpecCoverageReport {
  readonly scheduled: number;
  readonly missing: ScheduledElement[];
  readonly gddPath: string | null;
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
  if (elements.length === 0) return { scheduled: 0, missing: [], gddPath: doc };

  const assetsRoot = join(projectPath, "Assets");
  const files = (listFiles?.(assetsRoot) ?? walkCs(assetsRoot)).filter((f) => f.endsWith(".cs"));
  const corpus = files
    .map((f) => {
      try {
        return (readFile?.(f) ?? readFileSync(f, "utf8")).toLowerCase();
      } catch {
        return "";
      }
    })
    .join("\n");

  const missing = elements.filter((el) => {
    return !elementCodeTokens(el.name).some(
      (tok) => tok.length >= 5 && corpus.includes(tok.toLowerCase()),
    );
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
