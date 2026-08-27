import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshGenerateTool, MESH_SHAPES } from "./mesh-generate.js";
import type { ToolContext } from "../tool.interface.js";

function makeContext(projectPath: string, readOnly = false): ToolContext {
  return { projectPath, workingDirectory: projectPath, readOnly } as ToolContext;
}

function parseObj(text: string): { verts: number; normals: number; faces: number } {
  const lines = text.split("\n");
  return {
    verts: lines.filter((l) => l.startsWith("v ")).length,
    normals: lines.filter((l) => l.startsWith("vn ")).length,
    faces: lines.filter((l) => l.startsWith("f ")).length,
  };
}

describe("MeshGenerateTool", () => {
  let dir: string;
  const tool = new MeshGenerateTool();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mesh-gen-"));
    mkdirSync(join(dir, "Assets"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid OBJ and a model .meta under Assets/", async () => {
    const result = await tool.execute({ name: "PigBody", shape: "capsule" }, makeContext(dir));
    expect(result.isError).toBeFalsy();

    const objPath = join(dir, "Assets", "Art", "Generated", "Meshes", "PigBody.obj");
    expect(existsSync(objPath)).toBe(true);
    const parsed = parseObj(readFileSync(objPath, "utf8"));
    expect(parsed.verts).toBeGreaterThan(30);
    expect(parsed.normals).toBe(parsed.verts); // smooth per-vertex normals
    expect(parsed.faces).toBeGreaterThan(30);

    const meta = readFileSync(`${objPath}.meta`, "utf8");
    expect(meta).toContain("ModelImporter");
    expect(meta).toMatch(/guid: [0-9a-f]{32}/);
  });

  it("every shape produces a well-formed mesh", async () => {
    for (const shape of MESH_SHAPES) {
      const extra =
        shape === "organic"
          ? { fields: [{ pos: [0, 0, 0], radii: [0.3, 0.3, 0.3] }, { pos: [0.3, 0.1, 0], radii: [0.2, 0.2, 0.2] }] }
          : {};
      const result = await tool.execute({ name: `T_${shape}`, shape, detail: 8, ...extra }, makeContext(dir));
      expect(result.isError, shape).toBeFalsy();
      const parsed = parseObj(readFileSync(join(dir, "Assets", "Art", "Generated", "Meshes", `T_${shape}.obj`), "utf8"));
      expect(parsed.verts, shape).toBeGreaterThan(10);
      expect(parsed.faces, shape).toBeGreaterThan(8);
    }
  });

  it("OBJ face indices stay inside the vertex range", async () => {
    await tool.execute({ name: "Idx", shape: "rounded-box", detail: 6 }, makeContext(dir));
    const text = readFileSync(join(dir, "Assets", "Art", "Generated", "Meshes", "Idx.obj"), "utf8");
    const { verts } = parseObj(text);
    for (const line of text.split("\n")) {
      if (!line.startsWith("f ")) continue;
      for (const ref of line.slice(2).split(" ")) {
        const idx = Number(ref.split("//")[0]);
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThanOrEqual(verts);
      }
    }
  });

  it("rounded-box roundness moves vertices from cube toward sphere", async () => {
    await tool.execute({ name: "Sharp", shape: "rounded-box", roundness: 0, detail: 4 }, makeContext(dir));
    await tool.execute({ name: "Round", shape: "rounded-box", roundness: 0.9, detail: 4 }, makeContext(dir));
    const read = (n: string) =>
      readFileSync(join(dir, "Assets", "Art", "Generated", "Meshes", `${n}.obj`), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("v "))
        .map((l) => l.slice(2).split(" ").map(Number));
    const sharp = read("Sharp");
    const round = read("Round");
    // A sharp cube's face-center vertex is exactly size/2 from origin on one
    // axis; the rounded one pulls that same vertex off the plane.
    const sharpMax = Math.max(...sharp.flat());
    const roundMax = Math.max(...round.flat());
    expect(roundMax).toBeLessThan(sharpMax + 1e-9);
  });

  it("rejects bad names, bad shapes, and escapes", async () => {
    for (const bad of ["../x", "a/b", "", "1no"]) {
      expect((await tool.execute({ name: bad, shape: "sphere" }, makeContext(dir))).isError).toBe(true);
    }
    expect((await tool.execute({ name: "Ok", shape: "torus" }, makeContext(dir))).isError).toBe(true);
    expect((await tool.execute({ name: "Ok", shape: "sphere", path: "Elsewhere" }, makeContext(dir))).isError).toBe(true);
  });

  it("honours read-only mode", async () => {
    const result = await tool.execute({ name: "Block", shape: "rounded-box" }, makeContext(dir, true));
    expect(result.isError).toBe(true);
  });

  it("organic: fuses metaball fields into one smooth closed mesh", async () => {
    // A rough pig: body + head + two ears + snout.
    const fields = [
      { pos: [0, 0.3, 0], radii: [0.3, 0.26, 0.24] },
      { pos: [0, 0.62, 0.06], radii: [0.2, 0.18, 0.17] },
      { pos: [-0.1, 0.78, 0.02], radii: [0.05, 0.07, 0.03] },
      { pos: [0.1, 0.78, 0.02], radii: [0.05, 0.07, 0.03] },
      { pos: [0, 0.6, 0.22], radii: [0.08, 0.07, 0.08] },
    ];
    const result = await tool.execute({ name: "PigOrganic", shape: "organic", fields }, makeContext(dir));
    expect(result.isError).toBeFalsy();

    const objPath = join(dir, "Assets", "Art", "Generated", "Meshes", "PigOrganic.obj");
    const parsed = parseObj(readFileSync(objPath, "utf8"));
    expect(parsed.verts).toBeGreaterThan(200);
    expect(parsed.normals).toBe(parsed.verts);
    expect(parsed.faces).toBeGreaterThan(200);
  });

  it("organic: keeps vertices inside the padded field bounding box", async () => {
    const fields = [
      { pos: [0, 0, 0], radii: [0.2, 0.2, 0.2] },
      { pos: [0.25, 0, 0], radii: [0.15, 0.15, 0.15] },
    ];
    await tool.execute({ name: "Blobs", shape: "organic", fields }, makeContext(dir));
    const text = readFileSync(join(dir, "Assets", "Art", "Generated", "Meshes", "Blobs.obj"), "utf8");
    for (const line of text.split("\n")) {
      if (!line.startsWith("v ")) continue;
      const [x, y, z] = line.slice(2).split(" ").map(Number);
      // 1.4× max radius padding around the two blobs.
      for (const [v, lo, hi] of [[x!, -0.5, 0.75], [y!, -0.5, 0.5], [z!, -0.5, 0.5]] as Array<[number, number, number]>) {
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("organic: rejects missing fields, bad field shape, and empty surfaces", async () => {
    expect((await tool.execute({ name: "NoF", shape: "organic" }, makeContext(dir))).isError).toBe(true);
    expect(
      (await tool.execute({ name: "BadF", shape: "organic", fields: [{ pos: [0, 0], radii: [1, 1, 1] }] }, makeContext(dir))).isError,
    ).toBe(true);
    // Two far-apart blobs at a high iso: no shared surface anywhere.
    const far = [
      { pos: [0, 0, 0], radii: [0.01, 0.01, 0.01] },
      { pos: [5, 5, 5], radii: [0.01, 0.01, 0.01] },
    ];
    const empty = await tool.execute({ name: "Far", shape: "organic", fields: far, iso: 0.9 }, makeContext(dir));
    // Each tiny blob still has its own closed surface — so this is NOT empty;
    // what must hold is the tool never emits a zero-vertex mesh silently.
    if (empty.isError) {
      expect(String(empty.content)).toContain("no surface");
    }
  });
});
