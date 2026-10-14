/**
 * The gate between a game and a simulation nobody can see.
 *
 * A project can hold correct services, systems and prefabs and a green
 * play-mode suite, and still show a player an empty screen: tests that call
 * services directly never go through a scene, so no rule that reads code shape
 * or asserts on tests can catch a missing view.
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
  const moduleRoot = join(root, "Assets", "Modules", "ApiaryModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, "ApiaryModuleConfig.cs");
  writeFileSync(configPath, "public class ApiaryModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Apiary.asmdef"), JSON.stringify({ name: "Apiary" }));
  writeFileSync(join(scripts, "HiveService.cs"), "public class HiveService : IHiveService {}");
  writeFileSync(join(moduleRoot, "ApiaryModuleConfig.asset"), "%YAML 1.1");

  const prefabs = join(moduleRoot, "Prefabs");
  mkdirSync(prefabs, { recursive: true });
  writeFileSync(join(prefabs, "Smoker.prefab"), "GameObject:");

  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  // With a Camera: the cameraless case is tested on its own below, and without
  // one here every case would stop at that gate instead of the one it means to
  // exercise.
  writeFileSync(
    join(scenes, "Main.unity"),
    "Camera:\n  m_Enabled: 1\n  _gameConfig: {fileID: 11400000, guid: abc}",
  );

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

  it("comes before the reimplementation gate, and names it", () => {
    // A game nobody can see is a bigger fact than which event bus it uses, and
    // the run must hear both rather than discovering the second after the first.
    const { root, configPath, scripts } = assembledProject();
    const events = join(scripts, "Events.cs");
    writeFileSync(
      events,
      Array.from({ length: 8 }, (_, i) => `public event Action E${i};`).join("\n"),
    );
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);
    // The reimplementation rule counts what THIS run wrote (AUT-4).
    guard.trackToolCall("file_write", { path: events }, false);

    const prompt = guard.getPrompt() ?? "";

    expect(prompt).toContain("[STRADA NOTHING RENDERS]");
    expect(prompt).toContain("Also still true");
    expect(prompt).toContain("reimplements subsystems");
    expect(prompt).toContain("not fixed by adding views");
  });

  it("clears once something derives from MonoBehaviour", () => {
    const { root, configPath, scripts } = assembledProject();
    writeFileSync(join(scripts, "SmokerView.cs"), "public class SmokerView : MonoBehaviour {}");
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA NOTHING RENDERS]");
  });

  it("says nothing to a run that wrote no project code", () => {
    const { root } = assembledProject();

    expect(guardFor(root).getPrompt() ?? "").not.toContain("[STRADA NOTHING RENDERS]");
  });

  it("puts a missing camera ahead of the missing views", () => {
    const { root, configPath } = assembledProject();
    writeFileSync(
      join(root, "Assets", "Scenes", "Main.unity"),
      "GameObject:\n  _gameConfig: {fileID: 11400000, guid: abc}",
    );
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt() ?? "";

    expect(prompt).toContain("[STRADA NO CAMERA]");
    expect(prompt).toContain("Main.unity");
    expect(prompt).toContain("unity_scene_build");
  });

  it("says a cameraless scene draws nothing without claiming the prefabs carry renderers", () => {
    // The gate reads scenes for a Camera and never opens a prefab, so it knows
    // nothing about what the prefabs hold. Smoker.prefab here is a bare
    // GameObject with no renderer component at all — a shape every project is
    // free to have — and the ask must still be true of it.
    const { root, configPath } = assembledProject();
    writeFileSync(
      join(root, "Assets", "Scenes", "Main.unity"),
      "GameObject:\n  _gameConfig: {fileID: 11400000, guid: abc}",
    );
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt() ?? "";

    expect(prompt).toContain("[STRADA NO CAMERA]");
    // The claim the gate is entitled to make: the camera decides, whatever the
    // prefabs are.
    expect(prompt).toContain("not the prefabs, whatever they carry");
    expect(prompt).not.toMatch(/prefab[\s\S]{0,40}carries a renderer/i);
  });
});
