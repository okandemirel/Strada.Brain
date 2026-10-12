/**
 * The system's acceptance files (GDD-drift plan W05): the C# a Unity project
 * carries so a milestone's own GDD rows are judged by checks the system owns.
 *
 * In the measured campaign six of six milestones went green on prose. The checks
 * that replace it are only worth anything if nothing a worker writes can make
 * them pass, so everything that decides a check's verdict is the system's:
 *
 * - the wrapping (namespace, fixture, names, attributes, timeout, Boot()) —
 *   `renderAcceptanceFile`; the writer returns statements, never a method;
 * - every GDD number's assertion, from bounds code parsed out of the GDD —
 *   the writer supplies only the observation;
 * - which bodies may run at all — `lintAcceptanceBody` refuses a body that
 *   cannot fail (Assert.Pass, catch, #if, an assertion on reflection or on
 *   literals: the shape of the measured campaign's P1 guardrail) before a single run;
 * - the harness the bodies call, which knows no game — `ACCEPTANCE_FIXTURE_SOURCE`;
 * - what every name in a check means: the system's code and the writer's
 *   spell each type from the root (global::) and import none, so neither a
 *   type a worker declares nor a game namespace named like a framework type
 *   (Grid, Input, Is) can answer one — `unrootedNames`;
 * - the bytes on disk: restored from the stored copy before every commit and
 *   every measurement, foreign files deleted, differences reported as tamper,
 *   and what outside the folder could answer for a check reported with them.
 *
 * No LLM call and no clock live here. The writer (W06), the run (W08) and the
 * settle path (W09) build on these.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { generateFolderMetaContent, generateMetaContent } from "../agents/tools/unity/meta-file-utils.js";
import { requirementTokens } from "./campaign-planner.js";
import {
  ACCEPTANCE_DIR,
  ACCEPTANCE_TEST_CATEGORY,
  ACCEPTANCE_TEST_NAMESPACE,
  type AcceptanceCheckBody,
  type AcceptanceRefusal,
  type AcceptanceSource,
  type AcceptanceTestRef,
  type RequirementBounds,
  type RequirementRow,
} from "./scope-types.js";

// =============================================================================
// NAMES
// =============================================================================

/** The acceptance test assembly. */
export const ACCEPTANCE_ASSEMBLY_NAME = "Strada.Acceptance";
export const ACCEPTANCE_ASMDEF_PATH = `${ACCEPTANCE_DIR}/${ACCEPTANCE_ASSEMBLY_NAME}.asmdef`;
export const ACCEPTANCE_FIXTURE_PATH = `${ACCEPTANCE_DIR}/AcceptanceFixture.cs`;
/** Per test; Boot() alone may spend 30 s on a slow editor. */
export const ACCEPTANCE_TEST_TIMEOUT_MS = 120_000;
/** A body longer than this is not one requirement's check. */
export const MAX_ACCEPTANCE_BODY_LINES = 80;

/**
 * The harness's own failures carry `[strada-acceptance:<code>]`, so a judge
 * can tell "the harness could not run this check" from "the game failed it":
 * no-scene/no-boot/no-driver/no-input-route are about the project's wiring,
 * no-service about what the check bound to. Bodies may not write the tag.
 */
export const HARNESS_FAULT_CODES = ["no-scene", "no-boot", "no-driver", "no-service", "no-input-route"] as const;
export type HarnessFaultCode = (typeof HARNESS_FAULT_CODES)[number];
const HARNESS_FAULT_TAG = "strada-acceptance";

/** The harness fault a failure message carries, if any. */
export function harnessFaultOf(message: string): HarnessFaultCode | undefined {
  const match = /\[strada-acceptance:([a-z-]+)\]/.exec(message);
  const code = match?.[1];
  return (HARNESS_FAULT_CODES as readonly string[]).includes(code ?? "") ? (code as HarnessFaultCode) : undefined;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A milestone id as a C# identifier. Ids are system-made ("m3", "m3-tb1"); a
 * lowercase one only gains a capital, and any other spelling gets a hash of
 * the original, so "m3-tb1" and "m3_tb1" (or "m3" and "M3") can never share a
 * namespace.
 */
export function acceptanceIdent(milestoneId: string): string {
  const parts = milestoneId.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  let ident = parts.join("_");
  if (ident === "") ident = "M";
  ident = /^[0-9]/.test(ident) ? `M_${ident}` : ident[0]!.toUpperCase() + ident.slice(1);
  return /^[a-z][a-z0-9]*$/.test(milestoneId) ? ident : `${ident}_${sha256(milestoneId).slice(0, 6)}`;
}

/** Where a milestone's acceptance file lives (project-relative). */
export function acceptanceFilePath(milestoneId: string): string {
  return `${ACCEPTANCE_DIR}/Acceptance_${acceptanceIdent(milestoneId)}.cs`;
}

/**
 * The test method for a row: `R<ordinal>_<fingerprint>` from its id, so the
 * name survives rows being added or reordered around it. `wide` takes the
 * whole fingerprint, for the rare file where six hex digits collide.
 */
function testMethodName(rid: string, wide: boolean): string {
  const match = /^req-(\d+)-([0-9a-f]+)$/i.exec(rid);
  const ordinal = (match?.[1] ?? "0").padStart(3, "0");
  const fingerprint = (match?.[2] ?? sha256(rid)).toLowerCase();
  return `R${ordinal}_${fingerprint.slice(0, wide ? 32 : 6)}`;
}

// =============================================================================
// C# TEXT
// =============================================================================

/**
 * The first line of every C# file the system writes carries a hash of the
 * rest. A file in the folder that differs from the stored bytes but still
 * matches its own stamp is the system's — an older harness after an upgrade,
 * a check before its regeneration — and is put right without being called
 * tamper; tamper is red, and a harness upgrade must not bounce a sprint.
 */
const STAMP_RE = /^\/\/ strada-acceptance ([0-9a-f]{16})\n/;

function stampCSharp(body: string): string {
  return `// strada-acceptance ${sha256(body).slice(0, 16)}\n${body}`;
}

function carriesOwnStamp(text: string): boolean {
  const stamp = STAMP_RE.exec(text);
  return stamp !== null && sha256(text.slice(stamp[0].length)).slice(0, 16) === stamp[1];
}

/** Every character C# ends a line on. A GDD sentence carrying one must not end a comment early. */
const CS_LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
const CS_LINE_BREAKS = new RegExp(CS_LINE_BREAK.source, "g");

function csString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f || cp === 0x85 || cp === 0x2028 || cp === 0x2029 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** Text for a `//` comment line: control and bidi-override characters cannot hide or reorder code. */
function commentSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trimEnd();
}

function csDouble(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`a GDD bound must be a finite number, got ${value}`);
  return `${Object.is(value, -0) ? 0 : value}d`;
}

/** A part of a body, dedented and indented to sit inside a test method. */
function indentPart(part: string, indent: string): string[] {
  const lines = part.split(CS_LINE_BREAK).map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const margin = Math.min(...lines.filter((l) => l !== "").map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => (l === "" ? "" : indent + l.slice(Number.isFinite(margin) ? margin : 0)));
}

interface CSharpScan {
  /** The source with comments and the text of string and char literals blanked (same length, same lines). */
  readonly code: string;
  readonly error?: string;
}

/**
 * Blank comments and literal text so a check reads only code: a forbidden
 * word inside a string or a comment is not a forbidden construct, and a brace
 * inside one does not count. Interpolation holes stay code; `holeBraces:
 * false` also blanks the braces around them, for a reader that counts blocks.
 */
function scanCSharp(src: string, opts: { readonly holeBraces?: boolean } = {}): CSharpScan {
  const holeBraces = opts.holeBraces ?? true;
  const out = src.split("");
  let error: string | undefined;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const fail = (what: string): void => {
    error ??= what;
  };

  function charLiteral(i: number): number {
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "'") return i + 1;
      if (c === "\n" || c === "\r") {
        fail("an unterminated character literal");
        return i;
      }
      blank(i, i + 1);
      i++;
    }
    fail("an unterminated character literal");
    return i;
  }

  function stringLiteral(i: number, verbatim: boolean, interpolated: boolean): number {
    while (i < src.length) {
      const c = src[i];
      if (!verbatim && c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') {
        if (verbatim && src[i + 1] === '"') {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        return i + 1;
      }
      if (!verbatim && (c === "\n" || c === "\r")) {
        fail("an unterminated string");
        return i;
      }
      if (interpolated && c === "{") {
        if (src[i + 1] === "{") {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        if (!holeBraces) blank(i, i + 1);
        i = code(i + 1, true);
        if (!holeBraces) blank(i, i + 1);
        i++;
        continue;
      }
      if (interpolated && c === "}" && src[i + 1] === "}") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
    }
    fail("an unterminated string");
    return i;
  }

  /** Code until the end, or (in an interpolation hole) until the hole's closing brace, whose index it returns. */
  function code(i: number, hole: boolean): number {
    let braces = 0;
    let parens = 0;
    while (i < src.length) {
      const c = src[i]!;
      const next = src[i + 1];
      if (c === "/" && next === "/") {
        let end = i;
        while (end < src.length && src[end] !== "\n" && src[end] !== "\r") end++;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) {
          fail("an unterminated /* comment");
          blank(i, src.length);
          return src.length;
        }
        blank(i, end + 2);
        i = end + 2;
        continue;
      }
      const opener = /^(?:\$@|@\$|\$|@)?"/.exec(src.slice(i, i + 3));
      if (opener) {
        const prefix = opener[0].slice(0, -1);
        i = stringLiteral(i + opener[0].length, prefix.includes("@"), prefix.includes("$"));
        continue;
      }
      if (c === "'") {
        i = charLiteral(i + 1);
        continue;
      }
      if (hole) {
        if (c === "{") braces++;
        else if (c === "(") parens++;
        else if (c === ")") parens--;
        else if (c === "}") {
          if (braces === 0) return i;
          braces--;
        } else if (c === ":" && next === ":") {
          i += 2;
          continue;
        } else if (c === ":" && braces === 0 && parens <= 0) {
          // A format specifier ("{x:F2}") is text up to the hole's end.
          const end = src.indexOf("}", i);
          if (end < 0) break;
          blank(i + 1, end);
          return end;
        }
      }
      i++;
    }
    if (hole) fail("an unterminated interpolation");
    return i;
  }

  code(0, false);
  return { code: out.join(""), ...(error ? { error } : {}) };
}

/** Preprocessor lines blanked; for readers of declarations, which take both branches of an #if. */
function withoutDirectives(code: string): string {
  return code.replace(/^[ \t]*#.*$/gm, (line) => " ".repeat(line.length));
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

/** The index of the bracket that closes the one at `open`, or -1. */
function matchingClose(code: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (OPENERS[c]) stack.push(OPENERS[c]!);
    else if (CLOSERS.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Where a `<` that opens a type-argument list (`Service<global::Game.IScore>()`) closes, or -1 for a less-than. */
function typeArgumentsEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) {
        const after = code.slice(i + 1).trimStart()[0];
        return after === undefined || "().,];?>".includes(after) ? i : -1;
      }
    } else if (c === ":" && code[i + 1] === ":") i++;
    else if (!/[\w\s.,[\]?]/.test(c)) return -1;
  }
  return -1;
}

/** The text with every balanced bracket's contents blanked, keeping the brackets. */
function blankGroups(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (OPENERS[c]) {
      const close = matchingClose(code, i);
      if (close < 0) return out + code.slice(i);
      out += c + " ".repeat(close - i - 1) + code[close];
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split at depth 0: on commas, or on binary operators. */
function splitTopLevel(code: string, on: "commas" | "operators"): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (OPENERS[c]) {
      const close = matchingClose(code, i);
      i = close < 0 ? code.length : close + 1;
      continue;
    }
    if (c === "<") {
      const end = typeArgumentsEnd(code, i);
      if (end > 0) {
        i = end + 1;
        continue;
      }
    }
    if (on === "commas") {
      if (c === ",") {
        parts.push(code.slice(start, i));
        start = i + 1;
      }
      i++;
      continue;
    }
    const two = code.slice(i, i + 2);
    // `global::Game.X` is one name, not a conditional's colon.
    if (two === "=>" || two === "?." || two === "?[" || two === "::") {
      i += 2;
      continue;
    }
    if (["==", "!=", "<=", ">=", "&&", "||", "??", "<<", ">>"].includes(two)) {
      parts.push(code.slice(start, i));
      i += 2;
      start = i;
      continue;
    }
    // The sign of a literal's exponent (1e-5) is not an operator.
    if ("+-".includes(c) && /(?:^|[^\w.])[\d.][\d_.]*[eE]$/.test(code.slice(start, i))) {
      i++;
      continue;
    }
    if ("+-*/%<>&|^?:".includes(c)) {
      parts.push(code.slice(start, i));
      i++;
      start = i;
      continue;
    }
    i++;
  }
  parts.push(code.slice(start));
  return parts;
}

// =============================================================================
// NAMES THE COMPILER LOOKS UP
// =============================================================================

