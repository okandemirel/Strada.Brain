import { describe, it, expect } from "vitest";
import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";
import type { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";

function bigSnapshot(): FrameworkAPISnapshot {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: "abc",
    namespaces: many("Strada.Ns", 12),
    baseClasses: new Map(many("Base", 10).map((b) => [b, many(`${b}Derived`, 40)])),
    attributes: new Map(many("Attr", 10).map((a) => [a, many(`${a}Use`, 20)])),
    interfaces: many("IService", 60).map((name) => ({ name, namespace: "Strada.Core", methods: many("Method", 12) })),
    enums: many("Mode", 40).map((name) => ({ name, namespace: "Strada.Core", values: many("V", 16) })),
    classes: many("Service", 80).map((name, i) => ({ name, namespace: `Strada.Ns${i % 40}`, baseTypes: ["MonoBehaviour"], isAbstract: false })),
    structs: many("Data", 40).map((name) => ({ name, namespace: "Strada.Core", baseTypes: [] })),
    exportedFunctions: [],
    tools: [],
  } as unknown as FrameworkAPISnapshot;
}

function store(snapshot: FrameworkAPISnapshot | null): FrameworkKnowledgeStore {
  return { getLatestSnapshot: (id: string) => (id === "core" ? snapshot : null) } as unknown as FrameworkKnowledgeStore;
}

describe("FrameworkPromptGenerator — the catalog fits a char cap (measured 2026-09-09: 21 715 chars on every turn)", () => {
  it("leaves a section that fits untrimmed", () => {
    const gen = new FrameworkPromptGenerator(store(bigSnapshot()), { maxChars: 1_000_000 });
    const section = gen.buildFrameworkKnowledgeSection();
    expect(section).not.toBeNull();
    expect(gen.getLastTrim()).toBeNull();
  });

  it("halves the list lengths until the section fits, keeps every subsection, and reports the trim", () => {
    const full = new FrameworkPromptGenerator(store(bigSnapshot()), { maxChars: 1_000_000 }).buildFrameworkKnowledgeSection()!;
    const cap = Math.floor(full.length / 3);
    const gen = new FrameworkPromptGenerator(store(bigSnapshot()), { maxChars: cap });
    const section = gen.buildFrameworkKnowledgeSection()!;
    expect(section.length).toBeLessThan(full.length);
    const trim = gen.getLastTrim();
    expect(trim).not.toBeNull();
    expect(trim!.density).toBeLessThan(1);
    expect(trim!.untrimmedChars).toBe(full.length);
    expect(trim!.chars).toBe(section.length);
    // Same headings survive the trim — the shape is kept, the lists are shorter.
    const headings = (text: string) => text.split("\n").filter((l) => l.startsWith("#")).join("|");
    expect(headings(section)).toBe(headings(full));
    // The trim is disclosed, never silent: the shortened lists say what they left out.
    expect(section).toMatch(/\.\.\. and \d+ more namespaces/);
    // Cached: a second call is the same trimmed section.
    expect(gen.buildFrameworkKnowledgeSection()).toBe(section);
  });

  it("an empty store yields no section and no trim", () => {
    const gen = new FrameworkPromptGenerator(store(null), { maxChars: 5_000 });
    expect(gen.buildFrameworkKnowledgeSection()).toBeNull();
    expect(gen.getLastTrim()).toBeNull();
  });
});
