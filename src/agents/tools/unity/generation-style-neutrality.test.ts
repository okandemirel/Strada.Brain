/**
 * A generator asks for what THIS project's design document said, or for
 * nothing.
 *
 * The sprite and mesh fallbacks each carried one art direction, written into
 * the tool as a fixed character look: it was dispatched whatever the document
 * asked for and whatever the asset was, so an inanimate subject came back as
 * a character in that look (Codex 2026-09-12 T#13).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../../utils/logger.js";
import { describeStyleForPrompt, saveStyleProfile, loadStyleProfile } from "../../style/style-profile.js";
import { SpriteGenerateTool, defaultNegative, finishGrid, readsAsReport, styleNotesForPrompt } from "./sprite-generate.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function projectWith(profile?: Parameters<typeof saveStyleProfile>[1]): string {
  const root = mkdtempSync(join(tmpdir(), "gen-style-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  if (profile) saveStyleProfile(root, profile);
  return root;
}

const pixelProfile = {
  family: "pixel" as const,
  pipeline: "sprite-native" as const,
  proportions: { widthScale: 1.0, headScale: 1.0 },
  palette: ["#101020"],
  outline: { width: 0, color: "#2d3a4f" },
  shading: "unlit" as const,
  references: [],
  notes: "monochrome, no outline, 1-bit look",
};

describe("describeStyleForPrompt", () => {
  it("says what the profile says, and nothing about families it does not name", () => {
    const said = describeStyleForPrompt(pixelProfile as never);
    // Exactly what the profile says, in order, and nothing else: a forbidden
    // word list passes any wording it does not happen to name.
    expect(said).toBe("pixel style, unlit flat colours, monochrome, no outline, 1-bit look");
  });

  it("says nothing at all for an unspecified family with no notes", () => {
    const bare = describeStyleForPrompt({
      ...pixelProfile,
      family: "unspecified",
      shading: "flat",
      notes: "",
    } as never);
    expect(bare).toBe("flat shading");
  });
});

describe("the sprite generator's default prompt", () => {
  const promptFor = async (root: string): Promise<string> => {
    const tool = new SpriteGenerateTool();
    return (tool as unknown as { defaultPrompt(name: string, projectPath: string): Promise<string> })
      .defaultPrompt("StoneBridge", root);
  };

  it("asks for nothing in particular when the project has no style profile", async () => {
    // The whole prompt, pinned: the subject, plainly, and no look at all.
    expect(await promptFor(projectWith())).toBe(
      "game sprite of stone bridge, single subject centered, isolated on plain white background, studio quality",
    );
  });

  it("honours a profile's own family and notes", async () => {
    const root = projectWith(pixelProfile as never);
    expect(loadStyleProfile(root)?.family).toBe("pixel");
    expect(await promptFor(root)).toBe(
      "16-bit pixel-art game sprite of stone bridge, limited palette, crisp pixels, single subject centered, " +
        "plain background; monochrome, no outline, 1-bit look",
    );
  });
});

/**
 * Codex round AE#13, reproduced: a realistic profile asking for "overcast
 * natural lighting, no studio light" was dispatched as "studio lighting" with
 * its own notes dropped, while the fixed negative prompt forbade "photo,
 * realistic, scenery, dark background" — the opposite of what the project
 * asked for.
 */
