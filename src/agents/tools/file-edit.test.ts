import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileEditTool } from "./file-edit.js";
import { createToolContext } from "../../test-helpers.js";

vi.mock("../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("hello world hello"),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { validatePath } from "../../security/path-guard.js";
import { readFile, writeFile } from "node:fs/promises";

describe("FileEditTool", () => {
  let tool: FileEditTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new FileEditTool();
    vi.mocked(validatePath).mockResolvedValue({ valid: true, fullPath: "/test/project/file.cs" });
    vi.mocked(readFile).mockResolvedValue("hello world hello");
  });

  it("replaces a unique string", async () => {
    vi.mocked(readFile).mockResolvedValue("foo bar baz");
    const result = await tool.execute(
      { path: "t.cs", old_string: "bar", new_string: "qux" },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1 replacement");
    expect(writeFile).toHaveBeenCalledWith(
      "/test/project/file.cs",
      "foo qux baz",
      "utf-8"
    );
  });

  it("replaces all occurrences with replace_all", async () => {
    const result = await tool.execute(
      { path: "t.cs", old_string: "hello", new_string: "hi", replace_all: true },
      ctx
    );
    expect(result.content).toContain("2 replacements");
    expect(writeFile).toHaveBeenCalledWith(
      "/test/project/file.cs",
      "hi world hi",
      "utf-8"
    );
  });

  it("returns error when old_string appears multiple times without replace_all", async () => {
    const result = await tool.execute(
      { path: "t.cs", old_string: "hello", new_string: "hi" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple times");
  });

  it("returns error when old_string not found", async () => {
    const result = await tool.execute(
      { path: "t.cs", old_string: "nonexistent", new_string: "x" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when old_string equals new_string", async () => {
    const result = await tool.execute(
      { path: "t.cs", old_string: "hello", new_string: "hello" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("identical");
  });

  it("returns error in read-only mode", async () => {
    const result = await tool.execute(
      { path: "t.cs", old_string: "a", new_string: "b" },
      createToolContext({ readOnly: true })
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute(
      { path: "", old_string: "a", new_string: "b" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for file not found", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" }));
    const result = await tool.execute(
      { path: "missing.cs", old_string: "a", new_string: "b" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });
});
