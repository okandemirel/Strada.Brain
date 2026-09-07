import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AudioGenerateTool, SFX_PRESETS, synthesizeSfx, synthesizeMusic, encodeWav, SAMPLE_RATE } from "./audio-generate.js";
import { measureAudioClip } from "../../autonomy/built-as-specified.js";
import type { ToolContext } from "../tool.interface.js";

let root: string;
let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "audio-gen-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  ctx = { projectPath: root, workingDirectory: root, readOnly: false } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("synthesis", () => {
  it("every sfx preset renders a distinct, non-silent cue of its stated length", () => {
    const hashes = new Set<string>();
    for (const preset of SFX_PRESETS) {
      const { samples, seconds } = synthesizeSfx(preset, 1);
      expect(samples.length).toBe(Math.round(seconds * SAMPLE_RATE));
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      expect(peak, preset).toBeGreaterThan(0.5);
      hashes.add(createHash("sha1").update(encodeWav(samples)).digest("hex"));
    }
    expect(hashes.size).toBe(SFX_PRESETS.length);
  });

  it("is deterministic per seed and differs across seeds", () => {
    const a = encodeWav(synthesizeSfx("coin", 7).samples);
    const b = encodeWav(synthesizeSfx("coin", 7).samples);
    const c = encodeWav(synthesizeSfx("hit", 8).samples);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("a music loop is whole bars long and not a blip", () => {
    const m = synthesizeMusic({ bpm: 120, key: "A", mode: "minor", seconds: 10, seed: 3 });
    expect(m.seconds).toBeCloseTo(10, 5); // 120 bpm → 2 s bars → 5 bars
    expect(m.progression).toHaveLength(4);
    let peak = 0;
    for (const s of m.samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.5);
  });
});

describe("unity_generate_audio", () => {
  it("writes a WAV the delivery measurement reads back, with an AudioImporter meta", async () => {
    // Measured 2026-09-07: the GDD's cue list had no tool to come from.
    const r = await new AudioGenerateTool().execute({ name: "ui_click", preset: "click" }, ctx);
    expect(r.isError).toBeFalsy();
    const file = join(root, "Assets/Audio/Generated/ui_click.wav");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(`${file}.meta`, "utf8")).toContain("AudioImporter:");
    const clip = measureAudioClip(file);
    expect(clip.seconds).toBeCloseTo(0.06, 2);
    expect(r.content).toContain("ui_click.wav");
    expect(r.content).toContain("Bind it to an AudioSource");
  });

  it("writes a music loop and says it is procedural", async () => {
    const r = await new AudioGenerateTool().execute({ name: "music_farm", kind: "music", bpm: 100, key: "G", seconds: 8 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("PROCEDURAL");
    const clip = measureAudioClip(join(root, "Assets/Audio/Generated/music_farm.wav"));
    expect(clip.seconds).toBeCloseTo(7.2, 1); // 100 bpm → 2.4 s bars → 3 bars
  });

  it("keeps the guid on regeneration so bindings survive", async () => {
    const tool = new AudioGenerateTool();
    await tool.execute({ name: "pop_tap" }, ctx);
    const first = readFileSync(join(root, "Assets/Audio/Generated/pop_tap.wav.meta"), "utf8");
    await tool.execute({ name: "pop_tap", seed: 99 }, ctx);
    const second = readFileSync(join(root, "Assets/Audio/Generated/pop_tap.wav.meta"), "utf8");
    expect(second).toBe(first);
  });

  it("refuses bad names, kinds, presets and paths outside Assets/", async () => {
    const tool = new AudioGenerateTool();
    expect((await tool.execute({ name: "1bad" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ name: "x", kind: "voice" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ name: "x", preset: "laser" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ name: "x", path: "Library/Audio" }, ctx)).isError).toBe(true);
  });
});
