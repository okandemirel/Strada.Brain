/**
 * The framework knowledge section states which tools create Strada code.
 *
 * It already listed every MCP tool with its description and parameter names —
 * including `moduleName`, the exact argument an agent got wrong by sending
 * `name`, whose rejection then went unnoticed inside a batch. What it never
 * said is that those generators are the right way to create framework-shaped
 * code at all.
 *
 * Measured: a greenfield task in a project with Strada.Core and Strada.Modules
 * installed produced 19 hand-written files under
 * Assets/Modules/GameModule/Scripts/{Domain,Models,Services} — the framework's
 * folder shape, none of its APIs, and not one generator call.
 */

import { describe, it, expect } from "vitest";
import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import type { FrameworkAPISnapshot } from "./types.js";

function snapshot(tools: Array<{ name: string; description: string }>): FrameworkAPISnapshot {
  return {
    package: "mcp",
    version: "1.0.0",
    fileCount: 10,
    namespaces: [],
    classes: [],
    baseClasses: [],
    interfaces: [],
    methods: [],
    tools: tools.map((t) => ({ ...t, inputSchemaKeys: ["moduleName"] })),
    resources: [],
    prompts: [],
    capturedAt: 0,
    // A local source: the section claims "this project has Strada installed",
    // which only an installed package can support (plan 2.13).
    sourceOrigin: "local",
  } as unknown as FrameworkAPISnapshot;
}

function generatorFor(mcp: FrameworkAPISnapshot | null) {
  const store = {
    getLatestSnapshot: (pkg: string) => (pkg === "mcp" ? mcp : null),
  };
  return new FrameworkPromptGenerator(store as never);
}

const GENERATORS = [
  { name: "strada_create_module", description: "Create a Strada module" },
  { name: "strada_create_component", description: "Create a component" },
  { name: "strada_scaffold_feature", description: "Scaffold a feature" },
];

describe("generator preference", () => {
  it("tells the agent to call the generators instead of writing files by hand", () => {
    const section = generatorFor(snapshot(GENERATORS)).buildFrameworkKnowledgeSection();
    expect(section).toContain("Creating Strada Code");
    expect(section).toMatch(/rather than writing the files by hand/i);
    expect(section).toContain("strada_create_module");
    expect(section).toContain("strada_scaffold_feature");
  });

  it("warns about the argument-name mismatch that a batch hides", () => {
    const section = generatorFor(snapshot(GENERATORS)).buildFrameworkKnowledgeSection();
    expect(section).toMatch(/exact parameter names/i);
  });

  it("advertises only generators present in the live snapshot", () => {
    // It must never name a tool the agent cannot actually call.
    const section = generatorFor(
      snapshot([{ name: "strada_create_module", description: "Create a Strada module" }]),
    ).buildFrameworkKnowledgeSection();
    expect(section).toContain("strada_create_module");
    expect(section).not.toContain("strada_create_component");
  });

  it("says nothing when the snapshot has no generators", () => {
    const section = generatorFor(
      snapshot([{ name: "unity_compile_status", description: "Compile status" }]),
    ).buildFrameworkKnowledgeSection();
    expect(section ?? "").not.toContain("Creating Strada Code");
  });

  it("says nothing when the framework is not installed at all", () => {
    // The whole knowledge section is absent without a snapshot, so the
    // directive cannot appear for a project that has no Strada.
    expect(generatorFor(null).buildFrameworkKnowledgeSection()).toBeNull();
  });
});

describe("the installed claim needs an installation (plan 2.13 / U2+M3 / D51)", () => {
  it("says nothing about generators when the snapshot came from a clone, not this project", () => {
    // The sync falls back to a shallow GitHub clone exactly when the package is
    // NOT installed here; the section used to tell the agent the opposite.
    for (const origin of ["git-clone", "cached"] as const) {
      const fromClone = { ...snapshot([{ name: "strada_create_module", description: "Create a module" }]), sourceOrigin: origin } as FrameworkAPISnapshot;
      const section = generatorFor(fromClone).buildFrameworkKnowledgeSection();
      expect(section).not.toContain("This project has Strada installed");
      expect(section).not.toContain("## Creating Strada Code");
      // …and the header does not call a clone "live".
      expect(section).not.toContain("(live —");
      expect(section).toContain("not installed here");
    }
  })

  it("still tells the agent to use the generators for an installed package (guard)", () => {
    const section = generatorFor(snapshot([{ name: "strada_create_module", description: "Create a module" }])).buildFrameworkKnowledgeSection();
    expect(section).toContain("This project has Strada installed");
    expect(section).toContain("(live —");
  })
})
