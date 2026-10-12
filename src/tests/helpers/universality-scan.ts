/**
 * How the universality guard (src/universality.test.ts) reads a file: the
 * projections it compares, the rolling-hash prefilter, and its two local
 * checks — passages of a confidential document, and the checkout's own
 * vehicle terms. Kept apart from the guard so they can be tested on invented
 * text: the guard's real inputs may never be written down.
 */

const ROLL_BASE = 131;
/** A quoted passage is this long, as the owner's shingle scan measures it. */
export const SHINGLE = 36;

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * What carries one sentence across lines or literals without being part of
 * it: the comment marker opening a continued line (`*`, `//`, `#`, `--`, a
 * `>` quote), the joint between two string literals (`" +` and `"` on the
 * next line, `", "` in a list joined into one text), a backslash line
 * continuation, a newline escape. A passage wrapped in any of them had a
 * marker inside every window that spanned the wrap, and passed the guard.
 */
const WRAP_SYNTAX = /^[ \t]*(?:(?:\/\/+|\/\*+|\*+\/?|#+|-{2,}|>+)[ \t]*)+|["'`]\s*[+,]?\s*["'`]|\\(?:\r?\n|[nrt])/gm;

/**
 * The text as the char codes a matcher reads, each with the offset it came
 * from: "alnum" keeps lowercase letters and digits only; "prose" lowercases,
 * reads WRAP_SYNTAX as whitespace, and collapses each whitespace run to one
 * space, the way the owner's shingle scan reads a document.
 */
export function project(text: string, mode: "alnum" | "prose"): { codes: Uint16Array; origin: Int32Array } {
  // Blanked to as many spaces, so every offset still points into `text`.
  const read = mode === "prose" ? text.replace(WRAP_SYNTAX, (syntax) => " ".repeat(syntax.length)) : text;
  const codes = new Uint16Array(text.length);
  const origin = new Int32Array(text.length);
  let n = 0;
  for (let i = 0; i < read.length; i++) {
    let c = read.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if (mode === "alnum") {
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) continue;
    } else if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0) {
      // A run counts from where it ends: blanked markers stretch it back over
      // earlier lines, and a window opening on it starts at the next word.
      if (n > 0 && codes[n - 1] === 32) {
        origin[n - 1] = i;
        continue;
      }
      c = 32;
    }
    codes[n] = c;
    origin[n] = i;
    n++;
  }
  return { codes: codes.subarray(0, n), origin: origin.subarray(0, n) };
}

/**
 * Rolling hashes to look for, behind a 2^24-bit filter: tens of millions of
 * windows are checked per run, and a Set lookup for each one was most of a
 * run's eight seconds.
 */
export class RollSet {
  private readonly bits = new Uint32Array(1 << 19);
  private readonly set = new Set<number>();
  add(h: number): void {
    this.set.add(h);
    const b = h >>> 8;
    this.bits[b >>> 5] = (this.bits[b >>> 5] ?? 0) | (1 << (b & 31));
  }
  has(h: number): boolean {
    const b = h >>> 8;
    return ((this.bits[b >>> 5] ?? 0) & (1 << (b & 31))) !== 0 && this.set.has(h);
  }
}

/** Start offsets (into `codes`) of every window of `length` whose rolling hash is in `hashes`. */
export function rollingHits(codes: Uint16Array, length: number, hashes: RollSet): number[] {
  let top = 1;
  for (let i = 1; i < length; i++) top = Math.imul(top, ROLL_BASE) >>> 0;
  const hits: number[] = [];
  let h = 0;
  for (let i = 0; i < codes.length; i++) {
    if (i >= length) h = (h - Math.imul(codes[i - length]!, top)) >>> 0;
    h = (Math.imul(h, ROLL_BASE) + codes[i]!) >>> 0;
    if (i >= length - 1 && hashes.has(h)) hits.push(i - length + 1);
  }
  return hits;
}

const rollOf = (codes: Uint16Array): number => codes.reduce((h, c) => (Math.imul(h, ROLL_BASE) + c) >>> 0, 0);

/** Every SHINGLE-long window of the documents' prose, and its rolling hash. */
export interface QuoteIndex {
  readonly windows: ReadonlySet<string>;
  readonly rolls: RollSet;
}

export function quoteIndex(documents: readonly string[]): QuoteIndex {
  const windows = new Set<string>();
  const rolls = new RollSet();
  for (const document of documents) {
    const { codes } = project(document, "prose");
    for (let i = 0; i + SHINGLE <= codes.length; i++) {
      const slice = codes.subarray(i, i + SHINGLE);
      const window = String.fromCharCode(...slice);
      // A lone path or identifier is shared vocabulary, not a quoted passage.
      if (window.trim().split(" ").length < 3) continue;
      windows.add(window);
      rolls.add(rollOf(slice));
    }
  }
  return { windows, rolls };
}

/** The lines of `text` where a passage of an indexed document starts. */
export function quotedLines(text: string, index: QuoteIndex): number[] {
  const { codes, origin } = project(text, "prose");
  const lines = new Set<number>();
  for (const start of rollingHits(codes, SHINGLE, index.rolls)) {
    if (index.windows.has(String.fromCharCode(...codes.subarray(start, start + SHINGLE)))) {
      lines.add(lineAt(text, origin[start]!));
    }
  }
  return [...lines];
}

/** A vehicle-terms.txt list: one case-insensitive regular expression per line, `#` starting a comment. */
export function compileTerms(list: string): RegExp | undefined {
  const lines = list
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  return lines.length > 0 ? new RegExp(lines.map((l) => `(?:${l})`).join("|"), "i") : undefined;
}

/** The lines of `text` that name a term. */
export function termLines(text: string, terms: RegExp): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (terms.test(line)) lines.push(i + 1);
  });
  return lines;
}
