import { FileReadTool } from "./file-read.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ToolContext } from "./tool.interface.js";

let tempDir: string;
let ctx: ToolContext;
let tool: FileReadTool;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-read-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };

  // Create test files
  writeFileSync(join(tempDir, "hello.txt"), "Hello\nWorld\nFoo\nBar\nBaz\n");
  writeFileSync(join(tempDir, "five-lines.txt"), "line1\nline2\nline3\nline4\nline5");
  mkdirSync(join(tempDir, "subdir"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  tool = new FileReadTool();
});

describe("FileReadTool", () => {
  it("reads a normal file and returns content with line numbers", async () => {
    const result = await tool.execute({ path: "hello.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello.txt");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    // Should have line-number formatting with " | "
    expect(result.content).toMatch(/\d+ \| Hello/);
    expect(result.content).toMatch(/\d+ \| World/);
  });

  it("returns isError when file is not found", async () => {
    const result = await tool.execute({ path: "nonexistent.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  it("returns error when target is a directory", async () => {
    const result = await tool.execute({ path: "subdir" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a file");
  });

  it("respects offset and limit parameters", async () => {
    const result = await tool.execute(
      { path: "five-lines.txt", offset: 2, limit: 2 },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
    // Should not contain lines outside the slice
    expect(result.content).not.toMatch(/\| line1$/m);
    expect(result.content).not.toMatch(/\| line4$/m);
    expect(result.content).toContain("showing 2-3");
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute({ path: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for files larger than 512KB", async () => {
    const largePath = join(tempDir, "large-file.txt");
    // Write a file just over 512KB
    writeFileSync(largePath, "x".repeat(512 * 1024 + 1));

    const result = await tool.execute({ path: "large-file.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
  });

  it("uses default offset of 1 and default limit of 2000", async () => {
    const result = await tool.execute({ path: "five-lines.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    // Default offset=1 means the first line is included
    expect(result.content).toContain("line1");
    // All 5 lines should be present (well under limit of 2000)
    expect(result.content).toContain("line5");
    expect(result.content).toContain("showing 1-5");
  });

  it("right-pads line numbers to 5 characters", async () => {
    const result = await tool.execute({ path: "five-lines.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    // Line 1 should be padded to 5 chars: "    1 | line1"
    expect(result.content).toContain("    1 | line1");
    expect(result.content).toContain("    2 | line2");
  });
});
