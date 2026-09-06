import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpriteGenerateTool } from "./sprite-generate.js";
import { MeshGenerateTool } from "./mesh-generate.js";
import type { ToolContext } from "../tool.interface.js";

/**
 * Measured live 2026-09-03 03:38: the sprint called unity_generate_sprite with
 * shape "rounded-box" — a unity_generate_mesh word — got "unknown shape", and
 * never retried. One vocabulary slip cost the element its art, and the two
 * tools share one caller.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function project(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), "shape-vocab-"));
  dirs.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return { root, ctx: { projectPath: root, workingDirectory: root, readOnly: false } as ToolContext };
}

describe("the two generators forgive each other's vocabulary", () => {
  it("sprite: a mesh shape is drawn as its flat equivalent and says so", async () => {
    const { root, ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "rounded-box" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('drawn as sprite shape "rounded"');
    expect(String(r.content)).toContain("unity_generate_mesh");
    expect(existsSync(join(root, "Assets/Art/Generated/Pig.png"))).toBe(true);
  });

  it("sprite: a shape known to neither names the other tool", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "dodecahedron" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("unity_generate_mesh");
    expect(String(r.content)).toContain("square, rounded, circle");
  });

  it("mesh: a sprite shape is built as its nearest solid and says so", async () => {
    const { root, ctx } = project();
    const r = await new MeshGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "circle" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('built as mesh shape "sphere"');
    expect(String(r.content)).toContain("unity_generate_sprite");
    expect(existsSync(join(root, "Assets/Art/Generated/Meshes/Pig.obj"))).toBe(true);
  });

  it("mesh: a shape known to neither names the other tool", async () => {
    const { ctx } = project();
    const r = await new MeshGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "hexagon" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("unity_generate_sprite");
  });

  it("a native shape carries no note", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ name: "Pig", shape: "circle" }, ctx);
    expect(String(r.content)).not.toContain("Note:");
  });
});
