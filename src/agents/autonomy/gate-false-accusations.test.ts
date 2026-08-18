/**
 * Three ways the game gates accused a run that had done nothing wrong, and one
 * way they stayed silent when they should have spoken.
 *
 * Found by an adversarial audit of the gates rather than by using them, which is
 * the point: each one needs a project shape I had not thought to build.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true,
  corePath: "/core",
  modulesInstalled: true,
  modulesPath: "/modules",
  mcpInstalled: true,
  mcpPath: "/mcp",
  mcpVersion: "1.0.0",
  warnings: [],
} as const;

const guardFor = (root: string) =>
  new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "gate-accuse-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  return root;
}

/** A module built the way the generator builds one, fully assembled. */
function assembledModule(root: string, name = "Board"): string {
  const moduleRoot = join(root, "Assets", "Modules", `${name}Module`);
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, `${name}ModuleConfig.cs`), `public class ${name}ModuleConfig : ModuleConfig {}`);
  writeFileSync(join(scripts, `Game.Modules.${name}.asmdef`), `{"name":"Game.Modules.${name}"}`);
  writeFileSync(join(moduleRoot, `${name}ModuleConfig.asset`), "%YAML 1.1");

  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, `Game.Modules.${name}.Tests.asmdef`), `{"name":"Game.Modules.${name}.Tests"}`);
  writeFileSync(join(tests, `${name}Tests.cs`), "public class T { [Test] public void A() { } }");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  return join(scripts, `${name}ModuleConfig.cs`);
}

describe("a module the run deleted", () => {
  it("is not reported as incomplete", () => {
    // Deleting a module records its root exactly as writing one does, and the
    // only action that would clear an incomplete-module gate is re-creating
    // what the user asked to remove.
    const root = project();
    const configPath = assembledModule(root);
    const guard = guardFor(root);

    guard.trackToolCall("file_delete", { path: configPath }, false);
    rmSync(join(root, "Assets", "Modules", "BoardModule"), { recursive: true, force: true });

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA MODULE INCOMPLETE]");
  });

  it("still reports a module that exists and is genuinely incomplete", () => {
    // The rule has to keep working for the case it was written for.
    const root = project();
    const scripts = join(root, "Assets", "Modules", "HalfModule", "Scripts");
    mkdirSync(scripts, { recursive: true });
    const orphan = join(scripts, "Something.cs");
    writeFileSync(orphan, "public class Something {}");

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: orphan }, false);

    expect(guard.getPrompt()).toContain("[STRADA MODULE INCOMPLETE]");
  });
});

describe("a ModuleConfig class that was never meant to have an asset", () => {
  it("ignores a test double under Tests/", () => {
    const root = project();
    const configPath = assembledModule(root);
    writeFileSync(
      join(root, "Assets", "Modules", "BoardModule", "Tests", "Runtime", "FakeModuleConfig.cs"),
      "public class FakeModuleConfig : ModuleConfig {}",
    );

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("ignores an abstract base class", () => {
    // An abstract config has no asset by definition.
    const root = project();
    const configPath = assembledModule(root);
    writeFileSync(
      join(root, "Assets", "Modules", "BoardModule", "Scripts", "BaseModuleConfig.cs"),
      "public abstract class BaseModuleConfig : ModuleConfig {}",
    );

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("still demands an asset for a real module config", () => {
    const root = project();
    const configPath = assembledModule(root);
    rmSync(join(root, "Assets", "Modules", "BoardModule", "BoardModuleConfig.asset"));

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt()).toContain("BoardModuleConfig.cs has no BoardModuleConfig.asset");
  });
});

describe("a module built the recommended way", () => {
  it("is subject to the same rules as one written by hand", () => {
    // strada_create_module is what the guidance tells the agent to use, and the
    // generator branch used to skip the module-root recording entirely — so
    // following the advice made every game gate go silent.
    const root = project();
    const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
    mkdirSync(join(moduleRoot, "Scripts"), { recursive: true });
    writeFileSync(join(moduleRoot, "Scripts", "BoardModuleConfig.cs"), "public class BoardModuleConfig : ModuleConfig {}");
    writeFileSync(join(moduleRoot, "Scripts", "Game.Modules.Board.asmdef"), '{"name":"Game.Modules.Board"}');

    const guard = guardFor(root);
    guard.trackToolCall(
      "strada_create_module",
      { name: "Board" },
      false,
      [
        "Created module Board:",
        "  Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs",
        "  Assets/Modules/BoardModule/Scripts/Game.Modules.Board.asmdef",
      ].join("\n"),
    );

    // No scene, no config asset: the run produced a library.
    expect(guard.getPrompt()).toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("says nothing when the generator failed", () => {
    const root = project();
    const guard = guardFor(root);

    guard.trackToolCall("strada_create_module", { name: "Board" }, true, "Error: invalid name");

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });
});
