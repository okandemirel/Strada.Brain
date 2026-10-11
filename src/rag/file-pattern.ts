import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * SearchOptions.filePattern as a predicate over an indexed file path.
 *
 * The pattern is a glob over the path relative to a project root, with forward
 * slashes — the form grep_search and glob_search take — and a pattern naming a
 * directory also takes the files under it. It used to be tested as a literal
 * substring of the path relative to the daemon's cwd, so every glob, the
 * code_search schema's own example included, dropped every hit (audit tools#4).
 *
 * The pattern is LLM input. picomatch compiled it into a backtracking RegExp,
 * and a glob of eight `*a` runs ending in `b` took 17 s on one path with the
 * event loop blocked — the class MEM-8 fixed for vault pathGlob. This matcher
 * walks each path segment once per pattern token, O(pattern × path), with the
 * pattern's length and brace expansion capped (see filePatternProblem).
 *
 * Syntax and defaults follow grep_search's glob: `**` as a whole segment is
 * any number of directories, `*` any run within a segment, `?` one character,
 * `[...]` a class (`[!...]`/`[^...]` negated), `{a,b}` alternatives, `\` an
 * escape; wildcards never match a name starting with "." unless the pattern
 * spells the dot; a leading "!" or "#" is literal; and matching is
 * case-insensitive on macOS and Windows, case-sensitive elsewhere.
 * Extglobs (`+(a|b)` and the like) are refused rather than misread.
 *
 * A path is in scope when it lies under one of `roots` and its path relative
 * to that root matches; a path under none of them never matches.
 */
export function createFilePatternFilter(
  pattern: string,
  roots: readonly string[],
  options: { readonly nocase?: boolean } = {},
): (filePath: string) => boolean {
  const matches = compileFilePattern(pattern, options.nocase ?? caseInsensitivePlatform());
  const resolvedRoots = [...new Set(roots.map((root) => resolve(root)))];
  // A scoped search filters every chunk in the store; a file holds many.
  const verdicts = new Map<string, boolean>();
  return (filePath) => {
    let verdict = verdicts.get(filePath);
    if (verdict === undefined) {
      verdict = resolvedRoots.some((root) => {
        const rel = relative(root, resolve(root, filePath));
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
        return matches(sep === "/" ? rel : rel.split(sep).join("/"));
      });
      verdicts.set(filePath, verdict);
    }
    return verdict;
  };
}

/** Longest file pattern accepted (the vault pathGlob cap). */
export const MAX_FILE_PATTERN_LENGTH = 256;
/** Most patterns `{a,b}` alternatives may expand into. */
const MAX_BRACE_ALTERNATIVES = 64;
/** Most characters the expanded patterns may hold together: matching costs this × path length. */
const MAX_EXPANDED_LENGTH = 4 * MAX_FILE_PATTERN_LENGTH;

/** Why `pattern` cannot be matched, or undefined when it can; `label` names it in the answer. */
export function filePatternProblem(pattern: string, label = "file_pattern"): string | undefined {
  try {
    compileFilePattern(pattern, false, label);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Most `*` runs one path segment may hold when glob matches it. */
const MAX_GLOB_STARS_PER_SEGMENT = 3;
/**
 * What the segments holding several `*` runs may cost together, over every
 * {a,b} alternative: two runs cost 1 and three cost 8, about the ratio their
 * matching time grows by on 30-60 character names.
 */
const MAX_GLOB_MULTI_STAR_COST = 8;

/**
 * Why `pattern` cannot be handed to glob, or undefined when it can — the guard
 * for grep_search's file_pattern and glob_search's pattern, which glob matches.
 *
 * glob (minimatch) compiles each path segment into a backtracking RegExp in
 * which every `*` run is a lazy `[^/]*?`, so a name that fails a segment with
 * k runs is tried about C(name length, k) ways, on the main thread. `?` makes
 * every ordinary name adversarial: `**` + `/*?*?*?*?*?*?*?*?#` took 1.2 s over
 * 100 Unity file names, and the extglob `+(?|??)` grows exponentially. On top
 * of filePatternProblem's limits, which refuse extglobs, this caps the `*` runs
 * in a segment and what segments with several of them may cost together.
 */