/** C#'s reserved words: nothing can be declared under one, so a bare one means what C# says. */
const CS_KEYWORDS = new Set(
  (
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event " +
    "explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null " +
    "object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string " +
    "struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while"
  ).split(" "),
);
/** Reserved words that name a type: one before a name declares it. */
const CS_TYPE_KEYWORDS = new Set("bool byte sbyte char decimal double float int uint long ulong short ushort object string void".split(" "));
/** Contextual words that are syntax where they stand (`yield return`, `where T :`, query clauses, accessors, patterns). */
const CS_CONTEXTUAL = new Set(
  "add and ascending async await by descending equals from get global group init into join let nameof not notnull on or orderby partial record remove select set unmanaged when where with yield".split(" "),
);
/** Contextual names C# binds to a type in scope before its own meaning: a `class var` would type every `var` local. */
const CS_TYPE_LIKE_CONTEXTUAL = new Set(["var", "dynamic", "nint", "nuint"]);
/** What the compiler ignores inside an identifier: a soft hyphen or a zero-width joiner does not make `Strada` another name. */
const FORMATTING_CHARS = /\p{Cf}/gu;
const CS_TOKEN_RE = /@?[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*|\d[\p{L}\p{Nd}_]*(?:\.\d[\p{L}\p{Nd}_]*)?|::|\?\.|=>|==|!=|<=|>=|&&|\|\||\?\?=?|->|\+\+|--|[-+*/%&|^]=|\S/gu;

interface CSharpToken {
  readonly text: string;
  /** An identifier (`@` dropped); a verbatim one (`@class`) is never a keyword. */
  readonly id: boolean;
  readonly verbatim: boolean;
  /** Whitespace before it: `int?` is a nullable type, `a ? b : c` a conditional. */
  readonly spaced: boolean;
}

/** Code (comments, literal text and directives already blanked) as C# reads its tokens: escapes decoded, formatting characters dropped. */
function csTokens(code: string): CSharpToken[] {
  const decoded = code
    .replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (escape, four?: string, eight?: string) => {
      const cp = parseInt(four ?? eight ?? "", 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : escape;
    })
    .replace(FORMATTING_CHARS, "");
  const tokens: CSharpToken[] = [];
  let last = 0;
  for (const match of decoded.matchAll(CS_TOKEN_RE)) {
    const raw = match[0];
    const id = /^@?[\p{L}\p{Nl}_]/u.test(raw);
    tokens.push({ text: id ? raw.replace(/^@/, "") : raw, id, verbatim: raw.startsWith("@") && id, spaced: match.index > last });
    last = match.index + raw.length;
  }
  return tokens;
}

const isKeyword = (t: CSharpToken | undefined): boolean => t !== undefined && t.id && !t.verbatim && CS_KEYWORDS.has(t.text);
const isContextual = (t: CSharpToken | undefined): boolean => t !== undefined && t.id && !t.verbatim && CS_CONTEXTUAL.has(t.text);
/** Ends a declared name: `T name =`, `T name;`, `(T name)`, `foreach (T name in`, `out T name`, `is T name &&`, `T Method(`. */
const DECLARATION_ENDS = new Set(["=", ";", ",", ")", "in", ":", "&&", "||", "when", "{", "(", "=>", "<", "?"]);

/** Whether the token before a name is a type, so the name is being declared. */
function typeBefore(tokens: readonly CSharpToken[], i: number): boolean {
  const prev = tokens[i - 1];
  if (!prev) return false;
  if (prev.id) return prev.verbatim || CS_TYPE_KEYWORDS.has(prev.text) || CS_TYPE_LIKE_CONTEXTUAL.has(prev.text) || (!CS_KEYWORDS.has(prev.text) && !CS_CONTEXTUAL.has(prev.text));
  if (prev.text === ">" || prev.text === "]") return true;
  // `int? name`, not the `?` of a conditional.
  return prev.text === "?" && !prev.spaced && (tokens[i - 2]?.id === true || tokens[i - 2]?.text === ">" || tokens[i - 2]?.text === "]");
}

/** The index of the bracket token closing the one at `open` (forward), or -1. */
function closingToken(tokens: readonly CSharpToken[], open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (pairs[t]) stack.push(pairs[t]!);
    else if (t === ")" || t === "]" || t === "}") {
      if (stack.pop() !== t) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The index of the `(` that opens the group a `)` closes (backward), or -1. */
function openingToken(tokens: readonly CSharpToken[], close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const t = tokens[i]!.text;
    if (t === ")") depth++;
    else if (t === "(" && --depth === 0) return i;
  }
  return -1;
}

/** Where a `<` that opens type arguments closes (`Service<global::Game.IScore>`), or -1 for a less-than. */
function typeArgumentsClose(tokens: readonly CSharpToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === "<") depth++;
    else if (t.text === ">") {
      if (--depth === 0) return i;
    } else if (!t.id && ![".", "::", ",", "?", "[", "]"].includes(t.text)) return -1;
  }
  return -1;
}

/** Locals, parameters, members and types the code itself declares: found before any namespace, so never a worker's. */
function declaredNames(tokens: readonly CSharpToken[]): Set<string> {
  const declared = new Set<string>();
  const switchBraces = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if (t.text === "{") {
      if (tokens[i - 1]?.text === "switch") switchBraces.add(i);
      open.push(i);
    } else if (t.text === "}") open.pop();
    if (!t.id || isKeyword(t)) {
      if (t.text === "=>" && tokens[i - 1]?.text === ")" && !switchBraces.has(open[open.length - 1] ?? -1)) {
        // `(a, b) =>` and `(int a, Game.X b) =>`: the last name of each parameter.
        const from = openingToken(tokens, i - 1);
        for (let k = from + 1; k < i - 1; k++) {
          const after = tokens[k + 1]?.text;
          if (tokens[k]!.id && (after === "," || after === ")")) declared.add(tokens[k]!.text);
        }
      }
      continue;
    }
    const prev = tokens[i - 1];
    if (prev && !prev.verbatim && ["class", "struct", "interface", "enum", "record", "delegate", "from", "join", "let", "into"].includes(prev.text)) declared.add(t.text);
    else if (prev?.text === "where" && next?.text === ":") declared.add(t.text);
    else if (next?.text === "=>" && !switchBraces.has(open[open.length - 1] ?? -1) && (!prev || ["(", ",", "=", "return", "?", ":", "??", "&&", "||", "static", "async"].includes(prev.text))) declared.add(t.text);
    else if (next && DECLARATION_ENDS.has(next.text) && typeBefore(tokens, i)) declared.add(t.text);
    if (declared.has(t.text) && next?.text === "<") {
      // A generic method's or type's own type parameters.
      const close = typeArgumentsClose(tokens, i + 1);
      for (let k = i + 2; k < close; k++) if (tokens[k]!.id) declared.add(tokens[k]!.text);
    }
    if (t.text === "var" && next?.text === "(") {
      // `var (a, b) = …`
      const close = closingToken(tokens, i + 1);
      for (let k = i + 2; k < close; k++) if (tokens[k]!.id && [",", ")"].includes(tokens[k + 1]?.text ?? "")) declared.add(tokens[k]!.text);
    }
    if (prev?.text === "enum" && next?.text === "{") {
      const close = closingToken(tokens, i + 1);
      for (let k = i + 2; k < close; k++) if (tokens[k]!.id && [",", "}", "="].includes(tokens[k + 1]?.text ?? "")) declared.add(tokens[k]!.text);
    }
  }
  return declared;
}

export interface UnrootedNamesOptions {
  /** Names in scope from elsewhere: the harness's members, for code inside a fixture that derives from it. */
  readonly allowed?: Iterable<string>;
  /** `var` and its kin as types; a worker's type so named is reported by `scanForeignAcceptanceNamespace`. */
  readonly varAllowed?: boolean;
  /** Names a bare call (`Name(…)`) may use and nothing else may: methods every class inherits, a using static's methods. */
  readonly calls?: Iterable<string>;
}

/** What a check may call bare besides its own functions and the harness's: object's methods and Enumerable's statics. */
const INHERITED_CALLS = ["ToString", "Equals", "GetHashCode", "ReferenceEquals", "Range", "Repeat", "Empty"];

/**
 * Every name C# would look up by searching namespaces: a bare type or
 * namespace that is not spelled from the root (`global::`), not a keyword, and
 * not something the code or the harness declares. C# searches the enclosing
 * namespaces (`Strada.Acceptance`, `Strada`, the global one) and every using's
 * namespace for such a name, so a type a worker declares there — or a game
 * namespace sharing the name — would answer it. The checks' code must name
 * none.
 */
export function unrootedNames(source: string, opts: UnrootedNamesOptions = {}): string[] {
  const tokens = csTokens(withoutDirectives(scanCSharp(source).code));
  const declared = declaredNames(tokens);
  // A discard (`out _`) names nothing.
  declared.add("_");
  for (const name of opts.allowed ?? []) declared.add(name);
  const calls = new Set(opts.calls ?? []);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.id || isKeyword(t)) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && [".", "?.", "::", "->"].includes(prev.text)) continue;
    if (prev?.text === "namespace" && !prev.verbatim) continue;
    if (t.text === "global" && next?.text === "::") continue;
    if (isContextual(t) && next?.text !== "." && next?.text !== "::") continue;
    if (!t.verbatim && CS_TYPE_LIKE_CONTEXTUAL.has(t.text) && opts.varAllowed && (next?.id || next?.text === "(")) continue;
    // Assigned (`x = …`, an initializer's `Member = …`) or labelled (`name: …`): a value or a member, never a type.
    if (next?.text === "=") continue;
    if (next?.text === ":" && prev && ["(", ",", "{"].includes(prev.text)) continue;
    if (declared.has(t.text)) continue;
    // A call, not a type in call shape: `new Point(…)`, a positional pattern `is Point(…)`.
    const call = next?.text === "(" || (next?.text === "<" && tokens[typeArgumentsClose(tokens, i + 1) + 1]?.text === "(");
    if (call && calls.has(t.text) && !["new", "stackalloc", "is", "case", "not", "and", "or"].includes(prev?.text ?? "")) continue;
    found.add(t.text);
  }
  return [...found].sort();
}

// =============================================================================
// RENDERING A MILESTONE'S ACCEPTANCE FILE
// =============================================================================

/**
 * Rows whose GDD numbers the system asserts itself: a constant or a range
 * with bounds code parsed. Their check is an observation, never an assertion.
 */
export function systemAssertsRow(row: RequirementRow): boolean {
  return (row.kind === "constant" || row.kind === "range") && row.bounds !== undefined;
}

/** sha256 of the writer's parts, before the system wraps them (`AcceptanceCheckRef.bodySha`). */
export function checkBodySha(check: AcceptanceCheckBody): string {
  const parts: Record<string, string> = {};
  for (const key of ["setup", "act", "observe", "body"] as const) {
    const value = check[key];
    if (value !== undefined) parts[key] = value;
  }
  return sha256(JSON.stringify(parts));
}

/**
 * The system's own lines name the framework from the root. The acceptance
 * assembly references every game runtime assembly, and C# finds a type in an
 * enclosing namespace (`Strada`, the global one) — or a local the setup
 * declares — before a using's: a worker's `Assert`/`Is` there would judge the row.
 */
const NUNIT = "global::NUnit.Framework";

/**
 * What a check may name bare besides its own locals: the harness's protected
 * members. C# finds a member of the fixture's base class before it searches
 * any namespace, so no type a worker declares can stand in for one.
 */
export const ACCEPTANCE_HARNESS_MEMBERS: readonly string[] = [
  "Boot",
  "Frames",
  "Seconds",
  "Until",
  "Driver",
  "PlaythroughView",
  "StartSessionForSetup",
  "Service",
  "AnyAudioPlaying",
  "ActiveScreens",
  "InputInjectable",
  "TapViewport",
  "TapScreen",
  "TapObject",
  "Drag",
  "Press",
  "BootSeconds",
  "SessionStartSeconds",
];

/** The NUnit constraint for a row's bounds; the numbers come from the GDD, never from a model. */
function boundsConstraint(bounds: RequirementBounds): string {
  if (bounds.kind === "exact") return `${NUNIT}.Is.EqualTo(${csDouble(bounds.value)}).Within(${csDouble(Math.abs(bounds.tolerance))})`;
  const { lo, hi } = bounds;
  if (lo === undefined && hi === undefined) throw new Error("a range bound needs lo, hi or both");
  if (lo !== undefined && hi !== undefined && lo > hi) throw new Error(`a range bound has lo ${lo} above hi ${hi}`);
  if (lo !== undefined && hi !== undefined && !bounds.loExclusive && !bounds.hiExclusive) return `${NUNIT}.Is.InRange(${csDouble(lo)}, ${csDouble(hi)})`;
  const parts: string[] = [];
  if (lo !== undefined) parts.push(`${bounds.loExclusive ? "GreaterThan" : "GreaterThanOrEqualTo"}(${csDouble(lo)})`);
  if (hi !== undefined) parts.push(`${bounds.hiExclusive ? "LessThan" : "LessThanOrEqualTo"}(${csDouble(hi)})`);
  return `${NUNIT}.Is.${parts.join(".And.")}`;
}

export interface AcceptanceTestInput {
  readonly row: RequirementRow;
  readonly check: AcceptanceCheckBody;
}

/** A rendered acceptance file; the caller adds the writer and revision count to store it as an `AcceptanceSource`. */
export interface RenderedAcceptanceFile {
  readonly milestoneId: string;
  readonly path: string;
  readonly source: string;
  readonly sha256: string;
  readonly tests: AcceptanceTestRef[];
}

/**
 * The file's one using. It brings in no type name — a namespace import would
 * put `Grid`, `Input` or `Is` ahead of a game namespace so named and stop the
 * shared assembly compiling — only LINQ's extension methods, which then bind
 * inside the milestone's namespace before any a worker declares outside it.
 */
const FILE_USING = "using static global::System.Linq.Enumerable;";

/**
 * One milestone's acceptance file. Tests are in GDD order; each boots the
 * game, runs the writer's statements, and — for a numeric row — asserts the
 * observation against the row's own bounds. Bodies should have passed
 * `lintAcceptanceBody`; what the render cannot make honest it refuses
 * (throws): a numeric row with no observation, a check for another row, a
 * row twice.
 */
export function renderAcceptanceFile(milestoneId: string, tests: readonly AcceptanceTestInput[]): RenderedAcceptanceFile {
  const ident = acceptanceIdent(milestoneId);
  const className = `Acceptance_${ident}`;
  const namespace = `${ACCEPTANCE_TEST_NAMESPACE}.${ident}`;
  const seen = new Set<string>();
  for (const { row, check } of tests) {
    if (check.rid !== row.rid) throw new Error(`a check for rid ${check.rid} was given for row ${row.rid}`);
    if (seen.has(row.rid)) throw new Error(`row ${row.rid} was given twice`);
    seen.add(row.rid);
    if (systemAssertsRow(row) && !check.observe?.trim()) throw new Error(`row ${row.rid} has GDD bounds: its check must observe (an expression), not assert`);
    if (!systemAssertsRow(row) && !check.body?.trim()) throw new Error(`row ${row.rid} needs a body that asserts`);
  }
  const ordered = [...tests].sort((a, b) => a.row.span.start - b.row.span.start || (a.row.rid < b.row.rid ? -1 : a.row.rid > b.row.rid ? 1 : 0));
  const narrow = ordered.map((t) => testMethodName(t.row.rid, false));
  const methods = ordered.map((t, i) => (narrow.filter((n) => n === narrow[i]).length > 1 ? testMethodName(t.row.rid, true) : narrow[i]!));

  const inner = "            ";
  const body: string[] = [];
  ordered.forEach(({ row, check }, i) => {
    const textLines = row.text.split(CS_LINE_BREAK).map(commentSafe);
    if (i > 0) body.push("");
    body.push(`        // REQ ${row.rid} — ${textLines[0] ?? ""}`.trimEnd());
    for (const line of textLines.slice(1)) body.push(`        //     ${line}`.trimEnd());
    body.push(`        [global::UnityEngine.TestTools.UnityTest, ${NUNIT}.Timeout(${ACCEPTANCE_TEST_TIMEOUT_MS})]`);
    body.push(`        public global::System.Collections.IEnumerator ${methods[i]}()`);
    body.push("        {");
    body.push(`${inner}yield return Boot();`);
    if (check.setup?.trim()) body.push(...indentPart(check.setup, inner));
    if (systemAssertsRow(row)) {
      const observe = indentPart(check.observe!, "");
      // A comment ending the observation would swallow a `);` on its line, and with it every check in the assembly.
      const last = observe[observe.length - 1] ?? "";
      const lastCode = scanCSharp(observe.join("\n")).code.split("\n").pop() ?? "";
      const close = lastCode.trimEnd().length < last.trimEnd().length ? `\n${inner});` : ");";
      // `double`, not `var`: a worker's `class var` in Strada or the global namespace would type a `var` local.
      body.push(`${inner}double observed = (double)(${observe.join(`\n${inner}    `)}${close}`);
      body.push(`${inner}${NUNIT}.Assert.That(observed, ${boundsConstraint(row.bounds!)}, ${csString(`${row.rid}: ${row.text}`)});`);
    } else {
      if (check.act?.trim()) body.push(...indentPart(check.act, inner));
      body.push(...indentPart(check.body!, inner));
    }
    body.push("        }");
  });

  const source = stampCSharp(
    [
      `// Strada acceptance checks for milestone ${commentSafe(JSON.stringify(milestoneId).replace(CS_LINE_BREAKS, " "))}.`,
      "// System-owned: Strada.Brain writes this file from the approved GDD and restores the",
      "// stored bytes before every commit and measurement. Edits are reverted and reported.",
      "// Every type is spelled from the root (global::); the file imports only LINQ's extension methods.",
      "",
      `namespace ${namespace}`,
      "{",
      `    ${FILE_USING}`,
      "",
      `    [${NUNIT}.TestFixture, ${NUNIT}.Category(${csString(ACCEPTANCE_TEST_CATEGORY)})]`,
      `    public sealed class ${className} : global::${ACCEPTANCE_TEST_NAMESPACE}.AcceptanceFixture`,
      "    {",
      ...body,
      "    }",
      "}",
      "",
    ].join("\n"),
  );

  return {
    milestoneId,
    path: acceptanceFilePath(milestoneId),
    source,
    sha256: sha256(source),
    tests: ordered.map(({ row, check }, i) => ({
      rid: row.rid,
      testName: `${namespace}.${className}.${methods[i]}`,
      bodySha: checkBodySha(check),
    })),
  };
}

