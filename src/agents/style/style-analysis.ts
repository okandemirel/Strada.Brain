/**
 * Style Analysis — the LLM pass that DERIVES a game's style profile from its
 * own design document. This is what makes the pipeline honest about "no
 * universal style": every project's look is read out of its GDD's art
 * direction, not assumed. A vague GDD falls back to keyword inference plus
 * the safest family default, and the analysis is always surfaced (never a
 * silent guess) so a wrong read is correctable at the GDD approval gate.
 */

import type { IAIProvider } from "../providers/provider.interface.js";
import { streamOrChatText } from "../providers/provider.interface.js";
import { getLoggerSafe } from "../../utils/logger.js";
import { familyDefaults, styleProfileSchema, STYLE_FAMILIES } from "./style-profile.js";
import type { StyleProfile } from "./style-profile.js";

const ANALYSIS_SYSTEM = `You are the art-direction reader for an autonomous game-build pipeline.

You receive the art-direction sections of a game design document (or the whole document when short). Extract the game's visual style as STRICT JSON for this schema:

{
  "family": one of ["toon-casual", "realistic", "pixel", "lowpoly", "painterly"],
  "pipeline": one of ["prerendered-frames", "realtime-3d", "sprite-native"],
  "proportions": { "plump": 0.5-1.5, "headScale": 0.5-2.0 },
  "palette": ["#rrggbb", ...] (1-8 anchors, primary first),
  "outline": { "width": 0-3, "color": "#rrggbb" },
  "shading": one of ["glossy", "flat", "pbr-realistic", "unlit"],
  "references": ["game or media names the doc cites as visual reference"],
  "notes": "one sentence of the doc's own most load-bearing art rule"
}

Rules:
- The document is the only truth. Never import a style from another game: "plump glossy cartoon pigs" means toon-casual with plump>1 and outline>0; "gritty realistic military shooter" means realistic with plump=1 and outline=0.
- "Prerendered 2D frames with a 3D feel" or "2D renderer" → pipeline prerendered-frames; realtime 3D gameplay → realtime-3d; pure sprite/pixel games → sprite-native.
- Palette comes from the doc's named colors or its described mood (pastel/candy → bright soft hexes; muted/desaturated → grey-tinted hexes). Never fewer than 3.
- Respond ONLY with the JSON object.`;

/** Keyword fallback when the LLM is unavailable or unparseable. */
function inferFamilyFromText(text: string): StyleProfile["family"] {
  const t = text.toLowerCase();
  if (/pixel[- ]?art|16[- ]?bit|8[- ]?bit/.test(t)) return "pixel";
  if (/low[- ]?poly|voxel/.test(t)) return "lowpoly";
  if (/painterly|watercolor|hand[- ]?painted/.test(t)) return "painterly";
  if (/toon|cartoon|chibi|plump|glossy|cute|casual game/.test(t)) return "toon-casual";
  if (/realistic|pbr|military|shooter|simulation/.test(t)) return "realistic";
  return "toon-casual";
}

export class StyleAnalysis {
  constructor(private readonly provider: IAIProvider | undefined) {}

  /**
   * Derive the profile from the design document. LLM-first; keyword fallback
   * never fails the pass — a wrong-but-marked profile beats a crashed one.
   */
  async analyze(gddText: string): Promise<{ profile: StyleProfile; source: "llm" | "keyword-fallback" }> {
    if (this.provider) {
      try {
        // Same windowing as campaign planning: a hard head-slice cut the GDD
        // mid-document, and art direction typically lives mid-document.
        const { windowGdd } = await import("../../campaign/campaign-planner.js");
        const response = await streamOrChatText(
          this.provider,
          ANALYSIS_SYSTEM,
          `<gdd>\n${windowGdd(gddText)}\n</gdd>\n\nExtract the style profile.`,
        );
        const jsonText = extractJsonObject(response.text ?? "");
        if (jsonText) {
          const parsed = styleProfileSchema.safeParse(JSON.parse(jsonText));
          if (parsed.success) {
            return { profile: parsed.data, source: "llm" };
          }
          getLoggerSafe().warn("Style analysis returned invalid JSON shape — falling back to keywords");
        }
      } catch (err) {
        getLoggerSafe().warn("Style analysis LLM call failed — falling back to keywords", {
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }

    const family = inferFamilyFromText(gddText);
    const defaults = familyDefaults(family);
    const fallback: StyleProfile = styleProfileSchema.parse({
      family,
      pipeline: family === "pixel" ? "sprite-native" : "prerendered-frames",
      proportions: { plump: defaults.plump, headScale: defaults.headScale },
      palette: ["#f89eb8", "#7ec8f7", "#f7d97e"],
      outline: { width: defaults.outlineWidth, color: "#1f1418" },
      shading: defaults.shading,
      references: [],
      notes: "derived by keyword fallback — review at the approval gate",
    });
    return { profile: fallback, source: "keyword-fallback" };
  }
}

/** Tolerant extraction: the outermost balanced {...} in the reply. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export { STYLE_FAMILIES };
