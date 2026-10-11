import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { glob } from "glob";
import { createFilePatternFilter, filePatternProblem, globPatternProblem, MAX_FILE_PATTERN_LENGTH } from "./file-pattern.js";

const ROOT = "/proj";
const at = (rel: string) => `${ROOT}/${rel}`;

describe("createFilePatternFilter", () => {
  // code_search's file_pattern is LLM input. picomatch compiled it into a
  // backtracking RegExp: '**/*a*a*a*a*a*a*a*a*b' took 17 s on one path with
  // the event loop blocked (search-tools review, P3).
  it("decides an adversarial glob on an adversarial path in bounded time", () => {
    const inScope = createFilePatternFilter("**/*a*a*a*a*a*a*a*b", [ROOT]);
    const started = performance.now();
    const verdict = inScope(at(`Assets/${"a".repeat(40)}`));
    const elapsed = performance.now() - started;

    expect(verdict).toBe(false);
    expect(elapsed).toBeLessThan(250);
    expect(inScope(at(`Assets/${"a".repeat(40)}b`))).toBe(true);
  });

  it("keeps a whole-store scan of adversarial paths bounded", () => {
    const inScope = createFilePatternFilter("{**/*a*a*a*a*a*a*b,*a*a*a*a*a*a*a*c}/**", [ROOT]);
    const paths = Array.from({ length: 1_000 }, (_, i) => at(`${"a".repeat(24)}/${"a".repeat(24)}${i}.cs`));
    const started = performance.now();
    for (const path of paths) expect(inScope(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("refuses patterns past its size limits instead of matching them", () => {
    const tooLong = `**/${"a".repeat(MAX_FILE_PATTERN_LENGTH)}`;
    expect(filePatternProblem(tooLong)).toMatch(/too long/);
    expect(() => createFilePatternFilter(tooLong, [ROOT])).toThrow(/too long/);

    // 2^12 alternatives from a 60-character pattern.
    const braceBomb = "{a,b}".repeat(12);
    expect(filePatternProblem(braceBomb)).toMatch(/alternatives/);
    expect(() => createFilePatternFilter(braceBomb, [ROOT])).toThrow(/alternatives/);

    expect(filePatternProblem("**/+(a|aa)b")).toMatch(/extglob/);
    expect(filePatternProblem("**/*.{cs,shader}")).toBeUndefined();
  });

  // The matcher replaced picomatch. code_search documents file_pattern as
  // working as in grep_search, so the oracle is grep_search's own glob over a
  // real tree, given the pattern and the files under it (the directory rule;
  // a trailing "/**" adds nothing to it), with the platform's case rule.
  it("selects the files grep_search's glob selects for the pattern and the files under it", async () => {
    const patterns = [
      "**/Combat/**", "Assets/**/*.cs", "Assets/Scripts/Combat", "Assets/Scripts/Combat/",
      "**/*.cs", "*.cs", "Assets/*/Hud.cs", "**/*.{cs,shader}", "{Assets,Packages}/**/*.cs",
      "Assets/Scripts/[CU]*/**", "Assets/Scripts/[!C]*/*.cs", "Assets/Scripts/[A-D]*/*", "**/Dam?ge.cs",
      "**/*Damage*", "Assets/**/Combat/*.cs", "./Assets/**", "**", "**/.hidden/**", "**/.*",
      "Assets/Scripts/Combat/Damage.cs", "**/combat/**", "ASSETS/**/*.CS", "**/ui/*", "Assets/{Scripts/UI,Shaders}",
      "**/{a}.cs", "#*", "!Assets/**",
    ];
    const paths = [
      "Assets/Scripts/Combat/Damage.cs", "Assets/Scripts/UI/Hud.cs", "Assets/Hud.cs", "Assets/UI/Hud.cs",
      "Packages/Core/Runtime/Bus.cs", "Assets/Shaders/Toon.shader", "Damage.cs", "Assets/.hidden/Secret.cs",
      ".github/workflows/ci.yml", "Assets/Scripts/Combat/Sub/Deep.cs", "Assets/{a}.cs", "Assets/.env",
    ];
    const dir = await realpath(await mkdtemp(join(tmpdir(), "file-pattern-")));
    try {
      for (const path of paths) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), "");
      }
      const nocase = process.platform === "darwin" || process.platform === "win32";
      const key = (path: string) => (nocase ? path.toLowerCase() : path);
      let selectedInAll = 0;
      for (const pattern of patterns) {
        const base = pattern.replace(/\/+$/, "").replace(/(\/\*\*)+$/, "") || pattern;
        const selected = await glob([base, `${base}/**`], { cwd: dir, nodir: true });
        const oracle = new Set(selected.map((path) => key(path.split(sep).join("/"))));
        selectedInAll += oracle.size;
        const inScope = createFilePatternFilter(pattern, [dir]);
        for (const path of paths) {
          expect(inScope(join(dir, path)), `${pattern} vs ${path}`).toBe(oracle.has(key(path)));
        }
      }
      // The oracle chose files, so agreement was not two empty answers.
      expect(selectedInAll).toBeGreaterThan(50);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes an escaped wildcard literally and matches case as told", () => {
    const escaped = createFilePatternFilter("**/a\\*b.cs", [ROOT], { nocase: false });
    expect(escaped(at("Assets/a*b.cs"))).toBe(true);
    expect(escaped(at("Assets/axb.cs"))).toBe(false);

    expect(createFilePatternFilter("**/combat/**", [ROOT], { nocase: false })(at("Assets/Combat/D.cs"))).toBe(false);
    expect(createFilePatternFilter("**/combat/**", [ROOT], { nocase: true })(at("Assets/Combat/D.cs"))).toBe(true);
    expect(createFilePatternFilter("Assets/[A-C]*/*", [ROOT], { nocase: true })(at("Assets/combat/D.cs"))).toBe(true);
  });

  // grep_search's glob is case-insensitive on macOS and Windows and
  // case-sensitive elsewhere; code_search documents file_pattern as working
  // the same way, but picomatch was case-sensitive everywhere.
  describe("follows grep_search's case rule for the platform", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => Object.defineProperty(process, "platform", platform));

    for (const [name, insensitive] of [["darwin", true], ["win32", true], ["linux", false]] as const) {
      it(name, () => {
        Object.defineProperty(process, "platform", { ...platform, value: name });
        const inScope = createFilePatternFilter("**/combat/**", [ROOT]);
        expect(inScope(at("Assets/Scripts/Combat/Damage.cs"))).toBe(insensitive);
        expect(inScope(at("Assets/Scripts/combat/Damage.cs"))).toBe(true);
      });
    }
  });
});