// =============================================================================
// THE HARNESS
// =============================================================================

/**
 * The package (or built-in module) each optional part of the harness needs,
 * and the symbol its assembly defines when the project has it — so the same
 * bytes compile whether or not a project removed audio, physics or uGUI.
 */
const VERSION_DEFINES = [
  { name: "com.unity.inputsystem", expression: "0.0.0", define: "STRADA_ACCEPTANCE_INPUT_SYSTEM" },
  { name: "com.unity.ugui", expression: "0.0.0", define: "STRADA_ACCEPTANCE_UGUI" },
  { name: "com.unity.modules.ui", expression: "0.0.0", define: "STRADA_ACCEPTANCE_UI_MODULE" },
  { name: "com.unity.modules.uielements", expression: "0.0.0", define: "STRADA_ACCEPTANCE_UIELEMENTS" },
  { name: "com.unity.modules.audio", expression: "0.0.0", define: "STRADA_ACCEPTANCE_AUDIO" },
  { name: "com.unity.modules.physics", expression: "0.0.0", define: "STRADA_ACCEPTANCE_PHYSICS" },
  { name: "com.unity.modules.physics2d", expression: "0.0.0", define: "STRADA_ACCEPTANCE_PHYSICS2D" },
] as const;

/**
 * The generic harness every acceptance fixture derives from. It knows no
 * game: it boots build scene 0, reads the game through Strada.Core's
 * contracts (GameBootstrapper.Services, IPlaythroughDriver — read-only), and
 * injects input as a player's device would. Its own failures carry the
 * harness fault tag.
 */
