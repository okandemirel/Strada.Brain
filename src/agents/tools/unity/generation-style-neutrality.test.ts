/**
 * A generator asks for what THIS project's document said, or for nothing.
 *
 * The fallbacks carried one game's art direction — "mobile casual game
 * character, thick clean outline, soft glossy shading" for sprites, "casual
 * mobile game character, soft glossy 3d-look" for meshes — whatever the
 * document asked for and whatever the asset was, so a StoneBridge was
 * generated as a glossy casual character (Codex 2026-09-12 T#13).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../../utils/logger.js";
import { describeStyleForPrompt, saveStyleProfile, loadStyleProfile } from "../../style/style-profile.js";
import { SpriteGenerateTool, defaultNegative } from "./sprite-generate.js";

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
  proportions: { plump: 1.0, headScale: 1.0 },
  palette: ["#101020"],
  outline: { width: 0, color: "#1f1418" },
  shading: "unlit" as const,
  references: [],
  notes: "monochrome, no outline, 1-bit look",
};

describe("describeStyleForPrompt", () => {
  it("says what the profile says, and nothing about families it does not name", () => {
    const said = describeStyleForPrompt(pixelProfile as never);
    expect(said).toContain("pixel style");
    expect(said).toContain("unlit flat colours");
    expect(said).toContain("monochrome, no outline");
    expect(said).not.toMatch(/casual|glossy|character/i);
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
    const prompt = await promptFor(projectWith());
    expect(prompt).toContain("stone bridge");
    expect(prompt).not.toMatch(/casual|glossy|character|thick clean outline/i);
  });

  it("honours a profile that asks for the opposite of the old default", async () => {
    const root = projectWith(pixelProfile as never);
    expect(loadStyleProfile(root)?.family).toBe("pixel");
    const prompt = await promptFor(root);
    expect(prompt).toContain("pixel-art");
    expect(prompt).not.toMatch(/glossy/i);
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
