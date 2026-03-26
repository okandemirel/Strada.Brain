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
