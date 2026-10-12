/**
 * What a module's files contain is declared once, in Strada.Core.
 *
 * Core's module generator builds every file it writes from
 * ModuleSourceTemplates.cs — pure string building with no Unity in it, so the
 * same code the editor runs is compiled against the framework in Core's own
 * tests. strada_create_module kept its own templates, and they drifted: a
 * ModuleConfig whose Initialize was empty, so a service it registered was never
 * handed to the PatternManager (never initialized, never ticked); a service
 * interface that did not extend IService; and a starter system with an empty
 * OnUpdate, a TODO and a commented-out ForEach, left unfilled module after
 * module.
 *
 * So the templates are read the way module-folders reads the layout: from the
 * Strada.Core installed in the project. The file is C#, written in a small part
 * of the language — locals, if and foreach, string building, interpolation,
 * lambdas, calls between its own methods. This reads that part and runs
 * `Files(name, ns, options)` as the editor would. Anything outside it makes the
 * file "unreadable" with the construct named, never a guess.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where an installed Strada.Core declares its module templates. */
export const TEMPLATE_DECLARATION_FILE = "Editor/ModuleGenerator/Templates/ModuleSourceTemplates.cs";

/** A selection by ModuleTemplateOptions field name ("Service", "ConfigData", …); unset takes Core's default. */
export type TemplateSelection = Readonly<Record<string, boolean>>;

/** One file Core's Files() produces. */
export interface TemplateFile {
  /** The ComponentType it belongs to, which decides its folder. */
  component: string;
  fileName: string;
  source: string;
}

export interface ModuleSourceTemplates {
  /** Absolute path of the file the templates were read from. */
  file: string;
  /** The option fields this Core's ModuleTemplateOptions declares. */
  options: readonly string[];
  /** Core's `ModuleSourceTemplates.Files(name, ns, options)`. */
  render(name: string, namespace: string, selection: TemplateSelection): TemplateFile[];
}

// "absent" is a Core that predates source templates: its generator builds files
// elsewhere, and its bootstrapper may not provide what these templates call
// (the PatternManager they resolve arrived with them).
export type TemplateLookup =
  | { status: "declared"; templates: ModuleSourceTemplates }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

export interface TemplateFs {
  exists(path: string): boolean;
  read(path: string): string;
}
const NODE_FS: TemplateFs = { exists: existsSync, read: (path) => readFileSync(path, "utf-8") };

/** Read the templates a Strada.Core checkout rooted at `coreRoot` declares. */
export function readTemplatesAt(coreRoot: string, fs: TemplateFs = NODE_FS): TemplateLookup {
  const file = join(coreRoot, TEMPLATE_DECLARATION_FILE);
  if (!fs.exists(file)) return { status: "absent" };
  let source: string;
  try {
    source = fs.read(file);
  } catch {
    return { status: "unreadable", reason: `${TEMPLATE_DECLARATION_FILE}: could not be read` };
  }
  try {
    return { status: "declared", templates: parseModuleSourceTemplates(source, file) };
  } catch (error) {
    return { status: "unreadable", reason: `${TEMPLATE_DECLARATION_FILE}: ${(error as Error).message}` };
  }
}

/**
 * Parse a ModuleSourceTemplates.cs. Every selection of one option, of all and
 * of none is rendered once here, so a construct this reader cannot follow is
 * found when the file is read, not halfway through writing a module.
 */
export function parseModuleSourceTemplates(source: string, file: string): ModuleSourceTemplates {
  const program = new Program(lex(source));
  const options = program.optionFields();
  const render = (name: string, namespace: string, selection: TemplateSelection): TemplateFile[] =>
    program.files(name, namespace, selection);
  const probes: TemplateSelection[] = [
    {},
    Object.fromEntries(options.map((o) => [o, true])),
    ...options.map((o) => ({ [o]: true })),
  ];
  for (const probe of probes) render("Probe", "Probe.Namespace", probe);
  return { file, options, render };
}

class TemplateReadError extends Error {}

function fail(message: string): never {
  throw new TemplateReadError(message);
}

// ── Lexing ──────────────────────────────────────────────────────────────────

type Token =
  | { k: "id"; v: string; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "istr"; parts: Array<string | Token[]>; at: number }
  | { k: "chr"; v: string; at: number }
  | { k: "num"; v: number; at: number }
  | { k: "p"; v: string; at: number };

