/**
 * Campaign Planner
 *
 * One LLM pass that turns a GDD into the milestone ladder — the ordered list
 * of self-contained sprint prompts the campaign will walk. This replaces the
 * hand-authored per-sprint kick prompts that drove PixelFlow (Sprint B, then
 * Sprint C hours later, by hand). The rules below are the distilled shape of
 * those prompts.
 */

import { z } from "zod";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { getLoggerSafe } from "../utils/logger.js";
import { streamOrChatText } from "../agents/providers/provider.interface.js";
import { milestoneLadderSchema } from "./types.js";
import type { MilestoneLadder } from "./types.js";

/**
 * GDD windowing. The old 10k-head + 6k-tail window elided the MIDDLE of a
 * large GDD — which is where the element schedules, level structure, and
 * system tables actually live (the PixelFlow requirements summary put its
 * whole element table at 40–60% depth). A ladder planned from a document
 * whose schedule was cut out cannot cover the game. Now: documents up to
 * FULL_CHARS go through whole; larger ones keep a big head and tail plus a
 * structural outline of the middle (every heading and table row), so nothing
 * the GDD schedules is invisible to the planner.
 */
const GDD_FULL_CHARS = 150_000;
const GDD_HEAD_CHARS = 50_000;
const GDD_TAIL_CHARS = 30_000;
const GDD_OUTLINE_CHARS = 20_000;

const PLANNER_SYSTEM = `You are a campaign planner for an autonomous game-development system.

You receive a game design document (GDD) for a Unity project built with the Strada.Core framework, and you produce the MILESTONE LADDER: the ordered list of sprints that builds the whole game, start to finish.

Rules:
- 2 to 12 milestones, ordered strictly by dependency: foundations first (project scaffolding, core simulation), then mechanics/elements in the GDD's own groupings, then content (levels), then integration.
- Each milestone's "prompt" is the COMPLETE kick prompt an agent will execute without you in the room. It must name: its scope (the GDD sections/elements it covers), the architecture pattern to follow (the project's existing module pattern — reference it by name once foundations exist), the verification bar (headless compile green, the relevant PlayMode tests green and UNFILTERED, a captured frame proving something renders), commit discipline (commit per logical unit), and what to produce at the end of the sprint.
- The FINAL milestone is always integration + delivery: full PlayMode suite green with no filter, the assembled scene actually running the game, and a DELIVERY REPORT summarizing what was built against the GDD.
- The FINAL milestone also owns BUILD HYGIENE: it must leave EXACTLY ONE obvious entry scene enabled in Build Settings — the scene that runs the game — with every verification/scaffolding scene the campaign created (InitTestScene*, *Verification, *Verified, *Showcase, *Boundary, Assembled*) deleted or disabled, and its report must name the entry scene and list what it disabled or deleted.
- Every element the GDD schedules must end its milestone with a real, BOUND visual: source it with unity_my_assets (local cache) or unity_my_assets_cloud (the account's full purchased library) first, generate it when nothing fits — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for dimensional ones (stages, characters) — both use the machine's installed open-weights model automatically and SAY when they fell back to a procedural placeholder; a placeholder is not the element's visual, unity_prerender_frames to turn a 3D prefab into glossy 2D angle frames (the GDD's prerendered-character pipeline) — and bind it into the element's prefab. Code for an element without its visual is a milestone that is not done.
- Never plan a milestone whose output is a question for the user, and never re-plan what the GDD already specifies — the design document is the complete instruction.
- A sprint prompt must be self-contained: it cannot assume a previous sprint's conversation is remembered, only that its commits landed in the repo. Reference the GDD by its project-relative path (given below) rather than restating it.
- Keep each prompt focused: 150-600 words. Cover the milestone, don't narrate the whole GDD.

Respond ONLY with JSON:
{"milestones": [{"title": "Sprint A — ...", "prompt": "..."}, ...]}`;

