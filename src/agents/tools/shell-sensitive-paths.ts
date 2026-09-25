/**
 * The sensitive-path check shell_exec runs over a command's words.
 *
 * A best-effort guard, NOT a sandbox: a program can open files its command
 * line never names (`grep -r x .`, a build script, a pipe into xargs) and
 * only an OS boundary could stop that. What it does do: every word is read
 * the way the shell reads it (the shared shell-lexer: quotes, escapes,
 * operators, redirections) and expanded the way the shell will expand it —
 * variables from the child's real environment and the command's own literal
 * assignments, globs against the files actually on disk (bash's leading-dot
 * rule included). Only what cannot be known before the command runs (a
 * `read`, an `eval`, an indirect expansion, a glob too large to walk) is
 * judged conservatively: refused when some value of it could name a file the
 * path-guard blocklist protects. The whitespace-token check this replaces
 * compared the text as written, so any expansion walked past it (TLS-7).
 */
import { isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { lstatSync, readdirSync, statSync, type Dirent } from "node:fs";
import { isSensitivePath } from "../../security/path-guard.js";
import { lexShell, type ShellLex, type ShellWord } from "../../security/shell-lexer.js";

/** any: unknown text (an opaque variable); deep: `**`; star: `*`; one: `?` or `[…]`. */
type Wild = "any" | "deep" | "star" | "one";
/** A word as a sequence of known text and parts only the shell can fill in. */
type Part =
  | { readonly text: string }
  | { readonly wild: Wild; readonly raw: string; readonly cls?: string };
type Pattern = readonly Part[];

export interface SensitiveScanOptions {
  /** The environment the child will get (shell_exec passes buildShellEnv's output). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Also read the words as cmd.exe would. Defaults to running on Windows. */
  readonly cmd?: boolean;
  /** Directory entries a glob may examine before it is judged conservatively instead. */
  readonly globEntryBudget?: number;
}

/** What the command itself does to its variables. */
interface Bindings {
  /** Literal assignments and `for` lists: every value a name is given. */
  readonly assigned: ReadonlyMap<string, readonly ShellWord[]>;
  /** Names set by something this reader cannot evaluate (`read`, `printf -v`, `let`…). */
  readonly opaque: ReadonlySet<string>;
  /** `eval`/`source` can set any variable. */
  readonly everything: boolean;
  /** `set --`, `shift` or a function body: the positional parameters are unknown. */
  readonly positional: boolean;
}

interface Scope {
  readonly cwd: string;
  readonly home: string;
  readonly cmd: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly vars: Bindings;
  /** A leading `*`/`?` can match a leading dot (dotglob, GLOBIGNORE, cmd.exe programs). */
  readonly dotMatches: boolean;
  readonly globstar: boolean;
  readonly nocase: boolean;
  readonly globEntryBudget: number;
}

// The lexer reads `{`/`}` as grouping and ends the word there, so a brace
// list would be split apart: carry them through as word characters.
const OPEN = "\u{E000}";
const CLOSE = "\u{E001}";
/** Leads a redirection target: a file by definition, whatever its shape. */
const TARGET = "\u{E002}";
/** An extglob group `!(…)`, `@(…)`…: the lexer would read its `(` as a subshell. */
const EXT_KINDS = "?*+@!";
const EXT_OPENS = [..."\u{E010}\u{E011}\u{E012}\u{E013}\u{E014}"];
const EXT_CLOSE = "\u{E003}";
const EXT_BAR = "\u{E004}";

/** A word as it was written, placeholders back to their characters. */
function shownAs(raw: string): string {
  let out = raw.replaceAll(OPEN, "{").replaceAll(CLOSE, "}").replaceAll(EXT_CLOSE, ")").replaceAll(EXT_BAR, "|");
  EXT_OPENS.forEach((mark, k) => (out = out.replaceAll(mark, `${EXT_KINDS[k]}(`)));
  return out;
}
const MAX_VARIANTS = 64;
const MAX_VARIABLE_DEPTH = 3;
const DEFAULT_GLOB_ENTRY_BUDGET = 10_000;
const ONE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789._-";
const ANY: Pattern = [{ wild: "any", raw: "" }];

/** Variables the shell itself sets from what the command did (a match, a `read`, a `cd`). */
const SHELL_SET = new Set([
  "BASH_REMATCH", "REPLY", "OPTARG", "MAPFILE", "OLDPWD", "_", "BASH_COMMAND", "BASH_ARGV",
  "FUNCNAME", "DIRSTACK", "COPROC", "READLINE_LINE", "PIPESTATUS",
]);
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const READERS = new Set(["read", "mapfile", "readarray", "getopts", "let", "select"]);
const PREFIXES = new Set(["builtin", "command", "exec", "time", "nohup", "!", "if", "then", "else", "elif", "do", "while", "until"]);

/**
 * Names a protected path can take below some directory — used only when an
 * expansion cannot be evaluated. Membership is not what refuses; the
 * blocklist still decides for the whole path (`.git/c*g` is `config` there).
 */
const SAMPLE_NAMES = [
  ".env", ".env.local", ".env.production", "x.env", ".strada-lease-owner.json", ".strada-lease-seed.json",
  "config", "credentials", ".git/config", ".git/credentials", ".ssh/id_rsa", ".ssh/config",
  "credentials.json", "secret.json", "secrets.json", "secret.yml", "secrets.yaml", "secrets.yml", "secret.yaml",
  "id_rsa", "id_ed25519", "x.pem", "x.key", "x.pfx", "x.p12", "x.keystore", "x.jks", "keystore.properties",
  "google-services.json", "GoogleService-Info.plist", ".npmrc", ".netrc",
];
const SAMPLE_TAILS = [...SAMPLE_NAMES, ...SAMPLE_NAMES.map((name) => `x/${name}`)];

/**
 * Words of a shell command that name, or expand to, a path the
 * sensitive-file blocklist refuses, resolved against `cwd`. Returned as
 * written. Flags are skipped but their `=value` (and a short option's
 * attached value) is read.
 */
export function sensitiveCommandPaths(command: string, cwd: string, options: SensitiveScanOptions = {}): string[] {
  return scanCommand(command, cwd, options, 0);
}

function scanCommand(command: string, cwd: string, options: SensitiveScanOptions, evalDepth: number): string[] {
  const cmd = options.cmd ?? process.platform === "win32";
  // A redirection becomes a command break and its target a marked word: the
  // lexer keeps only output targets (as bare values), and an input target is
  // a file read all the same.
  const text = /\bextglob\b/.test(command) ? markExtglob(command) : command;
  const prepared = text.replace(/\$\{[^}]*\}|[{}]|[<>]+[&|]?\s*/g, (m) =>
    m === "{" ? OPEN : m === "}" ? CLOSE : /^[<>]/.test(m) ? ` ; ${TARGET}` : m);
  const read = lexShell(prepared, { cmd });
  const flags = new Set(prepared.match(/[A-Za-z_]\w*/g) ?? []);
  const env = options.env ?? {};
  const scope: Scope = {
    cwd,
    home: options.home ?? env["HOME"] ?? homedir(),
    cmd,
    env,
    vars: bindings(read.commands, prepared),
    dotMatches: cmd || flags.has("dotglob") || flags.has("GLOBIGNORE"),
    globstar: flags.has("globstar"),
    nocase: cmd || flags.has("nocaseglob"),
    globEntryBudget: options.globEntryBudget ?? DEFAULT_GLOB_ENTRY_BUDGET,
  };

  const hits: string[] = [];
  for (const marked of allWords(read)) {
    const target = marked.value.startsWith(TARGET);
    const word = target ? { ...marked, value: marked.value.slice(1), raw: marked.raw.slice(1) } : marked;
    const shown = shownAs(word.raw);
    if (!shown || hits.includes(shown)) continue;
    const variants = wordPatterns(word, scope, 0);
    if (cmd) variants.push(...wordPatterns(cmdReading(word), scope, 0));
    if (variants.some((p) => candidates(p).some((c) => judge(c, scope, target)))) hits.push(shown);
  }
  // `eval` joins its arguments and parses them again: read that line too.
  for (const words of read.commands) {
    const at = words.findIndex((w) => !/^(?:[A-Za-z_]\w*=.*|builtin|command)$/.test(w.value));
    if (words[at]?.value !== "eval" || evalDepth >= 3) continue;
    const line = words.slice(at + 1).map((w) => w.value).join(" ");
    if (scanCommand(shownAs(line), cwd, options, evalDepth + 1).length > 0) hits.push(shownAs(words.slice(at).map((w) => w.raw).join(" ")));
  }
  return hits;
}