const PUNCT = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-="];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'" };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const lineOf = (at: number) => source.slice(0, at).split("\n").length;
  const escape = (at: number): [string, number] => {
    const c = source[at + 1] ?? "";
    if (c === "u") return [String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16)), at + 6];
    const v = ESCAPES[c];
    if (v === undefined) fail(`line ${lineOf(at)}: unsupported escape \\${c}`);
    return [v!, at + 2];
  };
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === "#") {
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end < 0 ? source.length : end);
      if (!/^#\s*(region|endregion|pragma|nullable)\b/.test(line)) fail(`line ${lineOf(i)}: preprocessor directive ${line.trim()}`);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === "$" && source[i + 1] === '"') {
      const at = i;
      i += 2;
      const parts: Array<string | Token[]> = [];
      let text = "";
      for (;;) {
        const d = source[i];
        if (d === undefined) fail(`line ${lineOf(at)}: unterminated string`);
        if (d === '"') { i++; break; }
        if (d === "\\") { const [v, next] = escape(i); text += v; i = next; continue; }
        if (d === "{" && source[i + 1] === "{") { text += "{"; i += 2; continue; }
        if (d === "}" && source[i + 1] === "}") { text += "}"; i += 2; continue; }
        if (d === "{") {
          let depth = 1;
          let j = i + 1;
          while (j < source.length && depth > 0) {
            const e = source[j]!;
            if (e === '"' || e === "'") fail(`line ${lineOf(i)}: a string inside an interpolation hole`);
            if (e === "{" || e === "(") depth++;
            else if (e === "}" || e === ")") depth--;
            if (depth === 1 && (e === ":" || e === ",")) fail(`line ${lineOf(i)}: a format or alignment in an interpolation hole`);
            j++;
          }
          if (text) parts.push(text);
          text = "";
          parts.push(lex(source.slice(i + 1, j - 1)));
          i = j;
          continue;
        }
        if (d === "\n") fail(`line ${lineOf(at)}: unterminated string`);
        text += d;
        i++;
      }
      if (text) parts.push(text);
      tokens.push({ k: "istr", parts, at });
      continue;
    }
    if ((c === "$" || c === "@") && (source[i + 1] === "@" || source[i + 1] === "$")) {
      fail(`line ${lineOf(i)}: verbatim interpolated string`);
    }
    if (c === "@" && source[i + 1] === '"') {
      const at = i;
      i += 2;
      let text = "";
      for (;;) {
        const d = source[i];
        if (d === undefined) fail(`line ${lineOf(at)}: unterminated string`);
        if (d === '"' && source[i + 1] === '"') { text += '"'; i += 2; continue; }
        if (d === '"') { i++; break; }
        text += d;
        i++;
      }
      tokens.push({ k: "str", v: text, at });
      continue;
    }
    if (c === '"') {
      const at = i;
      i++;
      let text = "";
      for (;;) {
        const d = source[i];
        if (d === undefined || d === "\n") fail(`line ${lineOf(at)}: unterminated string`);
        if (d === '"') { i++; break; }
        if (d === "\\") { const [v, next] = escape(i); text += v; i = next; continue; }
        text += d;
        i++;
      }
      tokens.push({ k: "str", v: text, at });
      continue;
    }
    if (c === "'") {
      const at = i;
      let v: string;
      if (source[i + 1] === "\\") { const [e, next] = escape(i + 1); v = e; i = next; }
      else { v = source[i + 1] ?? ""; i += 2; }
      if (source[i] !== "'") fail(`line ${lineOf(at)}: malformed character literal`);
      i++;
      tokens.push({ k: "chr", v, at });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?[fFdDmMlLuU]?/.exec(source.slice(i))!;
      tokens.push({ k: "num", v: parseFloat(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ k: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const multi = PUNCT.find((p) => source.startsWith(p, i));
    const p = multi ?? c;
    tokens.push({ k: "p", v: p, at: i });
    i += p.length;
  }
  return tokens;
}

// ── Syntax ──────────────────────────────────────────────────────────────────

type Expr =
  | { t: "lit"; v: Value }
  | { t: "istr"; parts: Array<string | Expr> }
  | { t: "name"; id: string }
  | { t: "member"; obj: Expr; id: string }
  | { t: "call"; fn: Expr; args: Expr[] }
  | { t: "new"; type: string; args: Expr[]; items: Expr[] | null }
  | { t: "unary"; op: string; e: Expr }
  | { t: "bin"; op: string; l: Expr; r: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "assign"; target: Expr; e: Expr }
  | { t: "lambda"; params: string[]; body: Stmt[] | Expr };

type Stmt =
  | { t: "expr"; e: Expr }
  | { t: "var"; id: string; e: Expr }
  | { t: "fn"; id: string; params: string[]; body: Stmt[] }
  | { t: "if"; c: Expr; then: Stmt[]; else: Stmt[] | null }
  | { t: "foreach"; id: string; e: Expr; body: Stmt[] }
  | { t: "return"; e: Expr | null };

const KEYWORDS = new Set(["if", "else", "foreach", "for", "while", "do", "switch", "return", "new", "var", "in", "using", "throw", "try", "catch", "lock", "nameof", "typeof", "sizeof"]);

/** A method found in the file: its parameter names and the tokens of its body. */
interface MethodDecl {
  name: string;
  params: Array<{ name: string; type: string; def: Token[] | null }>;
  /** Block tokens including braces, or the expression of an `=>` body. */
  body: Token[];
  expressionBodied: boolean;
  parsed?: Stmt[] | Expr;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[], private readonly where: string) {}

  private peek(o = 0): Token | undefined { return this.toks[this.i + o]; }
  private isP(v: string, o = 0): boolean { const t = this.peek(o); return t?.k === "p" && t.v === v; }
  private isId(v?: string, o = 0): boolean { const t = this.peek(o); return t?.k === "id" && (v === undefined || t.v === v); }
  private fail(what: string): never {
    const t = this.peek();
    const at = t === undefined ? "end" : t.k === "p" || t.k === "id" ? `'${t.v}'` : t.k;
    return fail(`${this.where}: ${what} at ${at}`);
  }
  private expectP(v: string): void { if (!this.isP(v)) this.fail(`expected '${v}'`); this.i++; }
  private ident(): string { const t = this.peek(); if (t?.k !== "id") this.fail("expected a name"); this.i++; return (t as { v: string }).v; }
  atEnd(): boolean { return this.i >= this.toks.length; }

  /** Skip a type (`a.b<c, d>[]?`) if one starts here; returns its text or null without moving. */
  private tryType(from = this.i): { end: number; text: string } | null {
    let j = from;
    const text: string[] = [];
    const one = (): boolean => {
      const t = this.toks[j];
      if (t?.k !== "id" || KEYWORDS.has(t.v)) return false;
      text.push(t.v);
      j++;
      while (this.toks[j]?.k === "p" && (this.toks[j] as { v: string }).v === "." && this.toks[j + 1]?.k === "id") {
        text.push(".", (this.toks[j + 1] as { v: string }).v);
        j += 2;
      }
      const lt = this.toks[j];
      if (lt?.k === "p" && lt.v === "<") {
        // Not every `<` after a name opens type arguments; on a miss, the type
        // ends at the name.
        const save = j;
        const saveText = text.length;
        j++;
        text.push("<");
        for (;;) {
          if (!one()) { j = save; text.length = saveText; return true; }
          const sep = this.toks[j];
          if (sep?.k === "p" && sep.v === ",") { text.push(","); j++; continue; }
          if (sep?.k === "p" && sep.v === ">") { text.push(">"); j++; break; }
          j = save;
          text.length = saveText;
          return true;
        }
      }
      for (;;) {
        const a = this.toks[j], b = this.toks[j + 1];
        if (a?.k === "p" && a.v === "[" && b?.k === "p" && b.v === "]") { text.push("[]"); j += 2; continue; }
        if (a?.k === "p" && a.v === "?" && this.toks[j + 1]?.k === "id") { text.push("?"); j++; continue; }
        break;
      }
      return true;
    };
    if (!one()) return null;
    return { end: j, text: text.join("") };
  }

  block(): Stmt[] {
    this.expectP("{");
    const out: Stmt[] = [];
    while (!this.isP("}")) {
      if (this.atEnd()) this.fail("unterminated block");
      out.push(this.statement());
    }
    this.i++;
    return out;
  }

  /** A statement, or a braced block as a list. */
  private body(): Stmt[] {
    return this.isP("{") ? this.block() : [this.statement()];
  }

  statement(): Stmt {
    if (this.isId("if")) {
      this.i++;
      this.expectP("(");
      const c = this.expr();
      this.expectP(")");
      const then = this.body();
      let otherwise: Stmt[] | null = null;
      if (this.isId("else")) { this.i++; otherwise = this.body(); }
      return { t: "if", c, then, else: otherwise };
    }
    if (this.isId("foreach")) {
      this.i++;
      this.expectP("(");
      if (this.isId("var")) this.i++;
      else {
        const type = this.tryType();
        if (!type) return this.fail("expected a type");
        this.i = type.end;
      }
      const id = this.ident();
      if (!this.isId("in")) this.fail("expected 'in'");
      this.i++;
      const e = this.expr();
      this.expectP(")");
      return { t: "foreach", id, e, body: this.body() };
    }
    if (this.isId("return")) {
      this.i++;
      if (this.isP(";")) { this.i++; return { t: "return", e: null }; }
      const e = this.expr();
      this.expectP(";");
      return { t: "return", e };
    }
    if (this.isId("var") && this.peek(1)?.k === "id" && this.isP("=", 2)) {
      this.i++;
      const id = this.ident();
      this.i++;
      const e = this.expr();
      this.expectP(";");
      return { t: "var", id, e };
    }
    if (this.peek()?.k === "id" && !KEYWORDS.has((this.peek() as { v: string }).v)) {
      const type = this.tryType();
      if (type && this.toks[type.end]?.k === "id") {
        const nameTok = this.toks[type.end] as { v: string };
        const after = this.toks[type.end + 1];
        if (after?.k === "p" && (after.v === "=" || after.v === ";")) {
          this.i = type.end + 1;
          if (this.isP(";")) { this.i++; return { t: "var", id: nameTok.v, e: { t: "lit", v: null } }; }
          this.i++;
          const e = this.expr();
          this.expectP(";");
          return { t: "var", id: nameTok.v, e };
        }
        if (after?.k === "p" && after.v === "(") {
          // A local function: `void Add(bool enabled, …) { … }`.
          const close = matching(this.toks, type.end + 1);
          if (this.toks[close + 1]?.k === "p" && (this.toks[close + 1] as { v: string }).v === "{") {
            const params = paramList(this.toks.slice(type.end + 2, close)).map((p) => p.name);
            this.i = close + 1;
            return { t: "fn", id: nameTok.v, params, body: this.block() };
          }
        }
      }
    }
    const e = this.expr();
    this.expectP(";");
    return { t: "expr", e };
  }

  expr(): Expr {
    // Lambdas: `x => …`, `(a, b) => …`, `() => …`.
    if (this.peek()?.k === "id" && this.isP("=>", 1)) {
      const p = this.ident();
      this.i++;
      return { t: "lambda", params: [p], body: this.isP("{") ? this.block() : this.expr() };
    }
    if (this.isP("(")) {
      const close = matching(this.toks, this.i);
      const next = this.toks[close + 1];
      if (next?.k === "p" && next.v === "=>") {
        const inner = this.toks.slice(this.i + 1, close);
        const params = inner.filter((t) => t.k === "id").map((t) => (t as { v: string }).v);
        const commas = inner.filter((t) => t.k === "p" && t.v === ",").length;
        if (inner.some((t) => t.k !== "id" && !(t.k === "p" && t.v === ",")) || (params.length > 0 && params.length !== commas + 1)) {
          this.fail("typed lambda parameters");
        }
        this.i = close + 2;
        return { t: "lambda", params, body: this.isP("{") ? this.block() : this.expr() };
      }
    }
    const lhs = this.conditional();
    if (this.isP("=")) {
      this.i++;
      return { t: "assign", target: lhs, e: this.expr() };
    }
    return lhs;
  }

  private conditional(): Expr {
    const c = this.binary(0);
    if (!this.isP("?")) return c;
    this.i++;
    const a = this.expr();
    this.expectP(":");
    const b = this.expr();
    return { t: "cond", c, a, b };
  }

  private static readonly LEVELS: string[][] = [
    ["??"], ["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"],
  ];

  private binary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.unary();
    let l = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t?.k !== "p" || !Parser.LEVELS[level]!.includes(t.v)) return l;
      this.i++;
      l = { t: "bin", op: t.v, l, r: this.binary(level + 1) };
    }
  }

  private unary(): Expr {
    if (this.isP("!") || this.isP("-")) {
      const op = (this.peek() as { v: string }).v;
      this.i++;
      return { t: "unary", op, e: this.unary() };
    }
    return this.postfix(this.primary());
  }

  /** Generic arguments before a call (`Empty<string>(`): skipped, the call ignores types. */
  private skipGenericCall(): void {
    if (!this.isP("<")) return;
    const save = this.i;
    this.i++;
    for (;;) {
      const type = this.tryType();
      if (!type) { this.i = save; return; }
      this.i = type.end;
      if (this.isP(",")) { this.i++; continue; }
      if (this.isP(">") && this.isP("(", 1)) { this.i++; return; }
      this.i = save;
      return;
    }
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      if (this.isP(".")) {
        this.i++;
        e = { t: "member", obj: e, id: this.ident() };
        this.skipGenericCall();
        continue;
      }
      if (this.isP("(")) {
        e = { t: "call", fn: e, args: this.args() };
        continue;
      }
      if (this.isP("[")) this.fail("indexing");
      return e;
    }
  }

  private args(): Expr[] {
    this.expectP("(");
    const out: Expr[] = [];
    while (!this.isP(")")) {
      if (this.peek()?.k === "id" && this.isP(":", 1)) this.fail("named arguments");
      out.push(this.expr());
      if (this.isP(",")) this.i++;
      else if (!this.isP(")")) this.fail("expected ',' or ')'");
    }
    this.i++;
    return out;
  }

  private items(): Expr[] {
    this.expectP("{");
    const out: Expr[] = [];
    while (!this.isP("}")) {
      out.push(this.expr());
      if (this.isP(",")) this.i++;
      else if (!this.isP("}")) this.fail("expected ',' or '}'");
    }
    this.i++;
    return out;
  }

  private primary(): Expr {
    const t = this.peek();
    if (t === undefined) return this.fail("unexpected end");
    if (t.k === "str" || t.k === "chr") { this.i++; return { t: "lit", v: t.v }; }
    if (t.k === "num") { this.i++; return { t: "lit", v: t.v }; }
    if (t.k === "istr") {
      this.i++;
      return {
        t: "istr",
        parts: t.parts.map((part) => {
          if (typeof part === "string") return part;
          const sub = new Parser(part, this.where);
          const e = sub.expr();
          if (!sub.atEnd()) sub.fail("unexpected token in an interpolation hole");
          return e;
        }),
      };
    }
    if (t.k === "p" && t.v === "(") {
      this.i++;
      const e = this.expr();
      this.expectP(")");
      return e;
    }
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") { this.i++; return { t: "lit", v: t.v === "true" }; }
      if (t.v === "null") { this.i++; return { t: "lit", v: null }; }
      if (t.v === "new") {
        this.i++;
        if (this.isP("[")) {
          this.expectP("[");
          this.expectP("]");
          return { t: "new", type: "[]", args: [], items: this.items() };
        }
        let type = "";
        if (!this.isP("(")) {
          const ty = this.tryType();
          if (!ty) return this.fail("expected a type after 'new'");
          type = ty.text;
          this.i = ty.end;
        }
        const args = this.isP("(") ? this.args() : [];
        const items = this.isP("{") ? this.items() : null;
        return { t: "new", type, args, items };
      }
      if (KEYWORDS.has(t.v)) return this.fail(`'${t.v}' in an expression`);
      this.i++;
      this.skipGenericCall();
      return { t: "name", id: t.v };
    }
    return this.fail("unexpected token");
  }
}

