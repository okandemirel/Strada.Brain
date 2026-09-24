/**
 * What the autonomy gates read out of C# source and Unity project paths.
 *
 * Every regex rule over C# (spec scope, framework bypass, test detection,
 * prefab fields, primitive geometry) used to strip comments its own way —
 * one walked the source, one ran a regex that cut `"//"` inside a string, and
 * the rest did not strip at all, so a commented-out `// [Test]` counted as a
 * test and a comment naming StradaLog cleared the logging rule (audited
 * 2026-09-24). This is the one reader they share.
 */

export interface StripOptions {
  /**
   * Also empty every string and char literal (the quotes stay), so text
   * inside `"[Test]"` or `"StradaLog"` is not read as code. Interpolation
   * holes are code and are kept.
   */
  readonly blankStrings?: boolean;
}

/**
 * C# source with `//` and `/* *\/` comments removed. Strings are walked, not
 * pattern-matched: `string sep = "//";` keeps the rest of its line, a label
 * like `retry:// TODO` is still a comment, and verbatim (`@"…"`), interpolated
 * (`$"…{x}…"`) and mixed (`$@"…"`, `@$"…"`) literals end where C# ends them.
 */
export function stripCsComments(source: string, options: StripOptions = {}): string {
  const blank = options.blankStrings === true;
  const n = source.length;
  let out = "";
  let i = 0;

  const charLiteral = (): void => {
    out += "'";
    i += 1;
    while (i < n) {
      const d = source[i]!;
      if (d === "\\") {
        if (!blank) out += d + (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      // An unterminated literal ends at the line, so one stray quote cannot
      // swallow the rest of the file.
      if (d === "\n") return;
      i += 1;
      if (d === "'") {
        out += d;
        return;
      }
      if (!blank) out += d;
    }
  };

  const stringLiteral = (): void => {
    let verbatim = false;
    let interpolated = false;
    while (source[i] === "@" || source[i] === "$") {
      if (source[i] === "@") verbatim = true;
      else interpolated = true;
      out += source[i];
      i += 1;
    }
    out += '"';
    i += 1;
    while (i < n) {
      const d = source[i]!;
      const next = source[i + 1];
      if (!verbatim && d === "\\") {
        if (!blank) out += d + (next ?? "");
        i += 2;
      } else if (verbatim && d === '"' && next === '"') {
        if (!blank) out += '""';
        i += 2;
      } else if (interpolated && (d === "{" || d === "}") && next === d) {
        if (!blank) out += d + d;
        i += 2;
      } else if (interpolated && d === "{") {
        out += d;
        i += 1;
        code(true);
        if (source[i] === "}") {
          out += "}";
          i += 1;
        }
      } else if (d === '"') {
        out += d;
        i += 1;
        return;
      } else if (!verbatim && d === "\n") {
        return;
      } else {
        if (!blank) out += d;
        i += 1;
      }
    }
  };

  /** Code up to the end, or up to the `}` closing an interpolation hole. */
  const code = (inHole: boolean): void => {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      const next = source[i + 1];
      if (inHole && c === "}" && depth === 0) return;
      if (c === "/" && next === "/") {
        while (i < n && source[i] !== "\n") i += 1;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        out += " ";
      } else if (c === '"' || ((c === "@" || c === "$") && startsString(source, i))) {
        stringLiteral();
      } else if (c === "'") {
        charLiteral();
      } else {
        if (inHole && c === "{") depth += 1;
        if (inHole && c === "}") depth -= 1;
        out += c;
        i += 1;
      }
    }
  };

  code(false);
  return out;
}

/** `"`, `@"`, `$"`, `$@"` or `@$"` starting at `at`. */
function startsString(source: string, at: number): boolean {
  let j = at;
  while (j < at + 2 && (source[j] === "@" || source[j] === "$")) j += 1;
  return j > at && source[j] === '"';
}

const TEST_ATTRIBUTES = new Set(["Test", "UnityTest", "TestCase", "TestCaseSource"]);

/**
 * Does this source declare a test NUnit will run? Reads attribute sections,
 * not the text: `[Timeout(1000), Test]` and `[Category("x"), Test]` declare
 * one, while `// [Test]` and `"[Test]"` do not.
 */
export function declaresCsTest(source: string): boolean {
  // `new[]` / `int[]` would split `[TestCase(new[] { 1 })]` in two.
  const code = stripCsComments(source, { blankStrings: true }).replace(/\[\s*\]/gu, "");
  for (const section of code.matchAll(/\[([^[\]]*)\]/gu)) {
    for (const item of splitTopLevel(section[1] ?? "")) {
      const name = /^\s*(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*?)(?:Attribute)?\s*(?:\(|$)/u.exec(item)?.[1];
      if (name !== undefined && TEST_ATTRIBUTES.has(name)) return true;
    }
  }
  return false;
}

/** Split an attribute list at commas outside parentheses. */
function splitTopLevel(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      items.push(list.slice(start, i));
      start = i + 1;
    }
  }
  items.push(list.slice(start));
  return items;
}

/**
 * Code the project did not write: third-party plugins under Assets/Plugins,
 * and packages (embedded under Packages/, cached under Library/). A gate that
 * judges these blames the run for a vendor's choices, and no edit the run is
 * allowed to make can clear it.
 */
export function isVendorPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  // Under Assets/ only Plugins/ is vendor: a user folder named Packages or
  // Library inside Assets is the project's own code.
  if (/(^|\/)Assets\//iu.test(normalized)) return /(^|\/)Assets\/Plugins\//iu.test(normalized);
  return /(^|\/)(?:Packages|Library\/PackageCache)\//u.test(normalized);
}
