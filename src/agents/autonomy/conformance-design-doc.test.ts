/**
 * Which design document a campaign worker's conformance guard judges against.
 *
 * The guard found its document by itself: the largest markdown under docs/.
 * In a project whose docs/ holds another game's GDD, a text-only campaign's
 * workers were told "[STRADA SPEC SCOPE] … no implementation: Storm Boss"
 * and "[STRADA ELEMENT ASSETS MISSING]", and at the last ask to report the
 * game as partially delivered (review campaign-text-only P2). A campaign run
 * carries its own GDD text, or the word that it has none.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";
import { createAutonomyBundle } from "../orchestrator-autonomy-tracker.js";
import type { RunDesignDoc } from "./run-design-doc.js";

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

const ASSETS_GATE = "[STRADA ELEMENT ASSETS MISSING]";
const SCOPE_GATE = "[STRADA SPEC SCOPE]";

function schedule(title: string, rows: Array<[string, string]>): string {
  return [
    `# ${title}`,
    "",
    "## 4.1 Element Schedule",
    "",
    "| Unlock | Element | Notes |",
    "| ------ | ------- | ----- |",
    ...rows.map(([unlock, name]) => `| ${unlock} | ${name} | scheduled |`),
    "",
  ].join("\n");
}

/** Another game's design, the only (so the largest) markdown under docs/. */
const OTHER_GAME = schedule("Dungeon Game GDD", [["L5", "Storm Boss"], ["L9", "Lava Pit"]]);
const THIS_GAME = schedule("Puzzle Game GDD", [["L18", "Firefly"], ["L30", "Frost Tile"]]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Assembled, tested and sourced, so the schedule gates are the next to speak. */
function assembledProject(): { root: string; codePath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "design-doc-gate-"));
  roots.push(root);
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  const codePath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(codePath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Board.asmdef"), JSON.stringify({ name: "Board" }));
  writeFileSync(join(scripts, "BoardView.cs"), "public class BoardView : MonoBehaviour {}");
  const tests = join(moduleRoot, "Tests", "Runtime", "Board.Tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Board.Tests.asmdef"), JSON.stringify({ name: "Board.Tests" }));
  writeFileSync(join(tests, "BoardTest.cs"), "public class BoardTest { [Test] public void Boots() {} }");
  const configGuid = "0123456789abcdef0123456789abcdef";
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset.meta"), `guid: ${configGuid}\n`);
  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(
    join(scenes, "Main.unity"),
    `Camera:\n  m_Component: []\n--- !u!1 &1\nMonoBehaviour:\n  _gameConfig: {fileID: 11400000, guid: ${configGuid}, type: 2}`,
  );
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "GDD.md"), OTHER_GAME);
  return { root, codePath };
}

/** Art for every named element, bound into one prefab. */
function bindArt(root: string, names: string[]): void {
  const art = join(root, "Assets", "Art");
  const prefabs = join(root, "Assets", "Prefabs");
  mkdirSync(art, { recursive: true });
  mkdirSync(prefabs, { recursive: true });
  const guids = names.map((name, i) => {
    const guid = String(i + 1).repeat(32).slice(0, 32);
    writeFileSync(join(art, `${name}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(art, `${name}.png.meta`), `guid: ${guid}\n`);
    return guid;
  });
  writeFileSync(
    join(prefabs, "Board.prefab"),
    guids.map((g) => `  m_Sprite: {fileID: 21300000, guid: ${g}, type: 3}`).join("\n"),
  );
}

function playedGuard(root: string, codePath: string, designDoc?: RunDesignDoc): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, {
    projectPath: root,
    enabled: true,
    ...(designDoc ? { designDoc } : {}),
  });
  guard.trackToolCall("file_write", { path: codePath }, false);
  guard.trackToolCall("unity_my_assets_cloud", { query: "sprites" }, false);
  guard.trackToolCall("unity_playmode_verify", {}, false);
  return guard;
}

describe("a campaign run's conformance guard reads the campaign's GDD", () => {
  it("asks for art for the campaign's scheduled elements, not docs/'s", () => {
    const { root, codePath } = assembledProject();

    const prompt = playedGuard(root, codePath, { text: THIS_GAME }).getPrompt() ?? "";

    expect(prompt).toContain(ASSETS_GATE);
    expect(prompt).toContain("Firefly");
    expect(prompt).toContain("Frost Tile");
    expect(prompt).not.toContain("Storm Boss");
  });

  it("names the campaign's unimplemented elements in the spec-scope ask", () => {
    const { root, codePath } = assembledProject();
    bindArt(root, ["Firefly", "FrostTile"]); // art covered; no code mentions either

    const prompt = playedGuard(root, codePath, { text: THIS_GAME }).getPrompt() ?? "";

    expect(prompt).toContain(SCOPE_GATE);
    expect(prompt).toContain("Firefly (L18)");
    expect(prompt).not.toContain("Storm Boss");
  });

  it("holds a campaign with no GDD text to no document at all", () => {
    const { root, codePath } = assembledProject();

    const prompt = playedGuard(root, codePath, {}).getPrompt() ?? "";

    expect(prompt).not.toContain(ASSETS_GATE);
    expect(prompt).not.toContain(SCOPE_GATE);
    expect(prompt).not.toContain("Storm Boss");
  });

  it("still finds the project's own GDD for a run that serves no campaign", () => {
    const { root, codePath } = assembledProject();

    const prompt = playedGuard(root, codePath).getPrompt() ?? "";

    expect(prompt).toContain(ASSETS_GATE);
    expect(prompt).toContain("Storm Boss");
  });

  it("reaches the guard through the run's autonomy bundle", () => {
    const { root, codePath } = assembledProject();
    const { stradaConformance } = createAutonomyBundle({
      prompt: "build the next sprint",
      iterationBudget: 10,
      stradaDeps: deps,
      projectPath: root,
      designDoc: { text: THIS_GAME },
    });
    stradaConformance.trackToolCall("file_write", { path: codePath }, false);
    stradaConformance.trackToolCall("unity_my_assets_cloud", { query: "sprites" }, false);
    stradaConformance.trackToolCall("unity_playmode_verify", {}, false);

    const prompt = stradaConformance.getPrompt() ?? "";
    expect(prompt).toContain("Firefly");
    expect(prompt).not.toContain("Storm Boss");
  });
});

/**
 * The two production lines with no seam to drive short of booting the daemon
 * (the executor's half is run in background-executor.test.ts). Each row says
 * what breaks if its line goes missing: the guard falls back to discovering
 * docs/'s largest markdown for every campaign run.
 */
describe("production wiring: a campaign run's guard is given its GDD (tripwire)", () => {
  const source = (path: string): string => readFileSync(path, "utf8");

  it("the engine setup hands the run's design document to the bundle", () => {
    const setup = source("src/agent-core/engine/setup.ts");
    const bundle = setup.slice(setup.indexOf("const bundle = createAutonomyBundle({"));
    expect(bundle.slice(0, bundle.indexOf("});"))).toContain("designDoc: currentRunDesignDoc(),");
  });

  it("the runtime stage tells the executor where a campaign's GDD is", () => {
    expect(source("src/core/bootstrap-stages/stage-runtime.ts")).toContain(
      "backgroundExecutor.setCampaignDesignDocs((campaignId) => designDocs.designDocOf(campaignId));",
    );
  });
});
