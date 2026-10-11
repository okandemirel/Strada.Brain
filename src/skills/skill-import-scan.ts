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
// `require(…)`) is a Node built-in or a relative path (`./`, `../`) that stays
// inside the skill directory at every step and names a file the scan reads,
// and every `import()`/`require()` takes a string literal. A relative path is
// resolved from the importer's REAL path, so one that climbs out and back in
// can land elsewhere when a parent directory is a symlink; and CommonJS runs a
// file of any unknown extension, or none, as JavaScript. Every package.json
// "main" under the skill is held to the same rule: CommonJS follows it for a
// directory specifier (`require("./lib")`). Dependencies must be vendored into
// the skill directory and imported by relative path, or bundled into it.
// Type-only imports (`import type`) and declaration files are exempt: they are
// erased before anything runs.
//
// This is a static text scan, and deliberately conservative: it reads the raw
// source, comments and strings included, so text that merely looks like a
// loading statement is refused rather than silently allowed. The type-only
// exemption is the one place it removes text, so it applies only where the
// scan can place the statement in code with certainty (maskCertainCode). It
// covers the module graph Node resolves on the skill's behalf; it is not a
// sandbox — code that reads and evaluates other files at run time does so in
// plain sight in the source the user approves.
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
/** `… from "x"` (static import / re-export) and side-effect `import "x"`. */
const STATIC_SPECIFIER = /\bfrom\s*(["'])([^"'\r\n]*)\1|\bimport\s*(["'])([^"'\r\n]*)\3/g;
/** A call that loads a module: `import(…)`, `require(…)`. */
const LOADING_CALL = /\b(import|require)\s*\(\s*/g;
/** The call's argument when it is a single string literal. */
const LITERAL_ARGUMENT = /^(["'`])([^"'`\r\n]*)\1\s*[,)]/;
/** `createRequire` hands out a require function under any name; its calls cannot be recognised. */
const CREATE_REQUIRE = /\bcreateRequire\b/;
/**
 * Refused rather than interpreted: the raw text is scanned, so escapes are
 * not decoded, and URL parsing (ESM) reads `%`, `?`, `#`, `\` and control
 * characters differently from a path (CommonJS).
 */
const UNCHECKED_CHARACTER = /[\\%?#\u0000-\u001f\u007f]/;
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

/** Does `specifier`, loaded from `fromFile`, resolve outside `skillRoot` (or to a file the scan does not read)? */
export function specifierLeavesSkill(skillRoot: string, fromFile: string, specifier: string): boolean {
  if (specifier.startsWith("node:") || isBuiltin(specifier)) return false;
  // A package name (the skill's own name included), a `#` import-map entry,
  // an absolute path or a URL is resolved through lookups or locations the
  // skill directory does not decide.
  if (!RELATIVE_SPECIFIER.test(specifier) || UNCHECKED_CHARACTER.test(specifier)) return true;
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
  const found = new Set<string>();
  for (const match of code.matchAll(STATIC_SPECIFIER)) {
    const specifier = match[2] ?? match[4] ?? "";
    if (specifierLeavesSkill(skillRoot, file, specifier)) found.add(`"${specifier}"`);
  }
  for (const match of code.matchAll(LOADING_CALL)) {
    const start = (match.index ?? 0) + match[0].length;
    const literal = LITERAL_ARGUMENT.exec(code.slice(start, start + 1024));
    const specifier = literal?.[2];
    if (specifier === undefined || (literal?.[1] === "`" && specifier.includes("${"))) {
      found.add(`${match[1]}() with a computed specifier`);
    } else if (specifierLeavesSkill(skillRoot, file, specifier)) {
      found.add(`"${specifier}"`);
    }
  }
  if (CREATE_REQUIRE.test(code)) found.add("createRequire()");
  return [...found];
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
