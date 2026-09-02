import { describe, it, expect, vi, beforeEach } from "vitest";
import { GlobSearchTool, GrepSearchTool, ListDirectoryTool } from "./search.js";
import { createToolContext } from "../../test-helpers.js";

vi.mock("glob", () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project" }),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(""),
  stat: vi.fn().mockResolvedValue({ size: 100, isDirectory: () => false }),
}));

import { glob } from "glob";
import { validatePath } from "../../security/path-guard.js";
import { readdir, readFile, stat } from "node:fs/promises";

describe("GlobSearchTool", () => {
  let tool: GlobSearchTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new GlobSearchTool();
  });

  it("returns matching files", async () => {
    vi.mocked(glob).mockResolvedValue(["Assets/Script.cs", "Assets/Player.cs"] as any);
    const result = await tool.execute({ pattern: "**/*.cs" }, ctx);
    expect(result.content).toContain("2 file(s)");
    expect(result.content).toContain("Script.cs");
  });

  it("returns error when pattern is empty", async () => {
    const result = await tool.execute({ pattern: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("reports when no files found", async () => {
    vi.mocked(glob).mockResolvedValue([] as any);
    const result = await tool.execute({ pattern: "**/*.xyz" }, ctx);
    expect(result.content).toContain("No files found");
  });

  it("truncates results over 50", async () => {
    const files = Array.from({ length: 60 }, (_, i) => `file${i}.cs`);
    vi.mocked(glob).mockResolvedValue(files as any);
    const result = await tool.execute({ pattern: "**/*.cs" }, ctx);
    expect(result.content).toContain("60 file(s)");
    expect(result.content).toContain("10 more");
  });
});

describe("GrepSearchTool", () => {
  let tool: GrepSearchTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new GrepSearchTool();
    vi.mocked(stat).mockResolvedValue({ size: 100 } as any);
  });

  it("returns error when pattern is empty", async () => {
    const result = await tool.execute({ pattern: "" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("returns error for pattern exceeding 500 chars", async () => {
    const result = await tool.execute({ pattern: "a".repeat(501) }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too long");
  });

  it("returns error for invalid regex", async () => {
    const result = await tool.execute({ pattern: "[invalid" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid regex");
  });

  it("finds matches in files", async () => {
    vi.mocked(glob).mockResolvedValue(["test.cs"] as any);
    vi.mocked(readFile).mockResolvedValue("class Player {}\nclass Enemy {}");
    const result = await tool.execute({ pattern: "class \\w+" }, ctx);
    expect(result.content).toContain("match");
    expect(result.content).toContain("class Player");
  });

  it("reports no matches", async () => {
    vi.mocked(glob).mockResolvedValue(["test.cs"] as any);
    vi.mocked(readFile).mockResolvedValue("no match here");
    const result = await tool.execute({ pattern: "nonexistent" }, ctx);
    expect(result.content).toContain("No matches");
  });

  it("skips files larger than 1MB", async () => {
    vi.mocked(glob).mockResolvedValue(["big.cs"] as any);
    vi.mocked(stat).mockResolvedValue({ size: 2 * 1024 * 1024 } as any);
    const result = await tool.execute({ pattern: "anything" }, ctx);
    expect(result.content).toContain("No matches");
  });

  // Audited 2026-09-02: the match cap stopped the file scan and the result
  // read "Found 20 match(es):" — byte-identical to a genuine 20-match result.
  // A count that hit the cap must say the scan stopped and how far it got.
  it("says the scan stopped when the match cap is reached", async () => {
    const files = Array.from({ length: 60 }, (_, i) => `Caller${i}.cs`);
    vi.mocked(glob).mockResolvedValue(files as any);
    vi.mocked(readFile).mockResolvedValue(
      "EventBus.Publish(a);\nEventBus.Publish(b);\nEventBus.Publish(c);",
    );
    const result = await tool.execute({ pattern: "EventBus\\.Publish" }, ctx);
    expect(result.content).toContain("Found 20 match(es)");
    expect(result.content).toMatch(/limit reached/i);
    expect(result.content).toMatch(/scanning stopped after 7 of 60 files/);
  });

  // Audited 2026-09-02: files the extension filter refused to open were never
  // counted, so `file_pattern: "**/*.mat"` answered "No matches found" about
  // files that were never read — an absence claim over an unrun check.
  it("says when every globbed file was skipped by the extension filter", async () => {
    vi.mocked(glob).mockResolvedValue(["Assets/Red.mat", "Assets/Blue.mat"] as any);
    vi.mocked(readFile).mockResolvedValue("guid: deadbeef");
    const result = await tool.execute({ pattern: "deadbeef", file_pattern: "**/*.mat" }, ctx);
    expect(result.content).toMatch(/No files were searched/);
    expect(result.content).toMatch(/2 of 2 file\(s\) matching '\*\*\/\*\.mat' were NOT searched/);
    expect(result.content).toContain(".cs");
    expect(result.content).not.toMatch(/^No matches found for pattern: deadbeef$/);
  });

  it("names the skipped files next to a genuine miss", async () => {
    vi.mocked(glob).mockResolvedValue(["Player.cs", "Player.controller"] as any);
    vi.mocked(readFile).mockResolvedValue("nothing here");
    const result = await tool.execute({ pattern: "deadbeef" }, ctx);
    expect(result.content).toContain("No matches found for pattern: deadbeef in the 1 file(s) searched");
    expect(result.content).toMatch(/1 of 2 file\(s\) matching '\*\*\/\*' were NOT searched/);
  });

  it("reports an exact count as exact when the cap is not reached", async () => {
    vi.mocked(glob).mockResolvedValue(["a.cs", "b.cs"] as any);
    vi.mocked(readFile).mockResolvedValue("x\nEventBus.Publish(a);");
    const result = await tool.execute({ pattern: "EventBus\\.Publish" }, ctx);
    expect(result.content).toContain("Found 2 match(es)");
    expect(result.content).not.toMatch(/limit reached/i);
  });
});

describe("ListDirectoryTool", () => {
  let tool: ListDirectoryTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new ListDirectoryTool();
    vi.mocked(validatePath).mockResolvedValue({ valid: true, fullPath: "/test/project" });
  });

  it("lists directory contents sorted dirs first", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "file.cs", isDirectory: () => false },
      { name: "Scripts", isDirectory: () => true },
    ] as any);
    vi.mocked(stat).mockResolvedValue({ size: 1024 } as any);

    const result = await tool.execute({ path: "." }, ctx);
    expect(result.content).toContain("[DIR]  Scripts/");
    expect(result.content).toContain("[FILE] file.cs");
    // Dirs should come before files
    const dirIdx = result.content.indexOf("[DIR]");
    const fileIdx = result.content.indexOf("[FILE]");
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  it("reports empty directory", async () => {
    vi.mocked(readdir).mockResolvedValue([] as any);
    const result = await tool.execute({ path: "." }, ctx);
    expect(result.content).toContain("empty");
  });

  it("returns error when path validation fails", async () => {
    vi.mocked(validatePath).mockResolvedValue({ valid: false, fullPath: "", error: "blocked" });
    const result = await tool.execute({ path: "../escape" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("returns error for non-existent directory", async () => {
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" }));
    const result = await tool.execute({ path: "missing" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});