export const ACCEPTANCE_FIXTURE_SOURCE = stampCSharp(`// Strada acceptance harness.
// System-owned: Strada.Brain writes this file and restores the stored bytes before every
// commit and measurement. Edits are reverted and reported.
// It knows no game: it boots build scene 0, reads the game through Strada.Core's contracts,
// and injects input the way a player's device does.
// It imports nothing and spells every type from the root (global::): C# looks a bare name up
// in Strada.Acceptance, Strada and the global namespace first, and code outside this folder
// can declare a type in any of them.

namespace ${ACCEPTANCE_TEST_NAMESPACE}
{
    public abstract class AcceptanceFixture
    {
        protected const float BootSeconds = 30f;
        protected const float SessionStartSeconds = 10f;

#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        private global::UnityEngine.InputSystem.InputSettings _runInputSettings;
        private global::UnityEngine.InputSystem.InputSettings _projectInputSettingsAsset;
        private global::UnityEngine.InputSystem.InputSettings.EditorInputBehaviorInPlayMode _savedEditorBehavior;
        private global::UnityEngine.InputSystem.InputSettings.BackgroundBehavior _savedBackgroundBehavior;
#endif

        /// <summary>Puts back what Boot() changed for the run; the project's own settings asset is never edited.</summary>
        [global::NUnit.Framework.TearDown]
        public void RestoreHarnessState()
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            if (_projectInputSettingsAsset != null)
            {
                // The Input System destroys the run's HideAndDontSave copy as it takes the asset back.
                global::UnityEngine.InputSystem.InputSystem.settings = _projectInputSettingsAsset;
            }
            else if (_runInputSettings != null)
            {
                _runInputSettings.editorInputBehaviorInPlayMode = _savedEditorBehavior;
                _runInputSettings.backgroundBehavior = _savedBackgroundBehavior;
            }
            _projectInputSettingsAsset = null;
            _runInputSettings = null;
#endif
        }

        // ------------------------------------------------------------------ time

        /// <summary>Loads build scene 0 and waits until GameBootstrapper.Services is published.</summary>
        protected global::System.Collections.IEnumerator Boot()
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            // A test run has no focused Game View, and the Input System hands pointer and keyboard
            // events to whatever has focus: without this, every injected tap is dropped (measured).
            if (_runInputSettings == null)
            {
                global::UnityEngine.InputSystem.InputSettings current = global::UnityEngine.InputSystem.InputSystem.settings;
                if (current.hideFlags == global::UnityEngine.HideFlags.HideAndDontSave)
                {
                    // The Input System's own temporary (no settings asset): no file behind it to edit.
                    _runInputSettings = current;
                    _savedEditorBehavior = current.editorInputBehaviorInPlayMode;
                    _savedBackgroundBehavior = current.backgroundBehavior;
                }
                else
                {
                    _projectInputSettingsAsset = current;
                    _runInputSettings = global::UnityEngine.Object.Instantiate(current);
                    _runInputSettings.hideFlags = global::UnityEngine.HideFlags.HideAndDontSave;
                    global::UnityEngine.InputSystem.InputSystem.settings = _runInputSettings;
                }
                _runInputSettings.editorInputBehaviorInPlayMode = global::UnityEngine.InputSystem.InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
                _runInputSettings.backgroundBehavior = global::UnityEngine.InputSystem.InputSettings.BackgroundBehavior.IgnoreFocus;
            }
#endif
            if (global::UnityEngine.SceneManagement.SceneManager.sceneCountInBuildSettings < 1)
                HarnessFault("no-scene", "the build settings list no scene, so there is no entry scene to boot");
            global::UnityEngine.AsyncOperation load = global::UnityEngine.SceneManagement.SceneManager.LoadSceneAsync(0, global::UnityEngine.SceneManagement.LoadSceneMode.Single);
            if (load == null)
                HarnessFault("no-scene", "build scene 0 could not be loaded");
            // Bounded, so a scene that never loads is the harness's fault, not the test's timeout.
            float deadline = global::UnityEngine.Time.realtimeSinceStartup + BootSeconds;
            while (!load.isDone && global::UnityEngine.Time.realtimeSinceStartup < deadline)
                yield return null;
            if (!load.isDone)
                HarnessFault("no-scene", "build scene 0 did not finish loading in " + BootSeconds + " s");
            deadline = global::UnityEngine.Time.realtimeSinceStartup + BootSeconds;
            while (global::Strada.Core.Bootstrap.GameBootstrapper.Services == null && global::UnityEngine.Time.realtimeSinceStartup < deadline)
                yield return null;
            if (global::Strada.Core.Bootstrap.GameBootstrapper.Services == null)
                HarnessFault("no-boot", "GameBootstrapper.Services stayed null for " + BootSeconds + " s after build scene 0 loaded");
            yield return null;
        }

        protected global::System.Collections.IEnumerator Frames(int count)
        {
            for (int i = 0; i < count; i++)
                yield return null;
        }

        /// <summary>Real time: a paused game (timeScale 0) cannot stall the wait.</summary>
        protected global::System.Collections.IEnumerator Seconds(float seconds)
        {
            float end = global::UnityEngine.Time.realtimeSinceStartup + seconds;
            while (global::UnityEngine.Time.realtimeSinceStartup < end)
                yield return null;
        }

        /// <summary>Waits until the condition holds or the time runs out; it never fails by itself.</summary>
        protected global::System.Collections.IEnumerator Until(global::System.Func<bool> condition, float timeoutSeconds = 10f)
        {
            float end = global::UnityEngine.Time.realtimeSinceStartup + timeoutSeconds;
            while (!condition() && global::UnityEngine.Time.realtimeSinceStartup < end)
                yield return null;
        }

        // --------------------------------------------------------- reading the game

        /// <summary>The game's play-through driver, read-only: what it reports, never what it does.</summary>
        protected sealed class PlaythroughView
        {
            private readonly global::Strada.Core.Play.IPlaythroughDriver _driver;
            internal PlaythroughView(global::Strada.Core.Play.IPlaythroughDriver driver) { _driver = driver; }
            public string Phase { get { return _driver.Phase; } }
            public global::Strada.Core.Play.PlaythroughOutcome Outcome { get { return _driver.Outcome; } }
            public bool IsSessionActive { get { return _driver.IsSessionActive; } }
        }

        protected PlaythroughView Driver { get { return new PlaythroughView(ResolveDriver()); } }

        /// <summary>Starts a session for a check whose subject is not how play starts.</summary>
        protected global::System.Collections.IEnumerator StartSessionForSetup(int index)
        {
            global::Strada.Core.Play.IPlaythroughDriver driver = ResolveDriver();
            global::NUnit.Framework.Assert.That(driver.StartSession(index), global::NUnit.Framework.Is.True, "the game refused StartSession(" + index + ")");
            float end = global::UnityEngine.Time.realtimeSinceStartup + SessionStartSeconds;
            while (!driver.IsSessionActive && global::UnityEngine.Time.realtimeSinceStartup < end)
                yield return null;
            global::NUnit.Framework.Assert.That(driver.IsSessionActive, global::NUnit.Framework.Is.True, "no session was active " + SessionStartSeconds + " s after StartSession(" + index + ")");
        }

        protected T Service<T>() where T : class
        {
            if (global::Strada.Core.Bootstrap.GameBootstrapper.Services == null)
                HarnessFault("no-boot", "GameBootstrapper.Services is null: the game is not booted");
            T service;
            if (!global::Strada.Core.Bootstrap.GameBootstrapper.Services.TryGet(out service) || service == null)
                HarnessFault("no-service", "the game registers no " + typeof(T).FullName);
            return service;
        }

        protected bool AnyAudioPlaying()
        {
#if STRADA_ACCEPTANCE_AUDIO
            foreach (global::UnityEngine.AudioSource source in global::UnityEngine.Object.FindObjectsByType<global::UnityEngine.AudioSource>(global::UnityEngine.FindObjectsSortMode.None))
                if (source != null && source.isPlaying)
                    return true;
#endif
            return false;
        }

        /// <summary>Active root canvases, their active children, and active UI documents, by name.</summary>
        protected global::System.Collections.Generic.IReadOnlyList<string> ActiveScreens()
        {
            global::System.Collections.Generic.List<string> names = new global::System.Collections.Generic.List<string>();
#if STRADA_ACCEPTANCE_UI_MODULE
            foreach (global::UnityEngine.Canvas canvas in global::UnityEngine.Object.FindObjectsByType<global::UnityEngine.Canvas>(global::UnityEngine.FindObjectsSortMode.None))
            {
                if (canvas == null || !canvas.isActiveAndEnabled || !canvas.isRootCanvas)
                    continue;
                names.Add(canvas.gameObject.name);
                global::UnityEngine.Transform root = canvas.transform;
                for (int i = 0; i < root.childCount; i++)
                {
                    global::UnityEngine.GameObject child = root.GetChild(i).gameObject;
                    if (child.activeInHierarchy)
                        names.Add(child.name);
                }
            }
#endif
#if STRADA_ACCEPTANCE_UIELEMENTS
            foreach (global::UnityEngine.UIElements.UIDocument document in global::UnityEngine.Object.FindObjectsByType<global::UnityEngine.UIElements.UIDocument>(global::UnityEngine.FindObjectsSortMode.None))
                if (document != null && document.isActiveAndEnabled)
                    names.Add(document.gameObject.name);
#endif
            names.Sort(global::System.StringComparer.Ordinal);
            return names;
        }

        // ------------------------------------------------------------------ input

        /// <summary>"input-system" (device events), "event-system" (EventSystem pointer events) or "none".</summary>
        protected string InputInjectable { get { return CurrentRoute(); } }

        protected global::System.Collections.IEnumerator TapViewport(float x, float y)
        {
            return TapScreen(new global::UnityEngine.Vector2(x * global::UnityEngine.Screen.width, y * global::UnityEngine.Screen.height));
        }

        protected global::System.Collections.IEnumerator TapScreen(global::UnityEngine.Vector2 position)
        {
            RequireInputRoute("TapScreen");
            DeviceHover(position);
            yield return null;
            DevicePointer(position, global::UnityEngine.Vector2.zero, true, PointerStage.Begin);
            object ui = UiBegin(position);
            yield return null;
            DevicePointer(position, global::UnityEngine.Vector2.zero, false, PointerStage.End);
            UiEnd(ui, position);
            yield return null;
            yield return null;
        }

        protected global::System.Collections.IEnumerator TapObject(string name)
        {
            global::UnityEngine.GameObject target = global::UnityEngine.GameObject.Find(name);
            if (target == null)
                global::NUnit.Framework.Assert.Fail("TapObject: no active GameObject is named '" + name + "'");
            return TapObject(target);
        }

        protected global::System.Collections.IEnumerator TapObject(global::UnityEngine.Component target)
        {
            if (target == null)
                global::NUnit.Framework.Assert.Fail("TapObject: the target is null or destroyed");
            return TapObject(target.gameObject);
        }

        protected global::System.Collections.IEnumerator TapObject(global::UnityEngine.GameObject target)
        {
            if (target == null)
                global::NUnit.Framework.Assert.Fail("TapObject: the target is null or destroyed");
            if (!target.activeInHierarchy)
                global::NUnit.Framework.Assert.Fail("TapObject: " + target.name + " is not active");
            global::UnityEngine.Vector2 point;
            string why;
            if (!ScreenPointOf(target, out point, out why))
                global::NUnit.Framework.Assert.Fail("TapObject: " + target.name + " " + why);
            return TapScreen(point);
        }

        protected global::System.Collections.IEnumerator Drag(global::UnityEngine.Vector2 from, global::UnityEngine.Vector2 to, float seconds = 0.25f)
        {
            RequireInputRoute("Drag");
            DeviceHover(from);
            yield return null;
            DevicePointer(from, global::UnityEngine.Vector2.zero, true, PointerStage.Begin);
            object ui = UiBegin(from);
            yield return null;
            int steps = global::UnityEngine.Mathf.Max(2, global::UnityEngine.Mathf.CeilToInt(seconds * 30f));
            float start = global::UnityEngine.Time.realtimeSinceStartup;
            global::UnityEngine.Vector2 last = from;
            for (int i = 1; i <= steps; i++)
            {
                global::UnityEngine.Vector2 point = global::UnityEngine.Vector2.Lerp(from, to, (float)i / steps);
                DevicePointer(point, point - last, true, PointerStage.Move);
                UiMove(ui, point);
                last = point;
                float stepEnd = start + seconds * i / steps;
                do
                    yield return null;
                while (global::UnityEngine.Time.realtimeSinceStartup < stepEnd);
            }
            DevicePointer(to, global::UnityEngine.Vector2.zero, false, PointerStage.End);
            UiEnd(ui, to);
            yield return null;
            yield return null;
        }

        /// <summary>Presses and releases a keyboard key, by UnityEngine.InputSystem.Key name.</summary>
        protected global::System.Collections.IEnumerator Press(string key)
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            global::UnityEngine.InputSystem.Key parsed;
            if (!global::System.Enum.TryParse(key, true, out parsed) || parsed == global::UnityEngine.InputSystem.Key.None)
                HarnessFault("no-input-route", "Press('" + key + "'): not a UnityEngine.InputSystem.Key name");
            global::UnityEngine.InputSystem.Keyboard keyboard = Enabled(global::UnityEngine.InputSystem.Keyboard.current != null ? global::UnityEngine.InputSystem.Keyboard.current : global::UnityEngine.InputSystem.InputSystem.AddDevice<global::UnityEngine.InputSystem.Keyboard>());
            global::UnityEngine.InputSystem.InputSystem.QueueStateEvent(keyboard, new global::UnityEngine.InputSystem.LowLevel.KeyboardState(parsed));
            yield return null;
            global::UnityEngine.InputSystem.InputSystem.QueueStateEvent(keyboard, new global::UnityEngine.InputSystem.LowLevel.KeyboardState());
            yield return null;
            yield return null;
#elif STRADA_ACCEPTANCE_UGUI
            global::UnityEngine.EventSystems.EventSystem events = global::UnityEngine.EventSystems.EventSystem.current;
            if (events == null)
                HarnessFault("no-input-route", "Press('" + key + "'): no Input System, and no EventSystem in the scene");
            string name = key.Trim().ToLowerInvariant();
            global::UnityEngine.GameObject selected = events.currentSelectedGameObject;
            if (name == "enter" || name == "return" || name == "space" || name == "submit")
            {
                if (selected != null)
                    global::UnityEngine.EventSystems.ExecuteEvents.Execute(selected, new global::UnityEngine.EventSystems.BaseEventData(events), global::UnityEngine.EventSystems.ExecuteEvents.submitHandler);
            }
            else if (name == "escape" || name == "cancel")
            {
                if (selected != null)
                    global::UnityEngine.EventSystems.ExecuteEvents.Execute(selected, new global::UnityEngine.EventSystems.BaseEventData(events), global::UnityEngine.EventSystems.ExecuteEvents.cancelHandler);
            }
            else
                HarnessFault("no-input-route", "Press('" + key + "'): without the Input System only Enter/Space (submit) and Escape (cancel) reach the selected UI element");
            yield return null;
            yield return null;
#else
            HarnessFault("no-input-route", "Press('" + key + "'): this project has neither the Input System package nor uGUI");
            yield break;
#endif
        }

        // --------------------------------------------------------------- internals

        private static void HarnessFault(string code, string detail)
        {
            global::NUnit.Framework.Assert.Fail("[${HARNESS_FAULT_TAG}:" + code + "] " + detail);
        }

        private static global::Strada.Core.Play.IPlaythroughDriver ResolveDriver()
        {
            if (global::Strada.Core.Bootstrap.GameBootstrapper.Services == null)
                HarnessFault("no-boot", "GameBootstrapper.Services is null: the game is not booted");
            global::Strada.Core.Play.IPlaythroughDriver driver;
            if (!global::Strada.Core.Bootstrap.GameBootstrapper.Services.TryGet(out driver) || driver == null)
                HarnessFault("no-driver", "the game registers no Strada.Core.Play.IPlaythroughDriver");
            return driver;
        }

        private static string CurrentRoute()
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            return "input-system";
#elif STRADA_ACCEPTANCE_UGUI
            return global::UnityEngine.EventSystems.EventSystem.current != null ? "event-system" : "none";
#else
            return "none";
#endif
        }

        private static void RequireInputRoute(string what)
        {
            if (CurrentRoute() == "none")
                HarnessFault("no-input-route", what + ": no input can be injected: the project has no Input System package with the new input handling enabled, and the scene has no EventSystem");
        }

        private static bool OnScreen(global::UnityEngine.Vector2 point, out string why)
        {
            if (point.x < 0f || point.y < 0f || point.x > global::UnityEngine.Screen.width || point.y > global::UnityEngine.Screen.height)
            {
                why = "is off screen at (" + point.x + ", " + point.y + ") on a " + global::UnityEngine.Screen.width + "x" + global::UnityEngine.Screen.height + " screen";
                return false;
            }
            why = null;
            return true;
        }

        private static bool ScreenPointOf(global::UnityEngine.GameObject target, out global::UnityEngine.Vector2 point, out string why)
        {
#if STRADA_ACCEPTANCE_UI_MODULE
            global::UnityEngine.RectTransform rect = target.transform as global::UnityEngine.RectTransform;
            global::UnityEngine.Canvas canvas = rect != null ? target.GetComponentInParent<global::UnityEngine.Canvas>() : null;
            if (canvas != null)
            {
                global::UnityEngine.Canvas root = canvas.rootCanvas;
                global::UnityEngine.Camera uiCamera = null;
                if (root.renderMode != global::UnityEngine.RenderMode.ScreenSpaceOverlay)
                    uiCamera = root.worldCamera != null ? root.worldCamera : global::UnityEngine.Camera.main;
                point = global::UnityEngine.RectTransformUtility.WorldToScreenPoint(uiCamera, rect.TransformPoint(rect.rect.center));
                return OnScreen(point, out why);
            }
#endif
            global::UnityEngine.Camera camera = global::UnityEngine.Camera.main;
            if (camera == null)
            {
                point = global::UnityEngine.Vector2.zero;
                why = "has no screen position: no camera is tagged MainCamera";
                return false;
            }
            global::UnityEngine.Vector3 world = target.transform.position;
            global::UnityEngine.Renderer renderer = target.GetComponentInChildren<global::UnityEngine.Renderer>();
            if (renderer != null)
                world = renderer.bounds.center;
#if STRADA_ACCEPTANCE_PHYSICS
            else if (target.GetComponentInChildren<global::UnityEngine.Collider>() != null)
                world = target.GetComponentInChildren<global::UnityEngine.Collider>().bounds.center;
#endif
#if STRADA_ACCEPTANCE_PHYSICS2D
            else if (target.GetComponentInChildren<global::UnityEngine.Collider2D>() != null)
                world = target.GetComponentInChildren<global::UnityEngine.Collider2D>().bounds.center;
#endif
            global::UnityEngine.Vector3 screen = camera.WorldToScreenPoint(world);
            if (screen.z < 0f)
            {
                point = global::UnityEngine.Vector2.zero;
                why = "is behind the main camera";
                return false;
            }
            point = new global::UnityEngine.Vector2(screen.x, screen.y);
            return OnScreen(point, out why);
        }

        private enum PointerStage { Begin, Move, End }

#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        /// <summary>The touchscreen when it is the only pointer, else the mouse (one is added in a headless run).</summary>
        private static global::UnityEngine.InputSystem.Pointer InjectionPointer()
        {
            if (global::UnityEngine.InputSystem.Touchscreen.current != null && global::UnityEngine.InputSystem.Mouse.current == null)
                return Enabled(global::UnityEngine.InputSystem.Touchscreen.current);
            return Enabled(global::UnityEngine.InputSystem.Mouse.current != null ? (global::UnityEngine.InputSystem.Pointer)global::UnityEngine.InputSystem.Mouse.current : global::UnityEngine.InputSystem.InputSystem.AddDevice<global::UnityEngine.InputSystem.Mouse>());
        }

        /// <summary>A device disabled while the run had no focus ignores the events queued for it.</summary>
        private static T Enabled<T>(T device) where T : global::UnityEngine.InputSystem.InputDevice
        {
            if (!device.enabled)
                global::UnityEngine.InputSystem.InputSystem.EnableDevice(device);
            return device;
        }
#endif

        private static void DeviceHover(global::UnityEngine.Vector2 position)
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            global::UnityEngine.InputSystem.Mouse mouse = InjectionPointer() as global::UnityEngine.InputSystem.Mouse;
            if (mouse != null)
                global::UnityEngine.InputSystem.InputSystem.QueueStateEvent(mouse, new global::UnityEngine.InputSystem.LowLevel.MouseState { position = position });
#endif
        }

        private static void DevicePointer(global::UnityEngine.Vector2 position, global::UnityEngine.Vector2 delta, bool pressed, PointerStage stage)
        {
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            global::UnityEngine.InputSystem.Pointer pointer = InjectionPointer();
            global::UnityEngine.InputSystem.Touchscreen touch = pointer as global::UnityEngine.InputSystem.Touchscreen;
            if (touch != null)
            {
                global::UnityEngine.InputSystem.TouchPhase phase = stage == PointerStage.Begin ? global::UnityEngine.InputSystem.TouchPhase.Began
                    : stage == PointerStage.Move ? global::UnityEngine.InputSystem.TouchPhase.Moved
                    : global::UnityEngine.InputSystem.TouchPhase.Ended;
                global::UnityEngine.InputSystem.InputSystem.QueueStateEvent(touch, new global::UnityEngine.InputSystem.LowLevel.TouchState { touchId = 1, phase = phase, position = position, delta = delta });
                return;
            }
            global::UnityEngine.InputSystem.InputSystem.QueueStateEvent((global::UnityEngine.InputSystem.Mouse)pointer, new global::UnityEngine.InputSystem.LowLevel.MouseState { position = position, delta = delta }.WithButton(global::UnityEngine.InputSystem.LowLevel.MouseButton.Left, pressed));
#endif
        }

#if STRADA_ACCEPTANCE_UGUI
        private sealed class UiPress
        {
            public global::UnityEngine.EventSystems.PointerEventData Data;
            public global::UnityEngine.GameObject Target;
        }

        private static global::UnityEngine.GameObject RaycastTop(global::UnityEngine.EventSystems.EventSystem events, global::UnityEngine.EventSystems.PointerEventData data)
        {
            if (events == null)
                return null;
            global::System.Collections.Generic.List<global::UnityEngine.EventSystems.RaycastResult> hits = new global::System.Collections.Generic.List<global::UnityEngine.EventSystems.RaycastResult>();
            events.RaycastAll(data, hits);
            if (hits.Count == 0)
                return null;
            data.pointerCurrentRaycast = hits[0];
            return hits[0].gameObject;
        }

        private static bool UiNeedsDirectEvents()
        {
            global::UnityEngine.EventSystems.EventSystem events = global::UnityEngine.EventSystems.EventSystem.current;
            if (events == null)
                return false;
#if STRADA_ACCEPTANCE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            // Device events reach the UI only through the Input System's own UI module.
            return !(events.currentInputModule is global::UnityEngine.InputSystem.UI.InputSystemUIInputModule);
#else
            return true;
#endif
        }
#endif

        private static object UiBegin(global::UnityEngine.Vector2 position)
        {
#if STRADA_ACCEPTANCE_UGUI
            if (!UiNeedsDirectEvents())
                return null;
            global::UnityEngine.EventSystems.EventSystem events = global::UnityEngine.EventSystems.EventSystem.current;
            global::UnityEngine.EventSystems.PointerEventData data = new global::UnityEngine.EventSystems.PointerEventData(events)
            {
                position = position,
                pressPosition = position,
                button = global::UnityEngine.EventSystems.PointerEventData.InputButton.Left,
                eligibleForClick = true,
                clickCount = 1,
            };
            global::UnityEngine.GameObject target = RaycastTop(events, data);
            if (target == null)
                return null;
            data.pointerPressRaycast = data.pointerCurrentRaycast;
            global::UnityEngine.EventSystems.ExecuteEvents.ExecuteHierarchy(target, data, global::UnityEngine.EventSystems.ExecuteEvents.pointerEnterHandler);
            global::UnityEngine.GameObject pressed = global::UnityEngine.EventSystems.ExecuteEvents.ExecuteHierarchy(target, data, global::UnityEngine.EventSystems.ExecuteEvents.pointerDownHandler);
            data.pointerPress = pressed != null ? pressed : global::UnityEngine.EventSystems.ExecuteEvents.GetEventHandler<global::UnityEngine.EventSystems.IPointerClickHandler>(target);
            data.rawPointerPress = target;
            data.pointerDrag = global::UnityEngine.EventSystems.ExecuteEvents.GetEventHandler<global::UnityEngine.EventSystems.IDragHandler>(target);
            if (data.pointerDrag != null)
                global::UnityEngine.EventSystems.ExecuteEvents.Execute(data.pointerDrag, data, global::UnityEngine.EventSystems.ExecuteEvents.initializePotentialDrag);
            return new UiPress { Data = data, Target = target };
#else
            return null;
#endif
        }

        private static void UiMove(object state, global::UnityEngine.Vector2 position)
        {
#if STRADA_ACCEPTANCE_UGUI
            UiPress press = state as UiPress;
            if (press == null)
                return;
            global::UnityEngine.EventSystems.PointerEventData data = press.Data;
            data.delta = position - data.position;
            data.position = position;
            if (data.pointerDrag == null)
                return;
            if (!data.dragging)
            {
                global::UnityEngine.EventSystems.ExecuteEvents.Execute(data.pointerDrag, data, global::UnityEngine.EventSystems.ExecuteEvents.beginDragHandler);
                data.dragging = true;
                data.eligibleForClick = false;
            }
            global::UnityEngine.EventSystems.ExecuteEvents.Execute(data.pointerDrag, data, global::UnityEngine.EventSystems.ExecuteEvents.dragHandler);
#endif
        }

        private static void UiEnd(object state, global::UnityEngine.Vector2 position)
        {
#if STRADA_ACCEPTANCE_UGUI
            UiPress press = state as UiPress;
            if (press == null)
                return;
            global::UnityEngine.EventSystems.PointerEventData data = press.Data;
            data.position = position;
            if (data.pointerPress != null)
                global::UnityEngine.EventSystems.ExecuteEvents.Execute(data.pointerPress, data, global::UnityEngine.EventSystems.ExecuteEvents.pointerUpHandler);
            global::UnityEngine.GameObject clicked = global::UnityEngine.EventSystems.ExecuteEvents.GetEventHandler<global::UnityEngine.EventSystems.IPointerClickHandler>(press.Target);
            if (data.eligibleForClick && clicked != null && clicked == data.pointerPress)
                global::UnityEngine.EventSystems.ExecuteEvents.Execute(clicked, data, global::UnityEngine.EventSystems.ExecuteEvents.pointerClickHandler);
            if (data.dragging && data.pointerDrag != null)
            {
                global::UnityEngine.GameObject over = RaycastTop(global::UnityEngine.EventSystems.EventSystem.current, data);
                if (over != null)
                    global::UnityEngine.EventSystems.ExecuteEvents.ExecuteHierarchy(over, data, global::UnityEngine.EventSystems.ExecuteEvents.dropHandler);
                global::UnityEngine.EventSystems.ExecuteEvents.Execute(data.pointerDrag, data, global::UnityEngine.EventSystems.ExecuteEvents.endDragHandler);
            }
            global::UnityEngine.EventSystems.ExecuteEvents.ExecuteHierarchy(press.Target, data, global::UnityEngine.EventSystems.ExecuteEvents.pointerExitHandler);
#endif
        }
    }
}
`);

