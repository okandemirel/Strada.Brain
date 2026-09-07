import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpriteGenerateTool , type LocalRunnerLike } from "./sprite-generate.js";
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

  it("sprite: a knowing 'procedural' is refused while a local model is installed — unless accepted", async () => {
    // Measured 2026-09-07 12:21: eight pig sprites regenerated procedurally
    // (335 → 170 bytes) with sd15 installed; the delivery gate then counted
    // them as placeholder art.
    const { ctx } = project();
    const tool = new SpriteGenerateTool({ localAvailable: () => true, runner: refusing });
    const refused = await tool.execute({ name: "Pig", provider: "procedural" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("placeholder-grade");
    expect(refused.content).toContain("acceptPlaceholder");
    const accepted = await tool.execute({ name: "Pig", provider: "procedural", acceptPlaceholder: true }, ctx);
    expect(accepted.isError).toBeFalsy();
  });

  it("mesh: a knowing 'procedural' is refused while a local model is installed", async () => {
    const { ctx } = project();
    const r = await new MeshGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig", shape: "sphere", provider: "procedural" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("acceptPlaceholder");
  });

  it("sprite: a batch draws every name through one runner call and reports each file", async () => {
    // Measured 2026-09-07: ~45-60 s per sprite plus a model load per call;
    // a GDD with 20 canvases × 10 areas is 200 round-trips one by one.
    const { root, ctx } = project();
    const batchCalls: number[] = [];
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "should not be used when batch exists" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string }>) => {
        batchCalls.push(jobs.length);
        const written = jobs.slice(0, 2).map((j) => { writeFileSync(j.out, "png-bytes"); return j.out; });
        return { ok: false, detail: "1 of 3 failed: cuda", written, missing: jobs.slice(2).map((j) => j.out) };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner }).execute(
      { batch: [{ name: "PigRed" }, { name: "PigBlue", prompt: "a blue pig" }, { name: "PigGold" }] },
      ctx,
    );
    expect(batchCalls).toEqual([3]);
    expect(runner.textToImage).not.toHaveBeenCalled();
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("2 of 3 sprites written");
    expect(r.content).toContain("✓ Assets/Art/Generated/PigRed.png");
    expect(r.content).toContain("✗ Assets/Art/Generated/PigGold.png");
    expect(existsSync(join(root, "Assets/Art/Generated/PigBlue.png.meta"))).toBe(true);
    expect(existsSync(join(root, "Assets/Art/Generated/PigGold.png.meta"))).toBe(false); // orphan meta removed
  });

  it("sprite: a batch over the limit is refused with the limit named", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing }).execute(
      { batch: Array.from({ length: 13 }, (_, i) => ({ name: `S${i}` })) },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("limit is 12");
  });

  it("sprite: an accepted explicit placeholder is honoured and carries no placeholder note", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing }).execute({ name: "Pig", provider: "procedural", acceptPlaceholder: true }, ctx);
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

describe("realLocalAvailability is a measurement, not a require() that cannot run", () => {
  // Measured 2026-09-07 14:50: an ESM package, a require() in a try/catch,
  // and "false" for a model that was installed — every sprint's sprites went
  // procedural and nothing said why.
  it("agrees with the catalog and the runner asked directly, in this ESM module", async () => {
    const { realLocalAvailability } = await import("./sprite-generate.js");
    const { defaultModelFor } = await import("../../../assets-local/model-catalog.js");
    const { LocalModelRunner } = await import("../../../assets-local/local-model-runner.js");
    const spec = defaultModelFor("text-to-image");
    const direct = spec !== undefined && new LocalModelRunner().isModelInstalled(spec.id);
    expect(realLocalAvailability()("text-to-image")).toBe(direct);
  });

  it("the module holds no require() call", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./sprite-generate.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\brequire\(/);
  });

  it("sprite: a procedural batch keeps every PLACEHOLDER note whole", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ batch: [{ name: "A" }, { name: "B" }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content.match(/PLACEHOLDER/g)).toHaveLength(2);
  });
});
