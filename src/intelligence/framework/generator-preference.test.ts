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