// =============================================================================
// THE PROJECT: PACKAGES, INPUT, ASSEMBLIES
// =============================================================================

const SKIPPED_DIRS = new Set(["node_modules"]);
/** Bounds a scan of a very large project; a project this size is still read, just not past this many files. */
const MAX_SCANNED_FILES = 60_000;

const toPosix = (path: string): string => path.split(sep).join("/");
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function readText(path: string, maxBytes = 2_000_000): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return stripBom(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every file under `startRel` (project-relative, "/"-separated), the way Unity sees the tree: hidden and `~` folders skipped. */
function walkProject(root: string, startRel: string, visit: (rel: string, abs: string) => void, skipRel?: (rel: string) => boolean): void {
  const seen = new Set<string>();
  let count = 0;
  const walk = (abs: string, rel: string): void => {
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (count >= MAX_SCANNED_FILES) return;
      if (name.startsWith(".") || name.endsWith("~") || SKIPPED_DIRS.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = `${rel}/${name}`;
      if (skipRel?.(childRel)) continue;
      let stat: Stats;
      try {
        stat = statSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(childAbs, childRel);
      else if (stat.isFile()) {
        count++;
        visit(childRel, childAbs);
      }
    }
  };
  walk(join(root, ...startRel.split("/")), startRel);
}

const insideAcceptanceDir = (rel: string): boolean => rel === ACCEPTANCE_DIR || rel.startsWith(`${ACCEPTANCE_DIR}/`);

/** Package names the project depends on, directly or through another package. */
function projectPackages(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of ["manifest.json", "packages-lock.json"]) {
    const text = readText(join(root, "Packages", file));
    if (text === undefined) continue;
    try {
      const deps = (JSON.parse(text) as { dependencies?: unknown }).dependencies;
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
    } catch {
      // An unreadable manifest names no package; Unity would not open the project either.
    }
  }
  return names;
}

export type InputRoute = "input-system" | "event-system" | "none";

export interface InputInjection {
  /** How the harness's Tap/Drag/Press reach the game in this project. */
  readonly route: InputRoute;
  readonly inputSystemPackage: boolean;
  readonly ugui: boolean;
  /** ProjectSettings' active input handling; absent when ProjectSettings could not be read. */
  readonly activeInputHandler?: "old" | "new" | "both";
  readonly detail: string;
}

/**
 * How input can be injected into this project, from Packages/manifest.json
 * and ProjectSettings. Input System device events reach both gameplay code and
 * the Input System UI module; without them only EventSystem pointer events
 * remain, which reach UI and raycast-hit objects but never code polling the
 * old Input Manager.
 */
export function detectInputInjection(projectRoot: string): InputInjection {
  const root = resolve(projectRoot);
  const packages = projectPackages(root);
  const inputSystemPackage = packages.has("com.unity.inputsystem");
  const ugui = packages.has("com.unity.ugui");
  const settings = readText(join(root, "ProjectSettings", "ProjectSettings.asset"), 20_000_000);
  let activeInputHandler: InputInjection["activeInputHandler"];
  if (settings !== undefined) {
    const value = /^\s*activeInputHandler:\s*(\d+)\s*$/m.exec(settings)?.[1];
    activeInputHandler = value === "1" ? "new" : value === "2" ? "both" : "old";
  }
  if (inputSystemPackage && activeInputHandler !== "old") {
    return {
      route: "input-system",
      inputSystemPackage,
      ugui,
      ...(activeInputHandler ? { activeInputHandler } : {}),
      detail: "Input System device events (a mouse, or the touchscreen when it is the only pointer); gameplay code and the Input System UI module both see them",
    };
  }
  if (ugui) {
    return {
      route: "event-system",
      inputSystemPackage,
      ugui,
      ...(activeInputHandler ? { activeInputHandler } : {}),
      detail: inputSystemPackage
        ? "the Input System package is installed but the project's active input handling is the old Input Manager, which a test cannot drive: only EventSystem pointer events, which reach UI and objects a raycaster hits, never code polling UnityEngine.Input"
        : "the old Input Manager, which a test cannot drive: only EventSystem pointer events, which reach UI and objects a raycaster hits, never code polling UnityEngine.Input",
    };
  }
  return {
    route: "none",
    inputSystemPackage,
    ugui,
    ...(activeInputHandler ? { activeInputHandler } : {}),
    detail: "no input can be injected: the project has neither the Input System package with the new input handling enabled nor uGUI's EventSystem",
  };
}

const TEST_RUNNER_REFERENCES = new Set([
  "UnityEngine.TestRunner",
  "UnityEditor.TestRunner",
  "GUID:27619889b8ba8c24980f49ee34dbb44a",
  "GUID:0acc523941302664db1f4e527237feb3",
]);

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Why an asmdef is not a runtime assembly a PlayMode test may reference, or undefined when it is one. */
function notRuntimeBecause(rel: string, name: string, json: Record<string, unknown>): string | undefined {
  const folders = rel.split("/").slice(0, -1);
  if (folders.some((f) => f.toLowerCase() === "editor")) return "under an Editor folder";
  const include = stringsOf(json["includePlatforms"]);
  if (include.length === 1 && include[0] === "Editor") return "editor-only";
  if ((include.length > 0 && !include.includes("Editor")) || stringsOf(json["excludePlatforms"]).includes("Editor")) return "not built for the editor";
  if (stringsOf(json["defineConstraints"]).includes("UNITY_INCLUDE_TESTS")) return "a test assembly (UNITY_INCLUDE_TESTS)";
  if (stringsOf(json["references"]).some((r) => TEST_RUNNER_REFERENCES.has(r))) return "a test assembly (references the test runner)";
  if (stringsOf(json["precompiledReferences"]).some((p) => p.toLowerCase() === "nunit.framework.dll")) return "a test assembly (references NUnit)";
  if (stringsOf(json["optionalUnityReferences"]).includes("TestAssemblies")) return "a test assembly";
  if (folders.some((f) => /^tests?$/i.test(f))) return "under a Tests folder";
  if (name.split(".").some((p) => /^(?:tests?|editor)$/i.test(p))) return "named as a test or editor assembly";
  return undefined;
}

interface AssemblyScan {
  /** The game's runtime assemblies: what a check observes. */
  readonly runtime: Array<{ name: string; path: string }>;
  readonly excluded: Array<{ name: string; path: string; why: string }>;
  /** Folder → the assembly its scripts compile into, and whether that is one of `runtime`. */
  readonly owners: Map<string, { name: string; game: boolean }>;
  /** Strada.Core's own asmdef is under Assets (a vendored copy rather than a package). */
  readonly frameworkInAssets: boolean;
}

function scanAssemblies(root: string): AssemblyScan {
  const runtime: Array<{ name: string; path: string }> = [];
  const excluded: Array<{ name: string; path: string; why: string }> = [];
  const owners = new Map<string, { name: string; game: boolean }>();
  const refs: Array<{ dir: string; reference: string }> = [];
  let frameworkInAssets = false;
  walkProject(
    root,
    "Assets",
    (rel, abs) => {
      const isAsmdef = rel.endsWith(".asmdef");
      if (!isAsmdef && !rel.endsWith(".asmref")) return;
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(readText(abs) ?? "") as Record<string, unknown>;
      } catch {
        excluded.push({ name: rel, path: rel, why: "unreadable JSON" });
        return;
      }
      if (!isAsmdef) {
        refs.push({ dir, reference: typeof json["reference"] === "string" ? json["reference"] : "" });
        return;
      }
      const name = typeof json["name"] === "string" ? json["name"].trim() : "";
      if (name === "") {
        excluded.push({ name: rel, path: rel, why: "no assembly name" });
        return;
      }
      const why = notRuntimeBecause(rel, name, json);
      // The framework is referenced by name below; it is not the game.
      const framework = /^Strada\.Core(?:\.|$)/.test(name);
      if (name === "Strada.Core") frameworkInAssets = true;
      if (why) excluded.push({ name, path: rel, why });
      else if (!framework && name !== ACCEPTANCE_ASSEMBLY_NAME) runtime.push({ name, path: rel });
      owners.set(dir, { name, game: !why && !framework });
    },
    insideAcceptanceDir,
  );
  const runtimeNames = new Set(runtime.map((a) => a.name));
  for (const { dir, reference } of refs) owners.set(dir, { name: reference, game: runtimeNames.has(reference) });
  runtime.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const unique = runtime.filter((a, i) => i === 0 || runtime[i - 1]!.name !== a.name);
  return { runtime: unique, excluded, owners, frameworkInAssets };
}

export interface AcceptanceAssemblyPlan {
  /** The rendered Strada.Acceptance.asmdef. */
  readonly asmdef: string;
  readonly references: readonly string[];
  /** The game's runtime assemblies it references. */
  readonly runtime: ReadonlyArray<{ name: string; path: string }>;
  /** Assemblies left out, and why (Editor, tests, unreadable). */
  readonly excluded: ReadonlyArray<{ name: string; path: string; why: string }>;
  /** Set when no check could be built or observe the game here: the rows are unmeasurable, not red. */
  readonly refusal?: AcceptanceRefusal;
}

/** Strada.Acceptance.asmdef for these references; everything else in it is fixed. */
export function renderAcceptanceAsmdef(references: readonly string[]): string {
  return `${JSON.stringify(
    {
      name: ACCEPTANCE_ASSEMBLY_NAME,
      rootNamespace: ACCEPTANCE_TEST_NAMESPACE,
      references,
      includePlatforms: [],
      excludePlatforms: [],
      allowUnsafeCode: false,
      overrideReferences: true,
      precompiledReferences: ["nunit.framework.dll"],
      autoReferenced: false,
      defineConstraints: ["UNITY_INCLUDE_TESTS"],
      versionDefines: VERSION_DEFINES,
      noEngineReferences: false,
    },
    null,
    4,
  )}\n`;
}

/** An asmdef the system rendered for some set of references: a plan from before the project's assemblies changed. */
function isRenderedAsmdef(text: string): boolean {
  try {
    const references = (JSON.parse(text) as { references?: unknown }).references;
    return Array.isArray(references) && references.every((r) => typeof r === "string") && renderAcceptanceAsmdef(references) === text;
  } catch {
    return false;
  }
}

/**
 * The acceptance assembly for this project, from its asmdefs as they are now
 * (a worker may have added a module since the last run). It references the
 * game's runtime assemblies — never an Editor or test assembly, so a check
 * cannot call a worker's test helpers — plus Strada.Core, the test runner, and
 * the Input System and uGUI when the project has them. A test asmdef cannot
 * reference Assembly-CSharp, so a game with no runtime asmdef cannot be
 * observed at all, and a project without Strada.Core cannot build the harness.
 */
export function planAcceptanceAssembly(projectRoot: string): AcceptanceAssemblyPlan {
  const root = resolve(projectRoot);
  const scan = scanAssemblies(root);
  const packages = projectPackages(root);
  const references = [
    "Strada.Core",
    "UnityEngine.TestRunner",
    ...scan.runtime.map((a) => a.name),
    ...(packages.has("com.unity.inputsystem") ? ["Unity.InputSystem"] : []),
    ...(packages.has("com.unity.ugui") ? ["UnityEngine.UI"] : []),
  ];
  const refusal: AcceptanceRefusal | undefined = !packages.has("com.strada.core") && !scan.frameworkInAssets
    ? {
        kind: "no-assembly",
        detail: "the project has no Strada.Core (no com.strada.core package and no Strada.Core asmdef under Assets/), which the acceptance harness reads the game through",
      }
    : scan.runtime.length === 0
      ? {
          kind: "no-assembly",
          detail:
            "the game has no runtime assembly definition under Assets/ that a test assembly can reference (scripts in Assembly-CSharp cannot be referenced), so no acceptance check can observe it",
        }
      : undefined;
  return {
    asmdef: renderAcceptanceAsmdef(references),
    references,
    runtime: scan.runtime,
    excluded: scan.excluded,
    ...(refusal ? { refusal } : {}),
  };
}

// =============================================================================
// THE FILES ON DISK
// =============================================================================

/** A .meta GUID that is the same on every machine and every write: sha256("strada-acceptance:" + path), 32 hex. */
export function acceptanceGuid(path: string): string {
  return sha256(`strada-acceptance:${path}`).slice(0, 32);
}

/** Unity's own spelling of an asmdef's meta; a DefaultImporter one would be rewritten on import. */
function asmdefMeta(guid: string): string {
  return ["fileFormatVersion: 2", `guid: ${guid}`, "AssemblyDefinitionImporter:", "  externalObjects: {}", "  userData: ", "  assetBundleName: ", "  assetBundleVariant: ", ""].join("\n");
}

/** What the harness adds to the stored milestone files: its assembly and its fixture. */
export interface AcceptanceHarness {
  /** Defaults to `planAcceptanceAssembly(projectRoot).asmdef`: the project's assemblies as they are now. */
  readonly asmdef?: string;
  /** Defaults to ACCEPTANCE_FIXTURE_SOURCE. */
  readonly fixture?: string;
}

export type AcceptanceMaterializeMode = "committed" | "ephemeral";

export interface AcceptanceSyncResult {
  /**
   * Files that differed from the stored bytes, were not stored, or (committed
   * checks) were missing — all put right. Not metas, and not a file the system
   * itself wrote in another version (its stamp matches): those are refreshed.
   * From `restoreAcceptance`, also files outside the folder that could answer
   * for a check: left as they are, and reported until they are gone.
   */
  readonly tamper: string[];
  /** Every path written, metas included. */
  readonly written: string[];
  /** Every path removed because it is not stored. */
  readonly deleted: string[];
}

const STORED_FILE_RE = new RegExp(`^${ACCEPTANCE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[A-Za-z0-9_]+\\.cs$`);

/** Every byte the acceptance folder may hold in this project, by project-relative path, metas included. */
export function acceptanceFileSet(projectRoot: string, sources: readonly AcceptanceSource[], harness: AcceptanceHarness = {}): Map<string, string> {
  const files = new Map<string, string>();
  files.set(`${ACCEPTANCE_DIR}.meta`, generateFolderMetaContent(acceptanceGuid(ACCEPTANCE_DIR)));
  files.set(ACCEPTANCE_FIXTURE_PATH, harness.fixture ?? ACCEPTANCE_FIXTURE_SOURCE);
  files.set(`${ACCEPTANCE_FIXTURE_PATH}.meta`, generateMetaContent(acceptanceGuid(ACCEPTANCE_FIXTURE_PATH), ".cs"));
  files.set(ACCEPTANCE_ASMDEF_PATH, harness.asmdef ?? planAcceptanceAssembly(projectRoot).asmdef);
  files.set(`${ACCEPTANCE_ASMDEF_PATH}.meta`, asmdefMeta(acceptanceGuid(ACCEPTANCE_ASMDEF_PATH)));
  for (const source of sources) {
    if (!STORED_FILE_RE.test(source.path)) throw new Error(`stored acceptance file ${JSON.stringify(source.path)} is not a .cs file directly under ${ACCEPTANCE_DIR}`);
    if (files.has(source.path)) throw new Error(`stored acceptance file ${source.path} is stored twice, or overwrites the harness`);
    if (sha256(source.source) !== source.sha256) throw new Error(`stored acceptance file ${source.path} does not match its sha256: the stored bytes are damaged`);
    files.set(source.path, source.source);
    files.set(`${source.path}.meta`, generateMetaContent(acceptanceGuid(source.path), ".cs"));
  }
  return files;
}

