import { describe, it, expect } from "vitest";
import { validateFrameworkDrift, formatFrameworkDriftReport } from "./framework-drift.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

function makeSnapshot(overrides: Partial<FrameworkAPISnapshot> = {}): FrameworkAPISnapshot {
  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: null,
    namespaces: [],
    baseClasses: new Map(),
    attributes: new Map(),
    interfaces: [],
    enums: [],
    classes: [],
    structs: [],
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: new Date("2026-01-01"),
    sourcePath: "/tmp/core",
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: 0,
    ...overrides,
  };
}

// ─── First Sync (previous = null) ───────────────────────────────────────────

describe("first sync (previous = null)", () => {
  it("returns report with totalIssues=0 and driftScore=0", () => {
    const current = makeSnapshot({
      classes: [{ name: "PlayerController", namespace: "Strada", baseTypes: [], isAbstract: false }],
      namespaces: ["Strada"],
    });
    const report = validateFrameworkDrift("core", current, null);
    expect(report.totalIssues).toBe(0);
    expect(report.driftScore).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.infos).toHaveLength(0);
  });

  it("changelog lists all current classes, namespaces, and interfaces as added", () => {
    const current = makeSnapshot({
      classes: [{ name: "Foo", namespace: "NS", baseTypes: [], isAbstract: false }],
      namespaces: ["NS"],
      interfaces: [{ name: "IFoo", namespace: "NS", methods: [] }],
    });
    const report = validateFrameworkDrift("core", current, null);
    expect(report.changelog.addedClasses).toContain("Foo");
    expect(report.changelog.addedNamespaces).toContain("NS");
    expect(report.changelog.addedInterfaces).toContain("IFoo");
    expect(report.changelog.removedClasses).toHaveLength(0);
    expect(report.changelog.removedNamespaces).toHaveLength(0);
    expect(report.changelog.removedInterfaces).toHaveLength(0);
  });

  it("previousVersion is null; currentVersion matches current.version", () => {
    const current = makeSnapshot({ version: "2.5.0" });
    const report = validateFrameworkDrift("core", current, null);
    expect(report.previousVersion).toBeNull();
    expect(report.currentVersion).toBe("2.5.0");
  });
});

// ─── No Changes ─────────────────────────────────────────────────────────────

describe("no changes", () => {
  it("same snapshot twice produces totalIssues=0 and driftScore=0", () => {
    const snap = makeSnapshot({
      classes: [{ name: "Bar", namespace: "NS", baseTypes: [], isAbstract: false }],
      namespaces: ["NS"],
      interfaces: [{ name: "IBar", namespace: "NS", methods: [] }],
    });
    const report = validateFrameworkDrift("core", snap, snap);
    expect(report.totalIssues).toBe(0);
    expect(report.driftScore).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.infos).toHaveLength(0);
  });
});

// ─── Class Drift ─────────────────────────────────────────────────────────────

