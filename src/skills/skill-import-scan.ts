// ---------------------------------------------------------------------------
// SEC-4: module specifiers in a workspace skill's code that Node would resolve
// OUTSIDE the skill directory.
//
// A workspace skill's approval (skill-trust.ts) is a hash of its directory.
// Importing its entry point runs whatever module graph Node resolves from it,
// and resolution does not stop at that directory: a relative path can climb
// out of it, and a bare package name is looked up in the node_modules folder
// of every parent directory. Code reached that way is not in the hash, so it
// could change after approval without invalidating it.
//
// The rule a workspace skill must meet to be approved: every specifier in its
// code (`import … from`, `export … from`, `import "…"`, `import(…)`,
// `import.source(…)`, `require(…)`, `process.getBuiltinModule(…)`) is a Node
// built-in or a relative path (`./`, `../`) that stays inside the skill
// directory at every step, never enters the `.git` directory the hash skips,
// and names a file the scan reads; and every such call takes a string
// literal. A relative path is resolved from the importer's REAL path, so one
// that climbs out and back in can land elsewhere when a parent directory is a
// symlink; and CommonJS runs a file of any unknown extension, or none, as
// JavaScript. Every package.json "main" under the skill is held to the same
// rule: CommonJS follows it for a directory specifier (`require("./lib")`).
// `require` appears only called that way: `(0, require)(…)`, `require.call(…)`
// or `const r = require` hand the loader to code that calls it with a name the
// scan never sees. The loader's internals (`createRequire`, `Module._load`,
// `process.dlopen`), the `node:module` built-in that hands them out, and the
// JSX pragmas that make tsx add an import (`@jsxRuntime`, `@jsxImportSource`)
// do not appear at all. Dependencies must be vendored into the skill directory
// and imported by relative path, or bundled into it. Type-only imports
// (`import type`) and declaration files are exempt: they are erased before
// anything runs.
//
// This is a static text scan, and deliberately conservative: it reads the raw
// source, comments and strings included, so text that merely looks like a
// loading statement is refused rather than silently allowed. It reads every
// such word as V8 would if it were code: any comment may stand between two
// tokens (`import /* x */ "…"`), an identifier may be spelled with `\u`
// escapes (`\u0072equire`), and a string ends where V8 ends it. Prose passes
// only where reading it as code gives a syntax error (`require a token`). No
// parser decides what is code: those available at run time read some source
// differently from V8 (tree-sitter reads `f = () => {}\n/'/; …` as a division
// where V8 reads a regex), and code a parser placed in a string or comment
// would be exempt. The type-only exemption is the one place the scan removes
// text, so it applies only where the scan can place the statement in code with
// certainty (maskCertainCode). It covers the module graph Node and tsx resolve
// on the skill's behalf; it is not a sandbox — code that reaches the loader or
// other files through a name computed at run time (`module[name]`,
// `arguments[1]`, `eval`) does so in plain sight in the source the user
// approves.
// ---------------------------------------------------------------------------

import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, relative, sep } from "node:path";

/** Extensions Node (or the tsx loader) runs as module code. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);
/** What a specifier may name besides code: JSON data, and native addons (hashed, but not text to scan). */
const DATA_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".node"]);

/**
 * Type-only imports/re-exports, removed before scanning (erased at run time).
 * Matched in masked text only, and the braces may hold nothing but names,
 * commas and (blanked) comments, so a match never runs into another statement.
 */
