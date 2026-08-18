/**
 * Four blind spots in the game gates, each with the project shape that walks
 * straight through them. Every scenario here comes from an adversarial audit
 * that built the shape and ran the guard against it.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(os.tmpdir(), "blind-spot-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  return root;
}

const write = (root: string, rel: string, body: string): string => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
};

describe("a game written outside Assets/Modules", () => {
  it("is still held to producing a game", () => {
    // Nothing obliges an agent to use the Modules/ convention, and keying the
    // scene gate on that folder made a run under Assets/Scripts exempt from
    // every rule the gates exist to enforce.
    const root = project();
    const configPath = write(root, "Assets/Scripts/Board/BoardModuleConfig.cs", "public class BoardModuleConfig : ModuleConfig {}");
    write(root, "Assets/Scripts/Board/Game.Board.asmdef", '{"name":"Game.Board"}');

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt()).toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("says nothing for a run that wrote no project code", () => {
    const root = project();
    const guard = guardFor(root);

    guard.trackToolCall("file_write", { path: join(root, "notes.md") }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });
});

describe("assembly names Unity actually enforces", () => {
  it("sees two modules declaring the same assembly name", () => {
    // The name Unity enforces is the `name` field inside the .asmdef, not the
    // file name. Two files called Board.asmdef both declaring "Game.Board" is a
    // project Unity refuses to compile at all, and it read as two distinct
    // assemblies because the check compared file names within one module.
    const root = project();
    const a = write(root, "Assets/Modules/AModule/Scripts/AModuleConfig.cs", "public class AModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/AModule/Scripts/A.asmdef", '{"name":"Game.Shared"}');
    const b = write(root, "Assets/Modules/BModule/Scripts/BModuleConfig.cs", "public class BModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/BModule/Scripts/B.asmdef", '{"name":"Game.Shared"}');

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: a }, false);
    guard.trackToolCall("file_write", { path: b }, false);

    const prompt = guard.getPrompt();
    expect(prompt).toContain("[STRADA DUPLICATE ASSEMBLY]");
    expect(prompt).toContain("Game.Shared");
  });

  it("does not call two differently-named assemblies a duplicate", () => {
    // Two files that happen to share a file name but declare distinct assembly
    // names are perfectly legal.
    const root = project();
    const a = write(root, "Assets/Modules/AModule/Scripts/AModuleConfig.cs", "public class AModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/AModule/Scripts/Tests.asmdef", '{"name":"Game.A.Tests"}');
    const b = write(root, "Assets/Modules/BModule/Scripts/BModuleConfig.cs", "public class BModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/BModule/Scripts/Tests.asmdef", '{"name":"Game.B.Tests"}');

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: a }, false);
    guard.trackToolCall("file_write", { path: b }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA DUPLICATE ASSEMBLY]");
  });
});

describe("which assembly owns a source file", () => {
  it("does not credit an empty test assembly with a nested one's tests", () => {
    // Unity's rule is that a folder with its own .asmdef takes its sources out
    // of the parent assembly. Counting them meant the outer assembly — which
    // Unity compiles empty and runs zero tests from — passed the gate.
    const root = project();
    const configPath = write(root, "Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs", "public class BoardModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/BoardModule/Scripts/Game.Board.asmdef", '{"name":"Game.Board"}');
    write(root, "Assets/Modules/BoardModule/BoardModuleConfig.asset", "%YAML 1.1");
    write(root, "Assets/Scenes/Main.unity", "  _gameConfig: {fileID: 11400000, guid: abc}");

    // The outer test assembly holds no test of its own...
    write(root, "Assets/Modules/BoardModule/Tests/Runtime/Game.Board.Tests.asmdef", '{"name":"Game.Board.Tests"}');
    // ...and the only [Test] belongs to a nested assembly.
    write(root, "Assets/Modules/BoardModule/Tests/Runtime/Domain/Game.Board.Domain.Tests.asmdef", '{"name":"Game.Board.Domain.Tests"}');
    write(root, "Assets/Modules/BoardModule/Tests/Runtime/Domain/DomainTests.cs", "public class D { [Test] public void A() { } }");

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt();
    expect(prompt).toContain("[STRADA TEST ASSEMBLY EMPTY]");
    expect(prompt).toContain("Game.Board.Tests");
  });

  it("still accepts an assembly whose own folder holds the test", () => {
    const root = project();
    const configPath = write(root, "Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs", "public class BoardModuleConfig : ModuleConfig {}");
    write(root, "Assets/Modules/BoardModule/Scripts/Game.Board.asmdef", '{"name":"Game.Board"}');
    write(root, "Assets/Modules/BoardModule/BoardModuleConfig.asset", "%YAML 1.1");
    write(root, "Assets/Scenes/Main.unity", "  _gameConfig: {fileID: 11400000, guid: abc}");
    write(root, "Assets/Modules/BoardModule/Tests/Runtime/Game.Board.Tests.asmdef", '{"name":"Game.Board.Tests"}');
    write(root, "Assets/Modules/BoardModule/Tests/Runtime/BoardTests.cs", "public class B { [Test] public void A() { } }");

    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });
});