const absOf = (root: string, rel: string): string => join(root, ...rel.split("/"));

function unityRoot(projectRoot: string): string {
  const root = resolve(projectRoot);
  if (!lstatOf(join(root, "Assets"))) throw new Error(`${root} is not a Unity project: it has no Assets folder`);
  return root;
}

/** A checkout's line endings are not an edit: Git for Windows (core.autocrlf=true) writes the committed checks back with CRLF. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/**
 * Bytes in the folder that only the system writes, whatever their line
 * endings: the canonical ones, a stamped C# file, or an asmdef it rendered
 * for an older plan.
 */
function systemWrote(rel: string, abs: string, canonical?: string): boolean {
  const raw = readText(abs);
  if (raw === undefined) return false;
  const text = lf(raw);
  if (canonical !== undefined && text === lf(canonical)) return true;
  return rel === ACCEPTANCE_ASMDEF_PATH ? isRenderedAsmdef(text) : rel.endsWith(".cs") && carriesOwnStamp(text);
}

/**
 * Make the acceptance folder hold exactly `files`. Nothing is written through
 * a symlink: a folder or file swapped for one is removed and recreated. A
 * changed .meta is put right silently — Unity rewrites metas itself, and a
 * meta cannot change what a test asserts.
 */
function syncAcceptance(projectRoot: string, files: ReadonlyMap<string, string>, missingIsTamper: boolean): AcceptanceSyncResult {
  const root = unityRoot(projectRoot);
  const tamper: string[] = [];
  const written: string[] = [];
  const deleted: string[] = [];
  const isMeta = (rel: string): boolean => rel.endsWith(".meta");
  const isTamper = (rel: string, abs: string, canonical?: string): boolean => !isMeta(rel) && !systemWrote(rel, abs, canonical);

  const dirAbs = absOf(root, ACCEPTANCE_DIR);
  const dirStat = lstatOf(dirAbs);
  if (dirStat && !dirStat.isDirectory()) {
    unlinkSync(dirAbs);
    deleted.push(ACCEPTANCE_DIR);
    tamper.push(ACCEPTANCE_DIR);
  }
  mkdirSync(dirAbs, { recursive: true });

  const recordForeign = (abs: string, rel: string): void => {
    const stat = lstatOf(abs);
    if (stat?.isDirectory()) {
      for (const name of readdirSync(abs).sort()) recordForeign(join(abs, name), `${rel}/${name}`);
    } else if (!isMeta(rel)) tamper.push(rel);
  };
  for (const name of readdirSync(dirAbs).sort()) {
    const rel = `${ACCEPTANCE_DIR}/${name}`;
    const abs = join(dirAbs, name);
    const stat = lstatOf(abs);
    if (!stat) continue;
    if (stat.isDirectory()) {
      recordForeign(abs, rel);
      rmSync(abs, { recursive: true, force: true });
      deleted.push(rel);
    } else if (!files.has(rel)) {
      // A check the store no longer holds (a waived or renamed milestone) is the system's own.
      if (!stat.isFile() ? !isMeta(rel) : isTamper(rel, abs)) tamper.push(rel);
      unlinkSync(abs);
      deleted.push(rel);
    }
  }

  for (const [rel, text] of files) {
    const abs = absOf(root, rel);
    const stat = lstatOf(abs);
    const bytes = Buffer.from(text, "utf8");
    if (stat?.isFile()) {
      if (readFileSync(abs).equals(bytes)) continue;
      // Still rewritten: the canonical bytes are LF, whatever the checkout made of them.
      if (isTamper(rel, abs, text)) tamper.push(rel);
    } else if (stat) {
      rmSync(abs, { recursive: true, force: true });
      if (!isMeta(rel)) tamper.push(rel);
    } else if (missingIsTamper && !isMeta(rel)) tamper.push(rel);
    writeFileSync(abs, bytes);
    written.push(rel);
  }
  return { tamper: [...new Set(tamper)].sort(), written: written.sort(), deleted: deleted.sort() };
}

const EXCLUDE_BEGIN = "# >>> strada-acceptance: ephemeral checks, removed with them";
const EXCLUDE_END = "# <<< strada-acceptance";

/** The git exclude file that governs this project, and the project's path inside its repository. */
function gitExcludeFor(root: string): { exclude: string; prefix: string } | undefined {
  let dir = root;
  for (;;) {
    const dotGit = join(dir, ".git");
    let gitDir: string | undefined;
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) gitDir = dotGit;
      else if (stat.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (target) gitDir = resolve(dir, target);
      }
    } catch {
      // No .git here; look further up.
    }
    if (gitDir) {
      // A linked worktree reads info/exclude from the common git dir, not its own.
      let common = gitDir;
      try {
        common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // Not a linked worktree.
      }
      return { exclude: join(common, "info", "exclude"), prefix: toPosix(relative(dir, root)) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function withoutExcludeBlock(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line === EXCLUDE_BEGIN) inside = true;
    else if (inside) {
      if (line === EXCLUDE_END) inside = false;
    } else kept.push(line);
  }
  return kept.join("\n");
}

/** Ephemeral checks are kept out of git through info/exclude; committed checks never are. Returns whether the file changed. */
function setEphemeralExclude(root: string, on: boolean): boolean {
  const git = gitExcludeFor(root);
  if (!git) return false;
  let text = "";
  try {
    text = readFileSync(git.exclude, "utf8");
  } catch {
    // No exclude file yet.
  }
  const base = withoutExcludeBlock(text);
  const prefix = git.prefix === "" ? "/" : `/${git.prefix.replace(/[*?[\\]/g, "\\$&")}/`;
  const block = [EXCLUDE_BEGIN, `${prefix}${ACCEPTANCE_DIR}/`, `${prefix}${ACCEPTANCE_DIR}.meta`, EXCLUDE_END].join("\n");
  const next = on ? `${base}${base === "" || base.endsWith("\n") ? "" : "\n"}${block}\n` : base;
  if (next === text) return false;
  mkdirSync(dirname(git.exclude), { recursive: true });
  writeFileSync(git.exclude, next);
  return true;
}

/**
 * Write the stored checks and the harness into the project: the system
 * changing the set (first write, a regeneration, a waiver). `committed`: the
 * caller commits them (a `campaign:` commit). `ephemeral`: they are kept out
 * of git before they exist, and `removeEphemeral` takes them away after the
 * run. The result's `tamper` describes what was overwritten; judge tamper
 * from `restoreAcceptance`, called before this.
 */
export function materialize(
  projectRoot: string,
  sources: readonly AcceptanceSource[],
  mode: AcceptanceMaterializeMode,
  harness: AcceptanceHarness = {},
): AcceptanceSyncResult {
  const root = unityRoot(projectRoot);
  const files = acceptanceFileSet(root, sources, harness);
  setEphemeralExclude(root, mode === "ephemeral");
  return syncAcceptance(root, files, false);
}

/**
 * Before every commit and every measurement: write the canonical bytes over
 * any file that differs, delete what is not stored, and say what was found.
 * A missing file is tamper only for committed checks — ephemeral ones are
 * removed after every run on purpose, and are kept out of git when restored.
 * What outside the folder could answer for a check
 * (`scanForeignAcceptanceNamespace`) is tamper too, on every restore until the
 * worker removes it: the system does not rewrite or delete a worker's file.
 */
export function restoreAcceptance(
  projectRoot: string,
  sources: readonly AcceptanceSource[],
  mode: AcceptanceMaterializeMode,
  harness: AcceptanceHarness = {},
): AcceptanceSyncResult {
  const root = unityRoot(projectRoot);
  const files = acceptanceFileSet(root, sources, harness);
  setEphemeralExclude(root, mode === "ephemeral");
  const synced = syncAcceptance(root, files, mode === "committed");
  const foreign = scanForeignAcceptanceNamespace(root);
  return foreign.length === 0 ? synced : { ...synced, tamper: [...new Set([...synced.tamper, ...foreign])].sort() };
}

