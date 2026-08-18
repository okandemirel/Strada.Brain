import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";

const OUT = "/private/tmp/claude-501/-Users-okan-Documents-Strada-Strada-Brain/0debb6b8-a921-4f27-99ba-62c5ef1a7f9f/scratchpad/probe.txt";
const note = (label: string, value: unknown): void => {
  appendFileSync(OUT, `\n=== ${label} ===\n${JSON.stringify(value, null, 1)}\n`);
};
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

function tmp(prefix: string): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
}

describe("PROBE 1: a run that deletes an obsolete module", () => {
  it("what does the guard say", () => {
    const root = tmp("probe-delete-");
    mkdirSync(join(root, "Assets", "Modules"), { recursive: true });
    // The module existed; the run deleted it (successfully).
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_delete", { path: "Assets/Modules/Legacy/OldThing.cs" }, false);
    note("PROBE1:", guard.getPrompt());
    // never gives up:
    note("PROBE1 again x5:", [1, 2, 3, 4, 5].map(() => guard.getPrompt()?.slice(0, 30)));
    expect(true).toBe(true);
  });
});

describe("PROBE 2: deep module layout", () => {
  it("what does the guard say", () => {
    const root = tmp("probe-deep-");
    const layer = join(root, "Assets", "Modules", "PixelFlow", "Scripts", "Runtime", "Domain");
    mkdirSync(layer, { recursive: true });
    const cfg = join(layer, "PixelFlowModuleConfig.cs");
    writeFileSync(cfg, "public class PixelFlowModuleConfig : ModuleConfig {}");
    writeFileSync(join(layer, "Game.PixelFlow.Domain.asmdef"), '{"name":"Game.PixelFlow.Domain"}');
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: cfg }, false);
    note("PROBE2:", guard.getPrompt());
    expect(true).toBe(true);
  });

  it("one level shallower is fine", () => {
    const root = tmp("probe-shallow-");
    const layer = join(root, "Assets", "Modules", "PixelFlow", "Scripts", "Domain");
    mkdirSync(layer, { recursive: true });
    const cfg = join(layer, "PixelFlowModuleConfig.cs");
    writeFileSync(cfg, "public class PixelFlowModuleConfig : ModuleConfig {}");
    writeFileSync(join(layer, "Game.PixelFlow.Domain.asmdef"), '{"name":"Game.PixelFlow.Domain"}');
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: cfg }, false);
    note("PROBE2b:", guard.getPrompt()?.slice(0, 120));
    expect(true).toBe(true);
  });
});

/** A module that clears every gate, so a single added file can be probed. */
function goodModule(prefix: string): { root: string; moduleRoot: string; configPath: string } {
  const root = tmp(prefix);
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Board.asmdef"), '{"name":"Game.Board"}');
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");
  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Board.Tests.asmdef"), '{"name":"Game.Board.Tests"}');
  writeFileSync(join(tests, "BoardTests.cs"), "public class T { [Test] public void A() { } }");
  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  return { root, moduleRoot, configPath };
}

describe("PROBE 3: duplicate assembly NAME, different file names", () => {
  it("what does the guard say", () => {
    const { root, moduleRoot, configPath } = goodModule("probe-dupname-");
    const editor = join(moduleRoot, "Tests", "Editor");
    mkdirSync(editor, { recursive: true });
    // Different FILE name, same assembly name inside — Unity refuses to compile.
    writeFileSync(join(editor, "BoardEditorTests.asmdef"), '{"name":"Game.Board.Tests"}');
    writeFileSync(join(editor, "E.cs"), "public class E { [Test] public void A() { } }");
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    note("PROBE3:", guard.getPrompt());
    expect(true).toBe(true);
  });
});

describe("PROBE 4: same assembly name in two touched modules", () => {
  it("what does the guard say", () => {
    const { root, configPath } = goodModule("probe-dup2-");
    const other = join(root, "Assets", "Modules", "PlayerModule", "Scripts");
    mkdirSync(other, { recursive: true });
    const cfg2 = join(other, "PlayerModuleConfig.cs");
    writeFileSync(cfg2, "public class PlayerModuleConfig : ModuleConfig {}");
    writeFileSync(join(other, "Game.Board.asmdef"), '{"name":"Game.Board"}');
    writeFileSync(join(root, "Assets", "Modules", "PlayerModule", "PlayerModuleConfig.asset"), "%YAML");
    const t2 = join(root, "Assets", "Modules", "PlayerModule", "Tests", "Runtime");
    mkdirSync(t2, { recursive: true });
    writeFileSync(join(t2, "Game.Board.Tests.asmdef"), '{"name":"Game.Board.Tests"}');
    writeFileSync(join(t2, "P.cs"), "public class P { [Test] public void A() { } }");
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    guard.trackToolCall("file_write", { path: cfg2 }, false);
    note("PROBE4:", guard.getPrompt());
    expect(true).toBe(true);
  });
});

describe("PROBE 5: an empty test assembly with a populated child assembly", () => {
  it("what does the guard say", () => {
    const { root, moduleRoot, configPath } = goodModule("probe-nested-");
    // Remove the test source at Tests/Runtime, push it into a child assembly.
    rmSync(join(moduleRoot, "Tests", "Runtime", "BoardTests.cs"));
    const child = join(moduleRoot, "Tests", "Runtime", "Domain");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "Game.Board.Domain.Tests.asmdef"), '{"name":"Game.Board.Domain.Tests"}');
    writeFileSync(join(child, "DomainTests.cs"), "public class D { [Test] public void A() { } }");
    const domain = join(moduleRoot, "Scripts", "Domain");
    mkdirSync(domain, { recursive: true });
    writeFileSync(join(domain, "Game.Board.Domain.asmdef"), '{"name":"Game.Board.Domain"}');
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    // Game.Board.Tests now owns zero test sources; Unity runs 0 tests from it.
    note("PROBE5:", guard.getPrompt());
    expect(true).toBe(true);
  });
});

describe("PROBE 6: a test double named *ModuleConfig.cs", () => {
  it("what does the guard say", () => {
    const { root, moduleRoot, configPath } = goodModule("probe-fake-");
    writeFileSync(
      join(moduleRoot, "Tests", "Runtime", "FakeModuleConfig.cs"),
      "public class FakeModuleConfig : ModuleConfig { [Test] public void A() {} }",
    );
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    note("PROBE6:", guard.getPrompt());
    note("PROBE6 x4:", [1, 2, 3, 4].map(() => guard.getPrompt()?.slice(0, 32)));
    expect(true).toBe(true);
  });
});

describe("PROBE 7: prefab-instance bootstrapper in the scene", () => {
  it("what does the guard say", () => {
    const { root, configPath } = goodModule("probe-prefab-");
    writeFileSync(
      join(root, "Assets", "Scenes", "Main.unity"),
      [
        "--- !u!1001 &123",
        "PrefabInstance:",
        "  m_Modification:",
        "    m_Modifications:",
        "    - target: {fileID: 111, guid: bbb, type: 3}",
        "      propertyPath: _gameConfig",
        "      value:",
        "      objectReference: {fileID: 0}",
      ].join("\n"),
    );
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    note("PROBE7:", guard.getPrompt());
    expect(true).toBe(true);
  });
});