/** Index of the bracket closing the one at `open`. */
function matching(toks: Token[], open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const first = toks[open] as { v: string };
  const close = pairs[first.v]!;
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k !== "p") continue;
    if (t.v === first.v) depth++;
    else if (t.v === close && --depth === 0) return j;
  }
  return fail(`unbalanced '${first.v}'`);
}

/** `bool a = false, Action<StringBuilder> b` → names, types and default tokens. */
function paramList(toks: Token[]): MethodDecl["params"] {
  const out: MethodDecl["params"] = [];
  let depth = 0;
  let current: Token[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const eq = current.findIndex((t) => t.k === "p" && t.v === "=");
    const head = eq < 0 ? current : current.slice(0, eq);
    const name = [...head].reverse().find((t) => t.k === "id") as { v: string } | undefined;
    if (!name) fail("a parameter without a name");
    const type = head.slice(0, head.lastIndexOf(name as Token)).map((t) => ("v" in t ? String(t.v) : "")).join("");
    out.push({ name: name!.v, type, def: eq < 0 ? null : current.slice(eq + 1) });
    current = [];
  };
  for (const t of toks) {
    if (t.k === "p" && (t.v === "<" || t.v === "(" || t.v === "[")) depth++;
    if (t.k === "p" && (t.v === ">" || t.v === ")" || t.v === "]")) depth--;
    if (t.k === "p" && t.v === "," && depth === 0) { flush(); continue; }
    current.push(t);
  }
  flush();
  return out;
}

