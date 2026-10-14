/**
 * How the universality guard (src/universality.test.ts) reads a file: the
 * projections it compares, the rolling-hash prefilter, and its two local
 * checks — passages of a confidential document, and the checkout's own
 * product terms. Kept apart from the guard so they can be tested on invented
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

const WORD_CHAR = /[\p{L}\p{N}]/u;
const isSmall = (c: number): boolean => c >= 97 && c <= 122;
const isCapital = (c: number): boolean => c >= 65 && c <= 90;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0;
/** What "words" reads other punctuation as: no space in a term stands for it, so code between two words does not join them into a name. */
const BREAK = 10;

/**
 * The text as the char codes a matcher reads, each with the offset it came
 * from: "alnum" keeps lowercase letters and digits only; "prose" lowercases,
 * reads WRAP_SYNTAX as whitespace, and collapses each whitespace run to one
 * space, the way the owner's shingle scan reads a document; "words" also
 * reads each underscore, dash and camel hump (fooBar, foo2Bar, HTTPServer) as
 * a space, and a run holding any other punctuation as one BREAK.
 */
export function project(text: string, mode: "alnum" | "prose" | "words"): { codes: Uint16Array; origin: Int32Array } {
  // Blanked to as many spaces, so every offset still points into `text`.
  const read = mode === "alnum" ? text : text.replace(WRAP_SYNTAX, (syntax) => " ".repeat(syntax.length));
  // A camel hump adds a space, at most one before each character.
  const room = mode === "words" ? 2 * text.length : text.length;
  const codes = new Uint16Array(room);
  const origin = new Int32Array(room);
  let n = 0;
  for (let i = 0; i < read.length; i++) {
    let c = read.charCodeAt(i);
    const capital = isCapital(c);
    if (capital) c += 32;
    let gap: number | undefined;
    if (mode === "alnum") {
      if (!(isSmall(c) || isDigit(c))) continue;
    } else if (mode === "prose") {
      if (isSpace(c)) gap = 32;
    } else if (!(isSmall(c) || isDigit(c) || (c > 127 && WORD_CHAR.test(read.charAt(i))))) {
      gap = isSpace(c) || c === 95 || c === 45 ? 32 : BREAK;
    } else if (capital && n > 0 && codes[n - 1] !== 32 && codes[n - 1] !== BREAK) {
      const before = read.charCodeAt(i - 1);
      if (isSmall(before) || isDigit(before) || (isCapital(before) && isSmall(read.charCodeAt(i + 1)))) {
        codes[n] = 32;
        origin[n] = i;
        n++;
      }
    }
    if (gap !== undefined) {
      // A run counts from where it ends: blanked markers stretch it back over
      // earlier lines, and a window opening on it starts at the next word.
      if (n > 0 && (codes[n - 1] === 32 || codes[n - 1] === BREAK)) {
        if (gap === BREAK) codes[n - 1] = BREAK;
        origin[n - 1] = i;
        continue;
      }
      c = gap;
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

/**
 * A product-terms.txt list (one case-insensitive regular expression per line,
 * `#` starting a comment), matched so that how a name's parts are separated
 * does not decide whether it is found. Each line of a file is read as written and with
 * the underscores and dashes inside a word dropped (`\bfoobar\b` finds
 * foo_bar, foo-bar and FOO_BAR; case already finds FooBar). The whole file is
 * also read as words (see project), where a space in a term — or an
 * underscore or dash in one made of letters, digits and those alone — may be
 * there or not: `foo bar` finds FooBar, fooBar, foo_bar, FOO_BAR, foobar, and
 * a "foo" wrapped onto a ` * bar` line or joined to "bar" with a `+`, but not
 * a "foo" and a bar that only code punctuation stands between. Read line by
 * line as written, `foo bar` found none of those, and `\bfoobar\b` missed
 * foo_bar and foo-bar.
 */
export interface ProductTerms {
  readonly line: RegExp;
  readonly words: RegExp;
}

const PLAIN_TERM = /^(?:\\b)?[\p{L}\p{N} _-]+(?:\\b)?$/u;
const INNER_JOINT = /(?<=[\p{L}\p{N}])[_-]+(?=[\p{L}\p{N}])/gu;

export function compileTerms(list: string): ProductTerms | undefined {
  const terms = list
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (terms.length === 0) return undefined;
  // Outside a plain term `_` and `-` may be regex syntax (`[a-z]`), and a
  // space already followed by a quantifier says how many it means.
  const apart = terms.map((t) => t.replace(PLAIN_TERM.test(t) ? /[ _-]+/g : / +(?![?*+{])/g, " ?"));
  return {
    line: new RegExp(terms.map((t) => `(?:${t})`).join("|"), "i"),
    words: new RegExp(apart.map((t) => `(?:${t})`).join("|"), "gi"),
  };
}

/** The lines of `text` that name a term. */
export function termLines(text: string, terms: ProductTerms): number[] {
  const lines = new Set<number>();
  text.split("\n").forEach((line, i) => {
    if (terms.line.test(line) || terms.line.test(line.replace(INNER_JOINT, ""))) lines.add(i + 1);
  });
  const { codes, origin } = project(text, "words");
  let words = "";
  for (let i = 0; i < codes.length; i += 8192) words += String.fromCharCode(...codes.subarray(i, i + 8192));
  for (const match of words.matchAll(terms.words)) lines.add(lineAt(text, origin[match.index]!));
  return [...lines].sort((a, b) => a - b);
}
