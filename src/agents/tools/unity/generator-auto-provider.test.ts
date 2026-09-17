import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
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

/** A real RGBA PNG: "noise" is drawn art, "flat" a placeholder square, "specks" a cut-out that removed the subject. */
function pngFixture(kind: "noise" | "flat" | "specks", size = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let seed = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (kind === "noise") { raw[o] = seed & 0xff; raw[o + 1] = (seed >> 8) & 0xff; raw[o + 2] = (seed >> 16) & 0xff; raw[o + 3] = 255; }
      else if (kind === "flat") { raw[o] = 200; raw[o + 1] = 40; raw[o + 2] = 40; raw[o + 3] = 255; }
      else { const on = (seed >> 9) % 100 === 0; raw[o] = seed & 0xff; raw[o + 1] = (seed >> 8) & 0xff; raw[o + 2] = (seed >> 16) & 0xff; raw[o + 3] = on ? 255 : 0; }
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function project(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), "auto-provider-"));
  dirs.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return { root, ctx: { projectPath: root, workingDirectory: root, readOnly: false } as ToolContext };
}

const STUB_SPEC = { id: "sd15", kind: "text-to-image", label: "stub sd15", weightsRef: "stub", installMethod: "hub" } as never;
const specFor = () => STUB_SPEC;

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
        // Distinct artwork per subject; identical images are a defect of
        // their own (Codex 2026-09-11 N#10).
        const written = jobs.slice(0, 2).map((j, i) => { writeFileSync(j.out, pngFixture("noise", 64 + i)); return j.out; });
        return { ok: false, detail: "1 of 3 failed: cuda", written, missing: jobs.slice(2).map((j) => j.out) };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute(
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

  it("sprite: a blank draw is retried once with another seed, and reported ✗ when still blank", async () => {
    // Measured 2026-09-07 15:02: rembg wiped a green pig off its green
    // background — 19 KB of alpha specks reported as ✓.
    const { root, ctx } = project();
    // A flat square reads as blank; drawn noise is real.
    const blank = (out: string) => writeFileSync(out, pngFixture("flat"));
    const real = (out: string) => writeFileSync(out, pngFixture("noise"));
    let calls = 0;
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "unused" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string; seed?: number }>) => {
        calls++;
        for (const j of jobs) {
          // Retry (a seed is set) succeeds for PigA, PigB stays blank forever.
          if (j.seed !== undefined && j.out.endsWith("PigA.png")) real(j.out);
          else if (j.out.endsWith("PigA.png")) blank(j.out);
          else blank(j.out);
        }
        return { ok: true, detail: `${jobs.length} written`, written: jobs.map((j) => j.out), missing: [], keptBackground: [] };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute({ batch: [{ name: "PigA" }, { name: "PigB" }] }, ctx);
    expect(calls).toBe(2); // one batch, one retry of the blanks
    expect(r.content).toContain("✓ Assets/Art/Generated/PigA.png");
    expect(r.content).toContain("✗ Assets/Art/Generated/PigB.png — drew nothing usable twice");
    expect(existsSync(join(root, "Assets/Art/Generated/PigB.png"))).toBe(false);
    expect(existsSync(join(root, "Assets/Art/Generated/PigB.png.meta"))).toBe(false);
  });

  it("sprite: a kept background is said, not hidden", async () => {
    const { ctx } = project();
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "unused" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string }>) => {
        for (const j of jobs) writeFileSync(j.out, pngFixture("noise"));
        return { ok: true, detail: "1 written", written: jobs.map((j) => j.out), missing: [], keptBackground: [jobs[0]!.out] };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute({ batch: [{ name: "Pig" }] }, ctx);
    expect(r.content).toContain("background KEPT");
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
    // Inverted 2026-09-17 (audit A2 / D54): the expectation used to be
    // computed through defaultModelFor — the smallest model — which is the
    // defect itself. The measurement is "any supported model is installed".
    const { realLocalAvailability } = await import("./sprite-generate.js");
    const { installedModelFor } = await import("../../../assets-local/model-catalog.js");
    const { LocalModelRunner } = await import("../../../assets-local/local-model-runner.js");
    const runner = new LocalModelRunner();
    const spec = installedModelFor("text-to-image", (id) => runner.isModelInstalled(id));
    const direct = spec !== undefined && runner.isModelInstalled(spec.id);
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

describe("styleNotesForPrompt keeps the look and drops the report", () => {
  it("cuts at the first | and drops verification/config sentences", async () => {
    const { styleNotesForPrompt } = await import("./sprite-generate.js");
    const notes =
      "Use crisp flat pixel-art canvases against softly rendered dimensional stages, with thick friendly outlines, and plump glossy pigs. " +
      "| verification: visual assets for areas integrated into PresentationModule config and prefab references verified.";
    const out = styleNotesForPrompt(notes);
    expect(out).toContain("plump glossy pigs");
    expect(out).not.toMatch(/verif|config|prefab/i);
  });

  it("the default prompt handed to the runner carries no verification note", async () => {
    const { root, ctx } = project();
    writeFileSync(
      join(root, "style.json"),
      JSON.stringify({
        family: "toon-casual",
        pipeline: "realtime-3d",
        palette: ["#e4574c"],
        outline: { width: 2, color: "#3a2a2a" },
        shading: "flat",
        references: [],
        notes: "warm toy-like palette. | verification: prefab references verified.",
      }),
    );
    const prompts: string[] = [];
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async (_s: unknown, prompt: string, out: string) => {
        prompts.push(prompt);
        const b = Buffer.alloc(9000, 7); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(64, 16); b.writeUInt32BE(64, 20); writeFileSync(out, b);
        return { ok: true, detail: out };
      }),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
    } as unknown as LocalRunnerLike;
    await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute({ name: "Pig" }, ctx);
    expect(prompts[0]).toContain("warm toy-like palette");
    expect(prompts[0]).not.toMatch(/verif|prefab/i);
  });
});

