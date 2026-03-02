import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileDeleteTool, FileRenameTool, FileDeleteDirectoryTool } from "./file-manage.js";
import type { ToolContext } from "./tool.interface.js";

let tempDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "file-manage-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("FileDeleteTool", () => {
  const tool = new FileDeleteTool();

  it("deletes a file", async () => {
    await writeFile(join(tempDir, "test.txt"), "content");
    const result = await tool.execute({ path: "test.txt" }, ctx);
    expect(result.content).toContain("Deleted");

    // Verify file is gone
    await expect(stat(join(tempDir, "test.txt"))).rejects.toThrow();
  });

  it("blocks in read-only mode", async () => {
    const result = await tool.execute(
      { path: "test.txt" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("errors on missing file", async () => {
    const result = await tool.execute({ path: "nonexistent.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("errors on directory", async () => {
    await mkdir(join(tempDir, "subdir"));
    const result = await tool.execute({ path: "subdir" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a file");
  });

  it("requires path", async () => {
    const result = await tool.execute({ path: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("blocks path traversal", async () => {
    const result = await tool.execute({ path: "../../etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside");
  });
});

describe("FileRenameTool", () => {
  const tool = new FileRenameTool();

  it("renames a file", async () => {
    await writeFile(join(tempDir, "old.txt"), "content");
    const result = await tool.execute(
      { old_path: "old.txt", new_path: "new.txt" },
      ctx,
    );
    expect(result.content).toContain("Renamed");

    // Verify rename happened
    const content = await readFile(join(tempDir, "new.txt"), "utf-8");
    expect(content).toBe("content");
    await expect(stat(join(tempDir, "old.txt"))).rejects.toThrow();
  });

  it("blocks in read-only mode", async () => {
    const result = await tool.execute(
      { old_path: "a.txt", new_path: "b.txt" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("errors when source doesn't exist", async () => {
    const result = await tool.execute(
      { old_path: "missing.txt", new_path: "new.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("errors when destination exists", async () => {
    await writeFile(join(tempDir, "a.txt"), "a");
    await writeFile(join(tempDir, "b.txt"), "b");
    const result = await tool.execute(
      { old_path: "a.txt", new_path: "b.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
  });

  it("requires both paths", async () => {
    const r1 = await tool.execute({ old_path: "a.txt" }, ctx);
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute({ new_path: "b.txt" }, ctx);
    expect(r2.isError).toBe(true);
  });
});

describe("FileDeleteDirectoryTool", () => {
  const tool = new FileDeleteDirectoryTool();

  it("deletes a directory with files", async () => {
    await mkdir(join(tempDir, "subdir"));
    await writeFile(join(tempDir, "subdir/a.txt"), "a");
    await writeFile(join(tempDir, "subdir/b.txt"), "b");

    const result = await tool.execute({ path: "subdir" }, ctx);
    expect(result.content).toContain("Deleted directory");
    expect(result.content).toContain("2 files");

    await expect(stat(join(tempDir, "subdir"))).rejects.toThrow();
  });

  it("blocks deleting project root", async () => {
    const r1 = await tool.execute({ path: "." }, ctx);
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("project root");
  });

  it("blocks in read-only mode", async () => {
    const result = await tool.execute(
      { path: "subdir" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("errors on files (not directories)", async () => {
    await writeFile(join(tempDir, "file.txt"), "content");
    const result = await tool.execute({ path: "file.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a directory");
  });

  it("blocks directories with too many files", async () => {
    const dir = join(tempDir, "big");
    await mkdir(dir);
    for (let i = 0; i < 55; i++) {
      await writeFile(join(dir, `file${i}.txt`), `${i}`);
    }
    const result = await tool.execute({ path: "big" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit: 50");
  });
});
