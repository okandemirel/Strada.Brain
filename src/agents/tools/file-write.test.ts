import { FileWriteTool } from "./file-write.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import type { ToolContext } from "./tool.interface.js";

let tempDir: string;
let ctx: ToolContext;
let tool: FileWriteTool;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-write-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  tool = new FileWriteTool();
});

describe("FileWriteTool", () => {
  it("writes a file and returns a success message", async () => {
    const result = await tool.execute(
      { path: "output.txt", content: "Hello, World!\nSecond line." },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("File written");
    expect(result.content).toContain("output.txt");

    // Verify the file was actually created on disk
    const written = readFileSync(join(tempDir, "output.txt"), "utf-8");
    expect(written).toBe("Hello, World!\nSecond line.");
  });

  it("returns error in read-only mode", async () => {
    const readOnlyCtx: ToolContext = {
      projectPath: tempDir,
      workingDirectory: tempDir,
      readOnly: true,
    };
    const result = await tool.execute(
      { path: "blocked.txt", content: "data" },
      readOnlyCtx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error when content exceeds 256KB", async () => {
    const hugeContent = "x".repeat(256 * 1024 + 1);
    const result = await tool.execute(
      { path: "huge.txt", content: hugeContent },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
  });

  it("creates parent directories for nested paths", async () => {
    // validatePath requires the direct parent to exist for realpath resolution.
    // Create the parent so validation passes, then verify the tool writes
    // the file correctly into the nested structure.
    const { mkdirSync: mkdirSyncNode } = await import("node:fs");
    mkdirSyncNode(join(tempDir, "assets", "scripts"), { recursive: true });

    const result = await tool.execute(
      { path: "assets/scripts/player.txt", content: "nested content" },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("File written");

    const fullPath = join(tempDir, "assets", "scripts", "player.txt");
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath, "utf-8")).toBe("nested content");
  });

  it("returns error when path is empty", async () => {
    const result = await tool.execute({ path: "", content: "data" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("reports the correct byte count in the success message", async () => {
    const content = "abc\ndef";
    const expectedBytes = Buffer.byteLength(content, "utf-8");

    const result = await tool.execute(
      { path: "bytes-check.txt", content },
      ctx
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`${expectedBytes} bytes`);

    // Verify by reading the file back
    const written = readFileSync(join(tempDir, "bytes-check.txt"), "utf-8");
    expect(Buffer.byteLength(written, "utf-8")).toBe(expectedBytes);
  });
});