describe("class drift", () => {
  it("removed class → one error with category 'class' and driftScore=10", () => {
    const prev = makeSnapshot({
      classes: [{ name: "OldClass", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const curr = makeSnapshot({ classes: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].category).toBe("class");
    expect(report.driftScore).toBe(10);
  });

  it("added class → one info with category 'class'", () => {
    const prev = makeSnapshot({ classes: [] });
    const curr = makeSnapshot({
      classes: [{ name: "NewClass", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("class");
    expect(report.errors).toHaveLength(0);
  });

  it("class removed + added simultaneously → one error and one info", () => {
    const prev = makeSnapshot({
      classes: [{ name: "OldClass", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const curr = makeSnapshot({
      classes: [{ name: "NewClass", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].category).toBe("class");
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("class");
  });
});

// ─── Interface Drift ─────────────────────────────────────────────────────────

describe("interface drift", () => {
  it("removed interface → error with category 'interface'", () => {
    const prev = makeSnapshot({
      interfaces: [{ name: "IService", namespace: "NS", methods: ["DoWork"] }],
    });
    const curr = makeSnapshot({ interfaces: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].category).toBe("interface");
  });

  it("added interface → info with category 'interface'", () => {
    const prev = makeSnapshot({ interfaces: [] });
    const curr = makeSnapshot({
      interfaces: [{ name: "INew", namespace: "NS", methods: [] }],
    });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("interface");
    expect(report.errors).toHaveLength(0);
  });
});

// ─── Namespace Drift ─────────────────────────────────────────────────────────

describe("namespace drift", () => {
  it("removed namespace → warning with category 'namespace'", () => {
    const prev = makeSnapshot({ namespaces: ["Strada.Core"] });
    const curr = makeSnapshot({ namespaces: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].category).toBe("namespace");
    expect(report.errors).toHaveLength(0);
  });

  it("added namespace → info with category 'namespace'", () => {
    const prev = makeSnapshot({ namespaces: [] });
    const curr = makeSnapshot({ namespaces: ["Strada.New"] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("namespace");
  });
});

// ─── Attribute Drift ─────────────────────────────────────────────────────────

describe("attribute drift", () => {
  it("attribute removed with sourceLanguage 'csharp' → warning with category 'attribute'", () => {
    const prev = makeSnapshot({
      attributes: new Map([["Component", ["Strada.Core"]]]),
      sourceLanguage: "csharp",
    });
    const curr = makeSnapshot({
      attributes: new Map(),
      sourceLanguage: "csharp",
    });
    const report = validateFrameworkDrift("core", curr, prev);
    const attrWarnings = report.warnings.filter((w) => w.category === "attribute");
    expect(attrWarnings).toHaveLength(1);
  });

  it("attribute removed with sourceLanguage 'typescript' → NOT reported", () => {
    const prev = makeSnapshot({
      attributes: new Map([["Decorator", ["some.module"]]]),
      sourceLanguage: "typescript",
    });
    const curr = makeSnapshot({
      attributes: new Map(),
      sourceLanguage: "typescript",
    });
    const report = validateFrameworkDrift("core", curr, prev);
    const attrWarnings = report.warnings.filter((w) => w.category === "attribute");
    expect(attrWarnings).toHaveLength(0);
  });
});

// ─── MCP Drift ───────────────────────────────────────────────────────────────

describe("MCP drift", () => {
  it("tool removed from MCP package → error with category 'mcp_tool'", () => {
    const prev = makeSnapshot({
      packageId: "mcp",
      tools: [{ name: "read_file", description: "Reads a file", inputSchemaKeys: ["path"] }],
    });
    const curr = makeSnapshot({ packageId: "mcp", tools: [] });
    const report = validateFrameworkDrift("mcp", curr, prev);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].category).toBe("mcp_tool");
  });

  it("tool added to MCP package → info with category 'mcp_tool'", () => {
    const prev = makeSnapshot({ packageId: "mcp", tools: [] });
    const curr = makeSnapshot({
      packageId: "mcp",
      tools: [{ name: "write_file", description: "Writes a file", inputSchemaKeys: ["path", "content"] }],
    });
    const report = validateFrameworkDrift("mcp", curr, prev);
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("mcp_tool");
  });

  it("tool removed from non-mcp package → NOT reported", () => {
    const prev = makeSnapshot({
      packageId: "core",
      tools: [{ name: "some_tool", description: "A tool", inputSchemaKeys: [] }],
    });
    const curr = makeSnapshot({ packageId: "core", tools: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    const mcpErrors = report.errors.filter((e) => e.category === "mcp_tool");
    expect(mcpErrors).toHaveLength(0);
  });

  it("resource removed from MCP package → warning with category 'mcp_resource'", () => {
    const prev = makeSnapshot({
      packageId: "mcp",
      resources: [{ name: "docs", uri: "file:///docs", description: "Documentation" }],
    });
    const curr = makeSnapshot({ packageId: "mcp", resources: [] });
    const report = validateFrameworkDrift("mcp", curr, prev);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].category).toBe("mcp_resource");
  });
});

// ─── Score Computation ────────────────────────────────────────────────────────

describe("score computation", () => {
  it("3 removed classes → driftScore = 30", () => {
    const prev = makeSnapshot({
      classes: [
        { name: "A", namespace: "NS", baseTypes: [], isAbstract: false },
        { name: "B", namespace: "NS", baseTypes: [], isAbstract: false },
        { name: "C", namespace: "NS", baseTypes: [], isAbstract: false },
      ],
    });
    const curr = makeSnapshot({ classes: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.driftScore).toBe(30);
  });

  it("11 removed classes → driftScore = 100 (capped at 100)", () => {
    const classes = Array.from({ length: 11 }, (_, i) => ({
      name: `Class${i}`,
      namespace: "NS",
      baseTypes: [] as string[],
      isAbstract: false,
    }));
    const prev = makeSnapshot({ classes });
    const curr = makeSnapshot({ classes: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.driftScore).toBe(100);
  });
});

// ─── Changelog Builder ────────────────────────────────────────────────────────

describe("changelog builder", () => {
  it("prev has class A, curr has class B → removedClasses=['A'], addedClasses=['B']", () => {
    const prev = makeSnapshot({
      classes: [{ name: "A", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const curr = makeSnapshot({
      classes: [{ name: "B", namespace: "NS", baseTypes: [], isAbstract: false }],
    });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.changelog.removedClasses).toEqual(["A"]);
    expect(report.changelog.addedClasses).toEqual(["B"]);
  });

  it("prev has interface X, curr drops it → removedInterfaces=['X']", () => {
    const prev = makeSnapshot({
      interfaces: [{ name: "X", namespace: "NS", methods: [] }],
    });
    const curr = makeSnapshot({ interfaces: [] });
    const report = validateFrameworkDrift("core", curr, prev);
    expect(report.changelog.removedInterfaces).toEqual(["X"]);
    expect(report.changelog.addedInterfaces).toHaveLength(0);
  });
});

// ─── formatFrameworkDriftReport ───────────────────────────────────────────────

describe("formatFrameworkDriftReport", () => {
  function makeReport(overrides: Partial<Parameters<typeof formatFrameworkDriftReport>[0]> = {}) {
    return {
      packageId: "core",
      totalIssues: 0,
      errors: [],
      warnings: [],
      infos: [],
      driftScore: 0,
      validatedAt: new Date("2026-01-01"),
      previousVersion: "1.0.0",
      currentVersion: "1.1.0",
      changelog: {
        addedNamespaces: [],
        removedNamespaces: [],
        addedClasses: [],
        removedClasses: [],
        addedInterfaces: [],
        removedInterfaces: [],
      },
      ...overrides,
    };
  }

  it("report with score=0 contains 'GOOD'", () => {
    const output = formatFrameworkDriftReport(makeReport({ driftScore: 0 }));
    expect(output).toContain("GOOD");
  });

  it("report with score=20 contains 'MODERATE'", () => {
    const output = formatFrameworkDriftReport(makeReport({ driftScore: 20 }));
    expect(output).toContain("MODERATE");
  });

  it("report with score=50 contains 'HIGH'", () => {
    const output = formatFrameworkDriftReport(makeReport({ driftScore: 50 }));
    expect(output).toContain("HIGH");
  });

  it("first line contains the packageId", () => {
    const output = formatFrameworkDriftReport(makeReport({ packageId: "my-pkg" }));
    const firstLine = output.split("\n")[0];
    expect(firstLine).toContain("my-pkg");
  });

  it("added classes are listed in output", () => {
    const report = makeReport({
      changelog: {
        addedNamespaces: [],
        removedNamespaces: [],
        addedClasses: ["FancyClass", "AnotherClass"],
        removedClasses: [],
        addedInterfaces: [],
        removedInterfaces: [],
      },
    });
    const output = formatFrameworkDriftReport(report);
    expect(output).toContain("FancyClass");
    expect(output).toContain("AnotherClass");
  });

  it("errors section is rendered when errors are present", () => {
    const report = makeReport({
      totalIssues: 1,
      errors: [
        {
          severity: "error",
          category: "class",
          message: 'Class "Gone" was removed (breaking change)',
          brainValue: "Gone",
        },
      ],
      driftScore: 10,
    });
    const output = formatFrameworkDriftReport(report);
    expect(output).toContain("ERRORS:");
    expect(output).toContain("[class]");
    expect(output).toContain("Gone");
  });
});