describe("defects the generator review found (2026-09-07)", () => {
  const drawer = (draw: (out: string) => void, ok = true) => ({
    isModelInstalled: () => true,
    imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
    textToImage: vi.fn(async (_s: unknown, _p: string, out: string) => { if (ok) draw(out); return ok ? { ok: true, detail: "drawn" } : { ok: false, detail: "OOM" }; }),
  }) as unknown as LocalRunnerLike;

  it("a failed regeneration keeps the previous sprite AND its .meta (the guid every prefab references)", async () => {
    const { root, ctx } = project();
    const png = join(root, "Assets/Art/Generated/Pig.png");
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    writeFileSync(png, pngFixture("noise"));
    writeFileSync(`${png}.meta`, "fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: drawer(() => {}, false), specFor }).execute({ name: "Pig", provider: "local" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("previous drawn sprite and its .meta were kept");
    expect(readFileSync(`${png}.meta`, "utf8")).toContain("guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(readFileSync(png).equals(pngFixture("noise"))).toBe(true);
    // The backup is uniquely named per call (Codex 2026-09-11 N#9); none of
    // them may survive a completed restore.
    expect(readdirSync(dirname(png)).filter((f) => f.includes(".strada-prev"))).toEqual([]);
  });

  it("AUTO does not overwrite drawn art with a placeholder when the model fails", async () => {
    const { root, ctx } = project();
    const png = join(root, "Assets/Art/Generated/Pig.png");
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    writeFileSync(png, pngFixture("noise"));
    writeFileSync(`${png}.meta`, "fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: drawer(() => {}, false), specFor }).execute({ name: "Pig" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("was KEPT");
    expect(readFileSync(png).equals(pngFixture("noise"))).toBe(true);
    expect(readFileSync(`${png}.meta`, "utf8")).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("a blank-twice regeneration restores the previous good sprite instead of deleting it", async () => {
    const { root, ctx } = project();
    const png = join(root, "Assets/Art/Generated/Pig.png");
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    writeFileSync(png, pngFixture("noise"));
    writeFileSync(`${png}.meta`, "fileFormatVersion: 2\nguid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n");
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: drawer((out) => writeFileSync(out, pngFixture("flat"))), specFor }).execute({ name: "Pig", provider: "local" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("previous drawn sprite was kept");
    expect(readFileSync(png).equals(pngFixture("noise"))).toBe(true);
  });

  it("a cut-out that removed the subject (alpha specks) is not a usable sprite", async () => {
    const { root, ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: drawer((out) => writeFileSync(out, pngFixture("specks", 128))), specFor }).execute({ name: "GreenPig", provider: "local" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("opaque");
    expect(existsSync(join(root, "Assets/Art/Generated/GreenPig.png"))).toBe(false);
    expect(existsSync(join(root, "Assets/Art/Generated/GreenPig.png.meta"))).toBe(false);
  });

  it("a batch that drew nothing over earlier files reports 0 written, not 3", async () => {
    const { root, ctx } = project();
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    for (const n of ["A", "B", "C"]) writeFileSync(join(root, `Assets/Art/Generated/${n}.png`), pngFixture("noise"));
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "unused" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_s: unknown, jobs: Array<{ out: string }>) => ({ ok: false, detail: "python exited 1", written: jobs.map((j) => j.out), missing: [], keptBackground: [] })),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute({ batch: [{ name: "A" }, { name: "B" }, { name: "C" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("0 of 3 sprites written");
    expect(r.content).toContain("python exited 1");
    expect(readFileSync(join(root, "Assets/Art/Generated/A.png")).equals(pngFixture("noise"))).toBe(true);
  });

  it("a runner that throws mid-batch does not escape the tool or leave orphan metas", async () => {
    const { root, ctx } = project();
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "unused" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async () => { throw new Error("killed by SIGTERM"); }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute({ batch: [{ name: "A" }, { name: "B" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("killed by SIGTERM");
    expect(existsSync(join(root, "Assets/Art/Generated/A.png.meta"))).toBe(false);
    expect(existsSync(join(root, "Assets/Art/Generated/B.png.meta"))).toBe(false);
  });

  it("a path that resolves outside Assets/ is refused by every generator", async () => {
    const { root, ctx } = project();
    const sprite = await new SpriteGenerateTool({ localAvailable: () => false }).execute({ name: "Rocket", path: "Assets/../ProjectSettings" }, ctx);
    expect(sprite.isError).toBe(true);
    expect(sprite.content).toContain("outside Assets/");
    expect(existsSync(join(root, "ProjectSettings/Rocket.png"))).toBe(false);
    const mesh = await new MeshGenerateTool({ localAvailable: () => false }).execute({ name: "Rocket", shape: "cube", path: "Assets/.." }, ctx);
    expect(mesh.isError).toBe(true);
    expect(existsSync(join(root, "Rocket.obj"))).toBe(false);
    const { AudioGenerateTool } = await import("./audio-generate.js");
    const audio = await new AudioGenerateTool().execute({ name: "click", path: "Assets/../Library" }, ctx);
    expect(audio.isError).toBe(true);
    expect(existsSync(join(root, "Library/click.wav"))).toBe(false);
  });

  it("repeated names in a batch are refused up front", async () => {
    const { ctx } = project();
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner: refusing, specFor }).execute({ batch: [{ name: "Pig" }, { name: "Pig" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("repeat");
  });
});

describe("a batch item's bare name meets the existing placeholder (2026-09-09 19:24: twelve new files beside twelve untouched placeholders)", () => {
  it("two subjects may not share ONE image, and a runner that wrote nothing did not draw (Codex 2026-09-11 N#10, N#11)", async () => {
    const { root, ctx } = project();
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    // N#10: the same valid picture for every subject was reported as three
    // sprites written, and the inventory counted three with no placeholders.
    let round = 0;
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string }>) => {
        round += 1;
        // Every job gets the same image on the first pass; the retry draws
        // distinct ones.
        for (const [i, j] of jobs.entries()) writeFileSync(j.out, pngFixture("noise", round === 1 ? 64 : 64 + i + round));
        return { ok: true, detail: "ok", written: jobs.map((j) => j.out), missing: [] };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute(
      { batch: [{ name: "Pig" }, { name: "Rocket" }, { name: "Tree" }] },
      ctx,
    );
    // The duplicates were redrawn rather than counted as distinct artwork.
    expect(runner.textToImageBatch).toHaveBeenCalledTimes(2);
    expect(r.content).toContain("3 of 3 sprites written");

    // N#11: the runner exits 0 and writes nothing over an existing sprite.
    const target = join(root, "Assets/Art/Generated/Hero.png");
    writeFileSync(target, pngFixture("noise", 96));
    const lazy = {
      isModelInstalled: () => true,
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImage: vi.fn(async () => ({ ok: true, detail: "drawn" })),
    } as unknown as LocalRunnerLike;
    const stale = await new SpriteGenerateTool({ localAvailable: () => true, runner: lazy, specFor })
      .execute({ name: "Hero", provider: "local" }, ctx);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("byte-for-byte what was already there");
    expect(readFileSync(target).equals(pngFixture("noise", 96))).toBe(true);
  });

  it("a redraw that changed nothing is not three sprites (Codex 2026-09-11 O#18)", async () => {
    // The retry wrote nothing; the duplicate stayed on disk, its usability
    // check passed, and the duplicate reason was cleared — "3 of 3 sprites
    // written" over one image repeated three times.
    const { root, ctx } = project();
    mkdirSync(join(root, "Assets/Art/Generated"), { recursive: true });
    let round = 0;
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string }>) => {
        round += 1;
        if (round === 1) {
          for (const j of jobs) writeFileSync(j.out, pngFixture("noise", 64));
          return { ok: true, detail: "ok", written: jobs.map((j) => j.out), missing: [] };
        }
        // The redraw fails and writes nothing at all.
        return { ok: false, detail: "cuda error", written: [], missing: jobs.map((j) => j.out) };
      }),
    } as unknown as LocalRunnerLike;

    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute(
      { batch: [{ name: "Pig" }, { name: "Rocket" }, { name: "Tree" }] },
      ctx,
    );

    expect(r.content).not.toContain("3 of 3 sprites written");
    expect(r.content).toContain("the same image as");
  });

  it("the local batch job is aimed at the placeholder's real path, not the default directory", async () => {
    const { root, ctx } = project();
    mkdirSync(join(root, "Assets/Modules/LiveOpsModule/Art/Status"), { recursive: true });
    writeFileSync(join(root, "Assets/Modules/LiveOpsModule/Art/Status/ClaimFeedback.png"), pngFixture("flat"));
    const outs: string[] = [];
    const runner = {
      isModelInstalled: () => true,
      textToImage: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      imageToMesh: vi.fn(async () => ({ ok: false, detail: "n/a" })),
      textToImageBatch: vi.fn(async (_spec: unknown, jobs: Array<{ out: string }>) => {
        for (const [i, j] of jobs.entries()) { outs.push(j.out); writeFileSync(j.out, pngFixture("noise", 64 + i)); }
        return { ok: true, detail: "ok", written: jobs.map((j) => j.out), missing: [] };
      }),
    } as unknown as LocalRunnerLike;
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, specFor }).execute(
      { batch: [{ name: "ClaimFeedback" }, { name: "Brand" }] },
      ctx,
    );
    expect(r.isError, String(r.content)).toBeFalsy();
    // validatePath hands back REAL paths (/private/var…), so compare by suffix.
    expect(outs).toHaveLength(2);
    expect(outs[0]!.endsWith("/Assets/Modules/LiveOpsModule/Art/Status/ClaimFeedback.png")).toBe(true);
    expect(outs[1]!.endsWith("/Assets/Art/Generated/Brand.png")).toBe(true);
    expect(existsSync(join(root, "Assets/Art/Generated/ClaimFeedback.png"))).toBe(false);
  });
});

/**
 * Audit A2 / D54 (Codex #13): AUTO asked "is the SMALLEST supported model
 * installed?" — a machine with only sdxl (9 GB of weights) read as "nothing
 * installed", and even when availability was patched, every default spec
 * still resolved to sd15 and the runner refused it as not installed.
 */
describe("AUTO runs the model that is installed, not the smallest the device could run (audit A2 / D54)", () => {
  const bigMac = { totalRamGb: 64, appleSilicon: true };
  const onlySdxl = (id: string): boolean => id === "sdxl";
  const onlySd15 = (id: string): boolean => id === "sd15";
  /** A runner that records which model each inference was asked for. */
  function recorder(installed: (id: string) => boolean): LocalRunnerLike & { drawn: string[]; batched: string[]; lifted: string[] } {
    const drawn: string[] = [];
    const batched: string[] = [];
    const lifted: string[] = [];
    return {
      drawn,
      batched,
      lifted,
      isModelInstalled: installed,
      textToImage: async (spec: { id: string }, _p: string, out: string) => {
        drawn.push(spec.id);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, pngFixture("noise"));
        return { ok: true, detail: out };
      },
      textToImageBatch: async (spec: { id: string }, jobs: Array<{ out: string }>) => {
        batched.push(spec.id);
        for (const j of jobs) { mkdirSync(dirname(j.out), { recursive: true }); writeFileSync(j.out, pngFixture("noise")); }
        return { ok: true, detail: `${jobs.length} written`, written: jobs.map((j) => j.out), missing: [], keptBackground: [] };
      },
      imageToMesh: async (spec: { id: string }, _img: string, out: string) => {
        lifted.push(spec.id);
        writeFileSync(out, "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
        return { ok: true, detail: out };
      },
    } as never;
  }

  it("realLocalAvailability: only sdxl installed is 'available' (root isolated from ~/.strada)", async () => {
    const { realLocalAvailability } = await import("./sprite-generate.js");
    const root = mkdtempSync(join(tmpdir(), "auto-avail-"));
    dirs.push(root);
    const prevRoot = process.env["STRADA_ASSETS_LOCAL_ROOT"];
    process.env["STRADA_ASSETS_LOCAL_ROOT"] = root;
    try {
      mkdirSync(join(root, "venv", "bin"), { recursive: true });
      writeFileSync(join(root, "venv", "bin", "python3"), "");
      expect(realLocalAvailability(bigMac)("text-to-image")).toBe(false);
      writeFileSync(join(root, ".installed-sdxl"), "now\n");
      expect(realLocalAvailability(bigMac)("text-to-image")).toBe(true);
      // The 3D kind is judged on its own installs, not the 2D marker.
      expect(realLocalAvailability(bigMac)("image-to-3d")).toBe(false);
    } finally {
      if (prevRoot === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
      else process.env["STRADA_ASSETS_LOCAL_ROOT"] = prevRoot;
    }
  });

  it("single sprite: the spec handed to the runner is sdxl when only sdxl is installed", async () => {
    const { root, ctx } = project();
    const runner = recorder(onlySdxl);
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Hero" }, ctx);
    expect(String(r.content)).toContain("Sprite written by local diffusion");
    expect(String(r.content)).not.toContain("PLACEHOLDER");
    expect(runner.drawn).toEqual(["sdxl"]);
    expect(existsSync(join(root, "Assets", "Art", "Generated", "Hero.png"))).toBe(true);
  });

  it("batch: every batch call to the runner asks for sdxl", async () => {
    const { ctx } = project();
    const runner = recorder(onlySdxl);
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ batch: [{ name: "A" }, { name: "B" }] }, ctx);
    expect(r.isError).toBeFalsy();
    // The batch may retry blank draws with another seed; every call is sdxl.
    expect(runner.batched.length).toBeGreaterThanOrEqual(1);
    expect(new Set(runner.batched)).toEqual(new Set(["sdxl"]));
    expect(runner.drawn).toEqual([]);
  });

  it("mesh concept stage: the 2D model drawn with is sdxl, the lift uses the installed 3D model", async () => {
    const { ctx } = project();
    const runner = recorder((id) => id === "sdxl" || id === "triposr");
    const r = await new MeshGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Crate" }, ctx);
    expect(String(r.content)).toContain("Mesh written by local image-to-3D");
    expect(runner.drawn).toEqual(["sdxl"]);
    expect(runner.lifted).toEqual(["triposr"]);
  });

  // GUARDS: the smallest installed model still wins, an explicit id is still
  // honoured, and with nothing installed the message names the smallest.
  it("guard: with sd15 AND sdxl installed the smallest installed (sd15) is used", async () => {
    const { ctx } = project();
    const runner = recorder((id) => id === "sd15" || id === "sdxl");
    await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Hero" }, ctx);
    expect(runner.drawn).toEqual(["sd15"]);
  });

  it("guard: only sd15 installed keeps drawing with sd15", async () => {
    const { ctx } = project();
    const runner = recorder(onlySd15);
    await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Hero" }, ctx);
    expect(runner.drawn).toEqual(["sd15"]);
  });

  it("guard: an explicit model id is not swapped for the installed one", async () => {
    const { ctx } = project();
    const runner = recorder(onlySdxl);
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Hero", provider: "local", model: "sd15" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("is not installed");
    expect(String(r.content)).toContain("--model sd15");
    expect(runner.drawn).toEqual([]);
  });

  it("guard: nothing installed names the smallest supported model in the setup hint", async () => {
    const { ctx } = project();
    const runner = recorder(() => false);
    const r = await new SpriteGenerateTool({ localAvailable: () => true, runner, device: bigMac }).execute({ name: "Hero", provider: "local" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("--model sd15");
  });
});
