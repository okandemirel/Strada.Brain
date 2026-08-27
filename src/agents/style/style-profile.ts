/**
 * Style Profile — the game's visual identity, as a versioned project config.
 *
 * Product decision (2026-08-27, user's call): there is NO universal style.
 * A PixelFlow today is a Call of Duty tomorrow, so nothing about the look
 * may be hardcoded — the profile is DERIVED from each project's own GDD
 * (see style-analysis.ts), written to <project>/style.json, and read by
 * every generation/render tool as its default. Consistency inside one game
 * comes from everything flowing through ONE profile; adaptability across
 * games comes from the profile being a per-project derivative, never a
 * universal preset.
 */

import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// SCHEMA
// =============================================================================

export const STYLE_FAMILIES = [
  "toon-casual",
  "realistic",
  "pixel",
  "lowpoly",
  "painterly",
] as const;

export const RENDER_PIPELINES = ["prerendered-frames", "realtime-3d", "sprite-native"] as const;

export const styleProfileSchema = z.object({
  /** Broad look family driving material/proportion defaults. */
  family: z.enum(STYLE_FAMILIES),
  /** How the game should ship its characters/props. */
  pipeline: z.enum(RENDER_PIPELINES),
  proportions: z.object({
    /** Body squash for plumpness (1.0 = natural). */
    plump: z.number().min(0.5).max(1.5).default(1.0),
    /** Head-bone scale (1.0 = natural; >1 for chibi). */
    headScale: z.number().min(0.5).max(2).default(1.0),
  }).default({ plump: 1.0, headScale: 1.0 }),
  /** Named palette (hex) — the game's color anchors, primary first. */
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(8),
  outline: z.object({
    /** Inverted-hull width factor; 0 disables (realistic looks). */
    width: z.number().min(0).max(3).default(0),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#1f1418"),
  }).default({ width: 0, color: "#1f1418" }),
  /** Shading approach the material stage should target. */
  shading: z.enum(["glossy", "flat", "pbr-realistic", "unlit"]),
  /** Games/media the GDD cites as visual references (for the agent's context). */
  references: z.array(z.string()).default([]),
  /** Free-form art-direction notes carried into generation prompts. */
  notes: z.string().default(""),
});

export type StyleProfile = z.infer<typeof styleProfileSchema>;

export const STYLE_FILE = "style.json";

// =============================================================================
// IO
// =============================================================================

export function styleFilePath(projectRoot: string): string {
  return join(projectRoot, STYLE_FILE);
}

export function loadStyleProfile(projectRoot: string): StyleProfile | undefined {
  try {
    const path = styleFilePath(projectRoot);
    if (!existsSync(path)) return undefined;
    const parsed = styleProfileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveStyleProfile(projectRoot: string, profile: StyleProfile): void {
  writeFileSync(styleFilePath(projectRoot), JSON.stringify(profile, null, 2) + "\n", "utf8");
}

// =============================================================================
// DEFAULTS per family (used by tools when the profile omits specifics)
// =============================================================================

export interface FamilyDefaults {
  plump: number;
  headScale: number;
  outlineWidth: number;
  shading: StyleProfile["shading"];
}

export function familyDefaults(family: StyleProfile["family"]): FamilyDefaults {
  switch (family) {
    case "toon-casual":
      return { plump: 1.2, headScale: 1.22, outlineWidth: 1.0, shading: "glossy" };
    case "pixel":
      return { plump: 1.0, headScale: 1.0, outlineWidth: 0, shading: "unlit" };
    case "lowpoly":
      return { plump: 1.0, headScale: 1.05, outlineWidth: 0.5, shading: "flat" };
    case "painterly":
      return { plump: 1.0, headScale: 1.0, outlineWidth: 0.3, shading: "glossy" };
    case "realistic":
    default:
      return { plump: 1.0, headScale: 1.0, outlineWidth: 0, shading: "pbr-realistic" };
  }
}