/** Every method and constructor declared at type level, by name. */
function declarations(toks: Token[]): Map<string, MethodDecl[]> {
  const out = new Map<string, MethodDecl[]>();
  const NOT_A_RETURN = new Set(["new", "return", "throw", "else", "in", "case"]);
  for (let i = 1; i < toks.length - 1; i++) {
    const t = toks[i]!;
    const next = toks[i + 1]!;
    if (t.k !== "id" || KEYWORDS.has(t.v) || next.k !== "p" || next.v !== "(") continue;
    const prev = toks[i - 1]!;
    const prevOk = (prev.k === "id" && !NOT_A_RETURN.has(prev.v)) || (prev.k === "p" && (prev.v === ">" || prev.v === "]"));
    if (!prevOk) continue;
    const close = matching(toks, i + 1);
    const after = toks[close + 1];
    if (after?.k !== "p" || (after.v !== "{" && after.v !== "=>")) continue;
    const params = paramList(toks.slice(i + 2, close));
    let body: Token[];
    let end: number;
    if (after.v === "{") {
      end = matching(toks, close + 1);
      body = toks.slice(close + 1, end + 1);
    } else {
      end = close + 2;
      while (end < toks.length && !(toks[end]!.k === "p" && (toks[end] as { v: string }).v === ";")) end++;
      body = toks.slice(close + 2, end);
    }
    const decl: MethodDecl = { name: t.v, params, body, expressionBodied: after.v === "=>" };
    out.set(t.v, [...(out.get(t.v) ?? []), decl]);
    i = end;
  }
  return out;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

class Builder {
  text = "";
}
interface Closure { t: "closure"; params: string[]; body: Stmt[] | Expr; env: Env; self: Options | null }
interface Options { t: "options"; fields: Map<string, boolean> }
interface Generated { t: "generated"; component: string; fileName: string; source: string }
interface Qualified { t: "qualified"; parts: string[] }
type Value = string | number | boolean | null | Value[] | Builder | Closure | Options | Generated | Qualified;

class Env {
  private readonly vars = new Map<string, Value>();
  constructor(private readonly parent: Env | null) {}
  lookup(id: string): { found: boolean; value?: Value } {
    if (this.vars.has(id)) return { found: true, value: this.vars.get(id)! };
    return this.parent ? this.parent.lookup(id) : { found: false };
  }
  define(id: string, v: Value): void { this.vars.set(id, v); }
  assign(id: string, v: Value): boolean {
    if (this.vars.has(id)) { this.vars.set(id, v); return true; }
    return this.parent ? this.parent.assign(id, v) : false;
  }
}

const isObj = <T extends { t: string }>(v: Value, t: T["t"]): v is Value & T =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Builder) && (v as { t: string }).t === t;

