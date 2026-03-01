import { FileEditTool } from "./file-edit.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ToolContext } from "./tool.interface.js";

let tempDir: string;
let ctx: ToolContext;
let tool: FileEditTool;

const INITIAL_CONTENT = "hello world hello\nfoo bar baz\nhello again\n";

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-edit-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  tool = new FileEditTool();
  // Reset the test file before each test so edits don't bleed across tests
  writeFileSync(join(tempDir, "test.txt"), INITIAL_CONTENT);
});

describe("FileEditTool", () => {
  it("performs a single replacement correctly", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "foo bar baz", new_string: "replaced line" },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1 replacement");

    const updated = readFileSync(join(tempDir, "test.txt"), "utf-8");
    expect(updated).toContain("replaced line");
    expect(updated).not.toContain("foo bar baz");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "hello", new_string: "hi", replace_all: true },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("3 replacements");

    const updated = readFileSync(join(tempDir, "test.txt"), "utf-8");
    expect(updated).not.toContain("hello");
    expect(updated).toContain("hi world hi");
    expect(updated).toContain("hi again");
  });

  it("returns error when old_string is not found", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "nonexistent string", new_string: "x" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when old_string appears multiple times without replace_all", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "hello", new_string: "hi" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple times");
  });

  it("returns error when old_string equals new_string", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "hello", new_string: "hello" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("identical");
  });

  it("returns error in read-only mode", async () => {
    const readOnlyCtx: ToolContext = {
      projectPath: tempDir,
      workingDirectory: tempDir,
      readOnly: true,
    };
    const result = await tool.execute(
      { path: "test.txt", old_string: "foo", new_string: "bar" },
      readOnlyCtx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error when file is not found", async () => {
    const result = await tool.execute(
      { path: "missing.txt", old_string: "a", new_string: "b" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute(
      { path: "", old_string: "a", new_string: "b" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error when old_string is empty", async () => {
    const result = await tool.execute(
      { path: "test.txt", old_string: "", new_string: "b" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });
});