export function globPatternProblem(pattern: string, label = "file_pattern"): string | undefined {
  const problem = filePatternProblem(pattern, label);
  if (problem !== undefined) return problem;
  try {
    let cost = 0;
    for (const alternative of expandBraces(pattern, label)) {
      for (const part of alternative.split("/")) {
        const segment = parseSegment(part, false);
        if (segment.kind === "globstar") continue;
        const stars = segment.tokens.filter((token) => token.kind === "star").length;
        if (stars > MAX_GLOB_STARS_PER_SEGMENT) {
          return (
            `${label} segment '${part}' holds ${stars} '*' wildcards; one path segment may hold at most ` +
            `${MAX_GLOB_STARS_PER_SEGMENT}, because glob tries every way of splitting each file name between them. ` +
            "Use fewer '*' and narrow the results afterwards."
          );
        }
        if (stars >= 2) cost += 8 ** (stars - 2);
      }
    }
    if (cost > MAX_GLOB_MULTI_STAR_COST) {
      return (
        `${label} puts several '*' wildcards into too many path segments, counting every {a,b} alternative: ` +
        `a segment with two counts 1 and one with three counts 8, at most ${MAX_GLOB_MULTI_STAR_COST} in all, ` +
        "because glob tries every way of splitting each file name between them. Use fewer alternatives or fewer '*'."
      );
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** glob (grep_search) defaults to case-insensitive matching on these platforms. */
function caseInsensitivePlatform(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

type CharToken =
  | { readonly kind: "literal"; readonly char: string }
  | { readonly kind: "any-char" }
  | { readonly kind: "class"; readonly negated: boolean; readonly items: readonly (readonly [string, string])[] }
  | { readonly kind: "star" };

/** One path segment of a pattern: a globstar, or tokens that match within one name. */
type Segment =
  | { readonly kind: "globstar" }
  | { readonly kind: "name"; readonly tokens: readonly CharToken[]; readonly dot: boolean };

const GLOBSTAR: Segment = { kind: "globstar" };

/** @throws when the pattern is over a size limit or uses extglob syntax. */
function compileFilePattern(
  pattern: string,
  nocase: boolean,
  label = "file_pattern",
): (relPath: string) => boolean {
  if (pattern.length > MAX_FILE_PATTERN_LENGTH) {
    throw new Error(`${label} is too long (${pattern.length} characters, max ${MAX_FILE_PATTERN_LENGTH})`);
  }
  if (hasExtglob(pattern)) {
    throw new Error(
      `${label} uses extglob syntax such as +(a|b) or @(a|b), which is not supported; list alternatives as {a,b}`,
    );
  }
  const directory = pattern.replace(/\/+$/, "") || pattern;
  const alternatives = expandBraces(directory, label);
  const compiled = alternatives
    .map((alternative) => alternative.replace(/^(\.\/)+/, ""))
    // An absolute alternative never names a project-relative path.
    .filter((alternative) => !alternative.startsWith("/"))
    .map((alternative) => {
      const segments = alternative.split("/").filter((part) => part !== "").map((part) => parseSegment(part, nocase));
      // A pattern naming a directory also takes the files under it.
      if (segments[segments.length - 1] !== GLOBSTAR) segments.push(GLOBSTAR);
      return segments;
    });
  return (relPath) => {
    const names = relPath.split("/");
    return compiled.some((segments) => matchSegments(segments, names, nocase));
  };
}

function hasExtglob(pattern: string): boolean {
  for (let i = 0; i < pattern.length - 1; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if ("@!+*?".includes(pattern[i]!) && pattern[i + 1] === "(") return true;
  }
  return false;
}

/**
 * `{a,b}` alternatives, nested ones included, expanded into whole patterns.
 * A brace pair without a top-level comma is literal, as in grep_search.
 */
function expandBraces(pattern: string, label: string): string[] {
  const out: string[] = [];
  let expandedLength = 0;
  const expand = (p: string): void => {
    const group = findBraceGroup(p);
    if (!group) {
      out.push(p);
      expandedLength += p.length;
      if (out.length > MAX_BRACE_ALTERNATIVES) {
        throw new Error(`${label} expands to more than ${MAX_BRACE_ALTERNATIVES} {a,b} alternatives`);
      }
      if (expandedLength > MAX_EXPANDED_LENGTH) {
        throw new Error(`${label}'s {a,b} alternatives expand past ${MAX_EXPANDED_LENGTH} characters`);
      }
      return;
    }
    const prefix = p.slice(0, group.open);
    const suffix = p.slice(group.close + 1);
    for (const alternative of group.alternatives) expand(prefix + alternative + suffix);
  };
  expand(pattern);
  return out;
}

function findBraceGroup(p: string): { open: number; close: number; alternatives: string[] } | undefined {
  for (let open = 0; open < p.length; open++) {
    if (p[open] === "\\") {
      open++;
      continue;
    }
    if (p[open] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    for (let i = open; i < p.length; i++) {
      const c = p[i];
      if (c === "\\") {
        i++;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          if (commas.length === 0) break; // "{a}" is literal; a group may still open after it
          const bounds = [open, ...commas, i];
          const alternatives = bounds.slice(1).map((end, k) => p.slice(bounds[k]! + 1, end));
          return { open, close: i, alternatives };
        }
      } else if (c === "," && depth === 1) {
        commas.push(i);
      }
    }
  }
  return undefined;
}

function parseSegment(part: string, nocase: boolean): Segment {
  if (/^\*\*+$/.test(part)) return GLOBSTAR;
  const tokens: CharToken[] = [];
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (c === "\\" && i + 1 < part.length) {
      tokens.push(literal(part[++i]!, nocase));
    } else if (c === "*") {
      while (part[i + 1] === "*") i++;
      tokens.push({ kind: "star" });
    } else if (c === "?") {
      tokens.push({ kind: "any-char" });
    } else if (c === "[") {
      const parsed = parseClass(part, i, nocase);
      if (parsed) {
        tokens.push(parsed.token);
        i = parsed.end;
      } else {
        tokens.push(literal(c, nocase));
      }
    } else {
      tokens.push(literal(c, nocase));
    }
  }
  const first = tokens[0];
  return { kind: "name", tokens, dot: first?.kind === "literal" && first.char === "." };
}

function literal(char: string, nocase: boolean): CharToken {
  return { kind: "literal", char: nocase ? char.toLowerCase() : char };
}

/** The class opening at `start`, or undefined when it never closes (then "[" is literal). */
function parseClass(part: string, start: number, nocase: boolean): { token: CharToken; end: number } | undefined {
  let i = start + 1;
  const negated = part[i] === "!" || part[i] === "^";
  if (negated) i++;
  const items: (readonly [string, string])[] = [];
  let first = true;
  for (; i < part.length; i++) {
    let c = part[i]!;
    if (c === "]" && !first) {
      return { token: { kind: "class", negated, items }, end: i };
    }
    first = false;
    if (c === "\\" && i + 1 < part.length) c = part[++i]!;
    let to = c;
    if (part[i + 1] === "-" && i + 2 < part.length && part[i + 2] !== "]") {
      to = part[i + 2] === "\\" && i + 3 < part.length ? part[i + 3]! : part[i + 2]!;
      i += part[i + 2] === "\\" ? 3 : 2;
    }
    items.push(nocase ? [c.toLowerCase(), to.toLowerCase()] : [c, to]);
  }
  return undefined;
}

/** Set-of-positions simulation over path segments: reach[j] = the segments so far consume names[0, j). */
function matchSegments(segments: readonly Segment[], names: readonly string[], nocase: boolean): boolean {
  const n = names.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const segment of segments) {
    const next = new Uint8Array(n + 1);
    let any = false;
    if (segment.kind === "globstar") {
      // Any run of names, none of them hidden.
      let running = false;
      for (let j = 0; j <= n; j++) {
        if (reach[j]) running = true;
        if (running) {
          next[j] = 1;
          any = true;
        }
        if (j < n && names[j]!.startsWith(".")) running = false;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (reach[j] && matchName(segment, names[j]!, nocase)) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    reach = next;
  }
  return reach[n] === 1;
}

/** Set-of-positions simulation within one name: O(tokens × name length). */
function matchName(segment: Extract<Segment, { kind: "name" }>, name: string, nocase: boolean): boolean {
  if (name.startsWith(".") && !segment.dot) return false;
  const text = nocase ? name.toLowerCase() : name;
  const n = text.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const token of segment.tokens) {
    const next = new Uint8Array(n + 1);
    let any = false;
    if (token.kind === "star") {
      let running = false;
      for (let i = 0; i <= n; i++) {
        if (reach[i]) running = true;
        if (running) {
          next[i] = 1;
          any = true;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (reach[i] && matchChar(token, text[i]!)) {
          next[i + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    reach = next;
  }
  return reach[n] === 1;
}

function matchChar(token: Exclude<CharToken, { kind: "star" }>, c: string): boolean {
  switch (token.kind) {
    case "literal":
      return token.char === c;
    case "any-char":
      return true;
    case "class": {
      const inClass = token.items.some(([from, to]) => c >= from && c <= to);
      return inClass !== token.negated;
    }
  }
}