/** How C# prints a value into a string. */
function show(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (isObj<Qualified>(v, "qualified")) return v.parts[v.parts.length - 1]!;
  return fail("a non-text value printed into a string");
}

class Returned { constructor(readonly value: Value) {} }

const STEP_BUDGET = 500_000;
const DEPTH_LIMIT = 64;

class Program {
  private readonly methods: Map<string, MethodDecl[]>;
  private steps = 0;
  private depth = 0;

  constructor(toks: Token[]) {
    this.methods = declarations(toks);
    if (!this.methods.has("Files")) fail("declares no Files(name, ns, options)");
  }

  /** ModuleTemplateOptions' fields and their defaults, read from its constructor. */
  private optionDefaults(): Map<string, boolean> {
    const ctor = this.methods.get("ModuleTemplateOptions")?.[0];
    if (!ctor) return fail("declares no ModuleTemplateOptions constructor");
    const defaults = new Map<string, boolean>();
    const byParam = new Map(ctor.params.map((p) => [p.name, p]));
    for (const stmt of this.parsed(ctor) as Stmt[]) {
      if (stmt.t !== "expr" || stmt.e.t !== "assign" || stmt.e.target.t !== "name" || stmt.e.e.t !== "name") {
        return fail("ModuleTemplateOptions constructor does more than copy its parameters");
      }
      const param = byParam.get(stmt.e.e.id);
      if (!param || param.type !== "bool") return fail(`ModuleTemplateOptions.${stmt.e.target.id} is not a bool parameter`);
      const def = param.def?.[0];
      defaults.set(stmt.e.target.id, def?.k === "id" && def.v === "true");
    }
    return defaults;
  }

