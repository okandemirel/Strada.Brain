import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileWriteTool } from "./file-write.js";
import { createToolContext } from "../../test-helpers.js";

vi.mock("../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" }),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { validatePath } from "../../security/path-guard.js";
import { writeFile, mkdir } from "node:fs/promises";

describe("FileWriteTool", () => {
  let tool: FileWriteTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new FileWriteTool();
    vi.mocked(validatePath).mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" });
  });

  it("writes a file successfully", async () => {
    const result = await tool.execute({ path: "test.cs", content: "class A {}" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("File written");
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith("/test/project/file.cs", "class A {}", "utf-8");
  });

  it("returns error in read-only mode", async () => {
    const result = await tool.execute(
      { path: "test.cs", content: "x" },
      createToolContext({ readOnly: true })
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute({ path: "", content: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error when content exceeds 256KB", async () => {
    const bigContent = "x".repeat(300 * 1024);
    const result = await tool.execute({ path: "big.cs", content: bigContent }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
  });

  it("returns error when path validation fails", async () => {
    vi.mocked(validatePath).mockResolvedValue({ valid: false, fullPath: "", error: "blocked" });
    const result = await tool.execute({ path: ".env", content: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked");
  });

  it("creates parent directories", async () => {
    await tool.execute({ path: "Assets/Scripts/New.cs", content: "class A {}" }, ctx);
    expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("reports line count and byte length", async () => {
    const result = await tool.execute({ path: "t.cs", content: "line1\nline2\nline3" }, ctx);
    expect(result.content).toContain("3 lines");
    expect(result.metadata?.lineCount).toBe(3);
  });
});
