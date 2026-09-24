/**
 * A small shell reader shared by the deterministic shell gates.
 *
 * Three gates judge a shell command without running it: the project-scoped
 * allowlist (pre-approval), the shell-review fallback (approval when the LLM
 * reviewer is unavailable) and destructiveShellFlag (outright refusal). Each
 * used to carry its own regexes over the raw text, and each could read a
 * different program from the one the shell runs: a newline, a lone `&`, a
 * `$(…)` or a redirection hid a second command inside what looked like one.
 *
 * This reads a line the way bash does (quotes, escapes, list and pipeline
 * operators, substitutions) and reports every construct it does not model as
 * a hazard, so a caller can refuse what it cannot read instead of guessing.
 *
 * shell_exec runs cmd.exe on Windows, which quotes differently: `'` is not a
 * quote, `\` does not escape, `^` does, and `%NAME%` expands. With `cmd`,
 * text whose operators cmd.exe would split differently is a hazard too.
 */

export interface ShellWord {
  /** The word after bash quote removal; `$NAME` and substitutions stay as written. */
  readonly value: string;
  /** The word exactly as written. */
  readonly raw: string;
  /** Parameters the word expands ("HOME", "1", "?"); a complex `${…}` is listed whole. */
  readonly expands: readonly string[];
  /** The word holds an unquoted `*`, `?` or `[` (pathname expansion). */
  readonly glob: boolean;
}

export type ShellOperator = "|" | "|&" | "&&" | "||" | ";" | "&" | "newline";

export type ShellHazard =
  | "newline" // a raw CR or LF anywhere: a second command line
  | "background" // a lone `&`
  | "substitution" // $( ), backticks, <( ), >( )
  | "redirection" // <, >, <<, &> …
  | "grouping" // ( ) { }
  | "comment" // # …
  | "tilde" // ~ expansion
  | "ansi-quote" // $'…' / $"…"
  | "unterminated" // an unclosed quote or substitution, or nesting too deep to read
  | "cmd-quoting" // cmd.exe would split this line differently
  | "cmd-expansion"; // cmd.exe %NAME% expansion

export interface ShellLex {
  /** Simple commands in order; `operators[i]` joins `commands[i]` and `commands[i + 1]`. */
  readonly commands: readonly (readonly ShellWord[])[];
  readonly operators: readonly ShellOperator[];
  /** Targets of output redirections (`>`, `>>`, `&>`, `>|`, `<>`), as values. */
  readonly redirectTargets: readonly string[];
  /** The commands inside `$(…)`, backticks and `<(…)`, each read on its own. */
  readonly nested: readonly ShellLex[];
  readonly hazards: ReadonlySet<ShellHazard>;
}

export interface LexOptions {
  /** Also read the line as cmd.exe would. Defaults to running on Windows. */
  readonly cmd?: boolean;
}

const MAX_DEPTH = 8;