  optionFields(): string[] {
    return [...this.optionDefaults().keys()];
  }

  files(name: string, namespace: string, selection: TemplateSelection): TemplateFile[] {
    const fields = this.optionDefaults();
    for (const [key, on] of Object.entries(selection)) if (fields.has(key)) fields.set(key, on);
    this.steps = 0;
    this.depth = 0;
    const result = this.invoke("Files", [name, namespace, { t: "options", fields }], null);
    if (!Array.isArray(result)) return fail("Files() did not return a list");
    return result.map((f) => {
      if (!isObj<Generated>(f, "generated")) return fail("Files() returned something other than GeneratedFile");
      return { component: f.component, fileName: f.fileName, source: f.source };
    });
  }

  private parsed(decl: MethodDecl): Stmt[] | Expr {
    if (decl.parsed) return decl.parsed;
    const parser = new Parser(decl.body, `${decl.name}()`);
    const parsed = decl.expressionBodied ? parser.expr() : parser.block();
    if (!parser.atEnd()) return fail(`${decl.name}(): unexpected tokens after its body`);
    decl.parsed = parsed;
    return parsed;
  }

  private invoke(name: string, args: Value[], self: Options | null): Value {
    const decl = (this.methods.get(name) ?? []).find((d) => d.params.length === args.length);
    if (!decl) return fail(`calls ${name}() with ${args.length} argument(s), which it does not declare`);
    const env = new Env(null);
    decl.params.forEach((p, k) => env.define(p.name, args[k]!));
    return this.run({ t: "closure", params: [], body: this.parsed(decl), env, self }, []);
  }