/** Remove ephemeral checks and their exclude lines. */
export function removeEphemeral(projectRoot: string): { removed: string[]; excludeCleared: boolean } {
  const root = resolve(projectRoot);
  const removed: string[] = [];
  for (const rel of [ACCEPTANCE_DIR, `${ACCEPTANCE_DIR}.meta`]) {
    const abs = absOf(root, rel);
    if (!lstatOf(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  return { removed, excludeCleared: setEphemeralExclude(root, false) };
}

const FOREIGN_NAMESPACE_RE = /\bnamespace\s+Strada\s*\.\s*Acceptance\b|\bnamespace\s+Strada\s*[{;][\s\S]*\bnamespace\s+Acceptance\b/;
/** A string that names a test into the namespace: NUnit's TestName/SetName on a fixture in the global namespace. */
const ACCEPTANCE_NAME_LITERAL_RE = /"\s*Strada\s*\.\s*Acceptance\s*\./g;

/**
 * A type C# would give a check's `var` local (or `dynamic`, `nint`, `nuint`):
 * these names bind to a type in scope before their own meaning, wherever in
 * Strada or the global namespace it sits.
 */
const TYPE_LIKE_DECLARATION_RE = /\b(?:class|struct|interface|enum|record)\s+(?:var|dynamic|nint|nuint)\b/;
/** A delegate's name is the one before its parameters (and type parameters); the words before it are its return type. */
const TYPE_LIKE_DELEGATE_RE = /\bdelegate\b[^;{}]*?\b(?:var|dynamic|nint|nuint)\s*(?:<[^;{}()]*>)?\s*\(/;

/** A namespace's header as C# spells it: any identifier letters, and space allowed around each dot. */
const NAMESPACE_HEADER_RE = /\bnamespace\s+[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+(?:\s*\.\s*[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+)*\s*$/u;

/**
 * Whether a brace sits inside an #if group. Which branch compiles decides what
 * it opens or closes (`#if UNITY_EDITOR class Kiln : Editor {` / `#else class
 * Kiln : MonoBehaviour {`), so no walk over the text can say what is nested.
 */
function bracesUnderConditional(code: string): boolean {
  let depth = 0;
  for (const line of code.split("\n")) {
    const directive = /^[ \t]*#[ \t]*(if|elif|else|endif)\b/.exec(line);
    if (directive) {
      if (directive[1] === "if") depth++;
      else if (directive[1] === "endif") depth = Math.max(0, depth - 1);
    } else if (depth > 0 && !/^[ \t]*#/.test(line) && /[{}]/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the code declares such a type directly in a namespace or the global
 * one. A nested type is in scope only inside the type around it, and a check
 * is never inside a worker's type, so it cannot answer a check's `var`.
 *
 * FAILS CLOSED: when the nesting is not known (braces inside an #if group) or
 * the braces do not balance, a declaration anywhere in the file counts, as it
 * did before the walk. Skipping it instead let one extra frame hide every
 * namespace-level `struct nint` after it.
 */
function declaresTypeLikeName(code: string, nestingKnown: boolean): boolean {
  const anywhere = (): boolean => TYPE_LIKE_DECLARATION_RE.test(code) || TYPE_LIKE_DELEGATE_RE.test(code);
  if (!nestingKnown) return anywhere();
  // Per open brace: whether it opened a namespace's body.
  const opened: boolean[] = [];
  let segment = "";
  for (const c of code) {
    if (c !== "{" && c !== "}" && c !== ";") {
      segment += c;
      continue;
    }
    const inNamespace = opened.every((namespace) => namespace);
    if (inNamespace && c !== "}" && (TYPE_LIKE_DECLARATION_RE.test(segment) || TYPE_LIKE_DELEGATE_RE.test(segment))) return true;
    if (c === "{") opened.push(inNamespace && NAMESPACE_HEADER_RE.test(segment));
    else if (c === "}" && opened.pop() === undefined) return anywhere();
    segment = "";
  }
  return opened.length === 0 ? false : anywhere();
}

/**
 * Identifiers as the compiler reads them: a verbatim `@Strada`, one spelled
 * with Unicode escapes, or one carrying a soft hyphen or a zero-width
 * character (Roslyn drops formatting characters from a name) is `Strada`.
 */
function identifierSpelling(code: string): string {
  return code
    .replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (escape, four?: string, eight?: string) => {
      const cp = parseInt(four ?? eight ?? "", 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : escape;
    })
    .replace(FORMATTING_CHARS, "")
    .replace(/@(?=[A-Za-z_])/g, "");
}

/** An asmref that compiles its folder into the acceptance assembly: by name, or by the GUID: of its asmdef. */
function targetsAcceptanceAssembly(text: string): boolean {
  const name = ACCEPTANCE_ASSEMBLY_NAME.toLowerCase();
  const guid = acceptanceGuid(ACCEPTANCE_ASMDEF_PATH);
  try {
    const reference = (JSON.parse(text) as { reference?: unknown }).reference;
    const value = typeof reference === "string" ? reference.trim().toLowerCase() : "";
    return value === name || value === `guid:${guid}`;
  } catch {
    // Unity's reader is not JSON.parse: an asmref it might still read is judged by what it names.
    const lower = text.toLowerCase();
    return lower.includes(name) || lower.includes(guid);
  }
}

/**
 * What outside the system's folder could answer for an acceptance test: C#
 * that declares the acceptance namespace or names a test into it (a test
 * carrying an acceptance test's full name from an assembly the system does
 * not own), C# that declares a type a check's `var` would bind to, and an
 * .asmref that compiles its folder into the acceptance assembly itself, where
 * its types are found even before a name spelled from the root. Each hit is
 * tamper — `restoreAcceptance` reports it — but restore cannot put it right,
 * because the file is the worker's.
 */
export function scanForeignAcceptanceNamespace(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const hits: string[] = [];
  for (const top of ["Assets", "Packages"]) {
    walkProject(
      root,
      top,
      (rel, abs) => {
        const asmref = rel.endsWith(".asmref");
        if (!asmref && !rel.endsWith(".cs")) return;
        const text = readText(abs);
        if (text === undefined) return;
        if (asmref) {
          if (targetsAcceptanceAssembly(text)) hits.push(rel);
          return;
        }
        const code = scanCSharp(text).code;
        // The scan keeps a literal's quotes and blanks comments, so a quote that survives it opens a string.
        const named = [...text.matchAll(ACCEPTANCE_NAME_LITERAL_RE)].some((m) => code[m.index] === '"');
        const spelled = identifierSpelling(withoutDirectives(code));
        if (named || FOREIGN_NAMESPACE_RE.test(spelled) || declaresTypeLikeName(spelled, !bracesUnderConditional(code))) hits.push(rel);
      },
      insideAcceptanceDir,
    );
  }
  return hits.sort();
}

// =============================================================================
// THE LINT
// =============================================================================

export interface AcceptanceLintResult {
  readonly ok: boolean;
  /** One sentence each, for the writer's regeneration prompt. */
  readonly problems: string[];
}

/** Constructs no acceptance body may contain, wherever it sits; matched on code with comments and literal text blanked. */
const FORBIDDEN: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  { re: /\bAssert\s*\.\s*(?:Pass|Ignore|Inconclusive|Warn)\b/, why: "Assert.Pass, Assert.Ignore, Assert.Inconclusive and Assert.Warn end a test without judging the game" },
  // What Assert.Pass/Ignore/Inconclusive throw; thrown directly they end the test the same way.
  { re: /\b(?:Success|Ignore|Inconclusive)Exception\b/, why: "SuccessException, IgnoreException and InconclusiveException end a test without judging the game" },
  { re: /\bAssume\s*\./, why: "Assume turns a failure into an inconclusive result" },
  { re: /\bWarn\s*\.\s*(?:If|Unless)\b/, why: "Warn.If/Warn.Unless never fail" },
  { re: /\[[^[\]]*\b(?:Ignore|Explicit|Category)(?:Attribute)?\b[^[\]]*\]|\b(?:Ignore|Explicit|Category)Attribute\b/, why: "[Ignore], [Explicit] and [Category] change which tests run; the system sets the attributes" },
  { re: /\bcatch\b/, why: "catch can swallow the failure the test exists to report" },
  { re: /^[ \t]*#/m, why: "preprocessor directives (#if …) compile a different test than the one reviewed" },
  { re: /\bSystem\s*\.\s*IO\b/, why: "System.IO: a check reads the game, not files" },
  { re: /\bSystem\s*\.\s*Diagnostics\s*\.\s*Process\b|\bProcess\s*\.\s*(?:Start|GetCurrentProcess|GetProcesses\w*)\b|\bnew\s+Process\s*\(|\bProcessStartInfo\b/, why: "Process: a check does not start or stop processes" },
  { re: /\bApplication\s*\.\s*Quit\b|\bEnvironment\s*\.\s*(?:Exit|FailFast)\b/, why: "quitting ends the whole run" },
  { re: /\bUnityEditor\b/, why: "UnityEditor: a check reads the running game; the editor's API can stop play mode or edit assets" },
  { re: /\bignoreFailingMessages\b/, why: "LogAssert.ignoreFailingMessages hides the errors the game logs" },
  { re: /\byield\s+break\b/, why: "yield break ends the test before it judges anything" },
  { re: /\.\s*Act\s*\(/, why: ".Act( drives the game through its play-through driver, not as a player" },
  { re: /\bIPlaythroughDriver\b/, why: "IPlaythroughDriver: read the game through the harness's read-only Driver" },
  { re: /\b(?:GetMethods?|GetPropert(?:y|ies)|GetFields?|GetMembers?)\s*\([\s\S]*\.\s*(?:Invoke|SetValue|GetValue)\s*\(/, why: "reflection invocation reaches past the public surface the check was written against" },
];

/** Harness coroutines: called without `yield return`, they never run. */
const HARNESS_COROUTINES = ["Boot", "Frames", "Seconds", "Until", "StartSessionForSetup", "TapViewport", "TapScreen", "TapObject", "Drag", "Press"];
const HARNESS_CALL_RE = new RegExp(`(?<![\\w.])(${HARNESS_COROUTINES.join("|")})\\s*\\(`, "g");
const PLAYER_INPUT_RE = /(?<![\w.])(?:TapViewport|TapScreen|TapObject|Drag|Press)\s*\(/;

const ASSERT_CALL_RE = /\b(Assert|CollectionAssert|StringAssert)\s*\.\s*([A-Za-z_]\w*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/g;
/** How many leading arguments of an assertion are its subject; absent: no subject to judge (Fail, Throws, Multiple). */
const SUBJECT_ARGS: Record<string, number> = {
  That: 1, IsTrue: 1, True: 1, IsFalse: 1, False: 1, IsNull: 1, Null: 1, IsNotNull: 1, NotNull: 1,
  IsEmpty: 1, IsNotEmpty: 1, IsNaN: 1, Zero: 1, NotZero: 1, Positive: 1, Negative: 1,
  IsInstanceOf: 1, IsNotInstanceOf: 1, IsAssignableFrom: 1, IsNotAssignableFrom: 1,
  AreEqual: 2, AreNotEqual: 2, AreSame: 2, AreNotSame: 2, Greater: 2, GreaterOrEqual: 2, Less: 2, LessOrEqual: 2, Contains: 2,
};
const NO_SUBJECT = new Set(["Fail", "Throws", "ThrowsAsync", "Catch", "CatchAsync", "DoesNotThrow", "DoesNotThrowAsync", "Multiple", "MultipleAsync"]);

// A check spells types from the root, so `global::System.Int32.MaxValue` and `global::UnityEngine.Mathf.PI` are the literals `int.MaxValue` and `Mathf.PI` are.
const LITERAL_RE =
  /^(?:@?\$?@?"[^"{}]*"|'[^']*'|(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)(?:[fFdDmM]|[uU][lL]?|[lL][uU]?)?|true|false|null|default|(?:string|int|float|double|long|short|byte|decimal|char|(?:global\s*::\s*)?(?:System\s*\.\s*)?(?:String|Int16|Int32|Int64|Single|Double|Decimal|Byte|Char)|(?:global\s*::\s*UnityEngine\s*\.\s*)?Mathf)\s*\.\s*\w+)$/;
const REFLECTION_CALL_RE =
  /\.\s*(?:GetType|GetMethods?|GetInterfaces?|IsAssignableFrom|IsSubclassOf|IsInstanceOfType|GetPropert(?:y|ies)|GetFields?|GetMembers?|GetCustomAttributes?|IsDefined|GetConstructors?|GetEvents?|GetNestedTypes?|GetGenericArguments)\s*\(/;
/** A type as a check spells it: from the root, generic, array, nullable. */
const TYPE_SPELLING = String.raw`(?:global\s*::\s*)?[A-Za-z_][\w.]*(?:<[\w\s.,<>[\]?:]*>)?(?:\[\s*\])*\??`;
const LOCAL_RE = new RegExp(String.raw`(?:^|[;{}])\s*(?:var|${TYPE_SPELLING})\s+([A-Za-z_]\w*)\s*=(?![=>])([^;]*);`, "g");
const CAST_RE = new RegExp(String.raw`^\(\s*${TYPE_SPELLING}\s*\)\s*`);

type SubjectKind = "literal" | "reflection" | "observation";

/** What an expression is made of: only literals, only reflection and literals, or an observation of the game. */
function subjectKind(expr: string, locals: ReadonlyMap<string, string>, depth = 0): SubjectKind {
  const kinds = splitTopLevel(expr, "operators").map((op) => operandKind(op, locals, depth));
  if (kinds.every((k) => k === "literal")) return "literal";
  return kinds.every((k) => k !== "observation") ? "reflection" : "observation";
}

function operandKind(operand: string, locals: ReadonlyMap<string, string>, depth: number): SubjectKind {
  let s = operand.trim();
  while (/^[!~+-]/.test(s)) s = s.slice(1).trim();
  if (s === "" || depth > 6) return "literal";
  if (s.startsWith("(") && matchingClose(s, 0) === s.length - 1) return subjectKind(s.slice(1, -1), locals, depth + 1);
  const cast = CAST_RE.exec(s);
  if (cast && /^[\w(@"'$!]/.test(s.slice(cast[0].length))) return operandKind(s.slice(cast[0].length), locals, depth + 1);
  if (LITERAL_RE.test(s) || /^nameof\s*\(/.test(s) || /^@?"[^"{}]*"\s*\./.test(s)) return "literal";
  const flat = blankGroups(s);
  if (/^typeof\s*\(/.test(flat) || REFLECTION_CALL_RE.test(flat)) return "reflection";
  const local = /^[A-Za-z_]\w*$/.test(s) ? locals.get(s) : undefined;
  if (local !== undefined) return subjectKind(local, locals, depth + 1);
  return "observation";
}

/** Brackets that never close what they did not open and all close: a part is statements inside the test method, nothing more. */
function balanced(code: string): boolean {
  const stack: string[] = [];
  for (const c of code) {
    if (OPENERS[c]) stack.push(OPENERS[c]!);
    else if (CLOSERS.has(c) && stack.pop() !== c) return false;
  }
  return stack.length === 0;
}

/**
 * Whether a writer's check may run. It refuses what cannot fail or what does
 * not test the game: forbidden constructs, an assertion on reflection or
 * literals alone (the measured campaign's P1 guardrail asserted
 * `typeof(IX).GetMethods().Length == 1`), a harness coroutine that is never
 * yielded, a part that escapes its method, an input row that does not act
 * through the harness, a numeric row that writes its own assertion.
 */
export function lintAcceptanceBody(row: RequirementRow, check: AcceptanceCheckBody): AcceptanceLintResult {
  const problems: string[] = [];
  const add = (problem: string): void => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  if (check.rid !== row.rid) add(`the check answers rid ${check.rid}, not this row's ${row.rid}`);

  const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";
  const parts = (["setup", "act", "observe", "body"] as const).filter((k) => present(check[k])).map((k) => ({ key: k, raw: check[k]! }));
  const numeric = systemAssertsRow(row);
  if (numeric) {
    if (!present(check.observe)) add("this row's numbers come from the GDD: return `observe`, one C# expression whose value (in the row's unit) the system asserts against the GDD's bounds");
    if (present(check.body) || present(check.act)) add("a row with GDD bounds takes only `observe` (and an optional `setup`); the system writes its assertion");
  } else {
    if (present(check.observe)) add("only a constant or range row with GDD bounds takes `observe`; this row needs a `body` that asserts");
    if (!present(check.body)) add("return a `body`: statements that end in an assertion about the game");
  }

  const scanned = parts.map((p) => {
    const scan = scanCSharp(p.raw);
    if (scan.error) add(`\`${p.key}\` has ${scan.error}`);
    if (!balanced(scan.code)) add(`\`${p.key}\` does not balance its braces, brackets and parentheses: a part is statements inside the test method, nothing more`);
    if (p.raw.includes(`${HARNESS_FAULT_TAG}:`)) add(`the "[${HARNESS_FAULT_TAG}:…]" tag marks the harness's own faults; a check may not write it`);
    return { ...p, code: scan.code };
  });
  const code = scanned.map((p) => p.code).join("\n");

  for (const { re, why } of FORBIDDEN) if (re.test(code)) add(why);

  const bare = unrootedNames(parts.map((p) => p.raw).join("\n"), { allowed: ACCEPTANCE_HARNESS_MEMBERS, varAllowed: true, calls: INHERITED_CALLS });
  if (bare.length > 0) {
    const named = bare.slice(0, 8).map((n) => `\`${n}\``).join(", ") + (bare.length > 8 ? ", …" : "");
    add(
      `${named}: a bare name may only be a local, a lambda parameter or a harness member — spell every type and namespace from the root ` +
        "(global::NUnit.Framework.Is, global::UnityEngine.Vector2, the game's global::Namespace.Type): a game namespace or a type declared " +
        "outside the system's folder could answer a bare one",
    );
  }

  const lines = parts.reduce((n, p) => n + p.raw.split(CS_LINE_BREAK).length, 0);
  if (lines > MAX_ACCEPTANCE_BODY_LINES) add(`the check is ${lines} lines; at most ${MAX_ACCEPTANCE_BODY_LINES}`);

  for (const match of code.matchAll(HARNESS_CALL_RE)) {
    if (!/\byield\s+return\s*$/.test(code.slice(0, match.index))) add(`${match[1]}(…) is a coroutine: write \`yield return ${match[1]}(…);\` or it never runs`);
  }

  const locals = new Map<string, string>();
  for (const match of code.matchAll(LOCAL_RE)) locals.set(match[1]!, match[2]!);

  if (numeric && present(check.observe)) {
    const observe = scanned.find((p) => p.key === "observe")!.code;
    if (splitTopLevel(observe, "commas").length > 1 || /;|\byield\b/.test(blankGroups(observe))) add("`observe` is one expression: no statements, no yield");
    const kind = subjectKind(observe, locals);
    if (kind === "literal") add("`observe` is literals only: it must read a value the game reports");
    if (kind === "reflection") add("`observe` is reflection only (typeof, GetType(), GetMethods() …): it must read a value the game reports");
    const statements = scanned.filter((p) => p.key === "setup").map((p) => p.code).join("\n");
    if (/\bobserved\b/.test(statements)) add("`observed` is the system's name for the observation; the setup may not use it");
  }

  let assertions = 0;
  for (const match of code.matchAll(ASSERT_CALL_RE)) {
    assertions++;
    const method = match[2]!;
    if (NO_SUBJECT.has(method)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const args = splitTopLevel(code.slice(open + 1, close), "commas");
    const subjects = args.slice(0, SUBJECT_ARGS[method] ?? (match[1] === "Assert" ? 1 : 2));
    if (subjects.length === 0) continue;
    const kinds = subjects.map((s) => subjectKind(s, locals));
    if (kinds.every((k) => k === "literal")) add(`${match[1]}.${method}(…) asserts on literals only: its subject must be something the game reports`);
    else if (kinds.every((k) => k !== "observation")) {
      add(`${match[1]}.${method}(…) asserts on reflection only (typeof, GetType(), GetMethods(), GetInterfaces, IsAssignableFrom …): that code is shaped a way is not that the game behaves the GDD's way`);
    }
  }
  if (!numeric && assertions === 0) add("the body asserts nothing: every check ends in an NUnit assertion about the game (global::NUnit.Framework.Assert.That(…))");

  if (row.kind === "input") {
    if (/\bStartSession\w*\s*\(/.test(code)) add("an input row judges what the player's input does: the session must start from that input, not from StartSession");
    if (!PLAYER_INPUT_RE.test(code)) add("an input row must perform the player's input through the harness: TapViewport, TapScreen, TapObject, Drag or Press");
  }

  return { ok: problems.length === 0, problems };
}

// =============================================================================
// WHAT THE WRITER IS SHOWN
// =============================================================================

/** The framework contracts a check reads the game through, whatever the game. */
const STRADA_PLAY_SURFACE = [
  "// Strada.Core.Play (assembly Strada.Core): the game's own report; read the driver through the harness's Driver",
  "public enum global::Strada.Core.Play.PlaythroughOutcome { None, Won, Lost, Ended }",
  "public interface global::Strada.Core.Play.IActiveSession  // Service<global::Strada.Core.Play.IActiveSession>(), when the game registers it",
  "  int ActiveSession { get; }",
  "public interface global::Strada.Core.Play.ISessionCatalog  // Service<global::Strada.Core.Play.ISessionCatalog>(), when the game registers it",
  "  int SessionCount { get; }",
].join("\n");

interface SurfaceType {
  readonly fullName: string;
  readonly text: string;
}

const TYPE_DECL_RE = /(?:^|\s)(class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/;
const NON_PUBLIC_RE = /\b(?:private|protected|internal)\b/;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const withoutAttributes = (text: string): string => text.replace(/^(?:\s*\[[^\]]*\])+/, "").trim();

/** The text before the first top-level `=` that is an initializer (not `=>`, `==`, `<=`, a default argument). */
function beforeInitializer(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "=" && depth === 0) {
      const next = text[i + 1];
      const prev = text[i - 1];
      if (next !== "=" && next !== ">" && prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">") return text.slice(0, i).trim();
    }
  }
  return text;
}

/** A member's signature: no body, no initializer; an expression-bodied property reads as `{ get; }`. */
function memberSignature(header: string): string {
  const h = beforeInitializer(squash(withoutAttributes(header)));
  const arrow = h.indexOf("=>");
  if (arrow < 0) return h;
  const left = h.slice(0, arrow).trim();
  return left.includes("(") ? left : `${left} { get; }`;
}

/** Public types and members of one C# file, by a brace-level reading of its declarations; no body text survives. */
function publicTypesOf(source: string): SurfaceType[] {
  const code = withoutDirectives(scanCSharp(source, { holeBraces: false }).code);
  type TypeCtx = { kind: "type"; fullName: string; public: boolean; interface: boolean; enumeration: boolean; header: string; members: string[] };
  type MemberCtx = { kind: "member"; owner: TypeCtx; header: string; property: boolean; accessors: string[] };
  type Ctx = { kind: "namespace"; name: string } | TypeCtx | MemberCtx | { kind: "block" };
  const stack: Ctx[] = [];
  const types: TypeCtx[] = [];
  let fileNamespace = "";
  let segment = "";

  const scopeName = (): string => {
    const names = [fileNamespace, ...stack.map((c) => (c.kind === "namespace" ? c.name : c.kind === "type" ? c.fullName.split(".").pop()! : ""))];
    return names.filter((n) => n !== "").join(".");
  };
  const top = (): Ctx | undefined => stack[stack.length - 1];
  const isPublicMember = (owner: TypeCtx, header: string): boolean => owner.public && (owner.interface ? !NON_PUBLIC_RE.test(header) : /\bpublic\b/.test(header));

  const typeDeclaration = (header: string, parent: Ctx | undefined): TypeCtx | undefined => {
    const decl = TYPE_DECL_RE.exec(header);
    if (!decl || header.slice(0, decl.index).includes("(")) return undefined;
    const name = decl[2]!;
    const scope = scopeName();
    const fullName = scope === "" ? name : `${scope}.${name}`;
    const outerPublic = parent?.kind === "type" ? parent.public : true;
    const ctx: TypeCtx = {
      kind: "type",
      fullName,
      public: outerPublic && /\bpublic\b/.test(header.slice(0, decl.index)),
      interface: /interface/.test(decl[1]!),
      enumeration: decl[1] === "enum",
      header: header.replace(new RegExp(`\\b${decl[1]!.replace(/\s+/g, "\\s+")}\\s+${name}\\b`), `${decl[1]} global::${fullName}`),
      members: [],
    };
    types.push(ctx);
    return ctx;
  };

  const open = (raw: string): void => {
    const header = squash(withoutAttributes(raw));
    const parent = top();
    if (parent === undefined || parent.kind === "namespace" || parent.kind === "type") {
      const ns = /^namespace\s+([\w.]+)$/.exec(header);
      if (ns && (parent === undefined || parent.kind === "namespace")) {
        stack.push({ kind: "namespace", name: ns[1]! });
        return;
      }
      const ctx = typeDeclaration(header, parent);
      if (ctx) {
        stack.push(ctx);
        return;
      }
      if (parent?.kind === "type" && !parent.enumeration && header !== "" && isPublicMember(parent, header)) {
        stack.push({ kind: "member", owner: parent, header, property: !header.includes("("), accessors: [] });
        return;
      }
    } else if (parent.kind === "member") {
      const accessor = /^((?:(?:private|protected|internal)\s+)*)(get|set|init|add|remove)$/.exec(header);
      if (accessor && !accessor[1]) parent.accessors.push(accessor[2]!);
    }
    stack.push({ kind: "block" });
  };

  const close = (raw: string): void => {
    const ctx = stack.pop();
    if (ctx?.kind === "type" && ctx.enumeration) {
      ctx.members.push(
        ...raw
          .split(",")
          .map((m) => squash(withoutAttributes(m)).split(/[\s=]/)[0] ?? "")
          .filter((m) => /^[A-Za-z_]\w*$/.test(m)),
      );
    } else if (ctx?.kind === "member") {
      // An initializer's or an expression body's braces (`=> new[] { … }`) are not the member's.
      const signature = memberSignature(ctx.header);
      if (signature !== ctx.header) ctx.owner.members.push(signature);
      else if (ctx.property) ctx.owner.members.push(`${ctx.header} { ${ctx.accessors.map((a) => `${a}; `).join("")}}`);
      else ctx.owner.members.push(ctx.header);
    }
  };

  const statement = (raw: string): void => {
    const parent = top();
    const header = squash(raw);
    if (header === "") return;
    if (parent === undefined || parent.kind === "namespace" || parent.kind === "type") {
      const ns = /^namespace\s+([\w.]+)$/.exec(header);
      if (ns && parent === undefined) {
        fileNamespace = ns[1]!;
        return;
      }
      // A declaration with no body: a positional record, or a delegate type.
      const decl = squash(withoutAttributes(raw));
      if (typeDeclaration(decl, parent)) return;
      const delegate = parent?.kind !== "type" ? /\bdelegate\s+.+?\s([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*\(/.exec(decl) : null;
      if (delegate && /\bpublic\b/.test(decl.slice(0, delegate.index))) {
        const name = delegate[1]!;
        const scope = scopeName();
        const at = delegate.index + delegate[0].lastIndexOf(name);
        types.push({ kind: "type", fullName: scope === "" ? name : `${scope}.${name}`, public: true, interface: false, enumeration: false, header: `${decl.slice(0, at)}global::${scope === "" ? "" : `${scope}.`}${decl.slice(at)}`, members: [] });
      }
      if (parent?.kind !== "type") return;
    }
    if (parent.kind === "type" && !parent.enumeration && isPublicMember(parent, withoutAttributes(header))) parent.members.push(memberSignature(header));
    else if (parent.kind === "member") {
      const accessor = /^((?:(?:private|protected|internal)\s+)*)(get|set|init|add|remove)\b/.exec(withoutAttributes(header));
      if (accessor && !accessor[1]) parent.accessors.push(accessor[2]!);
    }
  };

  for (const c of code) {
    if (c === "{") {
      open(segment);
      segment = "";
    } else if (c === "}") {
      close(segment);
      segment = "";
    } else if (c === ";") {
      statement(segment);
      segment = "";
    } else segment += c;
  }

  return types
    .filter((t) => t.public)
    .map((t) => ({
      fullName: t.fullName,
      text: t.enumeration ? `${t.header} { ${t.members.join(", ")} }` : [t.header, ...t.members.map((m) => `  ${m}`)].join("\n"),
    }));
}

/** Stems for ranking, with an interface's `I` split off ("IJumpRules" → I, Jump, Rules). */
const surfaceTokens = (text: string): string[] => requirementTokens(text.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2"));

/**
 * The project's public surface for the test writer: public type and member
 * signatures of the game's runtime assemblies — never a body, never test or
 * editor code, never Assembly-CSharp (a test assembly cannot reference it) —
 * plus Strada.Core.Play's contracts. Types sharing the most stems with the
 * rows (`requirementTokens`) come first; what the cap leaves out is counted.
 */
export function publicSurfaceDigest(projectRoot: string, rankTokens: readonly string[], cap = 16_000): string {
  const root = resolve(projectRoot);
  const { owners } = scanAssemblies(root);
  // A script compiles into the assembly of the nearest asmdef (or asmref) above it.
  const ownerOf = (rel: string): { name: string; game: boolean } | undefined => {
    let dir = rel.slice(0, rel.lastIndexOf("/"));
    for (;;) {
      const owner = owners.get(dir);
      if (owner) return owner;
      const cut = dir.lastIndexOf("/");
      if (cut < 0) return undefined;
      dir = dir.slice(0, cut);
    }
  };
  const types: Array<SurfaceType & { score: number }> = [];
  const rank = new Set(rankTokens);
  walkProject(
    root,
    "Assets",
    (rel, abs) => {
      if (!rel.endsWith(".cs")) return;
      if (rel.split("/").slice(0, -1).some((f) => /^(?:editor|tests?)$/i.test(f))) return;
      if (!ownerOf(rel)?.game) return;
      const text = readText(abs, 1_000_000);
      if (text === undefined) return;
      for (const type of publicTypesOf(text)) {
        types.push({ ...type, score: surfaceTokens(`${type.fullName} ${type.text}`).filter((t) => rank.has(t)).length });
      }
    },
    insideAcceptanceDir,
  );
  types.sort((a, b) => b.score - a.score || (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

  const head = [
    "// Public surface of the game's runtime assemblies: signatures only, no bodies.",
    "// Spell every type in a check from the root, as printed here: global::Namespace.Type.",
    "",
    STRADA_PLAY_SURFACE,
  ].join("\n");
  if (head.length > cap) return head.slice(0, cap);
  const omittedLine = (n: number): string => `\n\n// … ${n} more type(s) not shown (cap)`;
  const reserve = omittedLine(types.length).length;
  let out = head;
  let omitted = 0;
  for (const type of types) {
    const block = `\n\n${type.text}`;
    if (out.length + block.length + reserve > cap) omitted++;
    else out += block;
  }
  return omitted > 0 ? out + omittedLine(omitted) : out;
}

/**
 * What the writer is told about the harness: how its parts are wrapped, what
 * it may call, and the rules `lintAcceptanceBody` enforces. With the
 * project's input detection it also says how input reaches this game.
 */
export function harnessApiDoc(injection?: InputInjection): string {
  const input =
    injection === undefined
      ? "Input goes through Input System device events when the project has the Input System with the new input handling, else through EventSystem pointer events (UI and raycast-hit objects only)."
      : injection.route === "none"
        ? `No input can be injected in this project: ${injection.detail}. An input row cannot be checked here — return it in "unbound" with missingObservable naming what is needed.`
        : `Input in this project: ${injection.detail}.`;
  return [
    "STRADA ACCEPTANCE HARNESS — how a check runs",
    "",
    "The system wraps every check you return; you write statements, never a method or a class:",
    `  namespace ${ACCEPTANCE_TEST_NAMESPACE}.<Milestone> { [TestFixture, Category("${ACCEPTANCE_TEST_CATEGORY}")] class Acceptance_<Milestone> : AcceptanceFixture {`,
    `    [UnityTest, Timeout(${ACCEPTANCE_TEST_TIMEOUT_MS})] public IEnumerator R<ordinal>_<id>() { yield return Boot(); <setup> <act> <body | the system's assertion> } } }`,
    "A part is C# 9 statements inside a Unity PlayMode iterator method.",
    "",
    "Names: the file imports no namespace, only LINQ's extension methods (.Any(), .Count(), .Contains() …). Spell every type and",
    "namespace from the root with global:: — global::NUnit.Framework.Assert.That(x, global::NUnit.Framework.Is.EqualTo(3)),",
    "global::UnityEngine.Time.timeScale, global::Strada.Core.Play.PlaythroughOutcome.Won, and the game's types as the public surface",
    "prints them (global::Namespace.Type). A bare name may only be a local or lambda parameter your check declares, or a harness",
    "member below: a game may name a namespace Grid, Input or Is, and code outside the system's folder may declare a type of any",
    "name, so a bare type name could mean either instead of the type you meant.",
    "",
    "Rows with GDD numbers (constant, range): return `observe` only — one C# expression whose value, in the row's unit,",
    "is what the game does (plus an optional `setup`). The system casts it to double and asserts it against the bounds",
    "it parsed out of the GDD. You never write that assertion or its numbers.",
    "Every other row: return `body` (optional `setup` and `act`) ending in at least one NUnit assertion about the game.",
    "",
    "Harness members (protected; every IEnumerator must be yielded: `yield return Frames(2);`):",
    "  IEnumerator Boot()                                     loads build scene 0, waits for GameBootstrapper.Services (already called first)",
    "  IEnumerator Frames(int count)                          waits frames",
    "  IEnumerator Seconds(float seconds)                     waits real time",
    "  IEnumerator Until(global::System.Func<bool> condition, float timeoutSeconds = 10f)   waits until it holds or times out; never fails by itself",
    "  PlaythroughView Driver                                 read-only: Driver.Phase (string), Driver.Outcome (global::Strada.Core.Play.PlaythroughOutcome),",
    "                                                         Driver.IsSessionActive (bool)",
    "  IEnumerator StartSessionForSetup(int index)            starts a session, for a check whose subject is not how play starts",
    "  T Service<T>() where T : class                         a service the game registered; fails when it is not registered",
    "  bool AnyAudioPlaying()                                 any AudioSource playing",
    "  IReadOnlyList<string> ActiveScreens()                  active root canvases, their active children, active UI documents, by name",
    "  string InputInjectable                                 \"input-system\", \"event-system\" or \"none\"",
    "  IEnumerator TapViewport(float x, float y)              tap at viewport coordinates (0..1, origin bottom-left)",
    "  IEnumerator TapScreen(global::UnityEngine.Vector2 position)   tap at screen pixels",
    "  IEnumerator TapObject(global::UnityEngine.GameObject target)  tap where the object is on screen (also TapObject(Component), TapObject(string name))",
    "  IEnumerator Drag(global::UnityEngine.Vector2 from, global::UnityEngine.Vector2 to, float seconds = 0.25f)   press, move, release, in screen pixels",
    "  IEnumerator Press(string key)                          press and release a keyboard key (a UnityEngine.InputSystem.Key name)",
    "  float BootSeconds, SessionStartSeconds                 how long Boot() and StartSessionForSetup() wait",
    "",
    input,
    "",
    "Rules — a check that breaks one is rejected before it runs:",
    "  - no Assert.Pass, Assert.Ignore, Assert.Inconclusive, Assert.Warn, Assume, Warn.If, or the exceptions they throw;",
    "    no [Ignore], [Explicit], [Category]; no catch; no preprocessor directives (#if …); no System.IO, Process, UnityEditor,",
    "    Application.Quit, LogAssert.ignoreFailingMessages; no yield break",
    "  - every type and namespace is spelled from the root (global::…); bare names are your own locals and lambda parameters,",
    "    and the harness's members",
    "  - never IPlaythroughDriver and never .Act( — the driver's own action is not the player's; no reflection invocation",
    "  - an assertion's subject must be something the game reports: not literals only, and not reflection only",
    "    (typeof, GetType(), GetMethods(), GetInterfaces, IsAssignableFrom …) — the shape of code is not the behaviour of the game",
    "  - input rows perform the input through TapViewport, TapScreen, TapObject, Drag or Press, and never call StartSession",
    `  - each part balances its braces; at most ${MAX_ACCEPTANCE_BODY_LINES} lines in all`,
  ].join("\n");
}
