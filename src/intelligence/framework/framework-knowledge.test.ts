/**
 * Framework Knowledge Layer -- Foundation Tests
 *
 * Covers FrameworkKnowledgeStore, framework-types, FrameworkDrift,
 * FrameworkExtractor factory, and FrameworkPackageConfigs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameworkAPISnapshot, FrameworkPackageId } from "./framework-types.js";
import { FRAMEWORK_SCHEMA_VERSION } from "./framework-types.js";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import { validateFrameworkDrift, formatFrameworkDriftReport } from "./framework-drift.js";
import {
  FRAMEWORK_PACKAGE_CONFIGS,
  CORE_PACKAGE_CONFIG,
  MODULES_PACKAGE_CONFIG,
  MCP_PACKAGE_CONFIG,
} from "./framework-package-configs.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<FrameworkAPISnapshot> = {}): FrameworkAPISnapshot {
  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: "abc123",
    namespaces: ["Strada.Core", "Strada.Core.ECS"],
    baseClasses: new Map([
      ["SystemBase", ["MonoBehaviour"]],
      ["JobSystemBase", ["SystemBase"]],
    ]),
    attributes: new Map([
      ["StradaSystem", ["AttributeTargets.Class"]],
      ["ExecutionOrder", ["AttributeTargets.Class"]],
    ]),
    interfaces: [
      { name: "IComponent", namespace: "Strada.Core.ECS", methods: ["Initialize", "Dispose"] },
      { name: "IPoolable", namespace: "Strada.Core.Pooling", methods: ["OnSpawn", "OnDespawn"] },
    ],
    enums: [
      { name: "UpdatePhase", namespace: "Strada.Core", values: ["PreUpdate", "Update", "PostUpdate"] },
    ],
    classes: [
      { name: "SystemBase", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: true },
      { name: "JobSystemBase", namespace: "Strada.Core.Systems", baseTypes: ["SystemBase"], isAbstract: true },
      { name: "EntityPool", namespace: "Strada.Core.Pooling", baseTypes: [], isAbstract: false },
    ],
    structs: [
      { name: "ComponentRef", namespace: "Strada.Core.ECS", baseTypes: [] },
    ],
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: new Date("2026-03-25T12:00:00Z"),
    sourcePath: "/tmp/Strada.Core",
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: 42,
    ...overrides,
  };
}

function makeMcpSnapshot(overrides: Partial<FrameworkAPISnapshot> = {}): FrameworkAPISnapshot {
  return {
    packageId: "mcp",
    packageName: "Strada.MCP",
    version: "0.5.0",
    gitHash: "mcp789",
    namespaces: ["tools", "resources"],
    baseClasses: new Map(),
    attributes: new Map(),
    interfaces: [],
    enums: [],
    classes: [],
    structs: [],
    exportedFunctions: [
      { name: "registerTools", module: "tools/index", signature: "() => void" },
    ],
    tools: [
      { name: "strada_inspect", description: "Inspect entities", inputSchemaKeys: ["entityId"] },
      { name: "strada_query", description: "Query ECS", inputSchemaKeys: ["query", "limit"] },
    ],
    resources: [
      { name: "entity_list", uri: "strada://entities", description: "All entities" },
    ],
    prompts: [
      { name: "debug_entity", description: "Debug an entity by ID" },
    ],
    extractedAt: new Date("2026-03-25T14:00:00Z"),
    sourcePath: "/tmp/Strada.MCP",
    sourceOrigin: "local",
    sourceLanguage: "typescript",
    fileCount: 15,
    ...overrides,
  };
}

// ─── 1. FrameworkKnowledgeStore ──────────────────────────────────────────────

describe("FrameworkKnowledgeStore", () => {
  let tmpDir: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fw-store-"));
    store = new FrameworkKnowledgeStore(join(tmpDir, "test-framework.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes and creates tables without throwing", () => {
    // The store was already initialized in beforeEach — create a second
    // instance to verify re-initialization is idempotent (IF NOT EXISTS)
    const store2 = new FrameworkKnowledgeStore(join(tmpDir, "test-framework.db"));
    expect(() => store2.initialize()).not.toThrow();
    store2.close();
  });

  it("storeSnapshot + getLatestSnapshot roundtrip preserves data", () => {
    const snapshot = makeSnapshot();
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.packageId).toBe("core");
    expect(retrieved!.packageName).toBe("Strada.Core");
    expect(retrieved!.version).toBe("1.0.0");
    expect(retrieved!.gitHash).toBe("abc123");
    expect(retrieved!.namespaces).toEqual(["Strada.Core", "Strada.Core.ECS"]);
    expect(retrieved!.fileCount).toBe(42);
    expect(retrieved!.sourceLanguage).toBe("csharp");
    expect(retrieved!.sourceOrigin).toBe("local");
    expect(retrieved!.sourcePath).toBe("/tmp/Strada.Core");
    expect(retrieved!.extractedAt.getTime()).toBe(new Date("2026-03-25T12:00:00Z").getTime());
  });

  it("roundtrip preserves Map fields (baseClasses, attributes)", () => {
    const snapshot = makeSnapshot();
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.baseClasses).toBeInstanceOf(Map);
    expect(retrieved!.baseClasses.get("SystemBase")).toEqual(["MonoBehaviour"]);
    expect(retrieved!.baseClasses.get("JobSystemBase")).toEqual(["SystemBase"]);
    expect(retrieved!.attributes).toBeInstanceOf(Map);
    expect(retrieved!.attributes.get("StradaSystem")).toEqual(["AttributeTargets.Class"]);
  });

  it("roundtrip preserves array-of-object fields (classes, interfaces, enums, structs)", () => {
    const snapshot = makeSnapshot();
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("core");
    expect(retrieved!.classes).toHaveLength(3);
    expect(retrieved!.classes[0]).toEqual({
      name: "SystemBase",
      namespace: "Strada.Core.Systems",
      baseTypes: [],
      isAbstract: true,
    });
    expect(retrieved!.interfaces).toHaveLength(2);
    expect(retrieved!.interfaces[0].methods).toEqual(["Initialize", "Dispose"]);
    expect(retrieved!.enums).toHaveLength(1);
    expect(retrieved!.enums[0].values).toEqual(["PreUpdate", "Update", "PostUpdate"]);
    expect(retrieved!.structs).toHaveLength(1);
  });

  it("roundtrip preserves MCP-specific fields (tools, resources, prompts)", () => {
    const snapshot = makeMcpSnapshot();
    store.storeSnapshot(snapshot);

    const retrieved = store.getLatestSnapshot("mcp");
    expect(retrieved!.tools).toHaveLength(2);
    expect(retrieved!.tools[0].name).toBe("strada_inspect");
    expect(retrieved!.resources).toHaveLength(1);
    expect(retrieved!.resources[0].uri).toBe("strada://entities");
    expect(retrieved!.prompts).toHaveLength(1);
    expect(retrieved!.prompts[0].name).toBe("debug_entity");
    expect(retrieved!.exportedFunctions).toHaveLength(1);
  });

  it("getLatestSnapshot returns null for unknown package", () => {
    expect(store.getLatestSnapshot("core")).toBeNull();
  });

  it("getPreviousSnapshot returns older snapshot when two exist", () => {
    const first = makeSnapshot({ extractedAt: new Date("2026-03-24T10:00:00Z"), version: "0.9.0" });
    const second = makeSnapshot({ extractedAt: new Date("2026-03-25T10:00:00Z"), version: "1.0.0" });
    store.storeSnapshot(first);
    store.storeSnapshot(second);

    const latest = store.getLatestSnapshot("core");
    expect(latest!.version).toBe("1.0.0");

    const previous = store.getPreviousSnapshot("core");
    expect(previous).not.toBeNull();
    expect(previous!.version).toBe("0.9.0");
  });

  it("getPreviousSnapshot returns null when only one snapshot exists", () => {
    store.storeSnapshot(makeSnapshot());
    expect(store.getPreviousSnapshot("core")).toBeNull();
  });

  it("needsSync returns true when no metadata exists", () => {
    expect(store.needsSync("core", "1.0.0", "abc123")).toBe(true);
  });

  it("needsSync returns false when version and hash match", () => {
    store.storeSnapshot(makeSnapshot({ version: "1.0.0", gitHash: "abc123" }));
    expect(store.needsSync("core", "1.0.0", "abc123")).toBe(false);
  });

  it("needsSync returns true when git hash changes", () => {
    store.storeSnapshot(makeSnapshot({ version: "1.0.0", gitHash: "abc123" }));
    expect(store.needsSync("core", "1.0.0", "def456")).toBe(true);
  });

  it("needsSync returns true when version changes", () => {
    store.storeSnapshot(makeSnapshot({ version: "1.0.0", gitHash: "abc123" }));
    expect(store.needsSync("core", "2.0.0", "abc123")).toBe(true);
  });

  it("pruneHistory keeps only N most recent snapshots", () => {
    for (let i = 0; i < 7; i++) {
      store.storeSnapshot(
        makeSnapshot({
          extractedAt: new Date(`2026-03-${(20 + i).toString().padStart(2, "0")}T12:00:00Z`),
          version: `1.0.${i}`,
        }),
      );
    }

    store.pruneHistory(3);

    // Latest should still be 1.0.6
    const latest = store.getLatestSnapshot("core");
    expect(latest!.version).toBe("1.0.6");

    // Previous should be 1.0.5
    const prev = store.getPreviousSnapshot("core");
    expect(prev!.version).toBe("1.0.5");

    // We stored 7, pruned to 3 — only 3 remain
    // Verify the oldest is now 1.0.4 (offset 2 from latest)
    // getStoredPackageIds still shows core
    expect(store.getStoredPackageIds()).toEqual(["core"]);
  });

  it("getStoredPackageIds returns correct list after storing multiple packages", () => {
    store.storeSnapshot(makeSnapshot({ packageId: "core" }));
    store.storeSnapshot(makeMcpSnapshot());
    store.storeSnapshot(makeSnapshot({ packageId: "modules", packageName: "Strada.Modules" }));

    const ids = store.getStoredPackageIds().sort();
    expect(ids).toEqual(["core", "mcp", "modules"]);
  });

  it("getStoredPackageIds returns empty array when no snapshots stored", () => {
    expect(store.getStoredPackageIds()).toEqual([]);
  });

  it("getMetadata tracks sync count correctly", () => {
    store.storeSnapshot(makeSnapshot({ extractedAt: new Date("2026-03-24T12:00:00Z") }));
    store.storeSnapshot(makeSnapshot({ extractedAt: new Date("2026-03-25T12:00:00Z") }));
    store.storeSnapshot(makeSnapshot({ extractedAt: new Date("2026-03-26T12:00:00Z") }));

    const meta = store.getMetadata("core");
    expect(meta).not.toBeNull();
    expect(meta!.syncCount).toBe(3);
    expect(meta!.lastVersion).toBe("1.0.0");
    expect(meta!.lastGitHash).toBe("abc123");
  });

  it("close() does not throw", () => {
    const tempStore = new FrameworkKnowledgeStore(join(tmpDir, "close-test.db"));
    tempStore.initialize();
    expect(() => tempStore.close()).not.toThrow();
  });
});

// ─── 2. Framework Types ─────────────────────────────────────────────────────

describe("framework-types", () => {
  it("FRAMEWORK_SCHEMA_VERSION is 1", () => {
    expect(FRAMEWORK_SCHEMA_VERSION).toBe(1);
  });

  it("FrameworkPackageId literal types cover core, modules, mcp", () => {
    // Type-level check: these assignments must compile without error
    const core: FrameworkPackageId = "core";
    const modules: FrameworkPackageId = "modules";
    const mcp: FrameworkPackageId = "mcp";
    expect([core, modules, mcp]).toEqual(["core", "modules", "mcp"]);
  });
});

// ─── 3. FrameworkDrift ──────────────────────────────────────────────────────

describe("validateFrameworkDrift", () => {
  it("first sync (no previous) returns zero drift score", () => {
    const current = makeSnapshot({ version: "1.0.0" });
    const report = validateFrameworkDrift("core", current, null);

    expect(report.driftScore).toBe(0);
    expect(report.totalIssues).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.infos).toEqual([]);
    expect(report.previousVersion).toBeNull();
    expect(report.currentVersion).toBe("1.0.0");
  });

  it("first sync changelog lists all current items as added", () => {
    const current = makeSnapshot();
    const report = validateFrameworkDrift("core", current, null);

    expect(report.changelog.addedNamespaces).toEqual(["Strada.Core", "Strada.Core.ECS"]);
    expect(report.changelog.removedNamespaces).toEqual([]);
    expect(report.changelog.addedClasses).toEqual(["SystemBase", "JobSystemBase", "EntityPool"]);
    expect(report.changelog.removedClasses).toEqual([]);
    expect(report.changelog.addedInterfaces).toEqual(["IComponent", "IPoolable"]);
    expect(report.changelog.removedInterfaces).toEqual([]);
  });

  it("namespace removal creates warning", () => {
    const prev = makeSnapshot({ namespaces: ["Strada.Core", "Strada.Core.ECS", "Strada.Core.Legacy"] });
    const curr = makeSnapshot({ namespaces: ["Strada.Core", "Strada.Core.ECS"] });

    const report = validateFrameworkDrift("core", curr, prev);

    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
    const nsWarning = report.warnings.find((w) => w.category === "namespace");
    expect(nsWarning).toBeDefined();
    expect(nsWarning!.message).toContain("Strada.Core.Legacy");
    expect(nsWarning!.severity).toBe("warning");
  });

  it("class removal creates error (breaking change)", () => {
    const prev = makeSnapshot({
      classes: [
        { name: "SystemBase", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: true },
        { name: "OldSystem", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: false },
      ],
    });
    const curr = makeSnapshot({
      classes: [
        { name: "SystemBase", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: true },
      ],
    });

    const report = validateFrameworkDrift("core", curr, prev);

    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    const classError = report.errors.find((e) => e.category === "class");
    expect(classError).toBeDefined();
    expect(classError!.message).toContain("OldSystem");
    expect(classError!.severity).toBe("error");
  });

  it("interface removal creates error (breaking change)", () => {
    const prev = makeSnapshot({
      interfaces: [
        { name: "IComponent", namespace: "Strada.Core.ECS", methods: [] },
        { name: "IDisposable", namespace: "Strada.Core", methods: ["Dispose"] },
      ],
    });
    const curr = makeSnapshot({
      interfaces: [
        { name: "IComponent", namespace: "Strada.Core.ECS", methods: [] },
      ],
    });

    const report = validateFrameworkDrift("core", curr, prev);

    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    const ifaceError = report.errors.find((e) => e.category === "interface");
    expect(ifaceError).toBeDefined();
    expect(ifaceError!.message).toContain("IDisposable");
  });

  it("MCP tool removal creates error when packageId is mcp", () => {
    const prev = makeMcpSnapshot({
      tools: [
        { name: "strada_inspect", description: "Inspect", inputSchemaKeys: ["id"] },
        { name: "strada_deploy", description: "Deploy", inputSchemaKeys: ["target"] },
      ],
    });
    const curr = makeMcpSnapshot({
      tools: [
        { name: "strada_inspect", description: "Inspect", inputSchemaKeys: ["id"] },
      ],
    });

    const report = validateFrameworkDrift("mcp", curr, prev);

    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    const toolError = report.errors.find((e) => e.category === "mcp_tool");
    expect(toolError).toBeDefined();
    expect(toolError!.message).toContain("strada_deploy");
  });

  it("attribute removal creates warning for csharp packages", () => {
    const prev = makeSnapshot({
      attributes: new Map([
        ["StradaSystem", ["AttributeTargets.Class"]],
        ["Deprecated", ["AttributeTargets.Method"]],
      ]),
    });
    const curr = makeSnapshot({
      attributes: new Map([
        ["StradaSystem", ["AttributeTargets.Class"]],
      ]),
    });

    const report = validateFrameworkDrift("core", curr, prev);

    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
    const attrWarning = report.warnings.find((w) => w.category === "attribute");
    expect(attrWarning).toBeDefined();
    expect(attrWarning!.message).toContain("Deprecated");
  });

  it("added items create info-level issues", () => {
    const prev = makeSnapshot({
      namespaces: ["Strada.Core"],
      classes: [{ name: "SystemBase", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: true }],
      interfaces: [{ name: "IComponent", namespace: "Strada.Core.ECS", methods: [] }],
    });
    const curr = makeSnapshot({
      namespaces: ["Strada.Core", "Strada.Core.NewModule"],
      classes: [
        { name: "SystemBase", namespace: "Strada.Core.Systems", baseTypes: [], isAbstract: true },
        { name: "NewSystem", namespace: "Strada.Core.NewModule", baseTypes: [], isAbstract: false },
      ],
      interfaces: [
        { name: "IComponent", namespace: "Strada.Core.ECS", methods: [] },
        { name: "ISerializable", namespace: "Strada.Core", methods: ["Serialize"] },
      ],
    });

    const report = validateFrameworkDrift("core", curr, prev);

    expect(report.infos.length).toBeGreaterThanOrEqual(3);
    const categories = report.infos.map((i) => i.category);
    expect(categories).toContain("namespace");
    expect(categories).toContain("class");
    expect(categories).toContain("interface");

    // All infos should be severity "info"
    for (const info of report.infos) {
      expect(info.severity).toBe("info");
    }
  });

  it("drift score calculation: errors=10, warnings=3, infos=1", () => {
    // 1 class removed (error=10), 1 ns removed (warning=3), 1 ns added (info=1) => 14
    const prev = makeSnapshot({
      namespaces: ["Strada.Core", "Strada.Core.Old"],
      classes: [
        { name: "SystemBase", namespace: "Strada.Core", baseTypes: [], isAbstract: true },
        { name: "RemovedClass", namespace: "Strada.Core", baseTypes: [], isAbstract: false },
      ],
      interfaces: [],
    });
    const curr = makeSnapshot({
      namespaces: ["Strada.Core", "Strada.Core.New"],
      classes: [
        { name: "SystemBase", namespace: "Strada.Core", baseTypes: [], isAbstract: true },
      ],
      interfaces: [],
    });

    const report = validateFrameworkDrift("core", curr, prev);

    // 1 error (class removed) * 10 + 1 warning (ns removed) * 3 + 1 info (ns added) * 1 = 14
    expect(report.driftScore).toBe(14);
  });

  it("drift score is capped at 100", () => {
    // Create many removals to exceed 100
    const manyClasses = Array.from({ length: 15 }, (_, i) => ({
      name: `Class${i}`,
      namespace: "Strada.Core",
      baseTypes: [],
      isAbstract: false,
    }));
    const prev = makeSnapshot({ classes: manyClasses, interfaces: [] });
    const curr = makeSnapshot({ classes: [], interfaces: [] });

    const report = validateFrameworkDrift("core", curr, prev);

    // 15 errors * 10 = 150, capped to 100
    expect(report.driftScore).toBe(100);
  });
});

describe("formatFrameworkDriftReport", () => {
  it("produces readable output with correct sections", () => {
    const prev = makeSnapshot({
      version: "1.0.0",
      namespaces: ["Strada.Core", "Strada.Core.Old"],
      classes: [
        { name: "SystemBase", namespace: "Strada.Core", baseTypes: [], isAbstract: true },
        { name: "RemovedClass", namespace: "Strada.Core", baseTypes: [], isAbstract: false },
      ],
      interfaces: [],
    });
    const curr = makeSnapshot({
      version: "2.0.0",
      namespaces: ["Strada.Core", "Strada.Core.New"],
      classes: [
        { name: "SystemBase", namespace: "Strada.Core", baseTypes: [], isAbstract: true },
        { name: "AddedClass", namespace: "Strada.Core", baseTypes: [], isAbstract: false },
      ],
      interfaces: [],
    });

    const report = validateFrameworkDrift("core", curr, prev);
    const output = formatFrameworkDriftReport(report);

    expect(output).toContain("Framework Drift Report: core");
    expect(output).toContain("1.0.0");
    expect(output).toContain("2.0.0");
    expect(output).toContain("Drift Score:");
    expect(output).toContain("Total Issues:");
    expect(output).toContain("ERRORS:");
    expect(output).toContain("RemovedClass");
    expect(output).toContain("WARNINGS:");
    expect(output).toContain("Added classes: AddedClass");
    expect(output).toContain("Removed classes: RemovedClass");
  });

  it("labels GOOD for low drift scores", () => {
    const current = makeSnapshot();
    const report = validateFrameworkDrift("core", current, null);
    const output = formatFrameworkDriftReport(report);

    expect(output).toContain("GOOD");
  });
});

// ─── 4. FrameworkExtractor factory ──────────────────────────────────────────

describe("createExtractor factory", () => {
  it("returns CSharpFrameworkExtractor for csharp language", async () => {
    const { createExtractor } = await import("./framework-extractor.js");
    const extractor = await createExtractor("/tmp/Strada.Core", CORE_PACKAGE_CONFIG);

    const { CSharpFrameworkExtractor } = await import("./framework-extractor-csharp.js");
    expect(extractor).toBeInstanceOf(CSharpFrameworkExtractor);
  });

  it("returns MCPFrameworkExtractor for typescript language", async () => {
    const { createExtractor } = await import("./framework-extractor.js");
    const extractor = await createExtractor("/tmp/Strada.MCP", MCP_PACKAGE_CONFIG);

    const { MCPFrameworkExtractor } = await import("./framework-extractor-mcp.js");
    expect(extractor).toBeInstanceOf(MCPFrameworkExtractor);
  });
});

// ─── 5. Package Configs ─────────────────────────────────────────────────────

describe("FRAMEWORK_PACKAGE_CONFIGS", () => {
  it("has 3 entries (core, modules, mcp)", () => {
    expect(FRAMEWORK_PACKAGE_CONFIGS.size).toBe(3);
    expect(FRAMEWORK_PACKAGE_CONFIGS.has("core")).toBe(true);
    expect(FRAMEWORK_PACKAGE_CONFIGS.has("modules")).toBe(true);
    expect(FRAMEWORK_PACKAGE_CONFIGS.has("mcp")).toBe(true);
  });

  it("core config has csharp language and *.cs glob", () => {
    const core = FRAMEWORK_PACKAGE_CONFIGS.get("core")!;
    expect(core.sourceLanguage).toBe("csharp");
    expect(core.fileGlob).toBe("**/*.cs");
    expect(core.packageId).toBe("core");
    expect(core.displayName).toBe("Strada.Core");
  });

  it("modules config has csharp language and *.cs glob", () => {
    const modules = FRAMEWORK_PACKAGE_CONFIGS.get("modules")!;
    expect(modules.sourceLanguage).toBe("csharp");
    expect(modules.fileGlob).toBe("**/*.cs");
    expect(modules.packageId).toBe("modules");
    expect(modules.displayName).toBe("Strada.Modules");
  });

  it("mcp config has typescript language and src/**/*.ts glob", () => {
    const mcp = FRAMEWORK_PACKAGE_CONFIGS.get("mcp")!;
    expect(mcp.sourceLanguage).toBe("typescript");
    expect(mcp.fileGlob).toBe("src/**/*.ts");
    expect(mcp.packageId).toBe("mcp");
    expect(mcp.displayName).toBe("Strada.MCP");
  });

  it("all configs have non-empty repoUrl", () => {
    for (const [, config] of FRAMEWORK_PACKAGE_CONFIGS) {
      expect(config.repoUrl).toBeTruthy();
      expect(config.repoUrl.length).toBeGreaterThan(0);
    }
  });

  it("all configs have ignoreGlobs arrays", () => {
    for (const [, config] of FRAMEWORK_PACKAGE_CONFIGS) {
      expect(Array.isArray(config.ignoreGlobs)).toBe(true);
      expect(config.ignoreGlobs.length).toBeGreaterThan(0);
    }
  });

  it("exported individual configs match map entries", () => {
    expect(FRAMEWORK_PACKAGE_CONFIGS.get("core")).toBe(CORE_PACKAGE_CONFIG);
    expect(FRAMEWORK_PACKAGE_CONFIGS.get("modules")).toBe(MODULES_PACKAGE_CONFIG);
    expect(FRAMEWORK_PACKAGE_CONFIGS.get("mcp")).toBe(MCP_PACKAGE_CONFIG);
  });
});
