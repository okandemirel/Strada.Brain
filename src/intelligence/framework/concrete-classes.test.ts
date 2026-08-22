import { describe, expect, it } from "vitest";

import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

/**
 * What the extractor read and the renderer threw away.
 *
 * Measured 2026-08-22 against the live Strada.Core snapshot: 355 classes, 49 of
 * them abstract. The section rendered the 49 and dropped the other 306 —
 * ViewRegistry, ViewSyncRunner and StradaLog among them, which are precisely
 * the names a plan needs in order to put something on screen or to log without
 * reaching for Debug.Log. The knowledge had been read correctly and was being
 * discarded on the way out.
 */

const snapshot = (classes: Array<{ name: string; namespace: string; isAbstract: boolean }>) =>
  ({
    packageId: "core",
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: null,
    namespaces: ["Strada.Core.Sync"],
    baseClasses: new Map(),
    attributes: new Map(),
    interfaces: [],
    enums: [],
    structs: [],
    classes,
    fileCount: 1,
  }) as unknown as FrameworkAPISnapshot;

function sectionFor(classes: Array<{ name: string; namespace: string; isAbstract: boolean }>): string {
  const store = {
    getLatestSnapshot: (id: string) => (id === "core" ? snapshot(classes) : null),
  } as never;
  return new FrameworkPromptGenerator(store).buildFrameworkKnowledgeSection() ?? "";
}

describe("the classes a plan can actually name", () => {
  it("renders concrete classes, not only the abstract ones", () => {
    const section = sectionFor([
      { name: "SystemBase", namespace: "Strada.Core.ECS", isAbstract: true },
      { name: "ViewSyncRunner", namespace: "Strada.Core.Sync", isAbstract: false },
      { name: "StradaLog", namespace: "Strada.Core.Logging", isAbstract: false },
    ]);

    expect(section).toContain("ViewSyncRunner");
    expect(section).toContain("StradaLog");
    // The abstract listing stays: a base class is what a module extends.
    expect(section).toContain("SystemBase");
  });

  it("groups them by namespace so the shape of the framework survives", () => {
    const section = sectionFor([
      { name: "EntityView", namespace: "Strada.Core.Sync", isAbstract: false },
      { name: "ViewPool", namespace: "Strada.Core.Sync", isAbstract: false },
    ]);

    expect(section).toMatch(/`Strada\.Core\.Sync`: .*EntityView.*ViewPool/u);
  });

  it("caps a huge namespace rather than burying the rest", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `Type${i}`,
      namespace: "Strada.Core.Big",
      isAbstract: false,
    }));

    const section = sectionFor(many);

    expect(section).toContain("(+20 more)");
  });

  it("says nothing when a package has no concrete classes", () => {
    const section = sectionFor([
      { name: "SystemBase", namespace: "Strada.Core.ECS", isAbstract: true },
    ]);

    expect(section).not.toContain("### Classes by namespace");
  });
});