  private run(fn: Closure, args: Value[]): Value {
    if (++this.depth > DEPTH_LIMIT) fail("calls nest deeper than a template does");
    try {
      const env = new Env(fn.env);
      fn.params.forEach((p, k) => env.define(p, args[k] ?? null));
      if (!Array.isArray(fn.body)) return this.eval(fn.body, env, fn.self);
      const out = this.exec(fn.body, env, fn.self);
      return out instanceof Returned ? out.value : null;
    } finally {
      this.depth--;
    }
  }

  private exec(stmts: Stmt[], env: Env, self: Options | null): Returned | null {
    for (const s of stmts) {
      if (++this.steps > STEP_BUDGET) fail("runs longer than a template does");
      switch (s.t) {
        case "expr": this.eval(s.e, env, self); break;
        case "var": env.define(s.id, this.eval(s.e, env, self)); break;
        case "fn": env.define(s.id, { t: "closure", params: s.params, body: s.body, env, self }); break;
        case "if": {
          const branch = this.truth(this.eval(s.c, env, self)) ? s.then : s.else;
          if (branch) {
            const out = this.exec(branch, new Env(env), self);
            if (out) return out;
          }
          break;
        }
        case "foreach": {
          const list = this.eval(s.e, env, self);
          if (!Array.isArray(list)) fail("foreach over something that is not a list");
          for (const item of list as Value[]) {
            const inner = new Env(env);
            inner.define(s.id, item);
            const out = this.exec(s.body, inner, self);
            if (out) return out;
          }
          break;
        }
        case "return": return new Returned(s.e ? this.eval(s.e, env, self) : null);
      }
    }
    return null;
  }

  private truth(v: Value): boolean {
    if (typeof v !== "boolean") fail("a condition that is not a bool");
    return v as boolean;
  }

