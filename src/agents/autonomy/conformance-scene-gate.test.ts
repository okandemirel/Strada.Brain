/**
 * The gate that separates a compiling library from a game.
 *
 * Measured on a 104-minute run: nine modules, fifty C# files, sixteen test
 * assemblies, all compiling — and zero scenes, zero ScriptableObject assets, no
 * bootstrapper. The run reported success, and every conformance rule agreed,
 * because all of them read the shape of the code. None of them looked for the
 * artifacts that make the code run.
 *
 * A ModuleConfig class is inert until a ModuleConfig *asset* exists for it: the
 * bootstrapper serializes asset references, not types. So "the class was
 * generated" is not evidence of anything at runtime.
 *
 * The rule is deliberately conditional on the run having written module code.
 * A question about the project owes nobody a scene, and a guard that demands one
 * from every run would fire on every read-only session.
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

/** A module that satisfies every *code-shaped* rule: config class + asmdef. */
function projectWithModule(): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "scene-gate-"));
  const scripts = join(root, "Assets", "Modules", "BoardModule", "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Board.asmdef"), JSON.stringify({ name: "Board" }));
  return { root, configPath };
}

/** Adds what makes it run: the config asset, and a scene wired to it. */
function assemble(root: string): void {
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
}

const guardFor = (root: string) =>
  new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

/** The signal the rule keys on: this run wrote C# into a module. */
const wroteModuleCode = (guard: StradaConformanceGuard, path: string) =>
  guard.trackToolCall("file_write", { path }, false);

describe("a run that wrote module code but assembled no game", () => {
  it("is blocked, naming the missing scene and the missing asset", () => {
    const { root, configPath } = projectWithModule();
    const guard = guardFor(root);
    wroteModuleCode(guard, configPath);

    const prompt = guard.getPrompt();

    expect(prompt).toContain("[STRADA GAME NOT ASSEMBLED]");
    expect(prompt).toContain("library, not a game");
    expect(prompt).toContain("BoardModuleConfig.cs has no BoardModuleConfig.asset");
    // It has to say what to do, not only what is wrong.
    expect(prompt).toContain("unity_scene_build");
  });

  it("clears once a scene holds a bootstrapper pointing at the config asset", () => {
    const { root, configPath } = projectWithModule();
    assemble(root);
    const guard = guardFor(root);
    wroteModuleCode(guard, configPath);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("still blocks when the scene exists but the reference is null", () => {
    // The failure this whole layer was built for: Unity writes {fileID: 0} when
    // an assignment silently did not take, and the scene looks complete.
    const { root, configPath } = projectWithModule();
    assemble(root);
    writeFileSync(
      join(root, "Assets", "Scenes", "Main.unity"),
      "  _gameConfig: {fileID: 0}",
    );
    const guard = guardFor(root);
    wroteModuleCode(guard, configPath);

    expect(guard.getPrompt()).toContain("{fileID: 0}");
  });
});

describe("runs the rule leaves alone", () => {
  it("says nothing about scenes when the run only read", () => {
    const { root, configPath } = projectWithModule();
    const guard = guardFor(root);
    guard.trackToolCall("file_read", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("says nothing when the guard is disabled", () => {
    const { root, configPath } = projectWithModule();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: false });
    wroteModuleCode(guard, configPath);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });

  it("says nothing when there is no project path to read", () => {
    const { configPath } = projectWithModule();
    const guard = new StradaConformanceGuard(deps, { enabled: true });
    wroteModuleCode(guard, configPath);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA GAME NOT ASSEMBLED]");
  });
});
