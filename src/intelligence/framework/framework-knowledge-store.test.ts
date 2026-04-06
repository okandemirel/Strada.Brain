import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import type { FrameworkAPISnapshot, FrameworkPackageId } from "./framework-types.js";
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
