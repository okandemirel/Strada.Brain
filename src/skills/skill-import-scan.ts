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
// `require(…)`) is a Node built-in or a relative path that stays inside the
// skill directory, and every `import()`/`require()` takes a string literal.
// Dependencies must be vendored into the skill directory and imported by
// relative path, or bundled into it. Type-only imports (`import type`) and
// declaration files are exempt: they are erased before anything runs.
//
// This is a static text scan, and deliberately conservative: it reads the raw
// source, comments and strings included, so text that merely looks like a
// loading statement is refused rather than silently allowed. It covers the
// module graph Node resolves on the skill's behalf; it is not a sandbox — code
// that reads and evaluates other files at run time does so in plain sight in
// the source the user approves.
// ---------------------------------------------------------------------------

import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Extensions Node (or the tsx loader) runs as module code. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);

/** Type-only imports/re-exports, removed before scanning (erased at run time). */
const TYPE_ONLY_STATEMENT =
  /\b(?:import|export)\s+type\s+(?:\{[^}]*\}\s*|\*(?:\s*as\s+[\w$]+)?\s*|[\w$]+\s+)from\s*(["'])[^"'\r\n]*\1/g;
/** `… from "x"` (static import / re-export) and side-effect `import "x"`. */
const STATIC_SPECIFIER = /\bfrom\s*(["'])([^"'\r\n]*)\1|\bimport\s*(["'])([^"'\r\n]*)\3/g;
/** A call that loads a module: `import(…)`, `require(…)`. */
const LOADING_CALL = /\b(import|require)\s*\(\s*/g;
/** The call's argument when it is a single string literal. */
const LITERAL_ARGUMENT = /^(["'`])([^"'`\r\n]*)\1\s*[,)]/;
/** `createRequire` hands out a require function under any name; its calls cannot be recognised. */
const CREATE_REQUIRE = /\bcreateRequire\b/;

/** Whether the scan checks this file's specifiers (code that runs; not `.d.ts`). */
export function isSkillCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.has(extname(name).toLowerCase()) && !/\.d\.[cm]?ts$/i.test(name);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Does `specifier`, loaded from `fromFile`, resolve outside `skillRoot` (or by lookups that can)? */
export function specifierLeavesSkill(skillRoot: string, fromFile: string, specifier: string): boolean {
  if (specifier.startsWith("node:") || isBuiltin(specifier)) return false;
  // The raw source text is scanned, so string escapes are not interpreted:
  // refuse a backslash rather than guess what it means.
  if (specifier.includes("\\")) return true;
  const fileUrl = /^file:/i.test(specifier);
  const pathLike =
    fileUrl || /^\.\.?(?:[/\\]|$)/.test(specifier) || isAbsolute(specifier) || win32.isAbsolute(specifier);
  // A package name, a `#` import-map entry or a non-file URL is resolved
  // through package lookups that reach outside the skill directory.
  if (!pathLike) return true;
  // CommonJS reads the text as a path, ESM as a URL (which also treats `\`
  // and percent-encoded dot segments as separators/`..`): both must stay inside.
  try {
    const targets = [fileURLToPath(new URL(specifier, pathToFileURL(fromFile)))];
    if (!fileUrl) targets.push(resolve(dirname(fromFile), specifier));
    return targets.some((target) => !isInside(skillRoot, target));
  } catch {
    return true;
  }
}

/**
 * The loading statements in `source` (the text of `file`, somewhere under
 * `skillRoot`) that leave the skill directory or cannot be checked, as short
 * descriptions. Empty when the file only loads built-ins and its own siblings.
 */
export function findOutsideImports(skillRoot: string, file: string, source: string): string[] {
  const code = source.replace(TYPE_ONLY_STATEMENT, " ");
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
