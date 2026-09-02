import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileDeleteTool, FileRenameTool, FileDeleteDirectoryTool } from "./file-manage.js";
import { createLogger } from "../../utils/logger.js";
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

/**
 * The GUID reference check is the only hard block on an irreversible delete.
 * Audited 2026-09-02: validatePath accepts an in-project ABSOLUTE path, but the
 * check was handed the raw input, built <project>/<project>/X.prefab.meta,
 * found nothing, and answered "safe" — so a prefab every scene references was
 * deleted with a bare "Deleted:" that read exactly like a passed check.
 */
describe("FileDeleteTool GUID reference check", () => {
  const tool = new FileDeleteTool();
  const guid = "0123456789abcdef0123456789abcdef";

  beforeAll(() => {
    // checkSafeToDelete logs via getLogger(); initialize once (idempotent).
    try {
      createLogger("error", join(tmpdir(), "strada-file-manage-test.log"));
    } catch {
      /* already initialized by another suite */
    }
  });

  async function referencedPrefab(): Promise<string> {
    await mkdir(join(tempDir, "Assets", "Prefabs"), { recursive: true });
    await mkdir(join(tempDir, "Assets", "Scenes"), { recursive: true });
    const prefab = join(tempDir, "Assets", "Prefabs", "Board.prefab");
    await writeFile(prefab, "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Board\n");
    await writeFile(`${prefab}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
    await writeFile(
      join(tempDir, "Assets", "Scenes", "Main.unity"),
      `%YAML 1.1\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n`,
    );
    return prefab;
  }

  it("blocks a referenced prefab named by relative path (control)", async () => {
    const prefab = await referencedPrefab();
    const result = await tool.execute({ path: "Assets/Prefabs/Board.prefab" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("referenced by 1 file(s)");
    await expect(stat(prefab)).resolves.toBeDefined();
  });

  it("blocks the same referenced prefab named by absolute path", async () => {
    const prefab = await referencedPrefab();
    const result = await tool.execute({ path: prefab }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("referenced by 1 file(s)");
    await expect(stat(prefab)).resolves.toBeDefined();
  });

  it("blocks the same referenced prefab named with a ./ prefix", async () => {
    const prefab = await referencedPrefab();
    const result = await tool.execute({ path: "./Assets/Prefabs/Board.prefab" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("referenced by 1 file(s)");
    await expect(stat(prefab)).resolves.toBeDefined();
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

  it("overwrites destination on rename (POSIX behavior)", async () => {
    await writeFile(join(tempDir, "a.txt"), "a");
    await writeFile(join(tempDir, "b.txt"), "b");
    const result = await tool.execute(
      { old_path: "a.txt", new_path: "b.txt" },
      ctx,
    );
    // POSIX rename overwrites the destination
    expect(result.content).toContain("Renamed");
    const content = await readFile(join(tempDir, "b.txt"), "utf-8");
    expect(content).toBe("a");
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

/**
 * Audited 2026-09-02: the GUID check is fail-closed — an unfinished scan is
 * never "safe" — but there was no way past it, so a directory the process
 * cannot read (EACCES) blocked every Unity-tracked delete under that project
 * permanently. `force: true` is the caller's explicit "proceed without the
 * check"; nothing else skips it, and the result never reads like a check
 * that passed.
 */
describe("FileDeleteTool force skips the GUID check only on request (audited 2026-09-02)", () => {
  const tool = new FileDeleteTool();
  const guid = "89abcdef89abcdef89abcdef89abcdef";
  const unreadableSupported =
    process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0);

  /** A tracked asset whose reference scan cannot finish: Assets/Locked is chmod 000. */
  async function trackedAssetWithUnreadableDir(): Promise<string> {
    await mkdir(join(tempDir, "Assets", "Locked"), { recursive: true });
    const mat = join(tempDir, "Assets", "Rock.mat");
    await writeFile(mat, "%YAML 1.1\n");
    await writeFile(`${mat}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
    await writeFile(join(tempDir, "Assets", "Locked", "Hidden.prefab"), `m_Materials:\n  - {guid: ${guid}}\n`);
    await chmod(join(tempDir, "Assets", "Locked"), 0o000);
    return mat;
  }

  afterEach(async () => {
    try {
      await chmod(join(tempDir, "Assets", "Locked"), 0o755);
    } catch {
      /* fixture not present in this test */
    }
  });

  it("without force, an unverified verdict still refuses the delete", async () => {
    if (!unreadableSupported) return;
    const mat = await trackedAssetWithUnreadableDir();

    const result = await tool.execute({ path: "Assets/Rock.mat" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not finish");
    expect(result.content).toContain("Assets/Locked");
    // ...and it says how a caller who accepts the risk can proceed.
    expect(result.content).toContain("force: true");
    await expect(stat(mat)).resolves.toBeDefined();
  });

  it("with force, the delete proceeds and the result says the check was skipped on request", async () => {
    if (!unreadableSupported) return;
    const mat = await trackedAssetWithUnreadableDir();

    const result = await tool.execute({ path: "Assets/Rock.mat", force: true }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Deleted: Assets/Rock.mat");
    // A skipped check must never read like a passed one.
    expect(result.content).toMatch(/SKIPPED on request/);
    expect(result.content).toContain("force: true");
    expect(result.content).toMatch(/never scanned|not .*(verified|safe)/i);
    expect(result.metadata).toMatchObject({ guidCheckSkipped: true });
    await expect(stat(mat)).rejects.toThrow();
  });

  it("force is off unless the caller passes exactly true", async () => {
    if (!unreadableSupported) return;
    const mat = await trackedAssetWithUnreadableDir();

    // A truthy-but-not-true value must not open the gate.
    const result = await tool.execute({ path: "Assets/Rock.mat", force: "yes" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not finish");
    await expect(stat(mat)).resolves.toBeDefined();
  });

  it("a delete with no force still reports the check it actually ran", async () => {
    await mkdir(join(tempDir, "Assets"), { recursive: true });
    const mat = join(tempDir, "Assets", "Unused.mat");
    await writeFile(mat, "%YAML 1.1\n");
    await writeFile(`${mat}.meta`, `fileFormatVersion: 2\nguid: ${"7".repeat(32)}\n`);

    const result = await tool.execute({ path: "Assets/Unused.mat" }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Deleted: Assets/Unused.mat");
    expect(result.content).not.toMatch(/SKIPPED/);
    expect(result.metadata).toMatchObject({ guidCheckSkipped: false });
    await expect(stat(mat)).rejects.toThrow();
  });
});
