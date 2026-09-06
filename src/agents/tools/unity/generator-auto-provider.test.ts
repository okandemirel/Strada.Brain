import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpriteGenerateTool } from "./sprite-generate.js";
import { MeshGenerateTool } from "./mesh-generate.js";
import type { ToolContext } from "../tool.interface.js";

/**
 * Measured 2026-09-06: sd15 and TripoSR were installed (6.7 GB of weights
 * under ~/.strada/assets-local) and across a whole campaign `provider:
 * "local"` was requested zero times. Every sprite the game shipped was a
 * procedural blob — "Pig.png" is a red circle with two white squares —
 * because "procedural" was the default and nothing told the sprint otherwise.
 */
/** A runner that is "installed" but refuses to draw — exercises the local branch without a model. */
const refusing = {
  isModelInstalled: () => true,
  textToImage: async () => ({ ok: false, detail: "stub: model refused" }),
  imageToMesh: async () => ({ ok: false, detail: "stub: model refused" }),
} as never;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function project(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), "auto-provider-"));
  dirs.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return { root, ctx: { projectPath: root, workingDirectory: root, readOnly: false } as ToolContext };
}

describe("the installed model is the default; the placeholder is the fallback", () => {
  it("sprite: with a local model available, AUTO goes local — and falls back WITH a note when that fails", async () => {
    // localAvailable says yes and the stub runner refuses to draw, so the
    // local branch errors and the fallback is exercised without a model.
    const { root, ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(root, "Assets/Art/Generated/Pig.png"))).toBe(true);
    expect(String(r.content)).toContain("PLACEHOLDER");
    expect(String(r.content)).toContain("local model failed");
  });

  it("sprite: with nothing installed, AUTO is procedural and SAYS it is a placeholder", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ name: "Pig" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("PLACEHOLDER: no local text-to-image model is installed");
  });

  it("sprite: an explicit provider is honoured and carries no placeholder note", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig", provider: "procedural" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).not.toContain("PLACEHOLDER");
  });

  it("sprite: explicit local does NOT silently fall back", async () => {
    const { root, ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig", provider: "local" }, ctx);
    expect(r.isError).toBe(true);
    expect(existsSync(join(root, "Assets/Art/Generated/Pig.png"))).toBe(false);
  });

  it("mesh: AUTO with a local model falls back WITH a note when it fails", async () => {
    const { root, ctx } = project();
    const r = await new MeshGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig", shape: "sphere" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(root, "Assets/Art/Generated/Meshes/Pig.obj"))).toBe(true);
    expect(String(r.content)).toContain("PLACEHOLDER");
  });

  it("mesh: AUTO with nothing installed says it is a placeholder", async () => {
    const { ctx } = project();
    const r = await new MeshGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "sphere" }, ctx);
    expect(String(r.content)).toContain("PLACEHOLDER: no local image-to-3D model is installed");
  });
});
