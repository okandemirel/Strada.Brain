/**
 * The play-through's runtime dump outranks the static scan (2026-09-10):
 * a world that code instantiates is invisible to the file scan and was
 * refused as "renders NOTHING".
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { assessBuiltAsSpecified } from "./built-as-specified.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}
/** An entry scene with a camera only, and one sprite asset nothing binds: the static refusal's strong case. */
function emptySceneProject(): string {
  const root = mkdtempSync(join(os.tmpdir(), "runtime-evidence-"));
  roots.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  put(root, "ProjectSettings/EditorBuildSettings.asset", "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  put(root, "Assets/Scenes/Main.unity", "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\nGameObject:\n  m_Name: Main Camera\n--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: 1\n", "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
  put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
  return root;
}

describe("runtime evidence and the static refusal", () => {
  it("the static scan refuses an empty scene; a play-through that saw real sprites at runtime withdraws it and says why", () => {
    const root = emptySceneProject();
    const cold = assessBuiltAsSpecified(root);
    expect(cold.refusal).toMatch(/render NOTHING/);
    const warm = assessBuiltAsSpecified(root, undefined, {
      runtime: { worldRenderers: 12, spriteRenderers: 12, meshRenderers: 0, sprites: ["pig_idle", "board_bg"], meshes: [], primitiveMeshes: 0, audioSources: 1, audioPlaying: 1 },
    });
    expect(warm.refusal).toBeUndefined();
    const text = warm.disclosures.join("\n");
    expect(text).toContain("At runtime (play-through of this sprint): 12 world renderer(s) — 12 sprite, 0 mesh; sprites bound: pig_idle, board_bg; 1 audio source(s), 1 playing.");
    expect(text).toContain("the play-through saw 12 at runtime binding 2 real sprite/mesh name(s) — the world is instantiated by code. The static refusal is withdrawn");
  });

  it("engine primitives at runtime do not withdraw the refusal", () => {
    const root = emptySceneProject();
    const r = assessBuiltAsSpecified(root, undefined, {
      runtime: { worldRenderers: 4, spriteRenderers: 0, meshRenderers: 4, sprites: [], meshes: ["Cube", "Sphere"], primitiveMeshes: 4, audioSources: 0, audioPlaying: 0 },
    });
    expect(r.refusal).toMatch(/render NOTHING/);
    expect(r.disclosures.join("\n")).toContain("4 world renderer(s) — 0 sprite, 4 mesh (4 engine primitives)");
  });
});