/**
 * Every value the command gives its variables. Order-insensitive on purpose:
 * a loop or a function can run an assignment before a use written above it,
 * so a name holds the union of its environment value and every assignment.
 */
function bindings(commands: readonly (readonly ShellWord[])[], command: string): Bindings {
  const assigned = new Map<string, ShellWord[]>();
  const opaque = new Set<string>();
  let everything = false;
  let positional = /\bfunction\s|[A-Za-z_][\w-]*\s*\(\s*\)/.test(command);
  const assignment = (word: ShellWord | undefined, into: Set<string> | undefined): boolean => {
    const m = word ? /^([A-Za-z_]\w*)(\+?)=/.exec(word.value) : null;
    if (!word || !m) return false;
    const name = m[1] ?? "";
    if (into || m[2]) (into ?? opaque).add(name);
    // No pathname expansion happens in an assignment; it happens at the use.
    else assigned.set(name, [...(assigned.get(name) ?? []), { ...word, value: word.value.slice(m[0].length), glob: false }]);
    return true;
  };
  for (const words of commands) {
    let at = 0;
    while (PREFIXES.has(words[at]?.value ?? "") || assignment(words[at], undefined)) at += 1;
    const verb = words[at]?.value ?? "";
    const args = words.slice(at + 1);
    const names = args.map((w) => w.value).filter((v) => /^[A-Za-z_]\w*$/.test(v));
    if (DECLARERS.has(verb)) {
      const nameref = args.some((w) => /^-\w*n/.test(w.value));
      for (const w of args) assignment(w, nameref ? opaque : undefined);
      if (nameref) names.forEach((n) => opaque.add(n));
    } else if (READERS.has(verb)) {
      names.forEach((n) => opaque.add(n));
      for (const w of args) assignment(w, opaque);
    } else if (verb === "printf") {
      const v = args.findIndex((w) => w.value === "-v");
      if (v >= 0) opaque.add(args[v + 1]?.value ?? "");
    } else if (verb === "for") {
      const name = args[0]?.value ?? "";
      if (args[1]?.value === "in") assigned.set(name, [...(assigned.get(name) ?? []), ...args.slice(2)]);
      else opaque.add(name);
    } else if (verb === "eval" || verb === "source" || verb === ".") {
      everything = true;
    } else if (verb === "set" || verb === "shift") {
      positional = true;
    } else if (verb === "cd" || verb === "pushd" || verb === "popd") {
      opaque.add("PWD");
    }
  }
  return { assigned, opaque, everything, positional };
}

