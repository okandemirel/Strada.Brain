/**
 * Strada.Brain is universal and public; the products it is measured on are
 * not. Nothing of a test vehicle belongs in this repository — not in system
 * code (defaults, schema examples, prompts, refusal wording), and since
 * 2026-10-12 not in a comment recording a measurement, a test, a fixture, a
 * doc or a note either: those are published too.
 * Measured 2026-09-10: the prerender tool described itself as the
 * casual-game chibi pipeline with a pink default and a user's own prefab
 * path as the example. The rule was written; nothing enforced it. Measured
 * 2026-10-12: with only system code checked, over 400 lines of tests, comments
 * and docs named the vehicle, and one fixture was a real campaign's export.
 *
 * The names are not written here, because a list of them would itself be
 * the trace. The built-in list holds digests of the vehicle's own
 * identifiers, so the rule holds on every checkout and in CI. A checkout
 * adds what it may not publish even as a digest in the gitignored
 * tests/fixtures/local/ (see src/tests/helpers/local-fixtures.ts):
 *   - vehicle-terms.txt: one case-insensitive regular expression per line
 *     (`#` starts a comment) — the vehicle's ordinary words, which a digest
 *     would leave to a dictionary, and the next vehicle's names;
 *   - confidential-documents.txt: one absolute path per line — design
 *     documents whose wording no tracked file may quote.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localFixturePath, missingLocalFixture, REPO_ROOT } from "./tests/helpers/local-fixtures.js";
import {
  compileTerms,
  lineAt,
  project,
  quotedLines,
  quoteIndex,
  RollSet,
  rollingHits,
  termLines,
} from "./tests/helpers/universality-scan.js";

/**
 * [length, rolling hash, sha256] of each identifier's lowercase letters and
 * digits. A file matches when a run of its letters and digits — everything
 * else dropped, so camel case, spaces, dashes and underscores between the
 * parts all match — is one of them.
 */
const VEHICLE_DIGESTS: ReadonlyArray<readonly [number, number, string]> = [
  [9, 1422222344, "31d06d90c70d7e7215efe52cd9913d937ff1adda0a944422cbd725b6ac2e1cb2"],
  [5, 1673210365, "02464f7a8f9f52dabc26906d93f62b0017ecab04eaca2fc6bb8b20afed5ae05a"],
  [13, 3850315725, "7f5edd585b8f9840b58dfbd25d3ea27b793ac97746ca31dde76f9ef0971adbf8"],
  [21, 1292840653, "4edef12e5a6eaf759885338644c1975103c0323191ff45f3ddfd02717feb392a"],
  [9, 3863861512, "dd4c4b403a7d4d8444802dca2986d1dac8079563776a858750cd1b4cb5652b81"],
  [16, 4269027509, "396c31926ad3d08da18841a0e7177e95fbd85f0fb3cf2096d8713409a3f966d7"],
  [8, 984327875, "3352c6e65e4d7e16620983238909243348cf2a655b0fbe5aad27afda6bcf9fcf"],
];
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

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

function localTerms(): RegExp | undefined {
  const path = localFixturePath("vehicle-terms.txt");
  return path ? compileTerms(readFileSync(path, "utf8")) : undefined;
}

describe("universality: nothing of a test vehicle in the repository", () => {
  const files = publishableFiles();

  it.skipIf(files === undefined)("no publishable file names the vehicle, in code, comments, tests, fixtures or docs", () => {
    const byLength = new Map<number, RollSet>();
    for (const [length, roll] of VEHICLE_DIGESTS) {
      if (!byLength.has(length)) byLength.set(length, new RollSet());
      byLength.get(length)!.add(roll);
    }
    const digests = new Set(VEHICLE_DIGESTS.map(([, , digest]) => digest));
    const terms = localTerms();
    const hits = new Set<string>();
    for (const file of files!) {
      const text = readText(file);
      if (text === undefined) continue;
      const { codes, origin } = project(text, "alnum");
      for (const [length, rolls] of byLength) {
        for (const start of rollingHits(codes, length, rolls)) {
          const run = String.fromCharCode(...codes.subarray(start, start + length));
          if (digests.has(sha256(run))) hits.add(`${file}:${lineAt(text, origin[start]!)}`);
        }
      }
      if (terms) for (const line of termLines(text, terms)) hits.add(`${file}:${line} (local term)`);
    }
    expect([...hits], `test-vehicle names in publishable files:\n${[...hits].join("\n")}`).toEqual([]);
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
    "# Harbor rules\n\nEvery lantern keeper polishes the brass hood before the tide turns the harbor silver at dusk.\n",
  ]);

  it.each([
    ["a JSDoc block", "/**\n * Every lantern keeper polishes\n * the brass hood before the tide\n */\n"],
    ["line comments", "// Every lantern keeper polishes\n// the brass hood before the tide\n"],
    ["hash comments", "# Every lantern keeper polishes\n# the brass hood before the tide\n"],
    ["string concatenation", 'const rule =\n  "Every lantern keeper polishes " +\n  "the brass hood before the tide";\n'],
    ["a list joined into one text", 'const rule = [\n  "Every lantern keeper polishes",\n  "the brass hood before the tide",\n].join(" ");\n'],
    ["joined template literals", "const rule = `Every lantern keeper polishes ` +\n  `the brass hood before the tide`;\n"],
    ["a newline escape", '{ "note": "Every lantern keeper polishes\\nthe brass hood before the tide" }\n'],
    ["a backslash line continuation", 'echo "Every lantern keeper polishes \\\nthe brass hood before the tide"\n'],
  ])("across %s", (_form, text) => {
    expect(quotedLines(text, index)).not.toEqual([]);
  });

  it("names the line the passage starts on", () => {
    expect(quotedLines("/**\n * Every lantern keeper polishes\n * the brass hood before the tide\n */\n", index)).toEqual([2]);
  });

  it("does not join the same words in another order into the passage", () => {
    expect(quotedLines('const rule =\n  "the brass hood before the tide " +\n  "Every lantern keeper polishes";\n', index)).toEqual([]);
  });
});
