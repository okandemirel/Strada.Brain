/**
 * Every assembly in a module needs tests of its own.
 *
 * A module split into several assemblies is several compilation units. One
 * shared test assembly referencing all of them defeats the split: a Domain test
 * can reach Presentation, no layer can be tested in isolation, and a change in
 * any layer rebuilds and reruns everything.
 *
 * Measured on a live run: a test-game module with five code assemblies —
 * Domain (22 files), Application (9), Infrastructure (8), Presentation (2),
 * Core (1) — carried a single YourGame.SampleGame.Tests at the module root whose
 * references listed all five. Four of the five assemblies had no test of their
 * own, and nothing in the system said so.
 */

import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { StradaConformanceGuard } from "./strada-conformance.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const DEPS = {
  coreInstalled: true,
  corePath: "/proj/Packages/Submodules/Strada.Core",
  modulesInstalled: false,
  modulesPath: null,
  mcpInstalled: false,
  mcpPath: null,
} as unknown as StradaDepsStatus;

// The guard resolves module roots natively ("D:\proj\..." on Windows), so the
// fixture names the directory the same way.
const MODULE_DIR = resolve("/proj/Assets/Modules/SampleGame");

/** A guard whose view of a module's .asmdef files is whatever the test says. */
function guardSeeing(asmdefs: string[]): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(DEPS, {
    projectPath: "/proj",
    // The completeness gate must stay quiet so this one is what we read.
    listDir: () => ["SampleGameModuleConfig.cs", "SampleGame.asmdef"],
    listAsmdefs: (dir: string) => (dir === MODULE_DIR ? asmdefs : []),
  });
  guard.trackToolCall(
    "file_write",
    { path: "Assets/Modules/SampleGame/Domain/Board.cs", content: "class X {}" },
    false,
    "written",
  );
  return guard;
}

describe("per-assembly test coverage", () => {
  it("names every assembly that nothing tests", () => {
    // The measured shape: five code assemblies, one catch-all test assembly.
    const guard = guardSeeing([
      "Core/YourGame.SampleGame.Core.asmdef",
      "Domain/YourGame.SampleGame.Domain.asmdef",
      "Application/YourGame.SampleGame.Application.asmdef",
      "Infrastructure/YourGame.SampleGame.Infrastructure.asmdef",
      "Presentation/YourGame.SampleGame.Presentation.asmdef",
      "Tests/Runtime/YourGame.SampleGame.Tests.asmdef",
      "Tests/Editor/YourGame.SampleGame.Editor.Tests.asmdef",
    ]);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain("STRADA MODULE TESTS MISSING");
    // One .asmdef per folder, or the project does not build at all. Saying
    // "give each assembly its own tests" without this sent an agent to write
    // five test assemblies into a single Tests/Editor folder; Unity answered
    // "contains multiple assembly definition files" and nothing compiled.
    expect(prompt).toMatch(/ONE \.asmdef per folder/i);
    expect(prompt).toMatch(/its own directory/i);
    for (const layer of ["Core", "Domain", "Application", "Infrastructure", "Presentation"]) {
      expect(prompt, `${layer} was not reported as untested`).toContain(
        `YourGame.SampleGame.${layer}`,
      );
    }
  });

  it("stays quiet when each assembly has its own tests", () => {
    const guard = guardSeeing([
      "Domain/YourGame.SampleGame.Domain.asmdef",
      "Domain/Tests/Runtime/YourGame.SampleGame.Domain.Tests.asmdef",
      "Application/YourGame.SampleGame.Application.asmdef",
      "Application/Tests/Runtime/YourGame.SampleGame.Application.Tests.asmdef",
    ]);

    expect(guard.getPrompt()).toBeNull();
  });

  it("accepts an edit-mode-only test assembly", () => {
    // Some layers are only meaningfully testable in the editor; that still
    // counts as tested.
    const guard = guardSeeing([
      "Presentation/YourGame.SampleGame.Presentation.asmdef",
      "Presentation/Tests/Editor/YourGame.SampleGame.Presentation.Editor.Tests.asmdef",
    ]);

    expect(guard.getPrompt()).toBeNull();
  });

  it("is satisfied by the module's own test pair when there is one assembly", () => {
    // The ordinary generated module: one code assembly, Tests/Runtime and
    // Tests/Editor beside it. This gate must not nag about that.
    const guard = guardSeeing([
      "SampleGame.asmdef",
      "Tests/Runtime/SampleGame.Tests.asmdef",
      "Tests/Editor/SampleGame.Editor.Tests.asmdef",
    ]);

    expect(guard.getPrompt()).toBeNull();
  });

  it("says nothing about a module with no assemblies yet", () => {
    // Mid-creation: the completeness gate covers that case, not this one.
    const guard = guardSeeing([]);
    expect(guard.getPrompt()).toBeNull();
  });
});
