import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpriteGenerateTool, encodePng, SPRITE_SHAPES } from "./sprite-generate.js";
import type { ToolContext } from "../tool.interface.js";

function makeContext(projectPath: string, readOnly = false): ToolContext {
  return {
    projectPath,
    workingDirectory: projectPath,
    readOnly,
  } as ToolContext;
}

/** Read width/height back out of the PNG IHDR. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("encodePng", () => {
  it("produces a valid PNG with the right dimensions", () => {
    const size = 8;
    const rgba = new Uint8Array(size * size * 4).fill(255);
    const png = encodePng(size, size, rgba);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngSize(png)).toEqual({ width: 8, height: 8 });
    expect(png.includes(Buffer.from("IDAT"))).toBe(true);
    expect(png.includes(Buffer.from("IEND"))).toBe(true);
  });

  it("rejects a mismatched buffer", () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow(/mismatch/);
  });
});

describe("SpriteGenerateTool", () => {
  let dir: string;
  const tool = new SpriteGenerateTool({ localAvailable: () => false });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sprite-gen-"));
    mkdirSync(join(dir, "Assets"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a PNG and a sprite .meta under Assets/", async () => {
    const result = await tool.execute(
      { name: "Rocket", shape: "arrow", color: "#ff5500" },
      makeContext(dir),
    );
    expect(result.isError).toBeFalsy();

    const pngPath = join(dir, "Assets", "Art", "Generated", "Rocket.png");
    expect(existsSync(pngPath)).toBe(true);
    const png = readFileSync(pngPath);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(pngSize(png)).toEqual({ width: 64, height: 64 });

    const meta = readFileSync(`${pngPath}.meta`, "utf8");
    expect(meta).toContain("textureType: 8");
    expect(meta).toContain("spriteMode: 1");
    expect(meta).toMatch(/guid: [0-9a-f]{32}/);
  });

  it("is deterministic in shape/colour when only a name is given", async () => {
    const r1 = await tool.execute({ name: "FrozenPig" }, makeContext(dir));
    const png1 = readFileSync(join(dir, "Assets", "Art", "Generated", "FrozenPig.png"));
    const r2 = await tool.execute({ name: "FrozenPig" }, makeContext(dir));
    const png2 = readFileSync(join(dir, "Assets", "Art", "Generated", "FrozenPig.png"));
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    // Same name → same shape, same palette, byte-identical render.
    // (The .meta guid intentionally differs per write.)
    expect(png1.equals(png2)).toBe(true);
    expect(String(r1.content)).toContain("shape triangle");
  });

  it("refuses names that would escape or collide weirdly", async () => {
    for (const bad of ["../evil", "a/b", "", "1startsWithDigit", "sp ace"]) {
      const result = await tool.execute({ name: bad }, makeContext(dir));
      expect(result.isError, `name ${bad}`).toBe(true);
    }
  });

  it("refuses output outside Assets/", async () => {
    const result = await tool.execute({ name: "Rocket", path: "SomewhereElse" }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Assets");
  });

  it("honours read-only mode", async () => {
    const result = await tool.execute({ name: "Rocket" }, makeContext(dir, true));
    expect(result.isError).toBe(true);
  });

  it("clamps size and rejects bad colours", async () => {
    const tooBig = await tool.execute({ name: "Big", size: 4096 }, makeContext(dir));
    expect(tooBig.isError).toBeFalsy();
    const png = readFileSync(join(dir, "Assets", "Art", "Generated", "Big.png"));
    expect(pngSize(png).width).toBe(256);

    const badColor = await tool.execute({ name: "Bad", color: "red" }, makeContext(dir));
    expect(badColor.isError).toBe(true);
  });

  it("every shape renders some non-transparent pixels", async () => {
    for (const shape of SPRITE_SHAPES) {
      const name = `Shape_${shape}`;
      const result = await tool.execute({ name, shape, size: 32 }, makeContext(dir));
      expect(result.isError, shape).toBeFalsy();
      const png = readFileSync(join(dir, "Assets", "Art", "Generated", `${name}.png`));
      // A degenerate (all-transparent) render would deflate to a tiny file.
      expect(png.length, shape).toBeGreaterThan(120);
    }
  });

  it("accepts a custom output dir under Assets/", async () => {
    mkdirSync(join(dir, "Assets", "Modules", "BoardModule", "Sprites"), { recursive: true });
    // Pre-create the meta-less dir chain the way a module would.
    writeFileSync(join(dir, "Assets", "Modules", "BoardModule", "Sprites", "keep.txt"), "x");
    const result = await tool.execute(
      { name: "Pig_Red", path: "Assets/Modules/BoardModule/Sprites" },
      makeContext(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "Assets", "Modules", "BoardModule", "Sprites", "Pig_Red.png"))).toBe(true);
  });
});