/** With extglob on (a line after `shopt -s extglob`), `!(…)` and friends are one pattern. */
function markExtglob(command: string): string {
  const open: boolean[] = [];
  let out = "";
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] ?? "";
    if (EXT_KINDS.includes(c) && command[i + 1] === "(") {
      open.push(true);
      out += EXT_OPENS[EXT_KINDS.indexOf(c)];
      i += 1;
    } else if (c === "(") {
      open.push(false);
      out += c;
    } else if (c === ")") {
      out += open.pop() ? EXT_CLOSE : c;
    } else if (c === "|" && open[open.length - 1]) {
      out += EXT_BAR;
    } else {
      out += c;
    }
  }
  return out;
}

function allWords(read: ShellLex): ShellWord[] {
  return [...read.commands.flat(), ...read.nested.flatMap(allWords)];
}

/** cmd.exe's reading: `"` and `^` are removed, `\` is literal, `%NAME%` expands. */
function cmdReading(word: ShellWord): ShellWord {
  const value = word.raw.replace(/["^]/g, "");
  return { value, raw: word.raw, expands: /%[^%\s]+%/.test(value) ? ["%"] : [], glob: /[*?]/.test(value) };
}

/** Every form the word can take, as patterns. Too many forms is one unknown. */
function wordPatterns(word: ShellWord, scope: Scope, depth: number): Pattern[] {
  // ANSI-C and locale quoting decode escapes the lexer leaves as written.
  if (/\$['"]/.test(word.raw)) return [ANY];
  const text = word.value;
  let variants: Part[][] = [[]];
  const append = (options: readonly Pattern[]) => {
    const next: Part[][] = [];
    for (const v of variants) for (const o of options) next.push([...v, ...o]);
    variants = next.length > MAX_VARIANTS ? [[...ANY]] : next;
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i] ?? "";
    const param = word.expands.some((name) => name !== "%") ? /^\$(?:\{([^}]*)\}|([A-Za-z_]\w*|[0-9?#$!@*-]))/.exec(rest) : null;
    const percent = scope.cmd && word.expands.includes("%") ? /^%[^%\s]+%/.exec(rest) : null;
    if (param) {
      append(param[2] !== undefined ? variable(param[2], scope, depth) : braced(param[1] ?? "", word, scope, depth));
      i += param[0].length;
    } else if (percent) {
      append([ANY]);
      i += percent[0].length;
    } else if (EXT_OPENS.includes(c)) {
      // `@(a|b)` is one of its alternatives and `?(a|b)` one or none; `!(x)`
      // ("not x"), `*(…)` and `+(…)` can be any run within the segment.
      const close = groupEnd(text, i, (ch) => EXT_OPENS.includes(ch), EXT_CLOSE);
      const body = text.slice(i + 1, close < 0 ? text.length : close);
      const kind = EXT_KINDS[EXT_OPENS.indexOf(c)];
      if ((kind === "@" || kind === "?") && !EXT_OPENS.some((mark) => body.includes(mark))) {
        const alternatives = body.split(EXT_BAR).flatMap((alt) => wordPatterns({ ...word, value: alt }, scope, depth));
        append(kind === "?" ? [...alternatives, []] : alternatives);
      } else {
        append([[{ wild: "star", raw: shownAs(text.slice(i, close < 0 ? text.length : close + 1)) }]]);
      }
      i = close < 0 ? text.length : close + 1;
    } else if (word.glob && (c === "*" || c === "?" || c === "[")) {
      const glob = globPart(rest);
      append([[glob.part]]);
      i += glob.length;
    } else if (c === OPEN && braceEnd(text, i) > 0) {
      const end = braceEnd(text, i);
      append(braceAlternatives(text.slice(i + 1, end), word, scope, depth));
      i = end + 1;
    } else {
      append([[{ text: c === OPEN ? "{" : c === CLOSE ? "}" : c }]]);
      i += 1;
    }
  }
  return variants.map(merge);
}

/** The glob construct at the start of `text` (`*`, `**`, `?`, `[…]`), or a literal `[`. */
function globPart(text: string): { part: Part; length: number } {
  if (text[0] === "*") {
    const run = /^\*+/.exec(text)?.[0] ?? "*";
    return { part: { wild: run.length > 1 ? "deep" : "star", raw: run }, length: run.length };
  }
  if (text[0] === "?") return { part: { wild: "one", raw: "?" }, length: 1 };
  const end = text.indexOf("]", 2);
  if (end < 0) return { part: { text: "[" }, length: 1 };
  return { part: { wild: "one", raw: text.slice(0, end + 1), cls: text.slice(1, end) }, length: end + 1 };
}

/** `{a,b}` lists and `{1..3}`/`{a..e}` ranges; anything else is literal text. */
function braceAlternatives(body: string, word: ShellWord, scope: Scope, depth: number): Pattern[] {
  if (body.includes(OPEN)) return [ANY];
  if (body.includes(",")) return body.split(",").flatMap((alt) => wordPatterns({ ...word, value: alt }, scope, depth));
  const numeric = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
  const letters = /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
  const [from, to] = numeric ? [Number(numeric[1]), Number(numeric[2])]
    : letters ? [(letters[1] ?? "a").charCodeAt(0), (letters[2] ?? "a").charCodeAt(0)] : [NaN, NaN];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [[{ text: `{${body}}` }]];
  if (Math.abs(to - from) >= MAX_VARIANTS) return [[{ wild: "star", raw: `{${body}}` }]];
  const step = from <= to ? 1 : -1;
  const out: Pattern[] = [];
  for (let n = from; n !== to + step; n += step) out.push([{ text: numeric ? String(n) : String.fromCharCode(n) }]);
  return out;
}

/** Index of the close matching the opener at `start`, or -1. */
function groupEnd(text: string, start: number, opens: (ch: string) => boolean, close: string): number {
  let depth = 0;
  for (let j = start; j < text.length; j += 1) {
    const ch = text[j] ?? "";
    if (opens(ch)) depth += 1;
    else if (ch === close && --depth === 0) return j;
  }
  return -1;
}

function braceEnd(text: string, open: number): number {
  return groupEnd(text, open, (ch) => ch === OPEN, CLOSE);
}

/**
 * What `$NAME` expands to: its value in the child's environment (empty when
 * unset) together with every literal value the command assigns it, each read
 * as an unquoted expansion is (globbed, split into fields). Only a name set
 * by something not evaluated here is unknown.
 */
function variable(name: string, scope: Scope, depth: number): Pattern[] {
  if (/^[?#$!]$/.test(name)) return [[{ text: "0" }]];
  if (name === "-") return [[{ text: "hB" }]];
  if (name === "0") return [[{ text: "bash" }]];
  if (/^[1-9@*]$/.test(name)) return scope.vars.positional ? [ANY] : [[]];
  const { vars } = scope;
  if (vars.everything || vars.opaque.has(name) || SHELL_SET.has(name) || depth >= MAX_VARIABLE_DEPTH) return [ANY];
  const envValue = name === "PWD" ? scope.cwd : scope.env[name];
  const values: Pattern[] = [envValue === undefined ? [] : [{ text: envValue }]];
  for (const word of vars.assigned.get(name) ?? []) values.push(...wordPatterns(word, scope, depth + 1));
  return values.flatMap(unquotedExpansion);
}

/** `${NAME}` and the default-value forms; any other operation is not evaluated. */
function braced(inner: string, word: ShellWord, scope: Scope, depth: number): Pattern[] {
  if (/^(?:[A-Za-z_]\w*|[0-9?#$!@*-])$/.test(inner)) return variable(inner, scope, depth);
  if (/^#[A-Za-z_]\w*$/.test(inner)) return [[{ text: "0" }]];
  const m = /^([A-Za-z_]\w*):?([-=+])(.*)$/.exec(inner);
  if (!m || depth >= MAX_VARIABLE_DEPTH) return [ANY];
  const alternative = wordPatterns({ ...word, value: m[3] ?? "", glob: false }, scope, depth + 1).flatMap(unquotedExpansion);
  return m[2] === "+" ? [[], ...alternative] : [...variable(m[1] ?? "", scope, depth), ...alternative];
}

/** An unquoted expansion's value is globbed and split into fields; each field is also a candidate. */
function unquotedExpansion(p: Pattern): Pattern[] {
  const globbed = merge(p.flatMap((part) => ("text" in part ? globParts(part.text) : [part])));
  if (!p.every((part) => "text" in part)) return [globbed];
  const fields = leadText(p).split(/\s+/).filter(Boolean);
  return fields.length > 1 ? [globbed, ...fields.map((field) => merge(globParts(field)))] : [globbed];
}

function globParts(text: string): Part[] {
  const out: Part[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "*" || c === "?" || c === "[") {
      const glob = globPart(text.slice(i));
      out.push(glob.part);
      i += glob.length;
    } else {
      out.push({ text: c });
      i += 1;
    }
  }
  return out;
}

function merge(parts: readonly Part[]): Pattern {
  const out: Part[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if ("text" in part && last && "text" in last) out[out.length - 1] = { text: last.text + part.text };
    else if (!("text" in part && part.text === "")) out.push(part);
  }
  return out;
}

function leadText(p: Pattern): string {
  const first = p[0];
  return first && "text" in first ? first.text : "";
}

function dropLead(p: Pattern, chars: number): Pattern {
  return merge([{ text: leadText(p).slice(chars) }, ...p.slice(1)]);
}

/** The parts of a word that can be a path: all of it, a flag's or assignment's value, an `@file`. */
function candidates(p: Pattern): Pattern[] {
  const lead = leadText(p);
  const out: Pattern[] = [];
  if (lead.startsWith("-")) {
    const eq = lead.indexOf("=");
    if (eq > 0) out.push(dropLead(p, eq + 1));
    else if (!lead.startsWith("--")) out.push(dropLead(p, Math.min(2, lead.length)));
  } else {
    out.push(p);
    const assignment = /^[A-Za-z_]\w*=/.exec(lead);
    if (assignment) out.push(dropLead(p, assignment[0].length));
  }
  for (const c of [...out]) if (leadText(c).startsWith("@")) out.push(dropLead(c, 1));
  return out.filter((c) => c.length > 0);
}

function judge(p: Pattern, scope: Scope, isFile: boolean): boolean {
  const lead = leadText(p);
  let pattern = p;
  if (lead.startsWith("~")) {
    // `~` and `~/…` are this user's home; `~name`, `~+`, `~-` are not known here.
    const end = lead.search(/[/\\]/);
    const prefix = end < 0 ? lead : lead.slice(0, end);
    pattern = merge([prefix === "~" ? { text: scope.home } : ANY[0]!, { text: lead.slice(prefix.length) }, ...p.slice(1)]);
  }
  if (pattern.every((part) => "text" in part)) return judgeLiteral(leadText(pattern), lead, scope, isFile);
  if (pattern.some((part) => "wild" in part && part.wild === "any")) return couldBeSensitive(pattern, scope);
  // A glob is expanded by the shell against the disk: judge what it matches.
  // One that matches nothing stays as written (bash's default), so judge that.
  const matches = expandGlob(pattern, scope);
  if (matches === undefined) return couldBeSensitive(pattern, scope);
  if (matches.length === 0) {
    const literal = pattern.map((part) => ("text" in part ? part.text : part.raw)).join("");
    return judgeLiteral(literal, lead, scope, isFile);
  }
  return matches.some((path) => isSensitivePath(path));
}

function judgeLiteral(text: string, lead: string, scope: Scope, isFile: boolean): boolean {
  // Only names shaped like paths (or redirection targets): `environment`
  // is not `.env`, `grep process.env` names a pattern, not a file.
  if (!(isFile || /[/\\]/.test(text) || lead.startsWith(".") || lead.startsWith("~"))) return false;
  return isSensitivePath(isAbsolute(text) ? text : resolve(scope.cwd, text));
}

/**
 * The paths a glob matches now, walked the way bash walks it: segment by
 * segment, no leading-dot match unless the pattern or dotglob allows it, `**`
 * recursive only under globstar. Undefined when the walk would exceed the
 * entry budget — the caller then judges the pattern conservatively.
 */
function expandGlob(p: Pattern, scope: Scope): string[] | undefined {
  const separators = scope.cmd || sep === "\\" ? /[/\\]/ : /\//;
  const segments: Part[][] = [[]];
  for (const part of p) {
    if (!("text" in part)) {
      segments[segments.length - 1]!.push(part);
      continue;
    }
    part.text.split(separators).forEach((piece, k) => {
      if (k > 0) segments.push([]);
      if (piece) segments[segments.length - 1]!.push({ text: piece });
    });
  }
  const lead = leadText(p);
  const root = isAbsolute(lead) ? resolve(lead.slice(0, lead.search(separators) + 1) || lead) : resolve(scope.cwd);
  // An absolute pattern's first segment is its root (`""` on POSIX, `C:` on Windows).
  if (isAbsolute(lead)) segments.shift();

  let budget = scope.globEntryBudget;
  const list = (dir: string): Dirent[] | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    budget -= entries.length + 1;
    return budget < 0 ? undefined : entries;
  };
  const isDir = (path: string, entry: Dirent): boolean => {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };

  let current = [root];
  let globbed = false;
  for (let k = 0; k < segments.length; k += 1) {
    const segment = segments[k]!;
    const last = k === segments.length - 1;
    if (segment.length === 0) continue;
    if (segment.every((part) => "text" in part)) {
      const name = leadText(segment);
      current = current.map((dir) => join(dir, name));
      if (globbed) current = current.filter((path) => exists(path));
      continue;
    }
    globbed = true;
    const deep = scope.globstar && segment.length === 1 && "wild" in segment[0]! && segment[0].wild === "deep";
    const matcher = segmentRegex(segment, scope);
    const next: string[] = [];
    const walk = (dir: string, recursive: boolean): boolean => {
      const entries = list(dir);
      if (!entries) return false;
      for (const entry of entries) {
        const path = join(dir, entry.name);
        const directory = isDir(path, entry);
        if (!matcher.test(entry.name)) continue;
        if (last || directory) next.push(path);
        if (recursive && directory && !entry.isSymbolicLink() && !walk(path, true)) return false;
      }
      return true;
    };
    for (const dir of current) {
      // `**/` also matches zero directories.
      if (deep && !last) next.push(dir);
      if (!walk(dir, deep)) return undefined;
    }
    current = next;
  }
  return current;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One path segment of a glob as an anchored regex over a directory entry name. */
function segmentRegex(segment: readonly Part[], scope: Scope): RegExp {
  let out = "";
  segment.forEach((part, index) => {
    if ("text" in part) {
      out += part.text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      return;
    }
    // A glob does not match a leading dot unless the shell was told to.
    if (index === 0 && !scope.dotMatches) out += "(?!\\.)";
    out += part.wild === "one" ? classRegex(part.cls) : part.wild === "any" ? ".*" : "[^/]*";
  });
  try {
    return new RegExp(`^${out}$`, scope.nocase ? "iu" : "u");
  } catch {
    // A class JavaScript cannot express: widen it to any character.
    return segmentRegex(segment.map((part) => ("wild" in part && part.cls !== undefined ? { wild: "one", raw: part.raw } : part)), scope);
  }
}

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: "a-zA-Z", digit: "0-9", alnum: "a-zA-Z0-9", upper: "A-Z", lower: "a-z", xdigit: "0-9a-fA-F", space: "\\s",
};

/** A bash bracket expression as a JavaScript character class (`[!a-c]`, `[[:digit:]]`). */
function classRegex(body: string | undefined): string {
  if (body === undefined) return "[^/]";
  const negate = body.startsWith("!") || body.startsWith("^");
  let out = "";
  for (let i = negate ? 1 : 0; i < body.length; i += 1) {
    const named = /^\[:(\w+):\]/.exec(body.slice(i));
    if (named) {
      const cls = POSIX_CLASSES[named[1] ?? ""];
      if (cls === undefined) return "[^/]";
      out += cls;
      i += named[0].length - 1;
      continue;
    }
    const ch = body[i] ?? "";
    const range = ch === "-" && i > (negate ? 1 : 0) && i < body.length - 1;
    out += range ? "-" : ch.replace(/[\\\]\[^/-]/, "\\$&");
  }
  return negate ? `[^/${out}]` : `(?!/)[${out}]`;
}

/**
 * Could some expansion of the pattern be a protected path? The conservative
 * judgement for what cannot be expanded here. Three views, each decided by
 * the blocklist itself: the fixed directory the expansion happens in, the
 * sample names the expansion can take there, and the shortest text each
 * wildcard can supply (the literal parts may carry the name: `q*.env`).
 */
function couldBeSensitive(p: Pattern, scope: Scope): boolean {
  const firstWild = p.findIndex((part) => "wild" in part);
  const lead = p.slice(0, firstWild).map((part) => ("text" in part ? part.text : "")).join("");
  const cut = Math.max(lead.lastIndexOf("/"), lead.lastIndexOf("\\"));
  const dir = lead.slice(0, cut + 1);
  const baseDir = dir === "" ? resolve(scope.cwd) : resolve(scope.cwd, dir);
  const base = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (isSensitivePath(`${base}x`)) return true;

  const rest = merge([{ text: lead.slice(cut + 1) }, ...p.slice(firstWild)]);
  const matcher = new RegExp(`^${toRegex(rest, scope.dotMatches)}$`, "i");
  if (SAMPLE_TAILS.some((tail) => matcher.test(tail) && isSensitivePath(base + tail))) return true;

  return instantiations(p, scope.dotMatches).some((text) =>
    isSensitivePath(isAbsolute(text) ? resolve(text) : resolve(scope.cwd, text)));
}

function toRegex(p: Pattern, dotMatches: boolean): string {
  let out = "";
  let segmentStart = true;
  for (const part of p) {
    if ("text" in part) {
      for (const ch of part.text) {
        out += ch === "/" || ch === "\\" ? "[/\\\\]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        segmentStart = ch === "/" || ch === "\\";
      }
      continue;
    }
    // A glob does not match a leading dot unless the shell was told to;
    // `**` obeys that in every directory it crosses.
    const guard = segmentStart && !dotMatches && part.wild !== "any" ? "(?!\\.)" : "";
    const deep = dotMatches ? ".*" : "(?:[^/\\\\]*(?:[/\\\\](?!\\.)[^/\\\\]*)*)";
    out += guard + ({ any: ".*", deep, star: "[^/\\\\]*", one: "[^/\\\\]" } as const)[part.wild];
    segmentStart = false;
  }
  return out;
}

/**
 * The pattern with each `*`/unknown filled by "" or "x" and each `?` by every
 * name character; then each `*`/unknown in turn as a protected directory.
 */
function instantiations(p: Pattern, dotMatches: boolean): string[] {
  const ones = p.filter((part) => "wild" in part && part.wild === "one").length;
  const oneFills: string[][] = ones <= 2 ? product(ones) : [Array<string>(ones).fill("x")];
  const fillWith = (pick: (part: { readonly wild: Wild }, index: number) => string): string =>
    p.map((part, index) => ("text" in part ? part.text : pick(part, index))).join("");
  const out: string[] = [];
  for (const fill of ["", "x"]) {
    for (const chars of oneFills) {
      let k = 0;
      out.push(fillWith((part) => (part.wild === "one" ? (chars[k++] ?? "x") : fill)));
    }
  }
  p.forEach((part, at) => {
    if (!("wild" in part) || part.wild === "one") return;
    const before = p[at - 1];
    const segmentStart = !before || ("text" in before && /[/\\]$/.test(before.text));
    if (part.wild !== "any" && !dotMatches && (segmentStart || part.wild === "deep")) return;
    out.push(fillWith((_, index) => (index === at ? ".ssh" : "x")));
  });
  return out;
}

function product(n: number): string[][] {
  let out: string[][] = [[]];
  for (let i = 0; i < n; i += 1) out = out.flatMap((prefix) => [...ONE_CHARS].map((ch) => [...prefix, ch]));
  return out;
}
