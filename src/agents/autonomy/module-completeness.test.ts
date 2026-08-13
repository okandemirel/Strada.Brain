/**
 * A Strada module is not a folder shape.
 *
 * strada_create_module emits a `<Name>ModuleConfig` deriving from the
 * framework's module-config base class (Configure/Initialize/Shutdown) and an
 * .asmdef referencing Strada.Core. Without the first the module is never
 * registered with the framework; without the second it cannot compile against
 * Strada.Core at all.
 *
 * Measured: a greenfield task with Strada installed produced 19 hand-written
 * files under Assets/Modules/GameModule/Scripts/{Domain,Models,Services} with
 * neither. The layout looked correct and the module did not exist as far as the
 * framework was concerned. Saying "prefer the generators" in the system prompt
 * did not change that — verified, the directive reached the model and the next
 * run still hand-wrote everything.
 *
 * So the gate checks the OUTCOME, not which tool produced it: hand-writing a
 * module stays legitimate as long as the result is a module.
 */

import { describe, it, expect } from "vitest";
import { StradaConformanceGuard } from "./strada-conformance.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const DEPS = {
  coreInstalled: true,
  corePath: "/proj/Packages/Submodules/Strada.Core",
  modulesInstalled: true,
  modulesPath: "/proj/Packages/Submodules/Strada.Modules",
  mcpInstalled: false,
  mcpPath: null,
} as unknown as StradaDepsStatus;

/** Guard whose disk view is whatever the test says it is. */
function guardSeeing(files: Record<string, string[]>) {
  return new StradaConformanceGuard(DEPS, {
    projectPath: "/proj",
    listDir: (dir: string) => files[dir.replace(/\\/g, "/")] ?? [],
  });
}

function writeCs(guard: StradaConformanceGuard, path: string): void {
  guard.trackToolCall("file_write", { path, content: "class X {}" }, false, "written");
}

const MODULE_DIR = "/proj/Assets/Modules/GameModule";

describe("module completeness gate", () => {
  it("flags a module written with neither ModuleConfig nor asmdef", () => {
    const guard = guardSeeing({ [MODULE_DIR]: ["BoardService.cs", "PixelColor.cs"] });
    writeCs(guard, "Assets/Modules/GameModule/Scripts/Services/BoardService.cs");

    const prompt = guard.getPrompt();
    expect(prompt).toContain("STRADA MODULE INCOMPLETE");
    expect(prompt).toMatch(/ModuleConfig\.cs/);
    expect(prompt).toMatch(/\.asmdef/);
    expect(prompt).toContain("Assets/Modules/GameModule");
  });

  it("names only what is actually missing", () => {
    const guard = guardSeeing({
      [MODULE_DIR]: ["GameModuleModuleConfig.cs", "BoardService.cs"],
    });
    writeCs(guard, "Assets/Modules/GameModule/Scripts/Services/BoardService.cs");

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toMatch(/\.asmdef/);
    expect(prompt).not.toMatch(/missing a \*ModuleConfig\.cs and/);
  });

  it("stays quiet for a complete module", () => {
    // Hand-written is fine — the gate is about the result, not the tool.
    const guard = guardSeeing({
      [MODULE_DIR]: ["GameModuleModuleConfig.cs", "GameModule.asmdef", "BoardService.cs"],
    });
    writeCs(guard, "Assets/Modules/GameModule/Scripts/Services/BoardService.cs");
    expect(guard.getPrompt()).toBeNull();
  });

  it("ignores writes outside a module directory", () => {
    const guard = guardSeeing({});
    writeCs(guard, "Assets/Scripts/GameBootstrap.cs");
    expect(guard.getPrompt()).toBeNull();
  });

  it("ignores non-compilable writes", () => {
    // A README dropped in a module folder does not make it a module in progress.
    const guard = guardSeeing({ [MODULE_DIR]: [] });
    guard.trackToolCall("file_write", { path: "Assets/Modules/GameModule/README.md" }, false, "ok");
    expect(guard.getPrompt()).toBeNull();
  });

  it("ignores a failed write", () => {
    const guard = guardSeeing({ [MODULE_DIR]: [] });
    guard.trackToolCall(
      "file_write",
      { path: "Assets/Modules/GameModule/Scripts/A.cs" },
      true,
      "Error: Path is outside allowed paths",
    );
    expect(guard.getPrompt()).toBeNull();
  });

  it("stays quiet without a project path", () => {
    // The check reads the project from disk; with no root it cannot run, and
    // must not guess.
    const guard = new StradaConformanceGuard(DEPS, {});
    writeCs(guard, "Assets/Modules/GameModule/Scripts/Services/BoardService.cs");
    expect(guard.getPrompt()).toBeNull();
  });

  it("reports every incomplete module it touched", () => {
    const guard = guardSeeing({
      [MODULE_DIR]: ["A.cs"],
      "/proj/Assets/Modules/UiModule": ["B.cs"],
    });
    writeCs(guard, "Assets/Modules/GameModule/Scripts/A.cs");
    writeCs(guard, "Assets/Modules/UiModule/Scripts/B.cs");

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain("GameModule");
    expect(prompt).toContain("UiModule");
  });
});
