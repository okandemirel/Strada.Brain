/**
 * A prefab nothing references is invisible.
 *
 * Measured 2026-08-22 on a project whose PlayMode suite was 44 of 44 green:
 * twenty-five prefabs, twenty-five sprites, a PresentationPrefabsConfig
 * declaring three GameObject fields — and no .asset instance of it anywhere, so
 * nothing held a reference to a single prefab at run time. Three GameObjects in
 * the scene, and all one hundred and twenty captured frames were the same empty
 * sky.
 *
 * Every rule in the conformance set passed. The tests passed. The game did not
 * exist.
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

const GUID = "7f09385215284bf5ae25c59b4a8eb15e";

function project(opts: {
  prefabFields: boolean;
  assetReferencingIt: boolean;
}): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "unbound-prefabs-"));
  const moduleRoot = join(root, "Assets", "Modules", "RenderingModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  // The module's own config, wired, so only the prefab rule can object.
  writeFileSync(join(scripts, "RenderingModuleConfig.cs"), "public class RenderingModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Modules.Rendering.asmdef"), '{"name":"Game.Modules.Rendering"}');
  writeFileSync(join(moduleRoot, "RenderingModuleConfig.asset"), "%YAML 1.1");
  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Modules.Rendering.Tests.asmdef"), '{"name":"Game.Modules.Rendering.Tests"}');
  writeFileSync(join(tests, "RenderingTests.cs"), "[Test] public void It() {}");

  const configPath = join(scripts, "PresentationPrefabsConfig.cs");
  writeFileSync(
    configPath,
    opts.prefabFields
      ? "public class PresentationPrefabsConfig : ScriptableObject {\n" +
          "    [SerializeField] private GameObject _pigPrefab;\n" +
          "    [SerializeField] private GameObject _cubePrefab;\n}"
      : "public class PresentationPrefabsConfig : ScriptableObject {\n" +
          "    [SerializeField] private int _spawnBudget;\n}",
  );
  // Unity records a script's identity in its .meta, and an .asset points at that
  // guid — not at the class name.
  writeFileSync(`${configPath}.meta`, `fileFormatVersion: 2\nguid: ${GUID}\n`);

  if (opts.assetReferencingIt) {
    writeFileSync(
      join(moduleRoot, "PresentationPrefabs.asset"),
      `%YAML 1.1\n  m_Script: {fileID: 11500000, guid: ${GUID}, type: 3}\n`,
    );
  }

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

describe("a config that holds prefabs and was never instantiated", () => {
  it("objects when nothing references the script", () => {
    const { root, configPath } = project({ prefabFields: true, assetReferencingIt: false });

    const prompt = promptFor(root, configPath);

    expect(prompt).toContain("[STRADA PREFABS UNBOUND]");
    expect(prompt).toContain("PresentationPrefabsConfig");
  });

  it("stays quiet once an asset points at it", () => {
    const { root, configPath } = project({ prefabFields: true, assetReferencingIt: true });

    expect(promptFor(root, configPath) ?? "").not.toContain("[STRADA PREFABS UNBOUND]");
  });

  it("ignores a config that holds no prefabs", () => {
    // A settings object with no GameObject field cannot leave prefabs unbound,
    // and objecting to it would train the agent to ignore the rule.
    const { root, configPath } = project({ prefabFields: false, assetReferencingIt: false });

    expect(promptFor(root, configPath) ?? "").not.toContain("[STRADA PREFABS UNBOUND]");
  });

  it("says what the missing asset costs", () => {
    const { root, configPath } = project({ prefabFields: true, assetReferencingIt: false });

    const prompt = promptFor(root, configPath) ?? "";

    expect(prompt.toLowerCase()).toMatch(/never be spawned|nothing will spawn|no prefab/u);
  });

  it("names the tool that can fix it", () => {
    // A gate that says what is wrong and not what to do gets repeated. Its
    // sibling gate names unity_scene_build and its spec; this one fired five
    // times in twenty minutes while saying only that the asset was missing.
    const { root, configPath } = project({ prefabFields: true, assetReferencingIt: false });

    const prompt = promptFor(root, configPath) ?? "";

    expect(prompt).toContain("unity_scene_build");
    expect(prompt).toContain('kind "prefab"');
  });
});
