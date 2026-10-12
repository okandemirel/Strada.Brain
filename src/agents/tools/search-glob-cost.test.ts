import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GlobSearchTool, GrepSearchTool } from "./search.js";
import type { ToolContext } from "./tool.interface.js";

/** 100 C# files, 20 under each of five feature folders, named round-robin from `stems`. */
function unityTree(stems: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "glob-cost-"));
  for (const [d, feature] of ["Combat", "Player", "Enemy", "UI", "Persistence"].entries()) {
    const dir = join(root, "Assets", "Scripts", feature);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      const n = d * 20 + i;
      writeFileSync(join(dir, `${stems[(d + i) % stems.length]}${n}.cs`), `class C${n} {}\n`);
    }
  }
  return root;
}

const context = (root: string): ToolContext => ({ projectPath: root, workingDirectory: root, readOnly: false });

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await run();
  return { result, ms: performance.now() - started };
}

/**
 * grep_search's file_pattern and glob_search's pattern are LLM input that
 * glob compiles, path segment by path segment, into backtracking RegExps and
 * runs on the main thread. '?' makes every ordinary name adversarial: over 100
 * Unity file names '**' + '/*?*?*?*?*?*?*?*?#' took 0.6-1.3 s and the extglob
 * '**' + '/+(?|??)#' 1.1 s, each with no match (a 55-character name pushes the
 * first past minutes). Real glob, real filesystem.
 */
describe("grep_search and glob_search bound what a glob may cost", () => {
  let ordinary: string;
  let longNames: string;

  beforeAll(() => {
    ordinary = unityTree([
      "DamageCalculatorSystem", "PlayerMovementController", "EnemySpawnerService", "InventoryViewModel",
      "SaveGameService",
    ]);
    longNames = unityTree([
      "LevelProgressionPersistenceServiceIntegrationTests", "ProjectileCollisionHandlerSystemPlayModeTests",
    ]);
  });
  afterAll(() => {
    rmSync(ordinary, { recursive: true, force: true });
    rmSync(longNames, { recursive: true, force: true });
  });

  const glob = (root: string, pattern: string) =>
    timed(() => new GlobSearchTool().execute({ pattern }, context(root)));
  const grep = (root: string, filePattern: string) =>
    timed(() => new GrepSearchTool().execute({ pattern: "class", file_pattern: filePattern }, context(root)));

  const backtracking: [string, RegExp][] = [
    ["**/*?*?*?*?*?*?*?*?#", /segment '\*\?\*\?\*\?\*\?\*\?\*\?\*\?\*\?#' holds 8 '\*' wildcards/],
    ["**/+(?|??)#", /extglob/],
    // glob's brace expansion follows bash, where `{a},b}` is the two
    // alternatives `a}` and `b`: ten of them make one three-'*' segment into
    // 1024, which ran 0.2-1 s per call over these trees (2-6 s in review).
    [`**/*?*?*?#${"{a},b}".repeat(10)}`, /expands to more than 64 \{a,b\} alternatives/],
    // Extglobs the brace expansion assembles: the first blocked the event loop
    // for 30 s over the ordinary tree in review, answering 'No files found'.
    ["**/{+,@}(?|??|???)#", /extglob/],
    ["**/+{,}(?|??)#", /extglob/],
    // brace-expansion unescapes `\.`, so each repeat is a `**/../a/b/` that
    // minimatch's preprocessing doubles: 2-5 s per call before glob walked.
    [`${String.raw`**/.\./a/b/`.repeat(12)}*.{cs,x}`, /must not contain '\.\.' or absolute paths/],
  ];

  it.each(backtracking)("glob_search refuses %j without walking the tree, saying why", async (pattern, why) => {
    const { result, ms } = await glob(ordinary, pattern);
    expect(result.content).toMatch(why);
    expect(result.content).toMatch(/^Error: pattern /);
    expect(result.isError).toBe(true);
    expect(ms).toBeLessThan(250);
  });

  it.each(backtracking)("grep_search refuses file_pattern %j without walking the tree, saying why", async (pattern, why) => {
    const { result, ms } = await grep(ordinary, pattern);
    expect(result.content).toMatch(why);
    expect(result.content).toMatch(/^Error: file_pattern /);
    expect(result.isError).toBe(true);
    expect(ms).toBeLessThan(250);
  });

  // One '*' or one alternative past what the limits let through.
  const justOver = [
    "**/*?*?*?*?#",
    "Assets/**/*?*?*?#/*?*?#",
    `**/{${Array.from({ length: 9 }, (_, i) => `*?*?#${i}`).join(",")}}`,
    "**/*?*?*?#{a},b}",
  ];

  it.each(justOver)("refuses %j, just past the limits, in both tools", async (pattern) => {
    expect((await glob(ordinary, pattern)).result.isError).toBe(true);
    expect((await grep(ordinary, pattern)).result.isError).toBe(true);
  });

  // The costliest patterns the limits let through: one segment with three
  // '*', or eight segments with two across {a,b} alternatives. Each fails on
  // every name, so glob tries every split of every one; long names cost most.
  const costliestAccepted = [
    "**/*?*?*?#",
    `**/{${Array.from({ length: 8 }, (_, i) => `*?*?#${i}`).join(",")}}`,
  ];

  it.each(costliestAccepted)("runs the costliest accepted glob %j within a bound", async (pattern) => {
    for (const root of [ordinary, longNames]) {
      const globbed = await glob(root, pattern);
      expect(globbed.result.content).toMatch(/^No files found/);
      expect(globbed.ms).toBeLessThan(1_000);

      const grepped = await grep(root, pattern);
      expect(grepped.result.content).toMatch(/^No (files were searched|matches found)/);
      expect(grepped.ms).toBeLessThan(1_000);
    }
  });

  it("still answers ordinary multi-wildcard patterns", async () => {
    const systems = (await glob(ordinary, "**/*Damage*System*.cs")).result;
    expect(systems.content).toMatch(/^Found 20 file\(s\)/);
    expect(systems.content).toContain("Assets/Scripts/Combat/DamageCalculatorSystem0.cs");

    const either = (await glob(ordinary, "Assets/**/*{Player,Enemy}*.cs")).result;
    expect(either.content).toMatch(/^Found 40 file\(s\)/);

    const grepped = (await grep(ordinary, "Assets/Scripts/UI/*Inventory*.cs")).result;
    expect(grepped.content).toMatch(/^Found 4 match\(es\)/);
  });
});
