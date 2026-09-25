/**
 * AUT-15: getPrompt() swept Assets/ synchronously, on the event loop that
 * serves every channel, and repeated the sweeps it had just done — the prefab
 * rule read every .asset in the project once PER config script it judged.
 *
 * The census is now taken once per generation (no tool call in between), the
 * .asset guid census is shared by every config, and prepare() does the reading
 * with fs.promises before getPrompt() runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const CONFIGS = 4;
const PACK_ASSETS = 150;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A wired module with CONFIGS prefab configs nothing instantiates, beside an asset pack. */
function project(): { root: string; configs: string[] } {
  const root = mkdtempSync(join(os.tmpdir(), "conformance-census-"));
  roots.push(root);
  const moduleRoot = join(root, "Assets", "Modules", "RenderingModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "RenderingModuleConfig.cs"), "public class RenderingModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Modules.Rendering.asmdef"), '{"name":"Game.Modules.Rendering"}');
  writeFileSync(join(moduleRoot, "RenderingModuleConfig.asset"), "%YAML 1.1");
  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Modules.Rendering.Tests.asmdef"), '{"name":"Game.Modules.Rendering.Tests"}');
  writeFileSync(join(tests, "RenderingTests.cs"), "[Test] public void It() {}");

  const configs: string[] = [];
  for (let i = 0; i < CONFIGS; i++) {
    const path = join(scripts, `PrefabsConfig${i}.cs`);
    writeFileSync(
      path,
      `public class PrefabsConfig${i} : ScriptableObject {\n    [SerializeField] private GameObject _prefab;\n}`,
    );
    writeFileSync(`${path}.meta`, `fileFormatVersion: 2\nguid: ${String(i + 1).padStart(32, "a")}\n`);
    configs.push(path);
  }
  const pack = join(root, "Assets", "Pack");
  mkdirSync(pack, { recursive: true });
  for (let i = 0; i < PACK_ASSETS; i++) {
    writeFileSync(join(pack, `Data${i}.asset`), `%YAML 1.1\n  m_Name: Data${i}\n`);
    writeFileSync(join(pack, `Data${i}.asset.meta`), `guid: ${String(i).padStart(32, "b")}\n`);
  }
  mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
  writeFileSync(join(root, "Assets", "Scenes", "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  return { root, configs };
}

function guardFor(root: string, configs: readonly string[]): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  for (const config of configs) guard.trackToolCall("file_write", { path: config }, false);
  return guard;
}

/** Synchronous reads of files with this extension since the last reset. */
function syncReads(ext: string): number {
  return vi.mocked(readFileSync).mock.calls.filter(([file]) => String(file).endsWith(ext)).length;
}

describe("the conformance census (AUT-15)", () => {
  it("reads each .asset once per draft, not once per config it judges", () => {
    const { root, configs } = project();
    const guard = guardFor(root, configs);
    vi.mocked(readFileSync).mockClear();

    const prompt = guard.getPrompt();

    expect(prompt).toContain("[STRADA PREFABS UNBOUND]");
    for (let i = 0; i < CONFIGS; i++) expect(prompt).toContain(`PrefabsConfig${i}`);
    // The pack's assets, the module's config asset, and its own dangling check.
    expect(syncReads(".asset")).toBeLessThanOrEqual(PACK_ASSETS + 3);
  });

  it("measures nothing again until a tool has run", () => {
    const { root, configs } = project();
    const guard = guardFor(root, configs);
    const first = guard.getPrompt();
    const unmet = guard.unmetDeliveryConditions();
    vi.mocked(readFileSync).mockClear();

    // The same draft asked again, and the delivery check after it: no disk.
    expect(guard.getPrompt()).toBe(first);
    expect(guard.unmetDeliveryConditions()).toEqual(unmet);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();

    // A tool call is a new generation: the project may have changed.
    writeFileSync(
      join(root, "Assets", "Modules", "RenderingModule", "Prefabs0.asset"),
      `%YAML 1.1\n  m_Script: {fileID: 11500000, guid: ${String(1).padStart(32, "a")}, type: 3}\n`,
    );
    guard.trackToolCall("file_write", { path: "Assets/Modules/RenderingModule/Prefabs0.asset" }, false);
    const after = guard.getPrompt() ?? "";
    expect(syncReads(".asset")).toBeGreaterThan(0);
    expect(after).not.toContain("PrefabsConfig0 ");
    expect(after).toContain("PrefabsConfig1");
  });

  it("does the reading in prepare(), off the event loop, and getPrompt() then reads no sidecar or asset", async () => {
    const { root, configs } = project();
    const expected = guardFor(root, configs).getPrompt();
    const guard = guardFor(root, configs);

    let ticks = 0;
    let running = true;
    const beat = (): void => {
      if (!running) return;
      ticks++;
      setImmediate(beat);
    };
    setImmediate(beat);
    await guard.prepare();
    running = false;
    expect(ticks).toBeGreaterThan(20);

    vi.mocked(readFileSync).mockClear();
    expect(guard.getPrompt()).toBe(expected);
    expect(syncReads(".asset")).toBeLessThanOrEqual(1); // the module's own asset, read by the dangling check
    expect(syncReads(".meta")).toBe(CONFIGS); // each config's own guid
  });
});
