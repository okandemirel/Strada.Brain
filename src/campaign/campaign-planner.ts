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
import { streamOrChatText } from "../agents/providers/provider.interface.js";
import { getLoggerSafe } from "../utils/logger.js";
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
- Every element the GDD schedules must end its milestone with a real, BOUND visual: source it with unity_my_assets (local cache) or unity_my_assets_cloud (the account's full purchased library) first, generate it when nothing fits — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for dimensional ones (stages, characters), unity_prerender_frames to turn a 3D prefab into glossy 2D angle frames (the GDD's prerendered-character pipeline) — and bind it into the element's prefab. Code for an element without its visual is a milestone that is not done.
- Never plan a milestone whose output is a question for the user, and never re-plan what the GDD already specifies — the design document is the complete instruction.
- A sprint prompt must be self-contained: it cannot assume a previous sprint's conversation is remembered, only that its commits landed in the repo. Reference the GDD by its project-relative path (given below) rather than restating it.
- Keep each prompt focused: 150-600 words. Cover the milestone, don't narrate the whole GDD.

Respond ONLY with JSON:
{"milestones": [{"title": "Sprint A — ...", "prompt": "..."}, ...]}`;

export function windowGdd(gddText: string): string {
  if (gddText.length <= GDD_FULL_CHARS) return gddText;
  const head = gddText.slice(0, GDD_HEAD_CHARS);
  const tail = gddText.slice(-GDD_TAIL_CHARS);
  const middle = gddText.slice(GDD_HEAD_CHARS, -GDD_TAIL_CHARS);
  // Structural skeleton of the elided middle: headings and table rows carry
  // the schedules; prose is what gets dropped.
  const outline = middle
    .split("\n")
    .filter((line) => /^\s*(#{1,6}\s|\|)/.test(line))
    .join("\n")
    .slice(0, GDD_OUTLINE_CHARS);
  return [
    head,
    `\n[... middle prose elided; its full structural outline (every heading and table row) follows ...]\n`,
    outline,
    `\n[... end of middle outline ...]\n`,
    tail,
  ].join("\n");
}

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
      `<gdd>\n${windowGdd(gddText)}\n</gdd>\n\n` +
      `<completed-ladder>\n${ladderSummary}\n</completed-ladder>\n\n` +
      `List the concrete items the GDD schedules (mechanics, game elements, blockers, set-pieces, screens, systems) that NO milestone above covered or delivered. Respond ONLY with JSON: {"missing": ["<item>: <one-line what is missing>", ...]} — an empty array when the ladder covers the GDD.`;

    const response = await streamOrChatText(this.provider, COVERAGE_SYSTEM, userMessage);
    const jsonText = extractJsonObject(response.text ?? "");
    if (!jsonText) throw new Error("coverage audit returned no JSON object");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("coverage audit returned malformed JSON");
    }
    const validated = coverageResultSchema.safeParse(parsed);
    if (!validated.success) throw new Error("coverage audit output failed schema validation");
    return validated.data.missing;
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
