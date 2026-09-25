/**
 * The sensitive-path check shell_exec runs over a command's words.
 *
 * A best-effort guard, NOT a sandbox: a program can open files its command
 * line never names (`grep -r x .`, a build script, a pipe into xargs) and
 * only an OS boundary could stop that. What it does do: every word is read
 * the way the shell reads it (the shared shell-lexer: quotes, escapes,
 * operators, redirections), and a word the shell would still EXPAND — a
 * glob, a brace list, a variable, a tilde — fails closed: it is refused when
 * some expansion of it could name a file the path-guard blocklist protects.
 * The whitespace-token check this replaces compared the text as written, so
 * any expansion walked past it (review TLS-7).
 */
import { isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isSensitivePath } from "../../security/path-guard.js";
import { lexShell, type ShellLex, type ShellWord } from "../../security/shell-lexer.js";

/** any: unknown text (a variable); deep: `**`; star: `*`; one: `?` or `[…]`. */
type Wild = "any" | "deep" | "star" | "one";
/** A word as a sequence of known text and parts only the shell can fill in. */
type Part = { readonly text: string } | { readonly wild: Wild };
type Pattern = readonly Part[];

export interface SensitiveScanOptions {
  /** The child's environment: an unassigned `$NAME` set here reads as its value; any other is unknown. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Also read the words as cmd.exe would. Defaults to running on Windows. */
  readonly cmd?: boolean;
}

interface Scope {
  readonly cwd: string;
  readonly home: string;
  readonly cmd: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Every identifier the command writes outside a `$` reference, with its count. */
  readonly bound: ReadonlyMap<string, number>;
  /** `for NAME in WORDS`: the words NAME takes. */
  readonly loops: ReadonlyMap<string, readonly ShellWord[]>;
  /** A leading `*`/`?` can match a leading dot (dotglob, GLOBIGNORE, cmd.exe programs). */
  readonly dotMatches: boolean;
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
const ONE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789._-";

/**
 * Names a protected path can take below some directory. Membership is not
 * what refuses — the blocklist still decides for the whole path — these are
 * what an expansion is tried against (`.git/c*g` is `config` under `.git`).
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
 * Words of a shell command that name, or could expand to, a path the
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
  const bound = new Map<string, number>();
  for (const name of prepared.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|\$./g, " ").match(/[A-Za-z_]\w*/g) ?? []) {
    bound.set(name, (bound.get(name) ?? 0) + 1);
  }
  const loops = new Map<string, readonly ShellWord[]>();
  for (const words of read.commands) {
    const [head, name, keyword] = words;
    if (head?.value === "for" && keyword?.value === "in" && name) loops.set(name.value, words.slice(3));
  }
  const scope: Scope = {
    cwd,
    home: options.home ?? homedir(),
    cmd,
    env: options.env ?? {},
    bound,
    loops,
    dotMatches: cmd || bound.has("dotglob") || bound.has("GLOBIGNORE"),
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
  if (/\$['"]/.test(word.raw)) return [[{ wild: "any" }]];
  const text = word.value;
  let variants: Part[][] = [[]];
  const append = (options: readonly Pattern[]) => {
    const next: Part[][] = [];
    for (const v of variants) for (const o of options) next.push([...v, ...o]);
    variants = next.length > MAX_VARIANTS ? [[{ wild: "any" }]] : next;
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i] ?? "";
    const param = word.expands.some((name) => name !== "%") ? /^\$(?:\{([^}]*)\}|([A-Za-z_]\w*|[0-9?#$!@*-]))/.exec(rest) : null;
    const percent = scope.cmd && word.expands.includes("%") ? /^%[^%\s]+%/.exec(rest) : null;
    if (param) {
      const name = param[1] ?? param[2] ?? "";
      append(/^(?:[A-Za-z_]\w*|[0-9?#$!@*-])$/.test(name) ? variable(name, scope, depth) : [[{ wild: "any" }]]);
      i += param[0].length;
    } else if (percent) {
      append([[{ wild: "any" }]]);
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
        append([[{ wild: "star" }]]);
      }
      i = close < 0 ? text.length : close + 1;
    } else if (word.glob && c === "*") {
      const run = /^\*+/.exec(rest)?.[0].length ?? 1;
      append([[{ wild: run > 1 ? "deep" : "star" }]]);
      i += run;
    } else if (word.glob && (c === "?" || (c === "[" && text.indexOf("]", i + 2) > 0))) {
      append([[{ wild: "one" }]]);
      i = c === "[" ? text.indexOf("]", i + 2) + 1 : i + 1;
    } else if (c === OPEN && braceEnd(text, i) > 0) {
      const end = braceEnd(text, i);
      const body = text.slice(i + 1, end);
      if (body.includes(OPEN)) append([[{ wild: "any" }]]);
      else if (body.includes(",")) append(body.split(",").flatMap((alt) => wordPatterns({ ...word, value: alt }, scope, depth)));
      else if (/^[^.]+\.\.[^.]+$/.test(body)) append([[{ wild: "star" }]]);
      else append([[{ text: `{${body}}` }]]);
      i = end + 1;
    } else {
      append([[{ text: c === OPEN ? "{" : c === CLOSE ? "}" : c }]]);
      i += 1;
    }
  }
  return variants.map(merge);
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
 * What `$NAME` can hold. Known only when the child's environment sets it and
 * the command never writes the name (assignment, `read`, `for`, `export`…);
 * a `for` variable holds its list's words.
 */
function variable(name: string, scope: Scope, depth: number): Pattern[] {
  if (/^[?#$!]$/.test(name)) return [[{ text: "0" }]];
  const list = scope.loops.get(name);
  if (list && scope.bound.get(name) === 1 && depth < 2) {
    return list.flatMap((word) => wordPatterns(word, scope, depth + 1));
  }
  if (name === "PWD" && !["cd", "pushd", "popd"].some((verb) => scope.bound.has(verb))) return [[{ text: scope.cwd }]];
  const value = scope.env[name];
  return value !== undefined && !scope.bound.has(name) ? [[{ text: value }]] : [[{ wild: "any" }]];
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
    pattern = merge([prefix === "~" ? { text: scope.home } : { wild: "any" }, { text: lead.slice(prefix.length) }, ...p.slice(1)]);
  }
  if (pattern.every((part) => "text" in part)) {
    // Only names shaped like paths (or redirection targets): `environment`
    // is not `.env`, `grep process.env` names a pattern, not a file.
    const text = leadText(pattern);
    if (!(isFile || /[/\\]/.test(text) || lead.startsWith(".") || lead.startsWith("~"))) return false;
    return isSensitivePath(isAbsolute(text) ? text : resolve(scope.cwd, text));
  }
  return couldBeSensitive(pattern, scope);
}

/**
 * Could some expansion of the pattern be a protected path? Three views, each
 * decided by the blocklist itself: the fixed directory the expansion happens
 * in, the sample names the expansion can take there, and the shortest text
 * each wildcard can supply (the literal parts may carry the name: `q*.env`).
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
