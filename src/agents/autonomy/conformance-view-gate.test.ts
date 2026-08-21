/**
 * The gate between a game and a simulation nobody can see.
 *
 * Measured 2026-08-21 on a delivered project: 85 C# files, 25 prefabs, 44
 * passing play-mode tests, and zero MonoBehaviours, zero uses of Strada.Core's
 * view layer, one GameObject in the only scene. Every service and system was
 * correct and a player would have faced an empty screen. The tests passed
 * because they call services directly and never go through a scene, so no rule
 * that reads code shape or asserts on tests could have caught it.
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

/** An assembled game: module, config asset, wired scene — and prefabs. */
function assembledProject(): { root: string; configPath: string; scripts: string } {
  const root = mkdtempSync(join(os.tmpdir(), "view-gate-"));
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Board.asmdef"), JSON.stringify({ name: "Board" }));
  writeFileSync(join(scripts, "BoardService.cs"), "public class BoardService : IBoardService {}");
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");

  const prefabs = join(moduleRoot, "Prefabs");
  mkdirSync(prefabs, { recursive: true });
  writeFileSync(join(prefabs, "Cube.prefab"), "GameObject:");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");

  return { root, configPath, scripts };
}

const guardFor = (root: string) =>
  new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

describe("a game that is assembled and renders nothing", () => {
  it("is blocked, counting the prefabs nothing can drive", () => {
    const { root, configPath } = assembledProject();
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt();

    expect(prompt).toContain("[STRADA NOTHING RENDERS]");
    expect(prompt).toContain("1 prefab(s)");
    // It must name the framework's own bridge, since not knowing it is the bug.
    expect(prompt).toContain("EntityView");
    expect(prompt).toContain("MediatorRegistry");
    // And it must not send the agent down the road it already took.
    expect(prompt).toContain("deliberately NOT");
  });

  it("clears once something derives from MonoBehaviour", () => {
    const { root, configPath, scripts } = assembledProject();
    writeFileSync(join(scripts, "CubeView.cs"), "public class CubeView : MonoBehaviour {}");
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA NOTHING RENDERS]");
  });

  it("says nothing to a run that wrote no project code", () => {
    const { root } = assembledProject();

    expect(guardFor(root).getPrompt() ?? "").not.toContain("[STRADA NOTHING RENDERS]");
  });
});
