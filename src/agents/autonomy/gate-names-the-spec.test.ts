/**
 * The gate has to say what a working spec contains.
 *
 * Measured on a 105-minute run: the agent chose unity_scene_build and called it
 * twice — the boot test it writes is on disk twice over — and the scene it
 * produced contains the word "GameBootstrapper" zero times. Running the same
 * tool by hand against that same project, with a spec that names the config
 * asset and the bootstrapper, assembled it on the first attempt with no
 * problems. The tool was never the difficulty; knowing what to put in the spec
 * was.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true, corePath: "/core",
  modulesInstalled: false, mcpInstalled: true, mcpPath: "/mcp",
  mcpVersion: "1.0.0", warnings: [],
} as const;

function libraryProject(): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "spec-gate-"));
  const scripts = join(root, "Assets", "Modules", "BoardModule", "Scripts");
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Board.asmdef"), '{"name":"Game.Board"}');
  return { root, configPath };
}

describe("what the not-assembled gate tells the run", () => {
  const { root, configPath } = libraryProject();
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  const prompt = guard.getPrompt() ?? "";

  it("names the tool", () => {
    expect(prompt).toContain("[STRADA GAME NOT ASSEMBLED]");
    expect(prompt).toContain("unity_scene_build");
  });

  it("names the three pieces a spec needs, since naming the tool was not enough", () => {
    expect(prompt).toContain("GameBootstrapperConfig");
    expect(prompt).toContain("GameBootstrapper component");
    expect(prompt).toContain("_gameConfig");
  });

  it("says where a runtime-spawned object goes", () => {
    // The design document asks for tiles spawned at runtime; without this the
    // spec describes a scene and the prefabs never exist.
    expect(prompt).toContain("prefabPath");
    expect(prompt).toContain("keepInScene");
  });
});
