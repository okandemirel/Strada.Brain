import { describe, it, expect } from "vitest";
import { compilePathGlob, MAX_PATH_GLOB_LENGTH } from "./glob-match.js";

describe("compilePathGlob", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.cs", "Player.cs", true],
    ["*.cs", "Assets/Player.cs", false],
    ["Assets/*.cs", "Assets/Player.cs", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "lib/a.ts", false],
    ["src/**", "src/a/b.md", true],
    ["**/*.md", "notes/x.md", true],
    ["**/*.md", "x.md", true],
    ["?.cs", "A.cs", true],
    ["?.cs", "AB.cs", false],
    ["a.b(c)+[d].md", "a.b(c)+[d].md", true], // regex metacharacters are literal
    ["a.b", "axb", false],
    ["", "", true],
    ["", "a", false],
  ];
  it.each(cases)("%s against %s -> %s", (glob, path, expected) => {
    expect(compilePathGlob(glob)(path)).toBe(expected);
  });

  // MEM-8: the RegExp this replaced took 34 s on one 63-character path.
  it("stays linear on many-star globs that made the old RegExp backtrack", () => {
    const glob = "*a*a*a*a*a*a*a*a*a*a*a*a*b";
    const path = "a".repeat(63);
    const matches = compilePathGlob(glob);
    const started = performance.now();
    for (let i = 0; i < 200; i++) expect(matches(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses a glob longer than the cap", () => {
    expect(() => compilePathGlob("*".repeat(MAX_PATH_GLOB_LENGTH + 1))).toThrow(/too long/);
  });
});
