/**
 * A file that outgrew the framework.
 *
 * Strada.Core's shape — controllers, signals, services, models, systems —
 * exists to divide work. Past a couple of hundred lines a class is almost
 * always doing several jobs that the pattern set already has homes for, and a
 * signal handler is the cheapest cut: it takes one action out whole, with its
 * own test.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";
import { STRADA_WORK_DIVISION } from "../context/strada-work-division.js";

const deps = {
  coreInstalled: true, corePath: "/core", modulesInstalled: false,
  mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
} as const;

/** A fully assembled project, so only the length rule can object. */
function project(sourceLines: number): { root: string; configPath: string; servicePath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "length-"));
  const moduleRoot = join(root, "Assets", "Modules", "QuarryModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "QuarryModuleConfig.cs");
  writeFileSync(configPath, "public class QuarryModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Quarry.asmdef"), '{"name":"Game.Quarry"}');
  writeFileSync(join(moduleRoot, "QuarryModuleConfig.asset"), "%YAML 1.1");
  const servicePath = join(scripts, "QuarryService.cs");
  writeFileSync(servicePath, "// x\n".repeat(sourceLines));

  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Quarry.Tests.asmdef"), '{"name":"Game.Quarry.Tests"}');
  writeFileSync(join(tests, "QuarryTests.cs"), "public class T { [Test] public void A() { } }");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Quarry.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  return { root, configPath, servicePath };
}

const promptFor = (lines: number): string => {
  const { root, configPath, servicePath } = project(lines);
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  // The length rule judges the files this run wrote (AUT-4).
  guard.trackToolCall("file_write", { path: servicePath }, false);
  guard.trackToolCall("unity_playmode_verify", { projectPath: root }, false);
  return guard.getPrompt() ?? "";
};

describe("a source file past the limit", () => {
  it("is named, with its length", () => {
    const prompt = promptFor(400);

    expect(prompt).toContain("[STRADA FILE TOO LONG]");
    expect(prompt).toContain("QuarryService.cs");
    expect(prompt).toContain("401 lines");
  });

  it("is told where the framework already puts that work", () => {
    // Naming a limit without naming the cut is advice a worker cannot act on.
    const prompt = promptFor(400);

    // Core has no commands: a module's actions are signals with one handler each.
    expect(prompt).toContain("signal and its handler per action");
    expect(prompt).toContain("service");
    // The one copy of that division, which the deps context teaches too and
    // strada-core-api-fidelity.test.ts holds to a Core checkout.
    expect(prompt).toContain(STRADA_WORK_DIVISION);
  });

  it("says nothing about a file within the limit", () => {
    expect(promptFor(150)).not.toContain("[STRADA FILE TOO LONG]");
  });

  it("says nothing at the boundary itself", () => {
    // 200 is allowed; the rule fires past it, not at it.
    expect(promptFor(199)).not.toContain("[STRADA FILE TOO LONG]");
  });
});
