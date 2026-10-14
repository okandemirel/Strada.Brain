/**
 * Strada.Brain is public and serves any project; a project built with it is
 * not part of it. No publishable file — code (defaults, schema examples,
 * prompts, refusal wording), comment, test, fixture, doc or note — may carry
 * such a project's names or quote its confidential design documents.
 *
 * Neither is written here: a list of names would itself be the trace, and a
 * digest of one still encodes it. A checkout states them in the gitignored
 * tests/fixtures/local/ (see src/tests/helpers/local-fixtures.ts):
 *   - product-terms.txt: one case-insensitive regular expression per line
 *     (`#` starts a comment) — the names a project built here must not leave
 *     behind; found however a name's parts are separated, so write them apart
 *     (`foo bar` finds FooBar, foo_bar and foobar too; see compileTerms);
 *   - confidential-documents.txt: one absolute path per line — design
 *     documents whose wording no tracked file may quote.
 * Without them the scans are skipped, saying why.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localFixturePath, missingLocalFixture, REPO_ROOT } from "./tests/helpers/local-fixtures.js";
import {
  compileTerms,
  quotedLines,
  quoteIndex,
  termLines,
  type ProductTerms,
} from "./tests/helpers/universality-scan.js";

/**
 * The terms file this guard reads. The older name is still accepted so a
 * checkout that has one keeps its coverage through the rename.
 */
const TERMS_FILES = ["product-terms.txt", "vehicle-terms.txt"] as const;

/**
 * Every file git would publish from this checkout: tracked, and new ones not
 * ignored. Regular files only: a submodule is its own repository, and a
 * symlink (a worktree's node_modules) points outside this one.
 */
function publishableFiles(): string[] | undefined {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(out.split("\0").filter(Boolean))].filter((f) => {
      try {
        return lstatSync(join(REPO_ROOT, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  return text.includes("\0") ? undefined : text;
}

function localTerms(): { terms: ProductTerms | undefined; path: string | undefined } {
  for (const name of TERMS_FILES) {
    const path = localFixturePath(name);
    if (path) return { terms: compileTerms(readFileSync(path, "utf8")), path };
  }
  return { terms: undefined, path: undefined };
}

describe("universality: nothing of a product built with Strada.Brain in the repository", () => {
  const files = publishableFiles();
  const { terms } = localTerms();
  const noTerms = terms ? "" : ` (${missingLocalFixture(TERMS_FILES[0], "the product names to scan for")})`;

  it.skipIf(files === undefined || !terms)(`no publishable file names a product listed in the local terms${noTerms}`, () => {
    const hits = new Set<string>();
    for (const file of files!) {
      const text = readText(file);
      if (text === undefined) continue;
      for (const line of termLines(text, terms!)) hits.add(`${file}:${line}`);
    }
    expect([...hits], `product names in publishable files:\n${[...hits].join("\n")}`).toEqual([]);
  });

  const docsList = localFixturePath("confidential-documents.txt");
  const why = docsList ? "" : ` (${missingLocalFixture("confidential-documents.txt", "the design documents to compare against")})`;
  it.skipIf(files === undefined || !docsList)(`no publishable file quotes a confidential design document${why}`, () => {
    const paths = readFileSync(docsList!, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    for (const path of paths) expect(existsSync(path), `listed confidential document ${path} is not there`).toBe(true);
    const index = quoteIndex(paths.map((path) => readFileSync(path, "utf8")));
    const hits = new Set<string>();
    for (const file of files!) {
      const text = readText(file);
      if (text === undefined) continue;
      for (const line of quotedLines(text, index)) hits.add(`${file}:${line}`);
    }
    // Locations only: the passage itself stays out of the test's output.
    expect([...hits], `passages of a confidential document in publishable files:\n${[...hits].join("\n")}`).toEqual([]);
  });
});

/**
 * How the guard reads a file, shown on an invented document: the real one may
 * not be written here. Each line of a wrapped passage below is shorter than a
 * shingle, so only reading through the wrapping finds it — as a passage of
 * the real document was once found by hand, after the guard had passed it.
 */
describe("universality: a passage is found through the syntax that wraps it", () => {
  const index = quoteIndex([
    "# Orchard rules\n\nEvery grafting knife is wiped with cedar oil before the second frost reaches the upper terraces.\n",
  ]);

  it.each([
    ["a JSDoc block", "/**\n * Every grafting knife is wiped\n * with cedar oil before the frost\n */\n"],
    ["line comments", "// Every grafting knife is wiped\n// with cedar oil before the frost\n"],
    ["hash comments", "# Every grafting knife is wiped\n# with cedar oil before the frost\n"],
    ["string concatenation", 'const rule =\n  "Every grafting knife is wiped " +\n  "with cedar oil before the frost";\n'],
    ["a list joined into one text", 'const rule = [\n  "Every grafting knife is wiped",\n  "with cedar oil before the frost",\n].join(" ");\n'],
    ["joined template literals", "const rule = `Every grafting knife is wiped ` +\n  `with cedar oil before the frost`;\n"],
    ["a newline escape", '{ "note": "Every grafting knife is wiped\\nwith cedar oil before the frost" }\n'],
    ["a backslash line continuation", 'echo "Every grafting knife is wiped \\\nwith cedar oil before the frost"\n'],
  ])("across %s", (_form, text) => {
    expect(quotedLines(text, index)).not.toEqual([]);
  });

  it("names the line the passage starts on", () => {
    expect(quotedLines("/**\n * Every grafting knife is wiped\n * with cedar oil before the frost\n */\n", index)).toEqual([2]);
  });

  it("does not join the same words in another order into the passage", () => {
    expect(quotedLines('const rule =\n  "with cedar oil before the frost " +\n  "Every grafting knife is wiped";\n', index)).toEqual([]);
  });
});

/**
 * Local terms, shown on invented ones: a name written apart, a name written
 * together and anchored, and a regular expression with a space in it. The
 * digests match a name on its letters and digits alone; a local term must
 * not depend on how the name's parts are separated either.
 */
describe("universality: a local term is found however its parts are separated", () => {
  const terms = compileTerms("# invented\nquill bright\n\\bmarrowfen\\b\n\\bsalt (wake|reach)\\b\n")!;

  it.each([
    "QuillBright",
    "quillBright",
    "quill_bright",
    "QUILL_BRIGHT",
    "quill-bright",
    "quillbright",
    "the Quill Bright banner",
    "MarrowFen",
    "marrowFen",
    "Marrow_Fen",
    "MARROW_FEN",
    "marrow-fen",
    "SaltWake",
    "salt_reach",
    "saltwake",
  ])("%s", (name) => {
    expect(termLines(`const x = 1;\nexport const label = ${JSON.stringify(name)};\n`, terms)).toEqual([2]);
  });

  it("across a wrapped comment and a string joint, on the line the name starts", () => {
    expect(termLines("/**\n * the Quill\n * Bright banner\n */\n", terms)).toEqual([2]);
    expect(termLines('const x = 1;\nconst title = "Quill " +\n  "Bright";\n', terms)).toEqual([2]);
  });

  it.each([
    "the quill is bright",
    'const kind = "quill";\nbright = true;',
    "marrow fence",
    "Marrow_Fence",
    "marrowfens",
    "salt water",
    "SaltWater",
  ])("not in %s", (text) => {
    expect(termLines(text, terms)).toEqual([]);
  });
});
