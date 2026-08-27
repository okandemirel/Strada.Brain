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

/** GDDs run to megabytes; the ladder is shaped by the design's structure, not
 * its prose. First + last chunks keep the intro/pillars and the schedules
 * (element tables live near the end, measured in the PixelFlow GDD). */
const GDD_HEAD_CHARS = 10_000;
const GDD_TAIL_CHARS = 6_000;

const PLANNER_SYSTEM = `You are a campaign planner for an autonomous game-development system.

You receive a game design document (GDD) for a Unity project built with the Strada.Core framework, and you produce the MILESTONE LADDER: the ordered list of sprints that builds the whole game, start to finish.

Rules:
- 2 to 12 milestones, ordered strictly by dependency: foundations first (project scaffolding, core simulation), then mechanics/elements in the GDD's own groupings, then content (levels), then integration.
- Each milestone's "prompt" is the COMPLETE kick prompt an agent will execute without you in the room. It must name: its scope (the GDD sections/elements it covers), the architecture pattern to follow (the project's existing module pattern — reference it by name once foundations exist), the verification bar (headless compile green, the relevant PlayMode tests green and UNFILTERED, a captured frame proving something renders), commit discipline (commit per logical unit), and what to produce at the end of the sprint.
- The FINAL milestone is always integration + delivery: full PlayMode suite green with no filter, the assembled scene actually running the game, and a DELIVERY REPORT summarizing what was built against the GDD.
- Every element the GDD schedules must end its milestone with a real, BOUND visual: source it with unity_my_assets first, generate it when nothing fits — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for dimensional ones (stages, characters) — and bind it into the element's prefab. Code for an element without its visual is a milestone that is not done.
- Never plan a milestone whose output is a question for the user, and never re-plan what the GDD already specifies — the design document is the complete instruction.
- A sprint prompt must be self-contained: it cannot assume a previous sprint's conversation is remembered, only that its commits landed in the repo. Reference the GDD by its project-relative path (given below) rather than restating it.
- Keep each prompt focused: 150-600 words. Cover the milestone, don't narrate the whole GDD.

Respond ONLY with JSON:
{"milestones": [{"title": "Sprint A — ...", "prompt": "..."}, ...]}`;

function windowGdd(gddText: string): string {
  if (gddText.length <= GDD_HEAD_CHARS + GDD_TAIL_CHARS + 200) return gddText;
  const head = gddText.slice(0, GDD_HEAD_CHARS);
  const tail = gddText.slice(-GDD_TAIL_CHARS);
  return `${head}\n\n[...${gddText.length - GDD_HEAD_CHARS - GDD_TAIL_CHARS} chars elided...]\n\n${tail}`;
}

export class CampaignPlanner {
  constructor(private readonly provider: IAIProvider | undefined) {}

  /**
   * Build the milestone ladder for a campaign. Throws on provider outage or
   * on structurally invalid output (caller fails the campaign with the cause
   * — a campaign that cannot plan must not silently degrade into one giant
   * sprint, which is exactly the failure mode the ladder exists to prevent).
   */
  async planMilestones(gddText: string, gddPath: string): Promise<MilestoneLadder> {
    if (!this.provider) {
      throw new Error("campaign planning requires an LLM provider");
    }

    const userMessage =
      `GDD project-relative path: ${gddPath}\n\n` +
      `<gdd>\n${windowGdd(gddText)}\n</gdd>\n\n` +
      `Produce the milestone ladder for this game.`;

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
}

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