export function windowGdd(gddText: string, fullThreshold: number = GDD_FULL_CHARS): string {
  if (gddText.length <= fullThreshold) return gddText;
  // The slices SCALE with the threshold. Audited 2026-09-02: fullThreshold
  // gated only the early return while head/tail/outline were fixed module
  // constants, so past 400k the audit's "far larger window" was byte-for-byte
  // the planner's window — the one blind spot the audit exists to catch.
  const scale = Math.max(1, fullThreshold / GDD_FULL_CHARS);
  const headChars = Math.round(GDD_HEAD_CHARS * scale);
  const tailChars = Math.round(GDD_TAIL_CHARS * scale);
  const outlineChars = Math.round(GDD_OUTLINE_CHARS * scale);
  const head = gddText.slice(0, headChars);
  const tail = gddText.slice(-tailChars);
  const middle = gddText.slice(headChars, -tailChars);
  // Structural skeleton of the elided middle. The old filter kept ONLY ATX
  // headings and pipe rows — a .docx/.pdf-converted GDD (the dominant intake
  // path) has neither, so a 150k+ converted document lost its entire middle
  // (element schedules, level ladders, art direction) under a marker claiming
  // the outline was present. Structure now includes list items, numbered
  // schedules and short definition lines; when even that matches almost
  // nothing, fall back to sampling the middle so SOMETHING of it survives.
  const structural = middle
    .split("\n")
    .filter((line) =>
      /^\s*(#{1,6}\s|\||[-*•]\s|\d{1,3}[.)]\s)/.test(line) ||
      (/^\s*[A-ZĞÜŞİÖÇ][^:\n]{2,60}:\s+\S/.test(line) && line.length <= 160),
    )
    .join("\n");
  let outline = structural.slice(0, outlineChars);
  let markerNote = "its structural outline (headings, tables, lists, schedules) follows";
  if (structural.length > outlineChars) {
    // Say so: a marker claiming the outline "follows" while it was cut at
    // the budget hid the loss from the model reading it.
    markerNote += ` (outline truncated to ${outlineChars} of ${structural.length} chars)`;
  }
  if (structural.length < middle.length * 0.02) {
    // Structure-less middle (converted document): take evenly-spaced samples
    // instead of pretending an outline exists.
    const sampleCount = 10;
    const sampleLen = Math.floor(outlineChars / sampleCount);
    const stride = Math.floor(middle.length / sampleCount);
    outline = Array.from({ length: sampleCount }, (_, i) =>
      middle.slice(i * stride, i * stride + sampleLen),
    ).join("\n[...]\n");
    markerNote = "the document has no markdown structure; evenly-spaced samples of the middle follow";
  }
  getLoggerSafe().warn("GDD windowed for planning — middle content reduced", {
    totalChars: gddText.length,
    middleChars: middle.length,
    outlineChars: outline.length,
    structural: structural.length >= middle.length * 0.02,
  });
  return [
    head,
    `\n[... middle elided (${middle.length} chars); ${markerNote} ...]\n`,
    outline,
    `\n[... end of middle extract ...]\n`,
    tail,
  ].join("\n");
}

/**
 * The coverage audit must NOT share the planner's blind spot: it runs once,
 * so it can afford a far larger window — windowing loss the planner suffered
 * is exactly what the audit exists to catch.
 */
export const GDD_AUDIT_FULL_CHARS = 400_000;

export class CampaignPlanner {
  constructor(private readonly provider: IAIProvider | undefined) {}

  /**
   * Build the milestone ladder for a campaign. Throws on provider outage or
   * on structurally invalid output (caller fails the campaign with the cause
   * — a campaign that cannot plan must not silently degrade into one giant
   * sprint, which is exactly the failure mode the ladder exists to prevent).
   */
  async planMilestones(gddText: string, gddPath: string, styleNote?: string): Promise<MilestoneLadder> {
    if (!this.provider) {
      throw new Error("campaign planning requires an LLM provider");
    }

    const userMessage =
      `GDD project-relative path: ${gddPath}\n\n` +
      (styleNote ? `Derived style profile (stored at style.json — generators read it): ${styleNote}\n\n` : "") +
      `<gdd>\n${windowGdd(gddText)}\n</gdd>\n\n` +
      `Produce the milestone ladder for this game.`;

    // One transient failure (provider blink, malformed reply) used to fail
    // the whole campaign terminally at its very first step. One retry.
    let lastError: unknown;
    for (let round = 0; round < 2; round++) {
      try {
        return await this.planOnce(userMessage);
      } catch (err) {
        lastError = err;
        getLoggerSafe().warn("Campaign planning round failed", {
          round: round + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        // A second round into a fully-cooling chain is a guaranteed burn —
        // the caller parks the campaign with a self-revival appointment.
        const { allProvidersCoolingDownMs } = await import("../agents/providers/provider-outage.js");
        if (allProvidersCoolingDownMs() > 0) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async planOnce(userMessage: string): Promise<MilestoneLadder> {
    if (!this.provider) {
      throw new Error("campaign planning requires an LLM provider");
    }
    const response = await streamOrChatText(this.provider, PLANNER_SYSTEM, userMessage);
    const text = response.text ?? "";
    const jsonText = extractJsonObject(text);
    if (!jsonText) {
      throw new Error("campaign planner returned no JSON object");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("campaign planner returned malformed JSON");
    }

    const validated = milestoneLadderSchema.safeParse(parsed);
    if (!validated.success) {
      getLoggerSafe().warn("Campaign planner output failed validation", {
        issues: z.prettifyError(validated.error).slice(0, 300),
      });
      throw new Error("campaign planner output failed schema validation");
    }
    return validated.data;
  }

  /**
   * Post-ladder coverage audit: does the finished ladder actually cover what
   * the GDD schedules? "Done" used to mean nothing more than "the last
   * milestone's task completed" — the ladder itself was a one-shot guess from
   * a truncated document, and nothing ever compared it back to the design.
   * Returns the concrete GDD-scheduled items no milestone delivered (empty
   * when coverage holds). Throws on provider outage — the CALLER decides that
   * a failed audit must not wedge delivery.
   */
  async auditCoverage(
    gddText: string,
    milestones: ReadonlyArray<{ title: string; resultExcerpt?: string }>,
  ): Promise<string[]> {
    if (!this.provider) {
      throw new Error("coverage audit requires an LLM provider");
    }
    const ladderSummary = milestones
      .map((m, i) => `${i + 1}. ${m.title}${m.resultExcerpt ? `\n   Result: ${m.resultExcerpt.slice(0, 300)}` : ""}`)
      .join("\n");
    const userMessage =
      `<gdd>\n${windowGdd(gddText, GDD_AUDIT_FULL_CHARS)}\n</gdd>\n\n` +
      `<completed-ladder>\n${ladderSummary}\n</completed-ladder>\n\n` +
      `List the concrete items the GDD schedules (mechanics, game elements, blockers, set-pieces, screens, systems) that NO milestone above covered or delivered. Respond ONLY with JSON: {"missing": ["<item>: <one-line what is missing>", ...]} — an empty array when the ladder covers the GDD.`;

    // RETRY THE SHAPE, not the judgement. One malformed reply used to skip
    // the GDD-coverage check for the whole delivery — measured live
    // 2026-09-03 08:33: "delivered WITHOUT a clean GDD-coverage check"
    // because a model wrapped its JSON in prose. The second ask restates the
    // contract; only then does the audit give up.
    let response = await streamOrChatText(this.provider, COVERAGE_SYSTEM, userMessage);
    let jsonText = extractJsonObject(response.text ?? "");
    let parsedOnce: unknown;
    const tryParse = (text: string | null | undefined): unknown => {
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    parsedOnce = tryParse(jsonText);
    if (parsedOnce === undefined) {
      getLoggerSafe().warn("Coverage audit reply was not usable JSON — asking once more", {
        replyLength: response.text?.length ?? 0,
      });
      response = await streamOrChatText(
        this.provider,
        COVERAGE_SYSTEM,
        `${userMessage}

Your previous reply was not valid JSON. Reply with the JSON object ALONE — no prose, no code fence: {"missing": [...]}.`,
      );
      jsonText = extractJsonObject(response.text ?? "");
      parsedOnce = tryParse(jsonText);
    }
    if (!jsonText) throw new Error("coverage audit returned no JSON object");
    let parsed: unknown;
    try {
      parsed = parsedOnce !== undefined ? parsedOnce : JSON.parse(jsonText);
    } catch {
      throw new Error("coverage audit returned malformed JSON");
    }
    const validated = coverageResultSchema.safeParse(parsed);
    if (validated.success) return validated.data.missing;
    // FAIL-OPEN INVERSION GUARD: a GDD with 31+ uncovered items used to fail
    // the schema, which skipped the audit entirely — the WORSE the build, the
    // MORE likely delivery proceeded unchecked. Clamp instead of reject.
    const raw = (parsed as { missing?: unknown }).missing;
    if (Array.isArray(raw)) {
      const clamped = raw
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .slice(0, 30)
        .map((x) => x.slice(0, 300));
      if (clamped.length > 0 || raw.length === 0) {
        getLoggerSafe().warn("Coverage audit output clamped to schema bounds", {
          rawCount: raw.length,
          kept: clamped.length,
        });
        return clamped;
      }
    }
    throw new Error("coverage audit output failed schema validation");
  }
}

const COVERAGE_SYSTEM = `You audit whether a completed milestone ladder covers everything its game design document schedules.
Be strict about scheduled content (element tables, mechanics lists, screens, win/lose rules) and lenient about aspiration (KPIs, live-ops roadmaps, marketing).
Only report an item as missing when no milestone's scope or result plausibly includes it. Respond ONLY with the requested JSON.`;

const coverageResultSchema = z.object({
  missing: z.array(z.string().min(1).max(300)).max(30),
});

/** Tolerant extraction: find the outermost balanced {...} in the reply. */
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
