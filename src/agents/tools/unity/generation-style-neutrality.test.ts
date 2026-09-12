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
import { SpriteGenerateTool } from "./sprite-generate.js";

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
