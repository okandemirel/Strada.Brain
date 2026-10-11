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

  // String.prototype.replace with a string replacement expands `$` patterns,
  // so a single (non-replace_all) edit used to write `$$` as `$`, `$&` as the
  // matched text, and `$'` / `` $` `` as the rest of the file around it.
  it("writes `$` replacement patterns in new_string verbatim", async () => {
    const newString = "a $$ b $& c $' d $` e $1 f";
    const result = await tool.execute(
      { path: "test.txt", old_string: "foo bar baz", new_string: newString },
      ctx
    );
    expect(result.isError).toBeUndefined();

    const updated = readFileSync(join(tempDir, "test.txt"), "utf-8");
    expect(updated).toBe(`hello world hello\n${newString}\nhello again\n`);
  });

  // Audit orchestrator#1: a model writes old_string with bare \n even when
  // file_read showed it the \r, so multi-line edits of CRLF files all missed.
  describe("on a CRLF file", () => {
    const CRLF = "public class A {\r\n    int x = 1;\r\n    int y = 1;\r\n}\r\n";

    beforeEach(() => {
      writeFileSync(join(tempDir, "crlf.cs"), CRLF);
    });

    it("matches a \\n old_string against the file's \\r\\n and writes new_string with \\r\\n", async () => {
      const result = await tool.execute(
        { path: "crlf.cs", old_string: "    int x = 1;\n    int y = 1;", new_string: "    int x = 2;\n    int y = 2;" },
        ctx
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("CRLF");
      expect(readFileSync(join(tempDir, "crlf.cs"), "utf-8")).toBe(
        "public class A {\r\n    int x = 2;\r\n    int y = 2;\r\n}\r\n",
      );
    });

    it("does the same under replace_all", async () => {
      const result = await tool.execute(
        { path: "crlf.cs", old_string: "1;\n", new_string: "3;\n", replace_all: true },
        ctx
      );
      expect(result.content).toContain("2 replacements");
      expect(readFileSync(join(tempDir, "crlf.cs"), "utf-8")).toBe(
        "public class A {\r\n    int x = 3;\r\n    int y = 3;\r\n}\r\n",
      );
    });

    it("still reports a real miss, and leaves an LF file's own matches alone", async () => {
      const miss = await tool.execute(
        { path: "crlf.cs", old_string: "    int x = 1;\n    int z = 1;", new_string: "x" },
        ctx
      );
      expect(miss.isError).toBe(true);
      expect(miss.content).toContain("old_string not found");
      expect(readFileSync(join(tempDir, "crlf.cs"), "utf-8")).toBe(CRLF);

      const lf = await tool.execute(
        { path: "test.txt", old_string: "foo bar baz\nhello", new_string: "a\nb" },
        ctx
      );
      expect(lf.content).not.toContain("CRLF");
      expect(readFileSync(join(tempDir, "test.txt"), "utf-8")).toBe("hello world hello\na\nb again\n");
    });
  });
});
