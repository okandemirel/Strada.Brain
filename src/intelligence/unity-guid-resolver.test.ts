import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSafeToDelete } from "./unity-guid-resolver.js";
import { createLogger } from "../utils/logger.js";

/**
 * Regression for the Unity GUID self-reference filter: `ref.filePath` is
 * produced by `path.relative()` (native separators) while the caller-supplied
 * `filePath` may use `/`. On Windows a raw `!==` failed to recognize the file's
 * own `.meta`, falsely reporting a self-reference and blocking a safe delete.
 * Passing a backslash-style relative path exercises the separator normalization
 * on every platform.
 */
describe("checkSafeToDelete self-reference filter", () => {
  let root: string;

  beforeAll(() => {
    // checkSafeToDelete logs via getLogger(); initialize once (idempotent).
    try {
      createLogger("error", "/tmp/strada-unity-guid-resolver-test.log");
    } catch {
      /* already initialized by another suite */
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guid-resolver-"));
    await mkdir(join(root, "Assets"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats a file whose only reference is its own .meta as safe (backslash input)", async () => {
    const guid = "a".repeat(32);
    await writeFile(join(root, "Assets", "Foo.cs"), "// code\n");
    await writeFile(join(root, "Assets", "Foo.cs.meta"), `guid: ${guid}\n`);

    // Backslash-style relative path mimics Windows tool input; the filter must
    // still recognize `Assets/Foo.cs.meta` as the self-reference and exclude it.
    const res = await checkSafeToDelete(root, "Assets\\Foo.cs");

    expect(res.safe).toBe(true);
    expect(res.references).toHaveLength(0);
  });

  it("still reports a genuine external reference", async () => {
    const guid = "b".repeat(32);
    await writeFile(join(root, "Assets", "Foo.cs"), "// code\n");
    await writeFile(join(root, "Assets", "Foo.cs.meta"), `guid: ${guid}\n`);
    await writeFile(join(root, "Assets", "Scene.unity"), `m_Script: {guid: ${guid}}\n`);

    const res = await checkSafeToDelete(root, "Assets/Foo.cs");

    expect(res.safe).toBe(false);
    expect(res.references.length).toBeGreaterThan(0);
  });
});
