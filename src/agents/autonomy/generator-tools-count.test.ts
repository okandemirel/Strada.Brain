/**
 * Every Strada generator the agent is offered counts as one.
 *
 * Brain registers four built-in generators; Strada.MCP adds
 * strada_create_service, _controller, _model and strada_scaffold_feature, and
 * those reach the agent too. The lists that decide what a generator call means
 * named only the built-in four, so a module made through an MCP generator
 * recorded no module root — the module rules never looked at it — and the stall
 * check read the call as reading. A node offer that named no Strada tool also
 * withheld every generator, leaving the agent to hand-write the module.
 */

import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { StradaConformanceGuard } from "./strada-conformance.js";
import { MUTATION_TOOLS, STRADA_GENERATOR_TOOLS, stallClassOf } from "./constants.js";
import { NODE_CORE_TOOLS, NODE_SCOPE_MARKER, selectNodeTools } from "./node-tool-offer.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const DEPS = {
  coreInstalled: true,
  corePath: "/proj/Packages/Submodules/Strada.Core",
  modulesInstalled: false,
  modulesPath: null,
  mcpInstalled: true,
  mcpPath: "/proj/Packages/Submodules/Strada.MCP",
} as unknown as StradaDepsStatus;

const MCP_GENERATORS = [
  "strada_create_service",
  "strada_create_controller",
  "strada_create_model",
  "strada_scaffold_feature",
] as const;

const BUILT_IN_GENERATORS = [
  "strada_create_module",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_system",
] as const;

const MODULE_DIR = resolve("/proj/Assets/Modules/HarborModule");

describe("a module made through an MCP generator is a module the rules read", () => {
  for (const tool of MCP_GENERATORS) {
    it(`${tool}: the module it wrote into is held to the module rules`, () => {
      const guard = new StradaConformanceGuard(DEPS, {
        projectPath: "/proj",
        listDir: (dir: string) => (dir === MODULE_DIR ? ["HarborService.cs"] : []),
      });

      guard.trackToolCall(
        tool,
        { name: "Harbor", namespace: "Game.Modules.Harbor", path: "Assets/Modules/HarborModule/Scripts/Services" },
        false,
        "Created Harbor at Assets/Modules/HarborModule/Scripts/Services/HarborService.cs",
      );

      const prompt = guard.getPrompt() ?? "";
      expect(prompt).toContain("STRADA MODULE INCOMPLETE");
      expect(prompt).toContain("Assets/Modules/HarborModule");
      // And it is the generator path, not a hand-written framework edit.
      expect(guard.needsConformanceReview()).toBe(false);
    });
  }
});

describe("one list of generators, shared", () => {
  it("names the built-in and the MCP generators", () => {
    for (const tool of [...BUILT_IN_GENERATORS, ...MCP_GENERATORS]) {
      expect(STRADA_GENERATOR_TOOLS.has(tool), tool).toBe(true);
    }
  });

  it("every generator is a mutation, and progress for the stall check", () => {
    for (const tool of [...BUILT_IN_GENERATORS, ...MCP_GENERATORS]) {
      expect(MUTATION_TOOLS.has(tool), tool).toBe(true);
      expect(stallClassOf(tool, { readOnly: false }), tool).toBe("progress");
    }
  });
});

describe("a plan node is always offered the Strada create tools", () => {
  const registry = [
    "file_read", "file_write", "unity_verify_change", "unity_generate_sprite", "unity_generate_mesh",
    ...BUILT_IN_GENERATORS, "strada_create_service", "strada_create_controller", "strada_create_model",
    "strada_scaffold_feature", "strada_analyze_project",
  ].map((name) => ({ name }));

  it("a node that names only other tools still gets every strada_create_*", () => {
    const offer = selectNodeTools(
      "Add the harbor's dock queue as a service; run unity_verify_change when done.\n\n" + NODE_SCOPE_MARKER,
      registry,
    );
    expect(offer.narrowed).toBe(true);
    const names = offer.offered.map((t) => t.name);
    for (const tool of registry.map((t) => t.name).filter((n) => n.startsWith("strada_create_"))) {
      expect(names, tool).toContain(tool);
      expect(NODE_CORE_TOOLS.has(tool), tool).toBe(true);
    }
    // The core set is the create tools, not the whole Strada family.
    expect(names).not.toContain("strada_analyze_project");
    expect(names).not.toContain("unity_generate_mesh");
  });
});
