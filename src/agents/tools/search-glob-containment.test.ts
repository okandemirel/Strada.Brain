import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GlobSearchTool, GrepSearchTool, globInsideProject } from "./search.js";
import type { ToolContext } from "./tool.interface.js";

/**
 * The `..`/absolute check on the pattern string runs BEFORE glob expands
 * braces, so an alternative could be absolute or assemble `..` from pieces
 * and list file names anywhere on disk. Real glob, real filesystem.
 */
describe("glob patterns stay inside the project root", () => {
  let base: string;
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "glob-containment-"));
    root = join(base, "project");
    mkdirSync(join(root, "Assets"), { recursive: true });
    writeFileSync(join(root, "Assets", "Player.cs"), "class Player {}\n");
    writeFileSync(join(root, "Assets", "Shader.shader"), "Shader \"x\" {}\n");
    // Siblings of the project: their names must never come back.
    writeFileSync(join(base, "outside-secret.cs"), "class OutsideSecret {}\n");
    writeFileSync(join(base, "outside-data.bin"), "OutsideSecret\n");
    ctx = { projectPath: root, workingDirectory: root, readOnly: false };
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  // `<base>` is replaced with the (absolute) directory holding the project.
  const escapes = ["{.,x}{.,y}/*", "{.,x}{.,y}/*.cs", "{<base>,x}/*"];
  const expand = (pattern: string): string => pattern.replace("<base>", base.replace(/\\/g, "/"));
  const refusal = /must not contain '\.\.' or absolute paths/;

  // The tools now refuse these up front (globPatternProblem checks what the
  // expansion makes), so the containment below is measured on glob directly.
  it.each(escapes)("glob_search refuses %j and returns nothing outside the root", async (pattern) => {
    const result = await new GlobSearchTool().execute({ pattern: expand(pattern) }, ctx);
    expect(result.content).toMatch(refusal);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("outside-");
  });

  it("an absolute brace alternative lists no system files", async () => {
    const result = await new GlobSearchTool().execute({ pattern: "{/etc,x}/host*" }, ctx);
    expect(result.content).toMatch(refusal);
    expect(result.content).not.toMatch(/hosts|hostname/);
  });

  it.each(escapes)("grep_search file_pattern %j neither searches nor counts files outside the root", async (filePattern) => {
    const result = await new GrepSearchTool().execute(
      { pattern: "OutsideSecret", file_pattern: expand(filePattern) },
      ctx,
    );
    expect(result.content).toMatch(refusal);
    expect(result.content).not.toContain("outside-");
    expect(result.content).not.toMatch(/Found \d+ match/);
    // Files outside the root are not even counted as skipped.
    expect(result.content).not.toMatch(/were NOT searched/);
  });

  // What a pattern the guard missed would reach: glob neither walks nor
  // returns anything past the root.
  it.each([...escapes, "{/etc,x}/host*", String.raw`.\./*`])("glob itself keeps %j inside the root", async (pattern) => {
    expect(await globInsideProject(expand(pattern), root)).toEqual([]);
  });

  // glob walks a segment without wildcards unescaped, so these are '..' to it
  // although the pattern never spells one.
  it.each([String.raw`Assets/.\./Assets/*.cs`, "Assets/[.]./Assets/*.cs"])(
    "glob reads %j as a '..', and the tools refuse it",
    async (pattern) => {
      expect(await globInsideProject(pattern, root)).toEqual(["Assets/Player.cs"]);
      const globbed = await new GlobSearchTool().execute({ pattern }, ctx);
      expect(globbed.content).toMatch(refusal);
      const grepped = await new GrepSearchTool().execute({ pattern: "class", file_pattern: pattern }, ctx);
      expect(grepped.content).toMatch(refusal);
    },
  );

  it("braces that stay inside the project still work", async () => {
    const result = await new GlobSearchTool().execute({ pattern: "Assets/*.{cs,shader}" }, ctx);
    expect(result.content).toContain("Found 2 file(s)");
    expect(result.content).toContain("Player.cs");
    expect(result.content).toContain("Shader.shader");
  });
});
