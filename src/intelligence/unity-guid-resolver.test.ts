import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSafeToDelete, scanGuidReferences, GUID_SCAN_MAX_DEPTH } from "./unity-guid-resolver.js";
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

/**
 * Audited 2026-09-02: the reference walk was rooted at Assets/ only, so a scene
 * whose GUID lives solely in ProjectSettings/EditorBuildSettings.asset (the
 * ordinary case for a build-list scene) or a package asset under Packages/
 * came back `safe: true` and FileDeleteTool unlinked it.
 */
describe("checkSafeToDelete scan roots (audited 2026-09-02)", () => {
  let root: string;

  beforeAll(() => {
    try {
      createLogger("error", "/tmp/strada-unity-guid-resolver-test.log");
    } catch {
      /* already initialized */
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guid-roots-"));
    await mkdir(join(root, "Assets", "Scenes"), { recursive: true });
    await mkdir(join(root, "ProjectSettings"), { recursive: true });
    await mkdir(join(root, "Packages", "com.x.y"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a scene GUID referenced only from ProjectSettings/EditorBuildSettings.asset", async () => {
    const guid = "c".repeat(32);
    await writeFile(join(root, "Assets", "Scenes", "Level_01.unity"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Scenes", "Level_01.unity.meta"), `fileFormatVersion: 2\nguid: ${guid}\n`);
    await writeFile(
      join(root, "ProjectSettings", "EditorBuildSettings.asset"),
      `%YAML 1.1\nEditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Level_01.unity\n    guid: ${guid}\n`
    );

    const res = await checkSafeToDelete(root, "Assets/Scenes/Level_01.unity");

    expect(res.safe).toBe(false);
    expect(res.references.map((r) => r.filePath.replace(/\\/g, "/"))).toContain(
      "ProjectSettings/EditorBuildSettings.asset"
    );
    expect(res.warning).toContain("EditorBuildSettings.asset");
    expect(res.scannedRoots.map((r) => r.replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining(["Assets", "ProjectSettings", "Packages"])
    );
  });

  it("finds a GUID referenced only from a prefab under Packages/", async () => {
    const guid = "d".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    await writeFile(join(root, "Packages", "com.x.y", "Thing.prefab"), `m_Materials:\n  - {fileID: 2100000, guid: ${guid}, type: 2}\n`);

    const res = await checkSafeToDelete(root, "Assets/Rock.mat");

    expect(res.safe).toBe(false);
    expect(res.references.map((r) => r.filePath.replace(/\\/g, "/"))).toContain("Packages/com.x.y/Thing.prefab");
  });

  it("reports the true referrer count instead of a silently capped one", async () => {
    const guid = "e".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    for (let i = 0; i < 20; i++) {
      await writeFile(join(root, "Assets", `P${i}.prefab`), `m_Materials:\n  - {guid: ${guid}}\n`);
    }

    const res = await checkSafeToDelete(root, "Assets/Rock.mat");

    expect(res.safe).toBe(false);
    // Was "referenced by 5 file(s)" for 20 referrers, with no "and N more" line.
    expect(res.references).toHaveLength(20);
    expect(res.warning).toContain("referenced by 20 file(s)");
    expect(res.warning).toContain("and 15 more");
  });
});

/**
 * Audited 2026-09-02: the walk aborted silently on the depth cap, on a readdir
 * failure and on the result cap, and every abort was indistinguishable from
 * "no references exist" — `safe: true` for a scan that never finished.
 */
describe("checkSafeToDelete never reports an unfinished scan as safe (audited 2026-09-02)", () => {
  let root: string;

  beforeAll(() => {
    try {
      createLogger("error", "/tmp/strada-unity-guid-resolver-test.log");
    } catch {
      /* already initialized */
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guid-incomplete-"));
    await mkdir(join(root, "Assets"), { recursive: true });
  });

  afterEach(async () => {
    // Restore permissions so rm can clean up the chmod-000 fixture.
    try {
      await chmod(join(root, "Assets", "Locked"), 0o755);
    } catch {
      /* fixture not present in this test */
    }
    await rm(root, { recursive: true, force: true });
  });

  it("a reference below the depth cap blocks the delete and names the cap", async () => {
    const guid = "f".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    // GUID_SCAN_MAX_DEPTH + 1 directories under Assets/: the walk cannot reach it.
    const segments = Array.from({ length: GUID_SCAN_MAX_DEPTH + 1 }, (_, i) => `d${i}`);
    const deep = join(root, "Assets", ...segments);
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "Deep.prefab"), `m_Materials:\n  - {guid: ${guid}}\n`);

    const res = await checkSafeToDelete(root, "Assets/Rock.mat");

    expect(res.safe).toBe(false);
    expect(res.scanIncomplete).toBeDefined();
    expect(res.scanIncomplete!.join("\n")).toMatch(/depth/i);
    expect(res.warning).toContain("did not finish");
    expect(res.warning).toMatch(/depth/i);
    expect(res.warning).toContain("Assets/d0/");
  });

  it("an unreadable directory blocks the delete and names the directory", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores chmod
    if (process.platform === "win32") return; // chmod 000 has no readdir effect on Windows
    const guid = "1".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    await mkdir(join(root, "Assets", "Locked"), { recursive: true });
    await writeFile(join(root, "Assets", "Locked", "Hidden.prefab"), `m_Materials:\n  - {guid: ${guid}}\n`);
    await chmod(join(root, "Assets", "Locked"), 0o000);

    const res = await checkSafeToDelete(root, "Assets/Rock.mat");

    expect(res.safe).toBe(false);
    expect(res.references).toHaveLength(0);
    expect(res.warning).toContain("did not finish");
    expect(res.warning).toContain("Assets/Locked");
  });

  it("a scan that hit the result cap says 'at least' instead of a hard count", async () => {
    const guid = "2".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    for (let i = 0; i < 4; i++) {
      await writeFile(join(root, "Assets", `P${i}.prefab`), `m_Materials:\n  - {guid: ${guid}}\n`);
    }

    const scan = await scanGuidReferences(root, guid, GUID_SCAN_MAX_DEPTH, 3);

    expect(scan.references).toHaveLength(3);
    expect(scan.incomplete.join("\n")).toMatch(/result cap/i);
  });

  it("a complete scan with no references stays safe and reports an empty incomplete list", async () => {
    const guid = "3".repeat(32);
    await writeFile(join(root, "Assets", "Rock.mat"), "%YAML 1.1\n");
    await writeFile(join(root, "Assets", "Rock.mat.meta"), `guid: ${guid}\n`);
    await mkdir(join(root, "Assets", "Sub"), { recursive: true });
    await writeFile(join(root, "Assets", "Sub", "Other.prefab"), `m_Materials:\n  - {guid: ${"4".repeat(32)}}\n`);

    const res = await checkSafeToDelete(root, "Assets/Rock.mat");

    expect(res.safe).toBe(true);
    expect(res.scanIncomplete ?? []).toEqual([]);
  });
});
