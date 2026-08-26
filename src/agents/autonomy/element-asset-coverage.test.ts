/**
 * The per-element art-coverage gate.
 *
 * Measured 2026-08-26 (PixelFlow, user-reported): scenes kept shipping empty
 * even when prefab structures nominally existed, and no gate ever forced the
 * TARGET GAME'S OWN assets to exist — the unsourced gate only asks "did you
 * check what the user owns", and the nothing-drawn gate only looks at frames
 * globally. This test pins the gate that closes the gap: every element the
 * GDD schedules must have art, and that art must be bound into a prefab.
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

const GATE = "[STRADA ELEMENT ASSETS MISSING]";

const GDD = [
  "# Test Game GDD",
  "",
  "## 4.1 Element Schedule",
  "",
  "| Unlock | Element | Notes |",
  "| ------ | ------- | ----- |",
  "| L21 | Rocket | blasts a row |",
  "| L36 | Ice Block | freezes a cell |",
  "",
].join("\n");

/**
 * A project that satisfies every gate ordered BEFORE the coverage gate:
 * assembled (config asset + wired scene), tested (a real test assembly),
 * assets sourced (unity_my_assets called in the guard), no dangling refs.
 */
function assembledProject(): { root: string; codePath: string; configGuid: string } {
  const root = mkdtempSync(join(os.tmpdir(), "coverage-gate-"));
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });

  const codePath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(codePath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Board.asmdef"), JSON.stringify({ name: "Board" }));
  // A view layer, so the NOTHING RENDERS gate (earlier in the chain) is satisfied.
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

  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "GDD.md"), GDD);

  return { root, codePath, configGuid };
}

/** A sprite + meta with a known guid, under Assets/. */
function addSprite(root: string, name: string, guid: string): void {
  const art = join(root, "Assets", "Art", "Generated");
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, `${name}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(art, `${name}.png.meta`), `guid: ${guid}\n`);
}

/** A prefab that references the given guids. */
function addPrefab(root: string, guids: string[]): void {
  const prefabs = join(root, "Assets", "Prefabs");
  mkdirSync(prefabs, { recursive: true });
  writeFileSync(
    join(prefabs, "Board.prefab"),
    guids.map((g) => `  m_Sprite: {fileID: 21300000, guid: ${g}, type: 3}`).join("\n"),
  );
}

function guardFor(root: string): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  return guard;
}

/** Drive the guard to the phase where the coverage gate is allowed to speak. */
function runToPlayedPhase(guard: StradaConformanceGuard, codePath: string): void {
  guard.trackToolCall("file_write", { path: codePath }, false);
  guard.trackToolCall("unity_my_assets", { query: "rocket sprite" }, false);
  guard.trackToolCall("unity_playmode_verify", {}, false);
}

describe("element asset coverage", () => {
  it("fires when scheduled elements have no art at all, naming them", () => {
    const { root, codePath } = assembledProject();
    const guard = guardFor(root);
    runToPlayedPhase(guard, codePath);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain(GATE);
    expect(prompt).toContain("Rocket");
    expect(prompt).toContain("Ice Block");
    expect(prompt).toContain("unity_generate_sprite");
  });

  it("names elements whose art exists but is bound to nothing", () => {
    const { root, codePath } = assembledProject();
    const rocketGuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    addSprite(root, "Rocket", rocketGuid); // on disk, referenced by nothing
    const iceGuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    addSprite(root, "IceBlock", iceGuid);
    addPrefab(root, [iceGuid]); // only IceBlock is bound

    const guard = guardFor(root);
    runToPlayedPhase(guard, codePath);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain(GATE);
    expect(prompt).toContain("no prefab/asset/scene references");
    expect(prompt).toContain("Rocket");
    expect(prompt).not.toContain("Ice Block");
  });

  it("stays silent when every element has art bound into a prefab", () => {
    const { root, codePath } = assembledProject();
    const rocketGuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const iceGuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    addSprite(root, "Rocket", rocketGuid);
    addSprite(root, "IceBlock", iceGuid);
    addPrefab(root, [rocketGuid, iceGuid]);

    const guard = guardFor(root);
    runToPlayedPhase(guard, codePath);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("stays silent before the game has ever been run", () => {
    const { root, codePath } = assembledProject();
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: codePath }, false);
    // No unity_playmode_verify: mid-build, missing art is not yet a finding.

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("stays silent when the project has no element schedule", () => {
    const { root, codePath } = assembledProject();
    writeFileSync(join(root, "docs", "GDD.md"), "# Notes\n\nNo schedule table here.\n");
    const guard = guardFor(root);
    runToPlayedPhase(guard, codePath);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });
});