describe("the request must not contradict the project's own direction (Codex 2026-09-12 AE#13)", () => {
  const realistic = {
    ...pixelProfile,
    family: "realistic" as const,
    shading: "pbr-realistic" as const,
    notes: "overcast natural lighting, no studio light",
  };

  const promptFor = async (root: string, name = "StoneBridge"): Promise<string> => {
    const tool = new SpriteGenerateTool();
    return (tool as unknown as { defaultPrompt(n: string, projectPath: string): Promise<string> }).defaultPrompt(name, root);
  };

  it("keeps the profile's own notes in EVERY family, and drops the lighting it never asked for", async () => {
    const prompt = await promptFor(projectWith(realistic as never));
    expect(prompt).toContain("overcast natural lighting, no studio light");
    expect(prompt).not.toMatch(/studio lighting/i);
    // …and the same for the other families that used to drop them.
    for (const family of ["pixel", "lowpoly", "painterly"] as const) {
      const said = await promptFor(projectWith({ ...pixelProfile, family, notes: "chalk on slate" } as never));
      expect(said, family).toContain("chalk on slate");
    }
  });

  it("does not call an arbitrary subject a character", async () => {
    for (const family of ["pixel", "painterly", "realistic"] as const) {
      const said = await promptFor(projectWith({ ...pixelProfile, family, notes: "" } as never), "StoneBridge");
      expect(said, family).toContain("stone bridge");
      expect(said, family).not.toMatch(/single (?:character|full-body)/i);
    }
  });

  it("does not forbid what the project asked for", async () => {
    const root = projectWith(realistic as never);
    const negative = await defaultNegative(root, false);
    expect(negative).not.toMatch(/\bphoto\b|\brealistic\b/);
    expect(negative).toContain("watermark");
    // A project that did NOT ask for realism still keeps the old guard…
    expect(await defaultNegative(projectWith(pixelProfile as never), false)).toMatch(/photo, realistic/);
    // …and a caller that keeps the background is not told to avoid one.
    const kept = await defaultNegative(projectWith(pixelProfile as never), true);
    expect(kept).not.toMatch(/dark background|scenery/);
    expect(await defaultNegative(projectWith(pixelProfile as never), false)).toMatch(/dark background/);
  });
});

/**
 * The placeholder shapes are finished the same way: the light band across the
 * top used to be drawn on every sprite, so a project with no profile at all
 * got a glossy one.
 */
describe("the placeholder sprite's gloss band", () => {
  const base = { r: 100, g: 100, b: 100 };
  const grid = (): ({ r: number; g: number; b: number } | null)[][] =>
    Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => ({ ...base })));
  const topBandIsLit = (g: ReturnType<typeof grid>): boolean =>
    g.slice(0, 5).some((row) => row.some((px) => px !== null && px.r > base.r));

  it("is drawn for a profile that asks for gloss, and for nobody else", () => {
    const glossy = grid();
    finishGrid(glossy, base, { outlineWidth: 0, gloss: true });
    expect(topBandIsLit(glossy)).toBe(true);

    for (const opts of [undefined, { outlineWidth: 0 }, { outlineWidth: 0, gloss: false }]) {
      const g = grid();
      finishGrid(g, base, opts);
      expect(topBandIsLit(g), JSON.stringify(opts)).toBe(false);
    }
  });
});

/**
 * A project's art-direction notes travel into every default prompt, and a run
 * can append its own bookkeeping to them. What is dropped is decided by the
 * FORM of a sentence — a path, an identifier, a proportion, a bare figure, a
 * progress mark — not by a list of words from one project's reports.
 */
describe("readsAsReport", () => {
  it.each([
    "Repainted the atlas at Assets/Art/tiles.png.",
    "paletteIndex now matches the importer.",
    "tile_width was raised everywhere.",
    "Covered 93% of the shelves.",
    "Re-pointed 12 of 30 bindings.",
    "Finished on run 418.",
    "See https://example.invalid/brief for the rest.",
    "Atlas re-cut \u2713",
    "TODO: pick the dusk palette.",
  ])("reads as a report: %s", (sentence) => {
    expect(readsAsReport(sentence)).toBe(true);
  });

  it.each([
    "Sun-bleached sandstone under indigo ink linework.",
    "Hand-painted goods on every shelf.",
    "A 1-bit look, 8 colours at most.",
    "Overcast natural lighting, no studio light.",
    "Thick 2 pixel outlines, dusk palette.",
  ])("reads as a look: %s", (sentence) => {
    expect(readsAsReport(sentence)).toBe(false);
  });

  it("keeps the look sentences of a note and drops the reporting ones", () => {
    const kept = styleNotesForPrompt(
      "Chalk on slate, all edges soft. Redrew 14 of them. Dusk palette only. | tiles.png re-cut, all checks green.",
    );
    expect(kept).toBe("Chalk on slate, all edges soft. Dusk palette only.");
  });
});