/** Index of the `)` closing a `(` opened just before `from`, or -1. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (c === "\\") {
      j += 1;
    } else if (c === "'") {
      j = text.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"') {
      j += 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return -1;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function closingBacktick(text: string, from: number): number {
  for (let j = from; j < text.length; j += 1) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === "`") return j;
  }
  return -1;
}

export function lexShell(command: string, options: LexOptions = {}): ShellLex {
  return lex(command, options.cmd ?? process.platform === "win32", 0);
}

function lex(command: string, cmd: boolean, depth: number): ShellLex {
  const hazards = new Set<ShellHazard>();
  const commands: ShellWord[][] = [];
  const operators: ShellOperator[] = [];
  const redirectTargets: string[] = [];
  const nested: ShellLex[] = [];

  if (/[\r\n]/.test(command)) hazards.add("newline");
  if (cmd) {
    if (/%[^%\s]+%/.test(command)) hazards.add("cmd-expansion");
    // cmd.exe does not honour `\"`, and `^"` is a literal quote to it: either
    // one shifts its quoting against bash's.
    if (/[\\^]"/.test(command)) hazards.add("cmd-quoting");
  }

  interface Draft { value: string; start: number; expands: string[]; glob: boolean }
  let words: ShellWord[] = [];
  let current: Draft | null = null;
  /** The next word is a redirection target: "" when none is pending. */
  let pendingRedirect = "";
  let i = 0;

  const word = (): Draft => (current ??= { value: "", start: i, expands: [], glob: false });
  // Read through a call: the closures below reassign `current`.
  const draft = (): Draft | null => current;
  const endWord = () => {
    if (!current) return;
    const done: ShellWord = {
      value: current.value,
      raw: command.slice(current.start, i),
      expands: current.expands,
      glob: current.glob,
    };
    current = null;
    if (pendingRedirect) {
      if (pendingRedirect.includes(">")) redirectTargets.push(done.value);
      pendingRedirect = "";
    } else {
      words.push(done);
    }
  };
  const endCommand = (op?: ShellOperator) => {
    endWord();
    pendingRedirect = "";
    commands.push(words);
    words = [];
    if (op) operators.push(op);
  };
  const substitute = (inner: string) => {
    hazards.add("substitution");
    if (depth >= MAX_DEPTH) {
      hazards.add("unterminated");
      return;
    }
    const sub = lex(inner, cmd, depth + 1);
    nested.push(sub);
    for (const h of sub.hazards) hazards.add(h);
  };
  /** `$(…)`, `<(…)`, `>(…)` starting at i, whose `(` is at open. */
  const parenSubstitution = (open: number) => {
    const w = word();
    const end = closingParen(command, open + 1);
    if (end < 0) hazards.add("unterminated");
    const stop = end < 0 ? command.length : end + 1;
    substitute(command.slice(open + 1, end < 0 ? command.length : end));
    w.value += command.slice(i, stop);
    i = stop;
  };
  const backtick = () => {
    const w = word();
    const end = closingBacktick(command, i + 1);
    if (end < 0) hazards.add("unterminated");
    const stop = end < 0 ? command.length : end + 1;
    substitute(command.slice(i + 1, end < 0 ? command.length : end));
    w.value += command.slice(i, stop);
    i = stop;
  };
  const dollar = (quoted: boolean) => {
    const next = command[i + 1] ?? "";
    if (next === "(") {
      parenSubstitution(i + 1);
      return;
    }
    const w = word();
    if (next === "{") {
      const end = command.indexOf("}", i + 2);
      if (end < 0) {
        hazards.add("unterminated");
        w.value += command.slice(i);
        i = command.length;
        return;
      }
      const inner = command.slice(i + 2, end);
      w.expands.push(/^(?:[A-Za-z_]\w*|\d+|[@*#?$!-])$/.test(inner) ? inner : `\${${inner}}`);
      if (/\$\(|`/.test(inner)) substitute(inner);
      w.value += command.slice(i, end + 1);
      i = end + 1;
      return;
    }
    if (!quoted && (next === "'" || next === '"')) {
      // ANSI-C / locale quoting decodes escapes this reader does not.
      hazards.add("ansi-quote");
      i += 1;
      return;
    }
    const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(command.slice(i + 1));
    if (name) {
      w.expands.push(name[0]);
      w.value += `$${name[0]}`;
      i += 1 + name[0].length;
      return;
    }
    w.value += "$";
    i += 1;
  };
  const doubleQuoted = () => {
    const w = word();
    i += 1;
    while (i < command.length && command[i] !== '"') {
      const c = command[i] ?? "";
      if (c === "\\" && /[$`"\\\n]/.test(command[i + 1] ?? "")) {
        if (command[i + 1] !== "\n") w.value += command[i + 1];
        i += 2;
      } else if (c === "$") {
        dollar(true);
      } else if (c === "`") {
        backtick();
      } else {
        w.value += c;
        i += 1;
      }
    }
    if (i >= command.length) hazards.add("unterminated");
    else i += 1;
  };
  const redirection = () => {
    hazards.add("redirection");
    // A bare descriptor number (`2>`) belongs to the operator, not the words.
    if (current && /^\d+$/.test(command.slice(current.start, i))) current = null;
    else endWord();
    const op = /^[<>&|-]+/.exec(command.slice(i))?.[0] ?? command[i] ?? "";
    i += op.length;
    if (op.endsWith("&")) {
      // `2>&1`, `>&-`: a descriptor, not a file.
      const fd = /^(?:\d+|-)(?=$|[\s;&|<>()])/.exec(command.slice(i));
      if (fd) {
        i += fd[0].length;
        return;
      }
    }
    pendingRedirect = op;
  };

  while (i < command.length) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else if (c === "\r" || c === "\n") {
      endCommand("newline");
      i += c === "\r" && next === "\n" ? 2 : 1;
    } else if (c === ";") {
      endCommand(";");
      i += 1;
    } else if (c === "&" && next === "&") {
      endCommand("&&");
      i += 2;
    } else if (c === "&" && next === ">") {
      redirection();
    } else if (c === "&") {
      hazards.add("background");
      endCommand("&");
      i += 1;
    } else if (c === "|") {
      endCommand(next === "|" ? "||" : next === "&" ? "|&" : "|");
      i += next === "|" || next === "&" ? 2 : 1;
    } else if ((c === "<" || c === ">") && next === "(") {
      parenSubstitution(i + 1);
    } else if (c === "<" || c === ">") {
      redirection();
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      // A group or a brace expansion: either way what follows is read as a
      // new command, so a verb inside `( … )` or `{ …; }` is still seen.
      hazards.add("grouping");
      endCommand(";");
      i += 1;
    } else if (c === "#" && draft() === null) {
      hazards.add("comment");
      const eol = command.slice(i).search(/[\r\n]/);
      i = eol < 0 ? command.length : i + eol;
    } else if (c === "\\") {
      if (next === "") {
        word().value += "\\";
        i += 1;
      } else {
        if (cmd && /[&|<>()^%"]/.test(next)) hazards.add("cmd-quoting");
        // `\<newline>` is a line continuation; the newline hazard is set above.
        if (next !== "\n") word().value += next;
        i += 2;
      }
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const body = command.slice(i + 1, end < 0 ? command.length : end);
      if (end < 0) hazards.add("unterminated");
      // cmd.exe reads single-quoted text as unquoted.
      if (cmd && /["&|<>]/.test(body)) hazards.add("cmd-quoting");
      word().value += body;
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      doubleQuoted();
    } else if (c === "`") {
      backtick();
    } else if (c === "$") {
      dollar(false);
    } else {
      const open = draft();
      if (c === "~" && (open === null || /[=:]$/.test(open.value))) hazards.add("tilde");
      if (c === "*" || c === "?" || c === "[") word().glob = true;
      word().value += c;
      i += 1;
    }
  }
  endCommand();

  return { commands, operators, redirectTargets, nested, hazards };
}

/**
 * The simple commands of a line that is nothing more: no hazard, and only the
 * given operators between non-empty commands. Null for anything else.
 */
export function plainCommands(
  command: string,
  joiners: readonly ShellOperator[],
  options?: LexOptions,
): readonly (readonly ShellWord[])[] | null {
  const read = lexShell(command, options);
  if (read.hazards.size > 0) return null;
  if (!read.operators.every((op) => joiners.includes(op))) return null;
  if (read.commands.some((words) => words.length === 0)) return null;
  return read.commands;
}
