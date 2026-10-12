import { describe, expect, it } from "vitest";
import { STRADA_API } from "../agents/context/strada-api-reference.js";
import { validateDrift } from "./strada-drift-validator.js";
import type { CoreAPISnapshot } from "./strada-core-extractor.js";

describe("validateDrift", () => {
  it("accepts the tracked Strada.Core surfaces without reporting drift", () => {
    const trackedNamespaces = [...new Set(Object.values(STRADA_API.namespaces))];
    const patternClasses = STRADA_API.baseClasses.patterns.map((name) => ({
      name,
      namespace: STRADA_API.namespaces.patterns,
      baseTypes: [],
      isAbstract: false,
    }));
    const attributeClasses = [
      "StradaSystemAttribute",
      "ExecutionOrderAttribute",
      "UpdatePhaseAttribute",
      "RunBeforeAttribute",
      "RunAfterAttribute",
      "RequiresSystemAttribute",
      "SystemCategoryAttribute",
      "SystemDescriptionAttribute",
    ].map((name) => ({
      name,
      namespace: STRADA_API.namespaces.modules,
      baseTypes: [],
      isAbstract: false,
    }));

    const snapshot: CoreAPISnapshot = {
      namespaces: trackedNamespaces,
      baseClasses: new Map(),
      attributes: new Map(
        Object.entries(STRADA_API.systemAttributes).map(([key, val]) => {
          const match = /^\[(\w+)/.exec(val);
          return [key, match ? [match[1]!] : [val]] as [string, string[]];
        }),
      ),
      interfaces: [
        { name: "IComponent", namespace: STRADA_API.namespaces.ecs, methods: [] },
        { name: "IPoolable", namespace: STRADA_API.namespaces.pooling, methods: [] },
        { name: "ITickable", namespace: STRADA_API.namespaces.patternsInterfaces, methods: [] },
        { name: "ILoopRunner", namespace: STRADA_API.namespaces.core, methods: [] },
      ],
      enums: [],
      classes: [
        { name: "SystemBase", namespace: STRADA_API.namespaces.systems, baseTypes: [], isAbstract: true },
        { name: "JobSystemBase", namespace: STRADA_API.namespaces.systems, baseTypes: ["SystemBase"], isAbstract: true },
        ...STRADA_API.baseClasses.burstSystemVariants.map((name) => ({
          name,
          namespace: STRADA_API.namespaces.systems,
          baseTypes: ["JobSystemBase"],
          isAbstract: true,
        })),
        ...patternClasses,
        ...attributeClasses,
      ],
      structs: [],
      extractedAt: new Date("2026-03-14T00:00:00Z"),
      sourcePath: "/tmp/Strada.Core",
      fileCount: 1,
    };

    const report = validateDrift(snapshot);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.infos).toEqual([]);
    expect(report.driftScore).toBe(0);
  });
});

describe("validateDrift scores what Brain names, not all of Core", () => {
  // Shaped as the extractor shapes Core: attributes keyed by the class that
  // carries them, attribute classes among the classes.
  const alignedSnapshot = (): CoreAPISnapshot => ({
    namespaces: [...new Set(Object.values(STRADA_API.namespaces))],
    baseClasses: new Map(),
    attributes: new Map([["MovementSystem", ["StradaSystem", "ExecutionOrder"]]]),
    interfaces: ["IComponent", "IPoolable", "ITickable", "ILoopRunner"].map((name) => ({ name, namespace: "", methods: [] })),
    enums: [],
    classes: [
      ...STRADA_API.baseClasses.systems,
      ...STRADA_API.baseClasses.burstSystemVariants,
      ...STRADA_API.baseClasses.patterns,
      ...Object.values(STRADA_API.systemAttributes).map((attr) => `${/^\[(\w+)/.exec(attr)![1]}Attribute`),
    ].map((name) => ({ name, namespace: "", baseTypes: [], isAbstract: false })),
    structs: [],
    extractedAt: new Date("2026-03-14T00:00:00Z"),
    sourcePath: "/tmp/Strada.Core",
    fileCount: 1,
  });

  it("reports nothing for a Core that has everything Brain names", () => {
    const report = validateDrift(alignedSnapshot());

    expect([...report.errors, ...report.warnings]).toEqual([]);
    expect(report.driftScore).toBe(0);
  });

  it("a type Core has and Brain does not mention is not drift", () => {
    const snapshot = alignedSnapshot();
    snapshot.namespaces.push("Strada.Core.Play");
    snapshot.classes.push({ name: "SessionCatalog", namespace: "Strada.Core.Play", baseTypes: [], isAbstract: false });
    snapshot.interfaces.push({ name: "IActiveSession", namespace: "Strada.Core.Play", methods: [] });

    const report = validateDrift(snapshot);

    expect(report.infos).toEqual([]);
    expect(report.driftScore).toBe(0);
  });

  it("a type Brain names and Core lacks still scores", () => {
    const snapshot = alignedSnapshot();
    snapshot.classes = snapshot.classes.filter((c) => c.name !== "TickableController");

    const report = validateDrift(snapshot);

    expect(report.errors.map((e) => e.brainValue)).toEqual(["TickableController"]);
    expect(report.driftScore).toBe(10);
  });
});
