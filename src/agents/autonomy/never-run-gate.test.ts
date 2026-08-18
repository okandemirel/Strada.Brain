/**
 * Assembled is not the same as running.
 *
 * Measured on a real project: breaking one reference to {fileID: 0} leaves a
 * scene that opens without complaint and a bootstrapper that logs
 * "[Strada][Bootstrap] No configuration assigned!" the moment play starts. The
 * headless play-mode run went from total=1 passed=1 to total=1 failed=1 on that
 * one change, and nothing that reads the scene file could tell the difference.
 *
 * So the last gate asks whether the run ever started the game.
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

/** A project that clears every earlier gate, so only this one can speak. */
function assembledProject(): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "never-run-"));
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
  writeFileSync(join(tests, "BoardTests.cs"), "public class T { [Test] public void A() { } }");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");

  return { root, configPath };
}

const guardFor = (root: string, configPath: string): StradaConformanceGuard => {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  return guard;
};

describe("a game that was built and never started", () => {
  it("is blocked", () => {
    const { root, configPath } = assembledProject();

    expect(guardFor(root, configPath).getPrompt()).toContain("[STRADA GAME NEVER RUN]");
  });

  it("clears once play mode has been run", () => {
    const { root, configPath } = assembledProject();
    const guard = guardFor(root, configPath);

    guard.trackToolCall("unity_playmode_verify", { projectPath: root }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NEVER RUN]");
  });

  it("clears even when the run failed", () => {
    // A failing verification is the agent's problem and it already sees the
    // error. Requiring a *passing* one here would trap a run in a gate it has
    // no way to clear from inside this guard.
    const { root, configPath } = assembledProject();
    const guard = guardFor(root, configPath);

    guard.trackToolCall("unity_playmode_verify", { projectPath: root }, true);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NEVER RUN]");
  });

  it("says nothing while the game is not assembled yet", () => {
    // Play mode has nothing to load without a scene, and the earlier gate is
    // already saying so — two gates for one problem is one too many.
    const { root, configPath } = assembledProject();
    writeFileSync(join(root, "Assets", "Scenes", "Main.unity"), "  _gameConfig: {fileID: 0}");

    const prompt = guardFor(root, configPath).getPrompt();

    expect(prompt).toContain("[STRADA GAME NOT ASSEMBLED]");
    expect(prompt).not.toContain("[STRADA GAME NEVER RUN]");
  });

  it("says nothing when the run wrote no module code", () => {
    const { root, configPath } = assembledProject();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

    guard.trackToolCall("file_read", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NEVER RUN]");
  });
});

describe("a project that cannot comply", () => {
  it("gives up after three askings instead of looping forever", () => {
    // unity_playmode_verify reaches a project through its Strada.MCP submodule.
    // A checkout that predates the tool cannot satisfy this gate however often
    // it is told to, and a gate that cannot be cleared is not a rule, it is a
    // loop that burns the whole iteration budget.
    const { root, configPath } = assembledProject();
    const guard = guardFor(root, configPath);

    const asked = [1, 2, 3].map(() => guard.getPrompt());
    expect(asked.every((p) => p?.includes("[STRADA GAME NEVER RUN]"))).toBe(true);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NEVER RUN]");
  });

  it("says on the last asking how to finish honestly", () => {
    const { root, configPath } = assembledProject();
    const guard = guardFor(root, configPath);

    guard.getPrompt();
    guard.getPrompt();
    const last = guard.getPrompt();

    expect(last).toContain("assembled but unverified");
    expect(last).toContain("submodule");
  });

  it("does not spend an asking once the game has been run", () => {
    const { root, configPath } = assembledProject();
    const guard = guardFor(root, configPath);

    guard.getPrompt();
    guard.trackToolCall("unity_playmode_verify", { projectPath: root }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NEVER RUN]");
  });
});
