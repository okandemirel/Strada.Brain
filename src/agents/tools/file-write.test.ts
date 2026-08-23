import { FileWriteTool, writeFileInsideRoot } from "./file-write.js";
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

describe("FileWriteTool TOCTOU containment", () => {
  // Measured 2026-08-23: validatePath resolved symlinks at CHECK time; the write
  // followed whatever sat at the path at WRITE time, so a symlink swapped in
  // between (the race) escaped the project root. The static-symlink case is
  // already caught by validatePath — this exercises the writer's own defenses.
  it("refuses to write through a symlink at the target path (ELOOP), leaving the target untouched", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "strada-toc-"));
    try {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "original", "utf-8");

      const project = join(root, "project");
      mkdirSync(project, { recursive: true });
      const linkPath = join(project, "Assets.cs");
      symlinkSync(outside, linkPath);

      await expect(writeFileInsideRoot(project, linkPath, "class X {}"))
        .rejects.toMatchObject({ code: "ELOOP" });
      expect(readFileSync(outside, "utf-8")).toBe("original");

      // A plain (non-symlink) target inside the root still writes fine.
      await writeFileInsideRoot(project, join(project, "Ok.cs"), "class Ok {}");
      expect(readFileSync(join(project, "Ok.cs"), "utf-8")).toBe("class Ok {}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the parent directory is swapped to a real directory outside the root", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "strada-toc2-"));
    try {
      const outsideDir = join(root, "outside-dir");
      mkdirSync(outsideDir, { recursive: true });
      const project = join(root, "project");
      mkdirSync(join(project, "sub"), { recursive: true });

      // The path LOOKS inside the project but its parent resolves outside.
      await expect(
        writeFileInsideRoot(join(project, "sub"), join(root, "project", "sub", "..", "..", "outside-dir", "x.txt"), "no"),
      ).rejects.toThrow(/escaped the project root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
