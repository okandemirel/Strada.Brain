import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GrepSearchTool } from "./search.js";
import type { ToolContext } from "./tool.interface.js";

/**
 * grep_search ran the model's regex on the main event loop with no time
 * limit. A nested-quantifier pattern against one long uniform line blocked
 * the whole process (each extra character roughly doubles the time). Real
 * files, real worker thread.
 */
describe("grep_search with a pathological regex", () => {
  let root: string;
  let ctx: ToolContext;
  // Takes seconds on the main thread (and doubles per extra character).
  const backtracking = "(x+x+)+y";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grep-regex-timeout-"));
    mkdirSync(join(root, "Assets"));
    writeFileSync(join(root, "Assets", "Guids.asset"), `guid: ${"x".repeat(30)}\n`);
    ctx = { projectPath: root, workingDirectory: root, readOnly: false };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("is stopped with a clear error, and the event loop keeps running meanwhile", async () => {
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    const startedAt = Date.now();
    try {
      const result = await new GrepSearchTool({ matchTimeoutMs: 300 }).execute({ pattern: backtracking }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/regex was stopped/);
      expect(result.content).toContain("Assets/Guids.asset");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(ticker);
    }
  });

  it("is stopped under the default limit of the tool as registered", async () => {
    const startedAt = Date.now();
    const result = await new GrepSearchTool().execute({ pattern: backtracking }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/regex was stopped/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("grep_search results for ordinary patterns are unchanged", () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grep-regex-normal-"));
    mkdirSync(join(root, "Assets"));
    writeFileSync(join(root, "Assets", "A.cs"), "class Player {}\n  class Enemy : Base {}\nnothing\n");
    writeFileSync(join(root, "Assets", "B.cs"), "// CLASS Boss\nclass Boss {}\n");
    ctx = { projectPath: root, workingDirectory: root, readOnly: false };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("reports every matching line with its file, line number and trimmed text", async () => {
    const result = await new GrepSearchTool().execute({ pattern: "class \\w+", file_pattern: "Assets/*.cs" }, ctx);
    expect(result.isError).toBeFalsy();
    // glob does not promise an order across files; within a file it is line order.
    const [header, ...lines] = result.content.split("\n");
    expect(header).toBe("Found 3 match(es):");
    expect(lines.sort()).toEqual([
      "Assets/A.cs:1: class Player {}",
      "Assets/A.cs:2: class Enemy : Base {}",
      "Assets/B.cs:2: class Boss {}",
    ]);
  });

  it("honours case_sensitive: false", async () => {
    const result = await new GrepSearchTool().execute(
      { pattern: "class boss", file_pattern: "Assets/B.cs", case_sensitive: false },
      ctx,
    );
    expect(result.content).toBe(
      "Found 2 match(es):\n" +
      "Assets/B.cs:1: // CLASS Boss\n" +
      "Assets/B.cs:2: class Boss {}",
    );
  });
});
