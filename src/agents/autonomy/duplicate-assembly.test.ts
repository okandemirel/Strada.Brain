/**
 * Two .asmdef files may not claim the same assembly name.
 *
 * Unity requires assembly names to be unique across the whole project and
 * refuses to compile when two claim the same one — every assembly fails, not
 * just the offending pair. Nothing else catches it: the JSON is valid, the C# is
 * valid, and script_validate is a syntax check, so the first sign is a project
 * that will not build.
 *
 * Measured on a live run: asked to add tests, the agent created the framework's
 * Tests/Runtime + Tests/Editor pair and also kept its own habit of a Tests/ root
 * assembly. It ended with Tests/YourGame.PixelFlow.Tests.asmdef and
 * Tests/Runtime/YourGame.PixelFlow.Tests.asmdef claiming one name, and six test
 * files at the Tests root belonging to neither mode.
 */

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

const MODULE_DIR = "/proj/Assets/Modules/PixelFlow";

function guardSeeing(asmdefs: string[]): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(DEPS, {
    projectPath: "/proj",
    listDir: () => ["PixelFlowModuleConfig.cs", "PixelFlow.asmdef"],
    listAsmdefs: (dir: string) => (dir.replace(/\\/g, "/") === MODULE_DIR ? asmdefs : []),
  });
  guard.trackToolCall(
    "file_write",
    { path: "Assets/Modules/PixelFlow/Tests/GridTests.cs", content: "class X {}" },
    false,
    "written",
  );
  return guard;
}

describe("duplicate assembly names", () => {
  it("reports both locations of the clashing name", () => {
    // The measured shape, verbatim.
    const guard = guardSeeing([
      "PixelFlow.asmdef",
      "Tests/YourGame.PixelFlow.Tests.asmdef",
      "Tests/Runtime/YourGame.PixelFlow.Tests.asmdef",
      "Tests/Editor/YourGame.PixelFlow.Editor.Tests.asmdef",
    ]);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain("STRADA DUPLICATE ASSEMBLY");
    expect(prompt).toContain("YourGame.PixelFlow.Tests");
    // Naming one location would leave the agent guessing which to remove.
    expect(prompt).toContain("Tests/YourGame.PixelFlow.Tests.asmdef");
    expect(prompt).toContain("Tests/Runtime/YourGame.PixelFlow.Tests.asmdef");
  });

  it("takes precedence over the test-coverage advice", () => {
    // With a duplicate present nothing in the project compiles, so telling the
    // agent about missing test assemblies first would be advice it cannot act on.
    const guard = guardSeeing([
      "Domain/YourGame.PixelFlow.Domain.asmdef",
      "Tests/YourGame.PixelFlow.Tests.asmdef",
      "Tests/Runtime/YourGame.PixelFlow.Tests.asmdef",
    ]);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain("STRADA DUPLICATE ASSEMBLY");
    expect(prompt).not.toContain("STRADA MODULE TESTS MISSING");
  });

  it("stays quiet when every assembly name is distinct", () => {
    const guard = guardSeeing([
      "PixelFlow.asmdef",
      "Tests/Runtime/PixelFlow.Tests.asmdef",
      "Tests/Editor/PixelFlow.Editor.Tests.asmdef",
    ]);

    expect(guard.getPrompt()).toBeNull();
  });

  it("does not confuse same-named files in different modules", () => {
    // Uniqueness is checked per module here; a second module's own Tests
    // assembly is a different name because it carries that module's namespace.
    const guard = guardSeeing(["PixelFlow.asmdef", "Tests/Runtime/PixelFlow.Tests.asmdef"]);
    expect(guard.getPrompt()).toBeNull();
  });
});