// grep_search and glob_search hand their glob to glob, whose RegExps
// backtrack: each `*` run in a segment multiplies the splits tried per name.
describe("globPatternProblem", () => {
  it("counts the '*' runs of each path segment of each {a,b} alternative", () => {
    expect(globPatternProblem("**/*Damage*System*.cs")).toBeUndefined();
    expect(globPatternProblem("*a*/*b*/*c*")).toBeUndefined();
    expect(globPatternProblem("**/*a*b*c*d")).toMatch(/segment '\*a\*b\*c\*d' holds 4 '\*' wildcards/);

    // Escaped stars, classes and a run like "**" inside a name are no extra runs.
    expect(globPatternProblem("**/*\\*\\*a**b[*]*.cs")).toBeUndefined();

    expect(globPatternProblem("**/*{a,b}*")).toBeUndefined();
    expect(globPatternProblem("**/*{a,b}*c*")).toMatch(/too many path segments/);
    expect(globPatternProblem(`**/{${Array.from({ length: 9 }, (_, i) => `*${i}*`).join(",")}}`)).toMatch(
      /too many path segments/,
    );
  });

  it("keeps filePatternProblem's limits and names the argument it was given", () => {
    expect(globPatternProblem("**/+(?|??)#", "pattern")).toMatch(/^pattern uses extglob syntax/);
    expect(globPatternProblem("{a,b}".repeat(12), "pattern")).toMatch(/^pattern expands to more than 64/);
    expect(globPatternProblem(`**/${"a".repeat(MAX_FILE_PATTERN_LENGTH)}`)).toMatch(/^file_pattern is too long/);
    expect(globPatternProblem("**/*.{cs,shader,compute,hlsl,cginc,json,xml,yaml}")).toBeUndefined();
  });
});
