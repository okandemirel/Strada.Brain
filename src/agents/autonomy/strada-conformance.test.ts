import { describe, expect, it } from "vitest";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true,
  corePath: "/tmp/project/Packages/Strada.Core",
  modulesInstalled: true,
  modulesPath: "/tmp/project/Packages/Strada.Modules",
  mcpInstalled: true,
  mcpPath: "/tmp/project/Packages/Strada.MCP",
  mcpVersion: "1.0.0",
  warnings: [],
} as const;

describe("StradaConformanceGuard", () => {
  it("does not trigger conformance review for generic system wording alone", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Improve the system prompt and tidy the chat flow.");

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("does not block pure Strada analysis prompts without framework code changes", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Analyze whether Strada.Core review should block completion.");

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("requires a successful authoritative-source check before clearing framework code changes", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackToolCall("file_write", { path: "/tmp/project/Packages/Strada.Core/Runtime/FooSystem.cs" }, false);
    expect(guard.needsConformanceReview()).toBe(true);

    guard.trackToolCall("file_read", { path: "/tmp/project/Packages/Strada.Core/README.md" }, true);
    expect(guard.needsConformanceReview()).toBe(true);

    guard.trackToolCall("file_read", { path: "/tmp/project/Packages/Strada.Core/README.md" }, false);
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("inspects successful nested batch operations for conformance evidence", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackToolCall(
      "batch_execute",
      {
        operations: [
          { tool: "file_write", input: { path: "Assets/Gameplay/CombatSystem.cs" } },
          { tool: "file_read", input: { path: "/tmp/project/Packages/Strada.Modules/README.md" } },
        ],
      },
      false,
      JSON.stringify({
        results: [
          { tool: "file_write", success: true, content: "written" },
          { tool: "file_read", success: true, content: "docs" },
        ],
      }),
    );

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("accepts successful Strada generators as built-in conformance-aware paths", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Create a Strada component for the new flow.");
    guard.trackToolCall("strada_create_component", { name: "FlowComponent" }, false);

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("returns false when enabled=false regardless of state", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
      { enabled: false },
    );
    guard.trackToolCall("file_edit", { path: "Packages/strada.core/Runtime/Foo.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("does not trigger for game project .cs files when frameworkPathsOnly is default", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
    );
    guard.trackToolCall("file_edit", { path: "Assets/Game/LevelSolver.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("triggers for files inside Strada package directory", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
    );
    guard.trackToolCall("file_edit", { path: "Packages/strada.core/Runtime/Component.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(true);
  });
});
