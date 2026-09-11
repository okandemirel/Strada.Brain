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
- The document is the only truth. Never import a style from another game: "plump glossy cartoon animals" means toon-casual with plump>1 and outline>0; "gritty realistic military shooter" means realistic with plump=1 and outline=0.
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
  // An unrecognized document is UNKNOWN, not a casual toon game: the default
  // stamped one genre's look on every GDD (Codex 2026-09-11 B#20).
  return "unspecified";
}

/**
 * The pipeline a family implies. Everything non-pixel used to become
 * prerendered-frames, so a realistic 3D game was rendered to sprite sheets
 * (Codex 2026-09-11 B#20).
 */
function pipelineForFamily(family: StyleProfile["family"], text = ""): StyleProfile["pipeline"] {
  // What the document SAYS about rendering outranks the art family: "rendered
  // in realtime with a free camera" became prerendered frames because the art
  // vocabulary was unfamiliar (Codex 2026-09-11 C#31).
  if (/\b(?:real[- ]?time (?:3d|render|rendering)|realtime|free(?:ly)?[- ]rotating camera|orbit camera|3d gameplay)\b/i.test(text)) return "realtime-3d";
  if (/\b(?:pre[- ]?rendered|sprite ?sheets?|billboard)\b/i.test(text)) return "prerendered-frames";
  if (/\b(?:2d sprites?|sprite[- ]native|pixel[- ]?art)\b/i.test(text)) return "sprite-native";
  switch (family) {
    case "pixel":
      return "sprite-native";
    case "realistic":
    case "lowpoly":
      return "realtime-3d";
    case "unspecified":
      // Nothing said: nothing imposed. A 2D sprite pipeline is the least
      // invasive default — it needs no model, no rig and no render pass.
      return "sprite-native";
    default:
      return "prerendered-frames";
  }
}

/** Hex colours the document itself names, in document order (max 5). */
export function paletteFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const raw = m[0].toLowerCase();
    // #fff is a colour; the profile schema stores six digits, and handing it
    // three threw a ZodError out of the fallback that promises never to fail
    // (Codex 2026-09-11 C#20).
    const hex = raw.length === 4 ? `#${raw[1]!}${raw[1]!}${raw[2]!}${raw[2]!}${raw[3]!}${raw[3]!}` : raw;
    if (!out.includes(hex)) out.push(hex);
    if (out.length === 5) break;
  }
  return out;
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
        const { windowGdd, GDD_AUDIT_FULL_CHARS } = await import("../../campaign/campaign-planner.js");
        const response = await streamOrChatText(
          this.provider,
          ANALYSIS_SYSTEM,
          // The analysis runs once and needs exactly the mid-document PROSE
          // (palette words, mood, reference games) the planner's tight window
          // drops — use the audit-sized window.
          `<gdd>\n${windowGdd(gddText, GDD_AUDIT_FULL_CHARS)}\n</gdd>\n\nExtract the style profile.`,
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
    // The document's own colours, never an invented palette: three pastels
    // were stamped on every fallback profile (Codex 2026-09-11 B#20).
    const palette = paletteFromText(gddText);
    const fallback: StyleProfile = styleProfileSchema.parse({
      family,
      pipeline: pipelineForFamily(family, gddText),
      proportions: { plump: defaults.plump, headScale: defaults.headScale },
      palette: palette.length > 0 ? palette : ["#9aa0a6"],
      outline: { width: defaults.outlineWidth, color: "#1f1418" },
      shading: defaults.shading,
      references: [],
      notes: palette.length > 0
        ? "derived by keyword fallback (palette read from the document) — review at the approval gate"
        : "derived by keyword fallback; the document names no colours, so the palette is a neutral grey — review at the approval gate",
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
