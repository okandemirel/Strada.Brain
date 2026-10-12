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
import { SelfVerification } from "./self-verification.js";
import { trackAndRecordToolResults } from "../orchestrator-tool-execution.js";
import { AgentPhase } from "../agent-state.js";
import type { ExecutionJournal } from "./execution-journal.js";
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

describe("a generator exempts what it wrote from the conformance review, not the rest of the run", () => {
  // A successful generator call used to switch the review off for the whole
  // run, so a later hand edit of framework code made without reading the
  // source passed — now also after MCP generators whose output does not
  // compile against Core.
  const SERVICE_DIR = "Assets/Modules/HarborModule/Scripts/Services";
  const SERVICE_FILE = `${SERVICE_DIR}/HarborService.cs`;
  // A file inside the installed Core, spelled the way DEPS names Core.
  const CORE_FILE = `${DEPS.corePath}/Runtime/Patterns/Service.cs`;
  const generate =(guard: StradaConformanceGuard, tool: string) =>
    guard.trackToolCall(
      tool,
      { name: "HarborService", namespace: "Game.Modules.Harbor", path: SERVICE_DIR },
      false,
      `Created service HarborService (Service) at ${SERVICE_FILE}`,
      { filesAffected: [SERVICE_FILE] },
    );

  for (const tool of [...MCP_GENERATORS, "strada_create_module"]) {
    it(`${tool}: a later hand edit of framework code still needs the review`, () => {
      const guard = new StradaConformanceGuard(DEPS, { projectPath: "/proj", listDir: () => [] });
      generate(guard, tool);
      expect(guard.needsConformanceReview()).toBe(false);

      guard.trackToolCall("file_edit", { path: CORE_FILE }, false, "ok");
      expect(guard.needsConformanceReview()).toBe(true);
    });
  }

  it("where all code counts as framework code: editing what the generator wrote is exempt, another file is not", () => {
    const guard = new StradaConformanceGuard(DEPS, { projectPath: "/proj", frameworkPathsOnly: false, listDir: () => [] });
    generate(guard, "strada_create_service");

    guard.trackToolCall("file_edit", { path: SERVICE_FILE }, false, "ok");
    expect(guard.needsConformanceReview()).toBe(false);

    guard.trackToolCall("file_write", { path: `${SERVICE_DIR}/HarborQueue.cs` }, false, "ok");
    expect(guard.needsConformanceReview()).toBe(true);
  });

  it("a hand edit before the generator is not covered by it either", () => {
    const guard = new StradaConformanceGuard(DEPS, { projectPath: "/proj", listDir: () => [] });
    guard.trackToolCall("file_edit", { path: CORE_FILE }, false, "ok");
    generate(guard, "strada_create_controller");
    expect(guard.needsConformanceReview()).toBe(true);
  });

  it("the tool loop hands the guard the result's metadata: a file the module call kept is not its work", () => {
    // strada_create_module's text lists kept files beside created ones; only
    // its metadata tells them apart.
    const kept = `${SERVICE_DIR}/HarborQueue.cs`;
    const guard = new StradaConformanceGuard(DEPS, { projectPath: "/proj", frameworkPathsOnly: false, listDir: () => [] });
    const call = (id: string, name: string, input: Record<string, unknown>, content: string, metadata?: Record<string, unknown>) =>
      trackAndRecordToolResults({
        chatId: "c",
        toolCalls: [{ id, name, input: input as never }],
        toolResults: [{ toolCallId: id, content, isError: false, ...(metadata ? { metadata } : {}) }],
        taskPlanner: { trackToolCall: () => {}, recordError: () => {} } as never,
        selfVerification: { track: () => {}, ingestWorkerResult: () => {} },
        stradaConformance: guard,
        errorRecovery: { analyze: () => null },
        executionJournal: { recordToolBatch: () => {} } as unknown as ExecutionJournal,
        agentPhase: AgentPhase.EXECUTING,
        providerName: "test",
        emitToolResult: () => {},
      });

    call(
      "m",
      "strada_create_module",
      { name: "Harbor" },
      `Module 'Harbor' completed\n\nCreated files:\n  ${SERVICE_FILE}\n\nKept (already existed, left unchanged):\n  ${kept}`,
      { createdFiles: [SERVICE_FILE], keptFiles: [kept] },
    );
    call("e", "file_edit", { path: kept }, "ok");
    expect(guard.needsConformanceReview()).toBe(true);
  });

  it("a generator that failed still asks for the review until one succeeds", () => {
    const guard = new StradaConformanceGuard(DEPS, { projectPath: "/proj", listDir: () => [] });
    guard.trackToolCall("strada_create_system", { name: "Tide" }, true, "Error: query_components is required");
    expect(guard.needsConformanceReview()).toBe(true);
    guard.trackToolCall(
      "strada_create_system",
      { name: "Tide", path: "Assets/Modules/TideModule/Scripts/Systems/TideSystem.cs" },
      false,
      "System 'TideSystem' created at: Assets/Modules/TideModule/Scripts/Systems/TideSystem.cs",
    );
    expect(guard.needsConformanceReview()).toBe(false);
  });
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

describe("what a generator wrote arms the compile gate", () => {
  // strada_create_module takes a module folder and MCP's generators an output
  // folder as `path`, so the input names no file. Read from the input, the
  // compile gate saw nothing after them — and MCP's controller and scaffold
  // output is exactly what does not compile against Core.
  const SERVICE_FILE = "Assets/Modules/HarborModule/Scripts/Services/HarborService.cs";
  const ok = (content: string, metadata?: Record<string, unknown>) => ({
    toolCallId: "tc",
    content,
    isError: false,
    ...(metadata ? { metadata } : {}),
  });

  it("an MCP generator: the files its result names", () => {
    for (const tool of MCP_GENERATORS) {
      const verifier = new SelfVerification();
      verifier.track(
        tool,
        { name: "HarborService", namespace: "Game.Modules.Harbor", path: "Assets/Modules/HarborModule/Scripts/Services" },
        ok(`Created ${tool} output at ${SERVICE_FILE}`, { filesAffected: [SERVICE_FILE] }),
      );
      expect(verifier.needsVerification(), tool).toBe(true);
      expect(verifier.getState().pendingFiles.has(SERVICE_FILE), tool).toBe(true);
    }
  });

  it("strada_create_module: the files it created, not the ones it kept", () => {
    const made = new SelfVerification();
    made.track(
      "strada_create_module",
      { name: "Harbor" },
      ok(`Module 'Harbor' created successfully!\n\nCreated files:\n  ${SERVICE_FILE}`, {
        createdFiles: [SERVICE_FILE],
        keptFiles: [],
      }),
    );
    expect(made.needsVerification()).toBe(true);

    const kept = new SelfVerification();
    kept.track(
      "strada_create_module",
      { name: "Harbor" },
      ok(`Module 'Harbor' already exists\n\nKept (already existed, left unchanged):\n  ${SERVICE_FILE}`, {
        createdFiles: [],
        keptFiles: [SERVICE_FILE],
      }),
    );
    expect(kept.needsVerification()).toBe(false);
  });

  it("inside a batch, where only the text of each result survives", () => {
    const verifier = new SelfVerification();
    verifier.track(
      "batch_execute",
      { operations: [{ tool: "strada_create_controller", input: { name: "HarborController", path: "Assets/Modules/HarborModule/Scripts/Controllers" } }] },
      ok(
        JSON.stringify({
          results: [
            {
              tool: "strada_create_controller",
              success: true,
              content: "Created controller HarborController at Assets/Modules/HarborModule/Scripts/Controllers/HarborController.cs",
            },
          ],
        }),
      ),
    );
    expect(verifier.needsVerification()).toBe(true);
  });

  it("a generator that refused wrote nothing", () => {
    const verifier = new SelfVerification();
    verifier.track(
      "strada_create_service",
      { name: "HarborService", path: "Assets/Modules/HarborModule/Scripts/Services" },
      { toolCallId: "tc", content: `Error: ${SERVICE_FILE} already exists`, isError: true },
    );
    expect(verifier.needsVerification()).toBe(false);
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