const TYPE_ONLY_STATEMENT =
  /\b(?:import|export)\s+type\s+(?:\{[\w$\s,]*\}\s*|\*(?:\s*as\s+[\w$]+)?\s*|[\w$]+\s+)from\s*(["'])[^"'\r\n]*\1/g;
/**
 * One step of maskCertainCode: a comment (1), a string literal (2), a
 * character whose meaning a plain lexer cannot settle (3), or plain code.
 */
const CERTAIN_CODE_TOKEN =
  /(\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*')|([/`<"']|-->)|[^/`<"'-]+|-/y;
/** An identifier as V8 reads it, `\u` escapes included. */
const IDENTIFIER = /(?:[\p{ID_Continue}$\u200c\u200d]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})+/gu;
const IDENTIFIER_AT = new RegExp(IDENTIFIER.source, "uy");
const IDENTIFIER_ESCAPE = /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g;
/**
 * A string (1, 2) or template (3) literal as V8 delimits it. Escapes and line
 * continuations stay in the body as written, where UNCHECKED_CHARACTER refuses
 * them: `"../../evil\<newline>.js"` names ../../evil.js.
 */
const STRING_LITERAL =
  /"((?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*)"|'((?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*)'|`((?:[^`\\]|\\[\s\S])*)`/y;
/** Whitespace, which V8 lets stand between two tokens. */
const WHITESPACE = /\s+/y;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
/** Functions that load the module named by their argument: checked where called directly with a literal. */
const LOADING_FUNCTIONS: ReadonlySet<string> = new Set(["import", "require", "getBuiltinModule"]);
/**
 * Words that may follow an expression on the same line (JS and TS). A
 * loading function followed by any other word there is prose: as code the
 * pair is a syntax error, so nothing runs.
 */
const EXPRESSION_WORDS: ReadonlySet<string> = new Set(["in", "instanceof", "of", "as", "satisfies", "implements"]);
/** The loader's internals: they load by a name or path decided at run time, so they may not appear at all. */
const LOADER_INTERNALS: ReadonlySet<string> = new Set(["createRequire", "_load", "dlopen"]);
/** Comment pragmas that make esbuild (tsx) add `import … from "<source>/jsx-runtime"` to a JSX file. */
const JSX_RUNTIME_PRAGMAS: ReadonlySet<string> = new Set(["jsxRuntime", "jsxImportSource"]);
/** Directory names excluded from the trust hash (skill-trust.ts). `node_modules` is NOT here (round 7 #10). */
export const HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git"]);
/**
 * Refused rather than interpreted, in any specifier, built-in names included:
 * the raw text is scanned, so escapes and line continuations are not decoded
 * (`"node:\x6dodule"` is node:module to V8), and URL parsing (ESM) reads `%`,
 * `?`, `#`, `\` and control characters differently from a path (CommonJS).
 */
const UNCHECKED_CHARACTER = /[\\%?#\u0000-\u001f\u007f\u2028\u2029]/;
/** `./…`, `../…`, `.` or `..`: the only specifiers resolved from the importer alone. */
const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;
/** A JSON string token, or any other single character (valid JSON only). */
const JSON_TOKEN = /"(?:[^"\\]|\\[\s\S])*"|[^\s"]/g;

/**
 * Whether the scan checks this file's specifiers: code that runs (not `.d.ts`),
 * including an extensionless file, which CommonJS runs as JavaScript when it
 * is required by name.
 */
export function isSkillCodeFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === "" || (CODE_EXTENSIONS.has(ext) && !/\.d\.[cm]?ts$/i.test(name));
}

/**
 * Does `specifier`, loaded from `fromFile`, resolve outside `skillRoot` (or to
 * a file the scan does not read, or to the loader itself)?
 */
export function specifierLeavesSkill(skillRoot: string, fromFile: string, specifier: string): boolean {
  if (UNCHECKED_CHARACTER.test(specifier)) return true;
  if (specifier === "module" || specifier === "node:module") return true;
  if (specifier.startsWith("node:") || isBuiltin(specifier)) return false;
  // A package name (the skill's own name included), a `#` import-map entry,
  // an absolute path or a URL is resolved through lookups or locations the
  // skill directory does not decide.
  if (!RELATIVE_SPECIFIER.test(specifier)) return true;
  const from = relative(skillRoot, dirname(fromFile));
  if (isAbsolute(from) || from === ".." || from.startsWith(`..${sep}`)) return true;
  // Never above the skill root, not even on the way back in: Node resolves
  // from the importer's realpath, so `../../skills/<name>/x.js` through a
  // symlinked `<project>/skills` is a different file from the one it spells.
  let depth = from === "" ? 0 : from.split(sep).length;
  const segments = specifier.split("/");
  for (const segment of segments) {
    if (segment === "..") depth--;
    else if (segment !== "." && segment !== "") depth++;
    if (depth < 0) return true;
    // macOS and Windows find `.git` under any letter case, and Windows drops
    // a segment's trailing dots and spaces.
    if (HASH_EXCLUDED_DIRS.has(segment.toLowerCase().replace(/[. ]+$/, ""))) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  return !isSkillCodeFile(last) && !DATA_EXTENSIONS.has(extname(last).toLowerCase());
}

/**
 * The leading part of `source` whose lexical context is certain, with
 * comments blanked and string contents replaced by `-` (offsets map 1:1 back
 * to `source`). It ends at the first character a plain lexer cannot settle —
 * `/` outside a comment (regex or division), a backtick (template
 * expressions), `<` (JSX text, `<!--`), `-->` — or at a string or comment
 * that does not close. Past that point text that looks like `import type {`
 * may sit in a regex, JSX text or a template, and erasing it could take a
 * real loading statement with it.
 */
function maskCertainCode(source: string): string {
  const parts: string[] = [];
  let at = 0;
  const blank = (text: string): string => text.replace(/[^\n\r\u2028\u2029]/g, " ");
  if (source.startsWith("#!")) {
    at = source.search(/[\n\r\u2028\u2029]/);
    if (at < 0) at = source.length;
    parts.push(blank(source.slice(0, at)));
  }
  while (at < source.length) {
    CERTAIN_CODE_TOKEN.lastIndex = at;
    const token = CERTAIN_CODE_TOKEN.exec(source);
    if (!token || token[3] !== undefined) break;
    const [text] = token;
    if (token[1] !== undefined) parts.push(blank(text));
    else if (token[2] !== undefined) parts.push(text[0] + "-".repeat(text.length - 2) + text[0]);
    else parts.push(text);
    at += text.length;
  }
  return parts.join("");
}

/** `source` with its type-only statements (those in certain code) blanked out. */
function withoutTypeOnlyStatements(source: string): string {
  const parts: string[] = [];
  let kept = 0;
  for (const match of maskCertainCode(source).matchAll(TYPE_ONLY_STATEMENT)) {
    parts.push(source.slice(kept, match.index), " ");
    kept = match.index + match[0].length;
  }
  parts.push(source.slice(kept));
  return parts.join("");
}

/**
 * The loading statements in `source` (the text of `file`, somewhere under
 * `skillRoot`) that leave the skill directory or cannot be checked, as short
 * descriptions. Empty when the file only loads built-ins and its own siblings.
 */
export function findOutsideImports(skillRoot: string, file: string, source: string): string[] {
  const code = withoutTypeOnlyStatements(source);
  const gaps = gapReader(code);
  const skipGap = gaps.skip;
  const found = new Set<string>();
  const check = (specifier: string): void => {
    if (specifierLeavesSkill(skillRoot, file, specifier)) found.add(`"${specifier}"`);
  };
  for (const match of code.matchAll(IDENTIFIER)) {
    let name = identifierName(match[0]);
    if (LOADER_INTERNALS.has(name)) found.add(`${name}()`);
    if (JSX_RUNTIME_PRAGMAS.has(name)) found.add(`@${name}`);
    if (name !== "from" && !LOADING_FUNCTIONS.has(name)) continue;
    const end = match.index + match[0].length;
    let at = skipGap(end);
    if (name === "from" || name === "import") {
      // `… from "x"` (static import / re-export) and side-effect `import "x"`.
      const literal = literalAt(code, at);
      if (literal !== undefined && literal.quote !== "`") check(literal.body);
      if (name === "from") continue;
      // `import.meta` is data; `import.source(…)` (a wasm module, which the
      // skill can then run) and `import.defer(…)` load like `import(…)`.
      if (code[at] === ".") {
        const phase = identifierAt(code, skipGap(at + 1));
        if (phase === undefined || phase.name === "meta") continue;
        name = `import.${phase.name}`;
        at = skipGap(phase.end);
      }
    } else {
      const word = identifierAt(code, at);
      if (word !== undefined && !EXPRESSION_WORDS.has(word.name) && !gaps.breaksLine(end, at)) continue;
    }
    if (code.startsWith("?.", at)) at = skipGap(at + 2);
    if (code[at] !== "(") {
      // `import` also opens a declaration (checked above), and an import
      // phase that is not called is a syntax error (or prose: "import. Then").
      if (!name.startsWith("import")) found.add(`${name} used other than as a direct call`);
      continue;
    }
    const argument = literalAt(code, skipGap(at + 1));
    const after = argument === undefined ? undefined : code[skipGap(argument.end)];
    if (argument === undefined || (after !== "," && after !== ")") || (argument.quote === "`" && argument.body.includes("${"))) {
      found.add(`${name}() with a computed specifier`);
    } else {
      check(argument.body);
    }
  }
  return [...found];
}

/** `spelled` with its `\u` escapes decoded: V8 reads `\u0072equire` as `require`. */
function identifierName(spelled: string): string {
  if (!spelled.includes("\\")) return spelled;
  return spelled.replace(IDENTIFIER_ESCAPE, (escape, braced: string | undefined, four: string | undefined) => {
    const codePoint = parseInt(braced ?? four ?? "", 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
  });
}

/** The identifier that starts at `at`, if one does, with its escapes decoded. */
function identifierAt(code: string, at: number): { name: string; end: number } | undefined {
  IDENTIFIER_AT.lastIndex = at;
  const identifier = IDENTIFIER_AT.exec(code);
  return identifier ? { name: identifierName(identifier[0]), end: IDENTIFIER_AT.lastIndex } : undefined;
}

/** The string or template literal that starts at `at`, if one does. */
function literalAt(code: string, at: number): { quote: string; body: string; end: number } | undefined {
  STRING_LITERAL.lastIndex = at;
  const literal = STRING_LITERAL.exec(code);
  if (!literal) return undefined;
  return { quote: code[at] ?? "", body: literal[1] ?? literal[2] ?? literal[3] ?? "", end: STRING_LITERAL.lastIndex };
}

/**
 * `skip` passes what V8 lets stand between two tokens from `at`: whitespace
 * and comments, including the `<!--` and `-->` line comments of a CommonJS
 * script (accepted anywhere here, which only adds matches). Comment ends come
 * from a sorted index and every walk's end is remembered at each comment it
 * passed, so text whose keywords sit in comments that look nested
 * (`from /*from /*…`) costs one walk, not one walk to the end per keyword.
 * `breaksLine` says whether a gap holds a line terminator, after which ASI
 * can end the statement.
 */
function gapReader(code: string): { skip: (at: number) => number; breaksLine: (from: number, to: number) => boolean } {
  let blockCloses: number[] | undefined;
  let lineEnds: number[] | undefined;
  const lineEndIndex = (): number[] => (lineEnds ??= Array.from(code.matchAll(LINE_TERMINATOR), (terminator) => terminator.index));
  const breaksLine = (from: number, to: number): boolean => (firstAtOrAfter(lineEndIndex(), from) ?? Infinity) < to;
  const walked = new Map<number, number>();
  const skip = (at: number): number => {
    const passed: number[] = [];
    let end: number | undefined;
    while (end === undefined) {
      WHITESPACE.lastIndex = at;
      if (WHITESPACE.test(code)) at = WHITESPACE.lastIndex;
      if (code.startsWith("/*", at)) {
        blockCloses ??= Array.from(code.matchAll(/\*\//g), (close) => close.index);
        const close = firstAtOrAfter(blockCloses, at + 2);
        // An unclosed comment is a syntax error, not a gap.
        if (close === undefined) end = at;
        else at = close + 2;
      } else if (code.startsWith("//", at) || code.startsWith("<!--", at) || code.startsWith("-->", at)) {
        at = firstAtOrAfter(lineEndIndex(), at) ?? code.length;
      } else {
        end = at;
      }
      if (end === undefined) {
        passed.push(at);
        end = walked.get(at);
      }
    }
    for (const position of passed) walked.set(position, end);
    return end;
  };
  return { skip, breaksLine };
}

/** The first entry of ascending `sorted` that is at least `from`. */
function firstAtOrAfter(sorted: readonly number[], from: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? Infinity) < from) low = mid + 1;
    else high = mid;
  }
  return sorted[low];
}

/**
 * The `main` entries of a package.json under the skill (`source`, the text of
 * `file`) that resolve outside it or to a file the scan does not read, as
 * short descriptions. CommonJS follows `main` for a directory specifier, so
 * `require("./lib")` lands wherever lib/package.json points. Every key
 * spelled `main` is checked, at any depth: Node matches the raw key (the last
 * one wins) while JSON.parse unescapes it. `exports` and `imports` are not:
 * Node consults them only for package and `#` specifiers, which are refused
 * everywhere in the skill.
 */
export function findOutsidePackageTargets(skillRoot: string, file: string, source: string): string[] {
  const text = source.replace(/^\uFEFF/, "");
  try {
    JSON.parse(text);
  } catch {
    return ["package.json does not parse, so its main cannot be checked"];
  }
  const found = new Set<string>();
  let key: string | null = null;
  let valueOf: string | null = null;
  for (const [token] of text.matchAll(JSON_TOKEN)) {
    if (valueOf !== null) {
      if (token.startsWith('"') && (valueOf === '"main"' || JSON.parse(valueOf) === "main")) {
        const main = token.slice(1, -1);
        // A bare `main` ("index.js") is a path relative to the package, not a package name.
        const specifier = RELATIVE_SPECIFIER.test(main) ? main : `./${main}`;
        if (isAbsolute(main) || main.includes(":") || specifierLeavesSkill(skillRoot, file, specifier)) {
          found.add(`main "${main}"`);
        }
      }
      valueOf = null;
      key = null;
    } else if (token === ":" && key !== null) {
      valueOf = key;
    } else {
      key = token.startsWith('"') ? token : null;
    }
  }
  return [...found];
}
