/**
 * A file that outgrew the framework.
 *
 * Strada.Core's shape — commands, services, models, systems — exists to divide
 * work. Past a couple of hundred lines a class is almost always doing several
 * jobs that the pattern set already has homes for, and a command is the
 * cheapest cut: it takes one action out whole, with its own test.
 *
 * Measured on the run that prompted this: 41 files, 733 lines in total, nothing
 * over 93. The rule did not fire there and should not have — it is a guardrail
 * for the shape this project has produced before, not a claim about this run.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true, corePath: "/core", modulesInstalled: false,
  mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
} as const;

/** A fully assembled project, so only the length rule can object. */
function project(sourceLines: number): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "length-"));
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Board.asmdef"), '{"name":"Game.Board"}');
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");
  writeFileSync(join(scripts, "BoardService.cs"), "// x\n".repeat(sourceLines));

  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Board.Tests.asmdef"), '{"name":"Game.Board.Tests"}');
  writeFileSync(join(tests, "BoardTests.cs"), "public class T { [Test] public void A() { } }");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  return { root, configPath };
}

const promptFor = (lines: number): string => {
  const { root, configPath } = project(lines);
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  guard.trackToolCall("unity_playmode_verify", { projectPath: root }, false);
  return guard.getPrompt() ?? "";
};

describe("a source file past the limit", () => {
  it("is named, with its length", () => {
    const prompt = promptFor(400);

    expect(prompt).toContain("[STRADA FILE TOO LONG]");
    expect(prompt).toContain("BoardService.cs");
    expect(prompt).toContain("401 lines");
  });

  it("is told where the framework already puts that work", () => {
    // Naming a limit without naming the cut is the shape of advice this project
    // has repeatedly found useless.
    const prompt = promptFor(400);

    expect(prompt).toContain("command per action");
    expect(prompt).toContain("service");
  });

  it("says nothing about a file within the limit", () => {
    expect(promptFor(150)).not.toContain("[STRADA FILE TOO LONG]");
  });

  it("says nothing at the boundary itself", () => {
    // 200 is allowed; the rule fires past it, not at it.
    expect(promptFor(199)).not.toContain("[STRADA FILE TOO LONG]");
  });
});
