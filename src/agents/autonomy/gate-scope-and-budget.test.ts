/**
 * AUT-4 (audited 2026-09-24): conformance gates with no ask budget judged
 * vendor and untouched files, and read C# comments as code. Each of these
 * returned the same gate on every call, so a run that could not clear it
 * (a vendor plugin, a registry package, an untouched legacy file) looped
 * until loop recovery blocked it.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";
import { declaresCsTest, isVendorPath, stripCsComments } from "./csharp-source.js";
import { assessViewLayer } from "./scene-wiring.js";

const deps = {
  coreInstalled: true, corePath: "/core", modulesInstalled: true, modulesPath: "/modules",
  mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
} as const;

/**
 * A complete, assembled, rendering module, so only the rule under test can
 * object. Returns the paths a test writes into.
 */
function project(): { root: string; scripts: string; moduleRoot: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), "gate-scope-"));
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, "BoardModuleConfig.cs");
  writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Board.asmdef"), '{"name":"Game.Board"}');
  writeFileSync(join(scripts, "CubeView.cs"), "public class CubeView : MonoBehaviour {}");
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");
  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Board.Tests.asmdef"), '{"name":"Game.Board.Tests"}');
  writeFileSync(join(tests, "BoardTests.cs"), "public class T { [Test] public void A() { } }");
  const prefabs = join(moduleRoot, "Prefabs");
  mkdirSync(prefabs, { recursive: true });
  writeFileSync(join(prefabs, "Cube.prefab"), "GameObject:");
  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(
    join(scenes, "Main.unity"),
    "Camera:\n  m_Enabled: 1\nGameBootstrapper:\n  _gameConfig: {fileID: 11400000, guid: abc}",
  );
  return { root, scripts, moduleRoot, configPath };
}

function guardFor(root: string): StradaConformanceGuard {
  return new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
}

describe("C# is read through one comment-aware reader", () => {
  it("finds a test in an attribute list and not in a comment or a string", () => {
    expect(declaresCsTest("[Timeout(1000), Test] public void A() {}")).toBe(true);
    expect(declaresCsTest('[Category("x"), Test] public void A() {}')).toBe(true);
    expect(declaresCsTest("[TestCase(new[] { 1, 2 })] public void A(int[] x) {}")).toBe(true);
    expect(declaresCsTest("[NUnit.Framework.TestAttribute] public void A() {}")).toBe(true);
    expect(declaresCsTest("// [Test] public void A() {}")).toBe(false);
    expect(declaresCsTest("/* [UnityTest] */ public void A() {}")).toBe(false);
    expect(declaresCsTest('var s = "[Test]"; [TestFixture] class F {}')).toBe(false);
  });

  it("ends interpolated and verbatim strings where C# ends them", () => {
    const source = [
      'var a = $"{(ok ? "x" : "y")} // not a comment";',
      'var b = @$"C:\\path\\"" // still a string";',
      "var c = '\"'; // a comment",
      "class Kept {}",
    ].join("\n");
    const stripped = stripCsComments(source);
    expect(stripped).toContain("// not a comment");
    expect(stripped).toContain("// still a string");
    expect(stripped).not.toContain("a comment\n");
    expect(stripped).toContain("class Kept");
  });

  it("treats Assets/Plugins and packages as vendor code, and nothing else under Assets", () => {
    expect(isVendorPath("Assets/Plugins/Vendor/Modules/Net/Scripts/A.cs")).toBe(true);
    expect(isVendorPath("C:\\Game\\Library\\PackageCache\\com.unity.ugui\\X.cs")).toBe(true);
    expect(isVendorPath("/p/Packages/com.vendor.tool/Runtime/A.cs")).toBe(true);
    expect(isVendorPath("Assets/Game/Packages/Offer.cs")).toBe(false);
    expect(isVendorPath("Assets/Modules/Board/Scripts/A.cs")).toBe(false);
  });
});

