import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  familyDefaults,
  loadStyleProfile,
  saveStyleProfile,
  styleProfileSchema,
  STYLE_FAMILIES,
} from "./style-profile.js";
import { StyleAnalysis } from "./style-analysis.js";

describe("styleProfileSchema", () => {
  it("accepts a full toon-casual profile and fills defaults", () => {
    const parsed = styleProfileSchema.parse({
      family: "toon-casual",
      pipeline: "prerendered-frames",
      proportions: { plump: 1.2, headScale: 1.22 },
      palette: ["#f89eb8"],
      outline: { width: 1.0, color: "#1f1418" },
      shading: "glossy",
    });
    expect(parsed.references).toEqual([]);
    expect(parsed.notes).toBe("");
  });

  it("rejects bad palettes and unknown families", () => {
    expect(
      styleProfileSchema.safeParse({
        family: "toon-casual",
        pipeline: "prerendered-frames",
        palette: ["pink"],
      }).success,
    ).toBe(false);
    expect(
      styleProfileSchema.safeParse({
        family: "gritty-90s",
        pipeline: "realtime-3d",
        palette: ["#112233"],
      }).success,
    ).toBe(false);
  });
});

describe("style.json IO", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "style-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a profile through the project file", () => {
    const profile = styleProfileSchema.parse({
      family: "realistic",
      pipeline: "realtime-3d",
      palette: ["#3a3f44", "#6b7280", "#9ca3af"],
      shading: "pbr-realistic",
    });
    saveStyleProfile(dir, profile);
    const loaded = loadStyleProfile(dir);
    expect(loaded?.family).toBe("realistic");
    expect(loaded?.outline.width).toBe(0);
    expect(loaded?.proportions.plump).toBe(1.0);
  });

  it("returns undefined for a missing or corrupt file", () => {
    expect(loadStyleProfile(dir)).toBeUndefined();
  });
});

describe("familyDefaults", () => {
  it("gives every family a coherent, distinct default", () => {
    expect(familyDefaults("toon-casual").outlineWidth).toBeGreaterThan(0);
    expect(familyDefaults("realistic").outlineWidth).toBe(0);
    expect(familyDefaults("realistic").shading).toBe("pbr-realistic");
    expect(familyDefaults("pixel").shading).toBe("unlit");
    for (const f of STYLE_FAMILIES) {
      expect(familyDefaults(f).plump).toBeGreaterThan(0);
    }
  });
});

describe("StyleAnalysis keyword fallback", () => {
  it("reads pixel-art docs as pixel, cartoon docs as toon, military as realistic", async () => {
    const analysis = new StyleAnalysis(undefined);
    expect((await analysis.analyze("A crisp pixel-art puzzle, 16-bit sprites everywhere.")).profile.family).toBe("pixel");
    expect((await analysis.analyze("Plump, glossy cartoon animals with thick outlines.")).profile.family).toBe("toon-casual");
    expect((await analysis.analyze("A realistic military shooter with PBR materials.")).profile.family).toBe("realistic");
  });

  it("never crashes on an empty document — returns a marked fallback", async () => {
    const analysis = new StyleAnalysis(undefined);
    const { profile, source } = await analysis.analyze("");
    expect(source).toBe("keyword-fallback");
    expect(profile.notes).toContain("keyword fallback");
    expect(STYLE_FAMILIES).toContain(profile.family);
  });
});