  private eval(e: Expr, env: Env, self: Options | null): Value {
    if (++this.steps > STEP_BUDGET) fail("runs longer than a template does");
    switch (e.t) {
      case "lit": return e.v;
      case "istr": return e.parts.map((p) => (typeof p === "string" ? p : show(this.eval(p, env, self)))).join("");
      case "name": {
        const local = env.lookup(e.id);
        if (local.found) return local.value!;
        if (self?.fields.has(e.id)) return self.fields.get(e.id)!;
        return { t: "qualified", parts: [e.id] };
      }
      case "member": {
        const obj = this.eval(e.obj, env, self);
        if (isObj<Options>(obj, "options")) {
          if (obj.fields.has(e.id)) return obj.fields.get(e.id)!;
          return fail(`reads ModuleTemplateOptions.${e.id}, which it does not declare`);
        }
        if (Array.isArray(obj) && (e.id === "Length" || e.id === "Count")) return obj.length;
        if (typeof obj === "string" && e.id === "Length") return obj.length;
        if (isObj<Qualified>(obj, "qualified")) return { t: "qualified", parts: [...obj.parts, e.id] };
        return fail(`reads .${e.id} of a value this reader does not model`);
      }
      case "call": return this.call(e, env, self);
      case "new": {
        const args = e.args.map((a) => this.eval(a, env, self));
        const items = e.items?.map((a) => this.eval(a, env, self)) ?? null;
        if (e.type === "[]" || /^List<.*>$/.test(e.type)) return items ?? [];
        if (e.type === "StringBuilder" && args.length === 0 && !items) return new Builder();
        if (e.type === "string" && args.length === 2 && typeof args[0] === "string" && typeof args[1] === "number") {
          return args[0].repeat(args[1]);
        }
        if (e.type === "GeneratedFile" && args.length === 3) {
          const [component, fileName, source] = args;
          if (!isObj<Qualified>(component!, "qualified") || typeof fileName !== "string" || typeof source !== "string") {
            return fail("new GeneratedFile(...) with arguments of an unexpected kind");
          }
          return { t: "generated", component: show(component), fileName, source };
        }
        return fail(`new ${e.type || "(...)"}(...)`);
      }
      case "unary": {
        const v = this.eval(e.e, env, self);
        if (e.op === "!") return !this.truth(v);
        if (typeof v !== "number") fail("negating something that is not a number");
        return -(v as number);
      }
      case "bin": {
        if (e.op === "&&") return this.truth(this.eval(e.l, env, self)) && this.truth(this.eval(e.r, env, self));
        if (e.op === "||") return this.truth(this.eval(e.l, env, self)) || this.truth(this.eval(e.r, env, self));
        const l = this.eval(e.l, env, self);
        if (e.op === "??") return l !== null ? l : this.eval(e.r, env, self);
        const r = this.eval(e.r, env, self);
        if (e.op === "==") return l === r;
        if (e.op === "!=") return l !== r;
        if (e.op === "+" && (typeof l === "string" || typeof r === "string")) return show(l) + show(r);
        if (typeof l !== "number" || typeof r !== "number") return fail(`'${e.op}' on values that are not numbers`);
        switch (e.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return Math.trunc(l / r);
          case "%": return l % r;
          case "<": return l < r;
          case ">": return l > r;
          case "<=": return l <= r;
          case ">=": return l >= r;
        }
        return fail(`operator '${e.op}'`);
      }
      case "cond": return this.truth(this.eval(e.c, env, self)) ? this.eval(e.a, env, self) : this.eval(e.b, env, self);
      case "assign": {
        if (e.target.t !== "name") return fail("assigns to something other than a local");
        const v = this.eval(e.e, env, self);
        if (!env.assign(e.target.id, v)) fail(`assigns to ${e.target.id}, which is not a local`);
        return v;
      }
      case "lambda": return { t: "closure", params: e.params, body: e.body, env, self };
    }
  }

  private call(e: Extract<Expr, { t: "call" }>, env: Env, self: Options | null): Value {
    const args = () => e.args.map((a) => this.eval(a, env, self));
    if (e.fn.t === "name") {
      const local = env.lookup(e.fn.id);
      if (local.found) {
        if (!isObj<Closure>(local.value!, "closure")) return fail(`calls ${e.fn.id}, which is not a function`);
        return this.run(local.value as Closure, args());
      }
      return this.invoke(e.fn.id, args(), null);
    }
    if (e.fn.t !== "member") return fail("calls something that is not a name");
    const obj = this.eval(e.fn.obj, env, self);
    const method = e.fn.id;
    const a = args();
    if (obj instanceof Builder) {
      if (method === "AppendLine" && a.length <= 1) { obj.text += (a.length ? show(a[0]!) : "") + "\n"; return obj; }
      if (method === "Append" && a.length === 1) { obj.text += show(a[0]!); return obj; }
      if (method === "ToString" && a.length === 0) return obj.text;
    }
    if (Array.isArray(obj)) {
      if (method === "Add" && a.length === 1) { obj.push(a[0]!); return null; }
      if (method === "Insert" && a.length === 2 && typeof a[0] === "number") { obj.splice(a[0], 0, a[1]!); return null; }
      if (method === "ToArray" && a.length === 0) return [...obj];
    }
    if (isObj<Options>(obj, "options")) return this.invoke(method, a, obj);
    if (isObj<Qualified>(obj, "qualified")) {
      const qualified = [...obj.parts, method].join(".");
      if (qualified === "Array.Empty" && a.length === 0) return [];
      if (qualified === "string.IsNullOrEmpty" && a.length === 1) return a[0] === null || a[0] === "";
    }
    return fail(`calls .${method}() on a value this reader does not model`);
  }
}

/** Read the templates of the Strada.Core installed in this project. */
export function readModuleTemplates(projectPath: string, coreInstallPath: string, fs: TemplateFs = NODE_FS): TemplateLookup {
  return readTemplatesAt(join(projectPath, coreInstallPath), fs);
}
