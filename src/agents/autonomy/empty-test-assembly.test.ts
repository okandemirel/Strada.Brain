/**
 * The rule that reads what is inside a test assembly.
 *
 * Measured on two full from-scratch runs: sixteen test assemblies each, and
 * thirty-two of thirty-two directories held zero .cs files. Every one satisfied
 * the coverage rule, which matches on .asmdef names. A headless PlayMode run
 * over one of those projects executed 0 tests, and Unity wrote
 * `result="Passed" total="0"` and exited 0 — so a naive verdict would have
 * reported the game verified.
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

/**
 * A module built the way the generator builds one, wired so that only the
 * emptiness rule can object: config class, asmdef, scene and config asset all
 * present.
 */
function project(testBody: string | null): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "empty-tests-"));
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Modules.Board.asmdef"), '{"name":"Game.Modules.Board"}');
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");

  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Modules.Board.Tests.asmdef"), '{"name":"Game.Modules.Board.Tests"}');
  if (testBody !== null) writeFileSync(join(tests, "BoardTests.cs"), testBody);

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");

  return { root, configPath };
}

const promptFor = (root: string, configPath: string): string | null => {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  return guard.getPrompt();
};

describe("a test assembly with nothing in it", () => {
  it("is caught when the directory holds no source at all", () => {
    // The measured shape: an .asmdef and its .meta, and nothing else.
    const { root, configPath } = project(null);

    const prompt = promptFor(root, configPath);

    expect(prompt).toContain("[STRADA TEST ASSEMBLY EMPTY]");
    expect(prompt).toContain("Game.Modules.Board.Tests");
  });

  it("is caught when the sources declare no test", () => {
    // Compiles, is not empty on disk, and still runs nothing.
    const { root, configPath } = project("public static class BoardHelpers { }");

    expect(promptFor(root, configPath)).toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });

  it("stays quiet for an assembly that declares a test", () => {
    const { root, configPath } = project(
      "public class BoardTests { [Test] public void Boots() { } }",
    );

    expect(promptFor(root, configPath) ?? "").not.toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });

  it("accepts a UnityTest, which is what a play-mode check declares", () => {
    const { root, configPath } = project(
      "public class BoardTests { [UnityTest] public IEnumerator Boots() { yield return null; } }",
    );

    expect(promptFor(root, configPath) ?? "").not.toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });

  it("accepts a parameterised test", () => {
    const { root, configPath } = project(
      "public class BoardTests { [TestCase(1)] public void Scores(int n) { } }",
    );

    expect(promptFor(root, configPath) ?? "").not.toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });

  it("says nothing about a non-test assembly with no tests in it", () => {
    // Game.Modules.Board holds no [Test] either; only assemblies whose name
    // claims to be a test assembly are held to this.
    const { root, configPath } = project("public class BoardTests { [Test] public void A() { } }");

    expect(promptFor(root, configPath) ?? "").not.toContain("Game.Modules.Board (");
  });
});
