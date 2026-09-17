import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { FrameworkKnowledgeStore, computeSnapshotFingerprint } from "./framework-knowledge-store.js";
import type { FrameworkAPISnapshot, FrameworkPackageId } from "./framework-types.js";
import { UNATTRIBUTED_PROJECT_ID } from "./framework-types.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<FrameworkAPISnapshot> & { packageId: FrameworkPackageId } = { packageId: "core" },
): FrameworkAPISnapshot {
  return {
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: "abc123",
    namespaces: ["Strada.Core"],
    baseClasses: new Map([["MonoBehaviour", ["PlayerController"]]]),
    attributes: new Map([["Serializable", ["HealthData"]]]),
    interfaces: [{ name: "ISystem", namespace: "Strada.Core.ECS", methods: ["OnUpdate"] }],
    enums: [{ name: "GameState", namespace: "Strada.Core", values: ["Playing", "Paused"] }],
    classes: [{ name: "SystemBase", namespace: "Strada.Core.ECS", baseTypes: [], isAbstract: true }],
    structs: [{ name: "Vector3", namespace: "Strada.Core.Math", baseTypes: [] }],
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: new Date("2026-01-15T10:00:00Z"),
    sourcePath: "/projects/strada-core",
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FrameworkKnowledgeStore", () => {
  let tmpDir: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fks-test-"));
    store = new FrameworkKnowledgeStore(join(tmpDir, "test.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Storage & retrieval
  // -------------------------------------------------------------------------

  it("stores and retrieves a snapshot", () => {
    const snapshot = makeSnapshot({ packageId: "core" });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.packageId).toBe("core");
    expect(retrieved!.packageName).toBe("Strada.Core");
    expect(retrieved!.version).toBe("1.0.0");
    expect(retrieved!.gitHash).toBe("abc123");
    expect(retrieved!.fileCount).toBe(42);
    expect(retrieved!.sourceOrigin).toBe("local");
    expect(retrieved!.sourceLanguage).toBe("csharp");
  });

  it("preserves Map fields (baseClasses, attributes) across serialize/deserialize", () => {
    const snapshot = makeSnapshot({ packageId: "core" });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.baseClasses).toBeInstanceOf(Map);
    expect(retrieved!.baseClasses.get("MonoBehaviour")).toEqual(["PlayerController"]);
    expect(retrieved!.attributes).toBeInstanceOf(Map);
    expect(retrieved!.attributes.get("Serializable")).toEqual(["HealthData"]);
  });

  it("preserves array fields (interfaces, enums, classes, structs)", () => {
    const snapshot = makeSnapshot({ packageId: "core" });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.interfaces).toHaveLength(1);
    expect(retrieved!.interfaces[0]!.name).toBe("ISystem");
    expect(retrieved!.enums).toHaveLength(1);
    expect(retrieved!.enums[0]!.values).toEqual(["Playing", "Paused"]);
    expect(retrieved!.classes).toHaveLength(1);
    expect(retrieved!.classes[0]!.isAbstract).toBe(true);
    expect(retrieved!.structs).toHaveLength(1);
  });

  it("preserves extractedAt as a Date", () => {
    const snapshot = makeSnapshot({ packageId: "core" });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.extractedAt).toBeInstanceOf(Date);
    expect(retrieved!.extractedAt.getTime()).toBe(new Date("2026-01-15T10:00:00Z").getTime());
  });

  it("returns null for a non-existent package", () => {
    const result = store.getLatestSnapshot("modules");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // History management
  // -------------------------------------------------------------------------

  it("getLatestSnapshot returns the most recent snapshot", () => {
    const older = makeSnapshot({
      packageId: "core",
      version: "1.0.0",
      extractedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = makeSnapshot({
      packageId: "core",
      version: "2.0.0",
      extractedAt: new Date("2026-02-01T00:00:00Z"),
    });

    store.storeSnapshot(older);
    store.storeSnapshot(newer);

    const latest = store.getLatestSnapshot("core");
    expect(latest!.version).toBe("2.0.0");
  });

  it("getPreviousSnapshot returns the second-most-recent snapshot", () => {
    const first = makeSnapshot({
      packageId: "core",
      version: "1.0.0",
      extractedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const second = makeSnapshot({
      packageId: "core",
      version: "2.0.0",
      extractedAt: new Date("2026-02-01T00:00:00Z"),
    });

    store.storeSnapshot(first);
    store.storeSnapshot(second);

    const prev = store.getPreviousSnapshot("core");
    expect(prev).not.toBeNull();
    expect(prev!.version).toBe("1.0.0");
  });

  it("getPreviousSnapshot returns null when only one snapshot exists", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core" }));
    const prev = store.getPreviousSnapshot("core");
    expect(prev).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it("stores and retrieves metadata", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core" }));

    const meta = store.getMetadata("core");
    expect(meta).not.toBeNull();
    expect(meta!.packageId).toBe("core");
    expect(meta!.lastVersion).toBe("1.0.0");
    expect(meta!.lastGitHash).toBe("abc123");
    expect(meta!.syncCount).toBe(1);
  });

  it("increments syncCount on each storeSnapshot call", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core",
      extractedAt: new Date("2026-01-01T00:00:00Z"),
    }));
    store.storeSnapshot(makeSnapshot({
      packageId: "core",
      extractedAt: new Date("2026-02-01T00:00:00Z"),
    }));
    store.storeSnapshot(makeSnapshot({
      packageId: "core",
      extractedAt: new Date("2026-03-01T00:00:00Z"),
    }));

    const meta = store.getMetadata("core");
    expect(meta!.syncCount).toBe(3);
  });

  it("returns null metadata for a non-existent package", () => {
    const meta = store.getMetadata("mcp");
    expect(meta).toBeNull();
  });

  // -------------------------------------------------------------------------
  // needsSync
  // -------------------------------------------------------------------------

  it("needsSync returns true when no metadata exists", () => {
    expect(store.needsSync("core", "1.0.0", "abc123")).toBe(true);
  });

  it("needsSync returns true when git hash changes", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", gitHash: "abc123" }));
    expect(store.needsSync("core", "1.0.0", "def456")).toBe(true);
  });

  it("needsSync returns true when version changes", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", version: "1.0.0" }));
    expect(store.needsSync("core", "2.0.0", "abc123")).toBe(true);
  });

  it("needsSync returns false when version and hash match", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core",
      version: "1.0.0",
      gitHash: "abc123",
    }));
    expect(store.needsSync("core", "1.0.0", "abc123")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  it("pruneHistory keeps only the N most recent snapshots per package", () => {
    for (let i = 0; i < 8; i++) {
      store.storeSnapshot(makeSnapshot({
        packageId: "core",
        version: `${i}.0.0`,
        extractedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }));
    }

    store.pruneHistory(3);

    // Only 3 should remain
    const latest = store.getLatestSnapshot("core");
    expect(latest!.version).toBe("7.0.0");

    const prev = store.getPreviousSnapshot("core");
    expect(prev!.version).toBe("6.0.0");
  });

  it("pruneHistory with default keepCount (5) works correctly", () => {
    for (let i = 0; i < 10; i++) {
      store.storeSnapshot(makeSnapshot({
        packageId: "core",
        version: `${i}.0.0`,
        extractedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }));
    }

    store.pruneHistory();

    const ids = store.getStoredPackageIds();
    expect(ids).toContain("core");

    // The latest should be version 9.0.0
    const latest = store.getLatestSnapshot("core");
    expect(latest!.version).toBe("9.0.0");
  });

  it("pruneHistory handles multiple packages independently", () => {
    for (let i = 0; i < 5; i++) {
      store.storeSnapshot(makeSnapshot({
        packageId: "core",
        version: `${i}.0.0`,
        extractedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }));
      store.storeSnapshot(makeSnapshot({
        packageId: "modules",
        packageName: "Strada.Modules",
        version: `${i}.0.0`,
        extractedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }));
    }

    store.pruneHistory(2);

    const latestCore = store.getLatestSnapshot("core");
    expect(latestCore!.version).toBe("4.0.0");

    const latestModules = store.getLatestSnapshot("modules");
    expect(latestModules!.version).toBe("4.0.0");
  });

  // -------------------------------------------------------------------------
  // getStoredPackageIds
  // -------------------------------------------------------------------------

  it("getStoredPackageIds returns all stored package IDs", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core" }));
    store.storeSnapshot(makeSnapshot({
      packageId: "modules",
      packageName: "Strada.Modules",
      extractedAt: new Date("2026-02-01T00:00:00Z"),
    }));

    const ids = store.getStoredPackageIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("core");
    expect(ids).toContain("modules");
  });

  it("getStoredPackageIds returns empty array when no snapshots exist", () => {
    const ids = store.getStoredPackageIds();
    expect(ids).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles snapshots with null version and gitHash", () => {
    const snapshot = makeSnapshot({
      packageId: "core",
      version: null,
      gitHash: null,
    });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.version).toBeNull();
    expect(retrieved!.gitHash).toBeNull();
  });

  it("handles empty Maps in baseClasses and attributes", () => {
    const snapshot = makeSnapshot({
      packageId: "core",
      baseClasses: new Map(),
      attributes: new Map(),
    } as FrameworkAPISnapshot & { packageId: FrameworkPackageId });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.baseClasses.size).toBe(0);
    expect(retrieved!.attributes.size).toBe(0);
  });

  it("handles empty arrays in all collection fields", () => {
    const snapshot = makeSnapshot({
      packageId: "core",
      namespaces: [],
      interfaces: [],
      enums: [],
      classes: [],
      structs: [],
      exportedFunctions: [],
      tools: [],
      resources: [],
      prompts: [],
    } as FrameworkAPISnapshot & { packageId: FrameworkPackageId });
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.namespaces).toEqual([]);
    expect(retrieved!.interfaces).toEqual([]);
    expect(retrieved!.enums).toEqual([]);
  });

  it("initialize can be called multiple times (CREATE IF NOT EXISTS)", () => {
    expect(() => {
      store.initialize();
      store.initialize();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// needsSync must measure content, not only version/hash (audited 2026-09-02)
// ---------------------------------------------------------------------------

describe("needsSync content fingerprint (audited 2026-09-02)", () => {
  let tmpDir: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fw-store-fp-"));
    store = new FrameworkKnowledgeStore(join(tmpDir, "fp.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when version and hash match but the extracted API content differs", () => {
    const stored = makeSnapshot({ packageId: "core", version: "1.0.0", gitHash: "abc123" });
    store.storeSnapshot(stored);

    const edited = makeSnapshot({
      packageId: "core",
      version: "1.0.0",
      gitHash: "abc123",
      classes: [
        ...stored.classes,
        { name: "NetworkSystemBase", namespace: "Strada.Core.ECS", baseTypes: ["SystemBase"], isAbstract: true },
      ],
    });

    expect(computeSnapshotFingerprint(edited)).not.toBe(computeSnapshotFingerprint(stored));
    expect(store.needsSync("core", "1.0.0", "abc123", computeSnapshotFingerprint(edited))).toBe(true);
    expect(store.needsSync("core", "1.0.0", "abc123", computeSnapshotFingerprint(stored))).toBe(false);
  });

  it("stores the content fingerprint in metadata and ignores extraction time in it", () => {
    const a = makeSnapshot({ packageId: "core", extractedAt: new Date("2026-01-01T00:00:00Z") });
    const b = makeSnapshot({ packageId: "core", extractedAt: new Date("2026-02-01T00:00:00Z"), sourcePath: "/elsewhere" });
    expect(computeSnapshotFingerprint(a)).toBe(computeSnapshotFingerprint(b));

    store.storeSnapshot(a);
    expect(store.getMetadata("core")!.lastContentHash).toBe(computeSnapshotFingerprint(a));
  });

  it("returns true when no signal at all can distinguish the snapshots", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", version: null, gitHash: null }));
    // No version, no hash, no fingerprint offered: nothing was compared, so
    // "unchanged" would be a fabricated verdict.
    expect(store.needsSync("core", null, null)).toBe(true);
  });

  it("returns true when the stored row predates fingerprints (nothing to compare against)", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", version: "1.0.0", gitHash: "abc123" }));
    // Simulate a row written before the column existed.
    const raw = new Database(join(tmpDir, "fp.db"));
    raw.prepare("UPDATE framework_metadata SET last_content_hash = NULL WHERE package_id = ?").run("core");
    raw.close();
    expect(store.getMetadata("core")!.lastContentHash).toBeNull();
    expect(store.needsSync("core", "1.0.0", "abc123", "anything")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-source keying (plan 2.13 / U2+M3 / D51)
// ---------------------------------------------------------------------------

describe("one machine, several sources", () => {
  let tmpDir: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fks-source-"));
    store = new FrameworkKnowledgeStore(join(tmpDir, "test.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not let a git clone answer for the project's installed package", () => {
    const installed = makeSnapshot({
      packageId: "core", sourcePath: "/projects/game/Packages/Strada.Core",
      sourceOrigin: "local", version: "1.0.0", fileCount: 42,
      extractedAt: new Date("2026-01-15T10:00:00Z"),
    });
    store.storeSnapshot(installed);
    // The git fallback clones the SAME package elsewhere, later. Keyed by
    // package alone, this clone became the answer for every reader.
    const clone = makeSnapshot({
      packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
      version: "9.9.9", fileCount: 7, extractedAt: new Date("2026-02-01T10:00:00Z"),
    });
    store.storeSnapshot(clone);

    const answered = store.getLatestSnapshot("core");
    expect(answered!.sourcePath).toBe("/projects/game/Packages/Strada.Core");
    expect(answered!.version).toBe("1.0.0");
    // …and the clone is still readable when asked for by name.
    expect(store.getLatestSnapshot("core", "/cache/strada-core")!.version).toBe("9.9.9");
    // "Live" means installed: a clone never claims it.
    expect(store.getLiveSnapshot("core")!.sourcePath).toBe("/projects/game/Packages/Strada.Core");
    expect(store.getLiveSourcePath("core")).toBe("/projects/game/Packages/Strada.Core");
  });

  it("keeps sync bookkeeping per source, so one source's sync does not silence the other", () => {
    const first = makeSnapshot({ packageId: "core", sourcePath: "/a", version: "1.0.0", gitHash: "aaa" });
    store.storeSnapshot(first);
    const firstPrint = computeSnapshotFingerprint(first);
    expect(store.needsSync("core", "1.0.0", "aaa", firstPrint, "/a")).toBe(false);
    // A DIFFERENT source with the same version and hash has never been synced.
    expect(store.needsSync("core", "1.0.0", "aaa", firstPrint, "/b")).toBe(true);

    const second = makeSnapshot({ packageId: "core", sourcePath: "/b", version: "1.0.0", gitHash: "aaa", fileCount: 9 });
    store.storeSnapshot(second);
    expect(store.needsSync("core", "1.0.0", "aaa", computeSnapshotFingerprint(second), "/b")).toBe(false);
    // …and /a is still considered synced, not re-extracted because /b moved.
    expect(store.needsSync("core", "1.0.0", "aaa", firstPrint, "/a")).toBe(false);
  });

  it("compares drift within one source (guard)", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: "/a", version: "1.0.0", extractedAt: new Date("2026-01-01T00:00:00Z") }));
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: "/b", version: "2.0.0", extractedAt: new Date("2026-01-02T00:00:00Z") }));
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: "/a", version: "1.1.0", extractedAt: new Date("2026-01-03T00:00:00Z") }));
    expect(store.getLatestSnapshot("core", "/a")!.version).toBe("1.1.0");
    // The previous snapshot OF THAT SOURCE, not of whatever synced in between.
    expect(store.getPreviousSnapshot("core", "/a")!.version).toBe("1.0.0");
  });

  it("without a local source, knowledge from a clone is still served, labelled as a clone (guard)", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "mcp", sourcePath: "/cache/mcp", sourceOrigin: "git-clone" }));
    const served = store.getLatestSnapshot("mcp");
    expect(served).not.toBeNull();
    expect(served!.sourceOrigin).toBe("git-clone");
    // But nothing claims it is installed here.
    expect(store.getLiveSnapshot("mcp")).toBeNull();
    expect(store.getLiveSourcePath("mcp")).toBeUndefined();
  });

  it("attributes an older database's bookkeeping to the source its snapshot names", () => {
    const dbPath = join(tmpDir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE framework_snapshots (
        package_id TEXT NOT NULL, package_name TEXT NOT NULL, version TEXT, git_hash TEXT,
        snapshot_json TEXT NOT NULL, extracted_at INTEGER NOT NULL, source_path TEXT NOT NULL,
        source_origin TEXT NOT NULL, source_language TEXT NOT NULL, file_count INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (package_id, extracted_at)
      );
      CREATE TABLE framework_metadata (
        package_id TEXT PRIMARY KEY, last_sync_at INTEGER, last_version TEXT,
        last_git_hash TEXT, last_content_hash TEXT, sync_count INTEGER DEFAULT 0
      );
    `);
    legacy.prepare("INSERT INTO framework_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("core", "Strada.Core", "1.0.0", "aaa", JSON.stringify({ packageName: "Strada.Core", version: "1.0.0", gitHash: "aaa" }), 1_000, "/projects/game/Strada.Core", "local", "csharp", 42, 1);
    legacy.prepare("INSERT INTO framework_metadata VALUES (?, ?, ?, ?, ?, ?)")
      .run("core", 1_000, "1.0.0", "aaa", "print-1", 3);
    legacy.close();

    const upgraded = new FrameworkKnowledgeStore(dbPath);
    upgraded.initialize();
    try {
      expect(upgraded.getSourceMetadata("core", "/projects/game/Strada.Core")).toMatchObject({
        lastVersion: "1.0.0", lastGitHash: "aaa", lastContentHash: "print-1", syncCount: 3,
      });
      // The local source it named is the live one.
      expect(upgraded.getLiveSourcePath("core")).toBe("/projects/game/Strada.Core");
      // …so nothing is re-extracted just because the schema grew.
      expect(upgraded.needsSync("core", "1.0.0", "aaa", "print-1", "/projects/game/Strada.Core")).toBe(false);
    } finally {
      upgraded.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Origin is project-relative (adversarial review round 10, finding 11)
// ---------------------------------------------------------------------------

describe("per-project source bindings (r10 finding 11)", () => {
  let tmpDir: string;
  let store: FrameworkKnowledgeStore;
  const projectA = "/projects/a";
  const projectB = "/projects/b";
  const shared = "/shared/framework-cache/core";

  function bindingFor(projectId: string, sourcePath: string | null) {
    return { projectId, resolve: () => sourcePath };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fks-project-"));
    store = new FrameworkKnowledgeStore(join(tmpDir, "test.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not hand a project that never synced the other project's installation (round 11 #13)", () => {
    // A installs the shared directory. B resolves the same path but has no
    // binding row — it has not synced yet, or its root was renamed. It used to
    // read A's "local" and believe the framework was installed for it.
    store.storeSnapshot(
      makeSnapshot({ packageId: "core", sourcePath: shared, sourceOrigin: "local", version: "1.0.0" }),
      projectA,
    );
    const readByB = store.getProjectSnapshot("core", bindingFor(projectB, shared));
    expect(readByB).not.toBeNull();
    expect(readByB!.sourceOrigin).toBe("unattributed");
    expect(readByB!.version).toBe("1.0.0");
    expect(store.getProjectLiveSourcePath(projectB, "core")).toBeUndefined();
    // A still reads its own installation (guard)…
    expect(store.getProjectSnapshot("core", bindingFor(projectA, shared))!.sourceOrigin).toBe("local");
    // …and once B syncs, it speaks for itself.
    store.reconcileSourceOrigin(projectB, "core", shared, "cached");
    expect(store.getProjectSnapshot("core", bindingFor(projectB, shared))!.sourceOrigin).toBe("cached");
  });

  it("labels one shared directory by the reading project, not by whoever stored it", () => {
    // A installs the shared cache directory; B only falls back to it. Same
    // bytes, same snapshot — opposite installation status.
    store.storeSnapshot(
      makeSnapshot({ packageId: "core", sourcePath: shared, sourceOrigin: "local", version: "1.0.0" }),
      projectA,
    );
    store.reconcileSourceOrigin(projectB, "core", shared, "cached");

    expect(store.getProjectSnapshot("core", bindingFor(projectA, shared))!.sourceOrigin).toBe("local");
    expect(store.getProjectSnapshot("core", bindingFor(projectB, shared))!.sourceOrigin).toBe("cached");
    // …and the content really is shared.
    expect(store.getProjectSnapshot("core", bindingFor(projectB, shared))!.version).toBe("1.0.0");
    expect(store.getProjectLiveSourcePath(projectA, "core")).toBe(shared);
    expect(store.getProjectLiveSourcePath(projectB, "core")).toBeUndefined();
  });

  it("a project whose tree moves keeps exactly one binding for the package", () => {
    store.reconcileSourceOrigin(projectA, "core", "/projects/a/Packages/Strada.Core", "local");
    store.reconcileSourceOrigin(projectA, "core", "/projects/a/Submodules/Strada.Core", "local");

    expect(store.getProjectLiveSourcePath(projectA, "core")).toBe("/projects/a/Submodules/Strada.Core");
    expect(store.getProjectSourceOrigin(projectA, "core", "/projects/a/Packages/Strada.Core")).toBeUndefined();
  });

  it("a first recording is not a correction; a changed claim is", () => {
    expect(store.reconcileSourceOrigin(projectA, "core", shared, "cached")).toBe(false);
    expect(store.reconcileSourceOrigin(projectA, "core", shared, "cached")).toBe(false);
    expect(store.reconcileSourceOrigin(projectA, "core", shared, "local")).toBe(true);
  });

  it("one project's reconcile does not release another project's installation pointer", () => {
    store.storeSnapshot(
      makeSnapshot({ packageId: "core", sourcePath: shared, sourceOrigin: "local", version: "1.0.0" }),
      projectA,
    );
    expect(store.getLiveSourcePath("core")).toBe(shared);

    store.reconcileSourceOrigin(projectB, "core", shared, "cached");

    // A really does install this directory: the package-wide pointer is not
    // B's to clear.
    expect(store.getLiveSourcePath("core")).toBe(shared);
    expect(store.getProjectLiveSourcePath(projectA, "core")).toBe(shared);
  });

  it("attributes a pre-upgrade database's origins to no project, and the first sync claims them", () => {
    const dbPath = join(tmpDir, "pre-r10.db");
    // A database written by the per-source (pre-per-project) code: origin lives
    // on framework_source_metadata and one package-wide live pointer.
    const legacy = new FrameworkKnowledgeStore(dbPath);
    legacy.initialize();
    legacy.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: shared, sourceOrigin: "local", version: "1.0.0",
    }));
    legacy.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE framework_project_source");
    raw.close();

    const upgraded = new FrameworkKnowledgeStore(dbPath);
    upgraded.initialize();
    try {
      // Nothing is re-extracted and nobody has to re-sync: a bound reader with
      // no recorded binding inherits the unattributed label…
      expect(upgraded.getProjectSourceOrigin(UNATTRIBUTED_PROJECT_ID, "core", shared)).toBe("local");
      expect(upgraded.getProjectSnapshot("core", bindingFor(projectA, shared))!.sourceOrigin).toBe("local");
      expect(upgraded.getProjectLiveSourcePath(projectA, "core")).toBe(shared);

      // …and the first project that actually syncs that source claims it, so
      // the inherited label can never outlive a real observation.
      upgraded.reconcileSourceOrigin(projectB, "core", shared, "cached");
      expect(upgraded.getProjectSourceOrigin(UNATTRIBUTED_PROJECT_ID, "core", shared)).toBeUndefined();
      expect(upgraded.getProjectSnapshot("core", bindingFor(projectB, shared))!.sourceOrigin).toBe("cached");
      // A, which never synced, no longer inherits anything — and round 11 #13:
      // it does not borrow the origin B stamped on the shared row either. An
      // unverified installation says so.
      expect(upgraded.getProjectSnapshot("core", bindingFor(projectA, shared))!.sourceOrigin).toBe("unattributed");
    } finally {
      upgraded.close();
    }
  });

  it("guard: a writer with no project identity records no project's installation", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: shared, sourceOrigin: "local" }));
    expect(store.getProjectSourceOrigin(projectA, "core", shared)).toBeUndefined();
    // The package-wide view still answers, as it did before.
    expect(store.getLiveSourcePath("core")).toBe(shared);
  });

  it("guard: a project with no source for the package is served a clone, never another project's install", () => {
    store.storeSnapshot(
      makeSnapshot({ packageId: "core", sourcePath: "/projects/a/Strada.Core", sourceOrigin: "local" }),
      projectA,
    );
    store.storeSnapshot(
      makeSnapshot({ packageId: "mcp", sourcePath: "/cache/mcp", sourceOrigin: "git-clone" }),
      projectA,
    );

    expect(store.getProjectSnapshot("core", bindingFor(projectB, null))).toBeNull();
    expect(store.getProjectSnapshot("mcp", bindingFor(projectB, null))!.sourceOrigin).toBe("git-clone");
  });

  it("guard: dropping the directory drops every project's binding to it", () => {
    store.storeSnapshot(
      makeSnapshot({ packageId: "core", sourcePath: shared, sourceOrigin: "local" }),
      projectA,
    );
    store.reconcileSourceOrigin(projectB, "core", shared, "cached");

    store.deleteSource("core", shared);

    expect(store.getProjectSourceOrigin(projectA, "core", shared)).toBeUndefined();
    expect(store.getProjectSourceOrigin(projectB, "core", shared)).toBeUndefined();
    expect(store.getProjectLiveSourcePath(projectA, "core")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Snapshot identity, retention and removal are per SOURCE
// (adversarial review round 9, findings 26-28)
// ---------------------------------------------------------------------------

describe("per-source snapshot identity (r9 26-28)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fks-identity-"));
    dbPath = join(tmpDir, "test.db");
    store = new FrameworkKnowledgeStore(dbPath);
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function countSnapshots(sourcePath?: string): number {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = sourcePath === undefined
        ? raw.prepare("SELECT COUNT(*) AS n FROM framework_snapshots").get() as { n: number }
        : raw.prepare("SELECT COUNT(*) AS n FROM framework_snapshots WHERE source_path = ?").get(sourcePath) as { n: number };
      return row.n;
    } finally {
      raw.close();
    }
  }

  // ── 26: identity must include the source path ────────────────────────────

  it("keeps both sources' snapshots when they share an extraction millisecond", () => {
    const sameMoment = new Date("2026-03-01T12:00:00.000Z");
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/game/Packages/Strada.Core", sourceOrigin: "local",
      version: "1.0.0", fileCount: 42, extractedAt: sameMoment,
    }));
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
      version: "9.9.9", fileCount: 7, extractedAt: sameMoment,
    }));

    // Keyed by (package, extracted_at) the clone REPLACED the installation and
    // the live pointer resolved to nothing.
    expect(countSnapshots()).toBe(2);
    expect(store.getLatestSnapshot("core", "/projects/game/Packages/Strada.Core")!.version).toBe("1.0.0");
    expect(store.getLatestSnapshot("core", "/cache/strada-core")!.version).toBe("9.9.9");
    expect(store.getLiveSnapshot("core")!.version).toBe("1.0.0");
  });

  it("guard: re-storing the SAME source at the same millisecond replaces, not duplicates", () => {
    const sameMoment = new Date("2026-03-01T12:00:00.000Z");
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: "/a", version: "1.0.0", extractedAt: sameMoment }));
    store.storeSnapshot(makeSnapshot({ packageId: "core", sourcePath: "/a", version: "1.0.1", extractedAt: sameMoment }));
    expect(countSnapshots("/a")).toBe(1);
    expect(store.getLatestSnapshot("core", "/a")!.version).toBe("1.0.1");
  });

  it("migrates a database whose snapshots are keyed by (package, extracted_at)", () => {
    const legacyPath = join(tmpDir, "legacy-pk.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE framework_snapshots (
        package_id TEXT NOT NULL, package_name TEXT NOT NULL, version TEXT, git_hash TEXT,
        snapshot_json TEXT NOT NULL, extracted_at INTEGER NOT NULL, source_path TEXT NOT NULL,
        source_origin TEXT NOT NULL, source_language TEXT NOT NULL, file_count INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (package_id, extracted_at)
      );
      CREATE TABLE framework_metadata (
        package_id TEXT PRIMARY KEY, last_sync_at INTEGER, last_version TEXT,
        last_git_hash TEXT, last_content_hash TEXT, sync_count INTEGER DEFAULT 0
      );
    `);
    legacy.prepare("INSERT INTO framework_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("core", "Strada.Core", "1.0.0", "aaa", JSON.stringify({ packageName: "Strada.Core", version: "1.0.0" }),
        2_000, "/projects/game/Strada.Core", "local", "csharp", 42, 1);
    legacy.close();

    const upgraded = new FrameworkKnowledgeStore(legacyPath);
    upgraded.initialize();
    try {
      // The pre-existing row survives the migration…
      expect(upgraded.getLatestSnapshot("core", "/projects/game/Strada.Core")!.version).toBe("1.0.0");
      // …and a second source may now share its extraction millisecond.
      upgraded.storeSnapshot(makeSnapshot({
        packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
        version: "9.9.9", extractedAt: new Date(2_000),
      }));
      expect(upgraded.getLatestSnapshot("core", "/projects/game/Strada.Core")!.version).toBe("1.0.0");
      expect(upgraded.getLatestSnapshot("core", "/cache/strada-core")!.version).toBe("9.9.9");
    } finally {
      upgraded.close();
    }
  });

  // ── 27: retention is per source ──────────────────────────────────────────

  it("pruneHistory retains each source's history, so clone churn cannot evict the installation", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/game/Strada.Core", sourceOrigin: "local",
      version: "1.0.0", extractedAt: new Date(Date.UTC(2026, 0, 1)),
    }));
    for (let i = 0; i < 6; i++) {
      store.storeSnapshot(makeSnapshot({
        packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
        version: `9.0.${i}`, extractedAt: new Date(Date.UTC(2026, 1, i + 1)),
      }));
    }

    store.pruneHistory(5);

    expect(store.getLatestSnapshot("core", "/projects/game/Strada.Core")!.version).toBe("1.0.0");
    expect(store.getLiveSnapshot("core")!.version).toBe("1.0.0");
    expect(store.getLatestSnapshot("core")!.version).toBe("1.0.0");
  });

  it("guard: pruneHistory still trims one source's own history to N", () => {
    for (let i = 0; i < 8; i++) {
      store.storeSnapshot(makeSnapshot({
        packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
        version: `9.0.${i}`, extractedAt: new Date(Date.UTC(2026, 1, i + 1)),
      }));
    }
    store.pruneHistory(3);
    expect(countSnapshots("/cache/strada-core")).toBe(3);
    expect(store.getLatestSnapshot("core", "/cache/strada-core")!.version).toBe("9.0.7");
  });

  // ── 28: removal is per source, and takes its bookkeeping with it ─────────

  it("deleteSource removes one source and leaves the other readable with no stale live pointer", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/game/Strada.Core", sourceOrigin: "local",
      version: "1.0.0", extractedAt: new Date(Date.UTC(2026, 0, 1)),
    }));
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
      version: "9.9.9", extractedAt: new Date(Date.UTC(2026, 0, 2)),
    }));

    const removed = store.deleteSource("core", "/projects/game/Strada.Core");

    expect(removed).toBe(1);
    // B survives…
    expect(store.getLatestSnapshot("core", "/cache/strada-core")!.version).toBe("9.9.9");
    // …the removed source's bookkeeping is gone…
    expect(store.getSourceMetadata("core", "/projects/game/Strada.Core")).toBeNull();
    // …and no reader follows a live pointer to a source that no longer exists.
    expect(store.getLiveSourcePath("core")).toBeUndefined();
    expect(store.getLiveSnapshot("core")).toBeNull();
    expect(store.getLatestSnapshot("core")!.version).toBe("9.9.9");
  });

  it("deleteSource reassigns the live pointer to a remaining installed source", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/a/Strada.Core", sourceOrigin: "local",
      version: "1.0.0", extractedAt: new Date(Date.UTC(2026, 0, 1)),
    }));
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/b/Strada.Core", sourceOrigin: "local",
      version: "2.0.0", extractedAt: new Date(Date.UTC(2026, 0, 2)),
    }));
    expect(store.getLiveSourcePath("core")).toBe("/projects/b/Strada.Core");

    store.deleteSource("core", "/projects/b/Strada.Core");

    expect(store.getLiveSourcePath("core")).toBe("/projects/a/Strada.Core");
    expect(store.getLiveSnapshot("core")!.version).toBe("1.0.0");
  });

  it("dropping a package clears its live pointer, so a fallback stored afterwards is served", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/projects/game/Strada.Core", sourceOrigin: "local",
      version: "1.0.0", extractedAt: new Date(Date.UTC(2026, 0, 1)),
    }));
    expect(store.deletePackage("core")).toBe(1);
    expect(store.getLiveSourcePath("core")).toBeUndefined();
    expect(store.getSourceMetadata("core", "/projects/game/Strada.Core")).toBeNull();

    // The package comes back from a clone: default reads must find it instead
    // of following the old live path and returning null.
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/cache/strada-core", sourceOrigin: "git-clone",
      version: "9.9.9", extractedAt: new Date(Date.UTC(2026, 0, 3)),
    }));
    expect(store.getLatestSnapshot("core")!.version).toBe("9.9.9");
  });

  it("deleteSource leaves the package's bookkeeping when another source remains", () => {
    store.storeSnapshot(makeSnapshot({
      packageId: "core", sourcePath: "/a", version: "1.0.0", gitHash: "aaa",
      extractedAt: new Date(Date.UTC(2026, 0, 1)),
    }));
    const second = makeSnapshot({
      packageId: "core", sourcePath: "/b", version: "2.0.0", gitHash: "bbb",
      extractedAt: new Date(Date.UTC(2026, 0, 2)),
    });
    store.storeSnapshot(second);

    store.deleteSource("core", "/a");

    // The package-wide row now describes the source that is still there, not
    // the deleted one (a stale fingerprint would skip a needed re-extraction).
    expect(store.getMetadata("core")).toMatchObject({
      lastVersion: "2.0.0", lastGitHash: "bbb", lastContentHash: computeSnapshotFingerprint(second),
    });
    expect(store.getSourceMetadata("core", "/b")).not.toBeNull();
  });
});
