import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileReadTool } from "./file-read.js";
import { createToolContext } from "../../test-helpers.js";

vi.mock("../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" }),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({
    isFile: () => true,
    size: 100,
  }),
  readFile: vi.fn().mockResolvedValue("line1\nline2\nline3\nline4\nline5"),
}));

import { validatePath } from "../../security/path-guard.js";
import { stat, readFile } from "node:fs/promises";

describe("FileReadTool", () => {
  let tool: FileReadTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new FileReadTool();
    vi.mocked(validatePath).mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" });
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
    vi.mocked(readFile).mockResolvedValue("line1\nline2\nline3\nline4\nline5");
  });

  it("has correct tool metadata", () => {
    expect(tool.name).toBe("file_read");
    expect(tool.inputSchema.required).toContain("path");
  });

  it("reads a file with line numbers", async () => {
    const result = await tool.execute({ path: "test.cs" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("line1");
    expect(result.content).toContain("5 lines total");
    expect(result.content).toMatch(/\d+ \| line1/);
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute({ path: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error when path validation fails", async () => {
    vi.mocked(validatePath).mockResolvedValue({ valid: false, fullPath: "", error: "outside" });
    const result = await tool.execute({ path: "../escape" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside");
  });

  it("returns error for files exceeding 512KB", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 600 * 1024 } as any);
    const result = await tool.execute({ path: "big.cs" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
  });

  it("returns error when target is not a file", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, size: 0 } as any);
    const result = await tool.execute({ path: "dir/" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a file");
  });

  it("returns error for file not found", async () => {
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await tool.execute({ path: "missing.cs" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  it("respects offset and limit", async () => {
    const result = await tool.execute({ path: "test.cs", offset: 2, limit: 2 }, ctx);
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
    expect(result.content).toContain("showing 2-3");
  });

  it("uses default offset and limit", async () => {
    const result = await tool.execute({ path: "test.cs" }, ctx);
    expect(result.content).toContain("line1");
    expect(result.content).toContain("line5");
  });
});