describe("gates judge the run's own work (AUT-4)", () => {
  it("a test declared beside another attribute is a test; a commented-out one is not", () => {
    const withTimeout = project();
    writeFileSync(
      join(withTimeout.moduleRoot, "Tests", "Runtime", "BoardTests.cs"),
      "public class T { [Timeout(1000), Test] public void A() { } }",
    );
    const guard = guardFor(withTimeout.root);
    guard.trackToolCall("file_write", { path: withTimeout.configPath }, false);
    expect(guard.getPrompt() ?? "").not.toContain("[STRADA TEST ASSEMBLY EMPTY]");

    const commented = project();
    writeFileSync(
      join(commented.moduleRoot, "Tests", "Runtime", "BoardTests.cs"),
      "public class T { // [Test]\n public void A() { } }",
    );
    const other = guardFor(commented.root);
    other.trackToolCall("file_write", { path: commented.configPath }, false);
    expect(other.getPrompt() ?? "").toContain("[STRADA TEST ASSEMBLY EMPTY]");
  });

  it("a vendor plugin's logging is not the run's reimplementation", () => {
    const { root, configPath } = project();
    const plugin = join(root, "Assets", "Plugins", "Vendor");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "VendorNet.cs"), Array.from({ length: 12 }, (_, i) => `Debug.Log("v${i}");`).join("\n"));
    const guard = guardFor(root);
    guard.trackToolCall("file_edit", { path: configPath }, false);
    expect(guard.getPrompt() ?? "").not.toContain("[STRADA REIMPLEMENTED]");
  });

  it("an untouched legacy file's logging is not the run's reimplementation either", () => {
    const { root, scripts, configPath } = project();
    writeFileSync(join(scripts, "Legacy.cs"), Array.from({ length: 12 }, (_, i) => `Debug.Log("l${i}");`).join("\n"));
    const guard = guardFor(root);
    guard.trackToolCall("file_edit", { path: configPath }, false);
    expect(guard.getPrompt() ?? "").not.toContain("[STRADA REIMPLEMENTED]");
  });

  it("a comment naming StradaLog does not excuse logging the run wrote", () => {
    const { root, scripts, configPath } = project();
    const mine = join(scripts, "BoardLogger.cs");
    writeFileSync(
      mine,
      "// TODO: switch to StradaLog\n" + Array.from({ length: 12 }, (_, i) => `Debug.Log("m${i}");`).join("\n"),
    );
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);
    guard.trackToolCall("file_write", { path: mine }, false);
    expect(guard.getPrompt() ?? "").toContain("[STRADA REIMPLEMENTED]");
  });

  it("an untouched long file is not named; a long file the run wrote is", () => {
    const { root, scripts, configPath } = project();
    const legacy = join(scripts, "Legacy.cs");
    writeFileSync(legacy, "// legacy\n".repeat(261));
    const untouched = guardFor(root);
    untouched.trackToolCall("file_edit", { path: configPath }, false);
    expect(untouched.getPrompt() ?? "").not.toContain("[STRADA FILE TOO LONG]");

    const wrote = guardFor(root);
    wrote.trackToolCall("file_edit", { path: legacy }, false);
    expect(wrote.getPrompt() ?? "").toContain("[STRADA FILE TOO LONG]");
  });

  it("a vendor path shaped like a module is not an incomplete module", () => {
    const { root } = project();
    const vendor = join(root, "Assets", "Plugins", "Vendor", "Modules", "Net", "Scripts");
    mkdirSync(vendor, { recursive: true });
    const file = join(vendor, "NetClient.cs");
    writeFileSync(file, "public class NetClient {}");
    const guard = guardFor(root);
    guard.trackToolCall("file_edit", { path: file }, false);
    expect(guard.getPrompt() ?? "").not.toContain("[STRADA MODULE INCOMPLETE]");
  });

  it("a reference into an uncached registry package is not called dangling", () => {
    const { root, moduleRoot, configPath } = project();
    mkdirSync(join(root, "Packages"), { recursive: true });
    writeFileSync(
      join(root, "Packages", "manifest.json"),
      JSON.stringify({ dependencies: { "com.unity.textmeshpro": "3.0.6" } }),
    );
    writeFileSync(join(moduleRoot, "BoardModuleConfig.asset.meta"), "guid: a3f1c9d84e2b47e6b0d5c8a1976f3210\n");
    writeFileSync(
      join(moduleRoot, "Hud.asset"),
      "%YAML 1.1\n  _font: {fileID: 11400000, guid: 8f586378b4e144a9851e7b34d9b748ee, type: 2}\n",
    );
    const guard = guardFor(root);
    guard.trackToolCall("file_write", { path: configPath }, false);
    expect(guard.getPrompt() ?? "").not.toContain("[STRADA REFERENCE DANGLING]");

    // With the package cache on disk, its guids are known.
    const cached = join(root, "Library", "PackageCache", "com.unity.textmeshpro@3.0.6", "Fonts");
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, "LiberationSans SDF.asset.meta"), "guid: 8f586378b4e144a9851e7b34d9b748ee\n");
    const again = guardFor(root);
    again.trackToolCall("file_write", { path: configPath }, false);
    expect(again.getPrompt() ?? "").not.toContain("[STRADA REFERENCE DANGLING]");
  });

  it("a scene whose camera is a prefab instance has a camera", () => {
    const { root, moduleRoot } = project();
    const cameraPrefab = join(moduleRoot, "Prefabs", "MainCamera.prefab");
    writeFileSync(cameraPrefab, "GameObject:\n  m_Name: Main Camera\n--- !u!20 &2\nCamera:\n  m_Enabled: 1\n");
    writeFileSync(`${cameraPrefab}.meta`, "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n");
    writeFileSync(
      join(root, "Assets", "Scenes", "Level.unity"),
      "PrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n",
    );
    writeFileSync(join(root, "Assets", "Scenes", "Empty.unity"), "GameObject:\n  m_Name: Nothing\n");
    expect(assessViewLayer(root)?.camerslessScenes).toEqual(["Empty.unity"]);
  });
});

describe("every conformance gate can give up (AUT-4)", () => {
  it("asks three times across turns, says the last is the last, then lets the run end", () => {
    const { root } = project();
    // A module directory the run wrote into and cannot complete.
    const orphan = join(root, "Assets", "Modules", "Combat", "Scripts");
    mkdirSync(orphan, { recursive: true });
    const file = join(orphan, "CombatService.cs");
    writeFileSync(file, "public class CombatService {}");
    const guard = guardFor(root);

    const prompts: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      guard.trackToolCall("file_edit", { path: file }, false);
      prompts.push(guard.getPrompt() ?? "");
    }
    const asked = prompts.filter((p) => p.includes("[STRADA MODULE INCOMPLETE]"));
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain("last time this is asked");
    expect(asked[0]).not.toContain("last time this is asked");
    // Re-reading the gate within one turn does not spend the budget.
    const fresh = guardFor(root);
    fresh.trackToolCall("file_edit", { path: file }, false);
    for (let i = 0; i < 5; i++) expect(fresh.getPrompt()).toContain("[STRADA MODULE INCOMPLETE]");
  });
});
