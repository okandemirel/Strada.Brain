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
import { stripLeakedReasoning } from "../agents/leaked-reasoning.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { getLoggerSafe } from "../utils/logger.js";
import { streamOrChatText } from "../agents/providers/provider.interface.js";
import { milestoneLadderSchema } from "./types.js";
import type { MilestoneLadder, PlannedLadder } from "./types.js";
import { measureGddScope, uncoveredSections, type GddScope } from "./gdd-scope.js";

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

/** The planner's instructions, sized by the GDD's measured scope (see gdd-scope.ts). */
export function plannerSystem(scope: GddScope): string {
  const asks: string[] = [];
  if (scope.asks.ui) asks.push("UI/screen flow (every screen the GDD names, wired Home → play → result)");
  if (scope.asks.audio) asks.push("audio (music and SFX bound to AudioSources in the shipped scenes)");
  if (scope.asks.onboarding) asks.push("onboarding/tutorial (FTUE)");
  if (scope.asks.save) asks.push("save/persistence");
  if (scope.asks.settings) asks.push("settings/options");
  if (scope.asks.performance) asks.push("performance targets (the GDD's fps/boot numbers, measured in the built player)");
  if (scope.asks.build) asks.push("the platform build (a runnable artifact for the GDD's platform)");
  const counted =
    `Measured scope of this GDD: ${scope.headings.length} sections, ${scope.elements} scheduled elements` +
    (scope.levels !== undefined ? `, ${scope.levels} levels` : "") +
    `, ${scope.screens} named screens.`;
  return `You are a campaign planner for an autonomous game-development system.

You receive a game design document (GDD) for a Unity project built with the Strada.Core framework, and you produce the MILESTONE LADDER: the ordered list of sprints that builds the whole game, start to finish.

${counted}

Rules:
- ${scope.minMilestones} to ${scope.maxMilestones} milestones (sized from the scope above), ordered strictly by dependency: foundations first (project scaffolding, core simulation), then mechanics/elements in the GDD's own groupings, then content (levels), then the non-code areas the GDD asks for, then integration.
- Every milestone returns "coveredSections": the GDD section headings it covers, spelled EXACTLY as the document's headings — the union over the ladder must cover every section of the document that describes work; a section you leave out is reported as unplanned.
- Every milestone returns "deliverables": the concrete things it leaves behind (scenes, prefabs, systems, screens, clips, data), so the sprint can be measured against them.
- The whole shipping list is planned unless the GDD explicitly excludes an item — then it goes in "excluded" with the GDD's own reason. This GDD asks for: ${asks.length > 0 ? asks.join("; ") : "no non-code areas beyond the core game (verify against the document)"}.
- Each milestone's "prompt" is the COMPLETE kick prompt an agent will execute without you in the room. It must name: its scope (the GDD sections/elements it covers), the architecture pattern to follow (the project's existing module pattern — reference it by name once foundations exist), the verification bar (headless compile green, the relevant PlayMode tests green and UNFILTERED, a captured frame proving something renders), commit discipline (commit per logical unit), and what to produce at the end of the sprint.
- The FINAL milestone is always integration + delivery: full PlayMode suite green with no filter, the assembled scene actually running the game, and a DELIVERY REPORT summarizing what was built against the GDD.
- The FINAL milestone also owns BUILD HYGIENE: it must leave EXACTLY ONE obvious entry scene enabled in Build Settings — the scene that runs the game — with every verification/scaffolding scene the campaign created (InitTestScene*, *Verification, *Verified, *Showcase, *Boundary, Assembled*) DISABLED in Build Settings — not deleted: the write-back carries only deletions of files the system itself wrote — and its report must name the entry scene and list what it disabled.
- Every element the GDD schedules must end its milestone with a real, BOUND visual: source it with unity_my_assets (local cache) or unity_my_assets_cloud (the account's full purchased library) first, generate it when nothing fits — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for dimensional ones (stages, characters) — both use the machine's installed open-weights model automatically and SAY when they fell back to a procedural placeholder; a placeholder is not the element's visual, unity_prerender_frames to turn a 3D prefab into 2D angle frames in the project's own style when the GDD wants 2D rendered from 3D — and bind it into the element's prefab. Code for an element without its visual is a milestone that is not done.
- Never plan a milestone whose output is a question for the user, and never re-plan what the GDD already specifies — the design document is the complete instruction.
- A sprint prompt must be self-contained: it cannot assume a previous sprint's conversation is remembered, only that its commits landed in the repo. Reference the GDD by its project-relative path (given below) rather than restating it.
- Keep each prompt focused: 150-600 words. Cover the milestone, don't narrate the whole GDD.

Respond ONLY with JSON:
{"milestones": [{"title": "Sprint A — ...", "prompt": "...", "coveredSections": ["<heading>", ...], "deliverables": ["<thing>", ...]}, ...], "excluded": ["<item>: <the GDD's reason>", ...]}`;
}

/**
 * MAP-REDUCE for a document too large to plan from whole (2026-09-10).
 * windowGdd kept a head, a tail and an outline of the middle — a 300k GDD's
 * middle sections (element schedules, level ladders, art direction) reached
 * the planner as heading lines. Now every section is briefed by the model
 * on its own (its elements, rules, screens, numbers, assets — the section's
 * own names and figures), and the planner plans from the briefs, so nothing
 * the document schedules is invisible. A section whose brief fails is
 * represented by its structural outline and counted, never dropped.
 */
export const GDD_BRIEF_CHUNK_CHARS = 40_000;
export const GDD_BRIEF_MAX_CHUNKS = 16;

const BRIEF_SYSTEM = `You brief a planner on ONE section of a game design document.
List everything the section specifies that would need building or measuring: scheduled elements (with their unlock tags), mechanics and rules, screens and UI flow, systems, content counts (levels, worlds, waves), numbers (frame rate, timings, budgets, sizes), assets (art, audio, VFX, animation), platform and build requirements, save/progression rules.
Keep the section's own names and numbers exactly as written. Omit marketing, KPIs and aspiration.
At most 350 words, plain text, first line = the section heading.`;

const SECTION_LINE_RE = /^\s{0,3}(?:#{1,3}\s+\S|\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z][^\n]{2,70}$)/;

/** The document cut at its headings into chunks of at most `chunkChars`, tiny sections merged, oversize ones split at paragraphs. */
export function splitGddSections(gddText: string, chunkChars: number = GDD_BRIEF_CHUNK_CHARS, maxChunks: number = GDD_BRIEF_MAX_CHUNKS): Array<{ heading: string; text: string }> {
  const lines = gddText.split(/\r?\n/);
  const sections: Array<{ heading: string; text: string }> = [];
  let heading = "(start of document)";
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) sections.push({ heading, text });
    buffer = [];
  };
  for (const line of lines) {
    if (SECTION_LINE_RE.test(line)) {
      flush();
      heading = line.replace(/^\s{0,3}#{1,3}\s+/, "").trim();
    }
    buffer.push(line);
  }
  flush();
  // Oversize sections split at paragraph boundaries.
  const sized: Array<{ heading: string; text: string }> = [];
  for (const sec of sections) {
    if (sec.text.length <= chunkChars) { sized.push(sec); continue; }
    // A paragraph longer than a chunk (a converted document with no blank
    // lines) is cut at whitespace so the bound holds.
    const paragraphs = sec.text.split(/\n\s*\n/).flatMap((para) => {
      const pieces: string[] = [];
      let rest = para;
      while (rest.length > chunkChars) {
        const cut = Math.max(rest.lastIndexOf("\n", chunkChars), rest.lastIndexOf(" ", chunkChars), Math.floor(chunkChars / 2));
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      pieces.push(rest);
      return pieces;
    });
    let part: string[] = []; let partLen = 0; let index = 1;
    for (const para of paragraphs) {
      if (partLen + para.length > chunkChars && part.length > 0) {
        sized.push({ heading: `${sec.heading} (part ${index++})`, text: part.join("\n\n") });
        part = []; partLen = 0;
      }
      part.push(para); partLen += para.length + 2;
    }
    if (part.length > 0) sized.push({ heading: index > 1 ? `${sec.heading} (part ${index})` : sec.heading, text: part.join("\n\n") });
  }
  // Tiny neighbours merged, and the whole list held to maxChunks by merging.
  const merged: Array<{ heading: string; text: string }> = [];
  for (const sec of sized) {
    const last = merged[merged.length - 1];
    if (last && last.text.length + sec.text.length + 2 <= chunkChars && (last.text.length < chunkChars / 4 || sec.text.length < chunkChars / 4)) {
      last.text = `${last.text}\n\n${sec.text}`;
      last.heading = `${last.heading} + ${sec.heading}`;
    } else merged.push({ ...sec });
  }
  while (merged.length > maxChunks) {
    // Merge the smallest adjacent pair.
    let best = 0;
    for (let i = 0; i + 1 < merged.length; i++) {
      if (merged[i]!.text.length + merged[i + 1]!.text.length < merged[best]!.text.length + merged[best + 1]!.text.length) best = i;
    }
    merged[best] = { heading: `${merged[best]!.heading} + ${merged[best + 1]!.heading}`, text: `${merged[best]!.text}\n\n${merged[best + 1]!.text}` };
    merged.splice(best + 1, 1);
  }
  return merged;
}

/** The section's headings, tables, lists and short definition lines — what stands in for a brief that could not be made. */
function structuralOutline(text: string, cap = 4_000): string {
  return text
    .split("\n")
    .filter((line) => /^\s*(#{1,6}\s|\||[-*•]\s|\d{1,3}[.)]\s)/.test(line) || (/^\s*[A-ZĞÜŞİÖÇ][^:\n]{2,60}:\s+\S/.test(line) && line.length <= 160))
    .join("\n")
    .slice(0, cap);
}

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
  async planMilestones(gddText: string, gddPath: string, styleNote?: string): Promise<PlannedLadder> {
    if (!this.provider) {
      throw new Error("campaign planning requires an LLM provider");
    }
    const scope = measureGddScope(gddText);
    const system = plannerSystem(scope);
    const planning = await this.gddForPlanning(gddText);

    const userMessage =
      `GDD project-relative path: ${gddPath}\n\n` +
      (styleNote ? `Derived style profile (stored at style.json — generators read it): ${styleNote}\n\n` : "") +
      (planning.briefed
        ? `<gdd-briefs sections="${planning.sections}" original-chars="${gddText.length}">\n${planning.text}\n</gdd-briefs>\n\n`
        : `<gdd>\n${planning.text}\n</gdd>\n\n`) +
      `Produce the milestone ladder for this game.`;

    // One transient failure (provider blink, malformed reply) used to fail
    // the whole campaign terminally at its very first step. One retry.
    let lastError: unknown;
    for (let round = 0; round < 2; round++) {
      try {
        // A RETRY THAT CHANGES NOTHING CHANGES NOTHING. The second round sent
        // the identical message, so a model that answered in prose answered in
        // prose again and the campaign failed at its first step (measured live
        // 2026-09-12 00:42). The second ask names what was wrong with the
        // first reply.
        const ask = round === 0
          ? userMessage
          : `${userMessage}\n\nYour previous reply could not be used: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }. Do NOT think out loud and do NOT restate the GDD: the FIRST character of your reply must be "{" and the last must be "}". No prose, no explanation, no markdown fence, no <reasoning> block.`;
        let ladder = await this.planOnce(system, ask);
        let uncovered = uncoveredSections(scope.headings, ladder.milestones.flatMap((m) => m.coveredSections));
        if (uncovered.length > 0) {
          // Once: name the sections nobody claimed and ask for a ladder that
          // does. What is still unclaimed after that is recorded, never hidden.
          getLoggerSafe().info("Campaign plan leaves GDD sections unclaimed — asking once more", { uncovered: uncovered.slice(0, 12) });
          try {
            const again = await this.planOnce(
              system,
              `${userMessage}\n\nYour previous ladder claimed no milestone for these GDD sections: ${uncovered.map((h) => `"${h}"`).join(", ")}. ` +
                "Return the ladder again with every one of them covered by some milestone's coveredSections (add or extend milestones), or listed in \"excluded\" with the GDD's own reason.",
            );
            const againUncovered = uncoveredSections(scope.headings, again.milestones.flatMap((m) => m.coveredSections));
            if (againUncovered.length <= uncovered.length) {
              ladder = again;
              uncovered = againUncovered;
            }
          } catch (err) {
            getLoggerSafe().warn("Second planning round failed — keeping the first ladder", { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { ...ladder, uncoveredSections: uncovered, totalSections: scope.headings.length, minMilestones: scope.minMilestones, maxMilestones: scope.maxMilestones };
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
    // TWO SHORT ANSWERS INSTEAD OF ONE LONG ONE. A whole ladder — twenty
    // milestones with their prompts — is a reply some models cannot finish:
    // measured live 2026-09-12, every attempt was spent enumerating the GDD's
    // headings and the campaign failed at its first step. Asking for the
    // titles alone, then each prompt on its own, is the same ladder in replies
    // any model can complete.
    try {
      const staged = await this.planInStages(system, userMessage, scope);
      const uncovered = uncoveredSections(scope.headings, staged.milestones.flatMap((m) => m.coveredSections));
      getLoggerSafe().warn("Campaign ladder planned in stages after the single-reply plan failed", {
        milestones: staged.milestones.length,
        cause: lastError instanceof Error ? lastError.message : String(lastError),
      });
      return { ...staged, uncoveredSections: uncovered, totalSections: scope.headings.length, minMilestones: scope.minMilestones, maxMilestones: scope.maxMilestones };
    } catch (err) {
      getLoggerSafe().warn("Staged planning failed too", { error: err instanceof Error ? err.message : String(err) });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * The ladder in two kinds of short reply: the titles and their sections
   * first, then one prompt per milestone. Every reply is small enough for a
   * model that would never finish the whole ladder in one answer.
   */
  private async planInStages(system: string, userMessage: string, scope: GddScope): Promise<MilestoneLadder> {
    if (!this.provider) throw new Error("campaign planning requires an LLM provider");
    // THE HEADINGS, NOT THE DOCUMENT. Sending the whole GDD and asking to
    // "cover every section" invited the model to enumerate all eighty headings
    // inside its reasoning and never answer (measured live 2026-09-12 01:10).
    // They are already measured; grouping a given list is a small answer.
    const headingList = scope.headings.map((h, i) => `${i + 1}. ${h}`).join("\n");
    const titlesAsk =
      `These are the section headings of the game's design document, in order:\n${headingList}\n\n` +
      `Group them into between ${scope.minMilestones} and ${scope.maxMilestones} build milestones, in order, ` +
      `each covering consecutive headings. Reply with this JSON and NOTHING else — no prose, no <reasoning>, no fence:\n` +
      `{"milestones":[{"title":"…","coveredSections":["…"]}]}`;
    let titles = this.readStagedTitles(
      (await streamOrChatText(this.provider, system, titlesAsk, { maxTokens: CampaignPlanner.STAGE_OUTPUT_TOKENS })).text ?? "",
    );
    if (titles.length < 2) {
      // THE DOCUMENT'S OWN SHAPE. A ladder does not need a model to exist: the
      // GDD's top-level sections are milestones, and a model that cannot
      // group a list can still write one sprint instruction at a time.
      titles = groupHeadingsIntoMilestones(scope);
      getLoggerSafe().warn("Staged planning grouped the GDD's headings itself — the model returned no titles", {
        milestones: titles.length,
      });
    }
    if (titles.length < 2) throw new Error("staged planning: no milestone titles");

    const milestones: MilestoneLadder["milestones"] = [];
    for (const [index, item] of titles.entries()) {
      const promptAsk =
        `${userMessage}\n\nThis is step two, milestone ${index + 1} of ${titles.length}: "${item.title}"` +
        `${item.coveredSections.length > 0 ? ` covering ${item.coveredSections.map((h) => `"${h}"`).join(", ")}` : ""}.\n` +
        `Write the sprint instruction for THIS milestone only: what to build, in this project, with what proof. ` +
        `End it by demanding a CAPTURED FRAME of what was built, so the visual gate can run. ` +
        `Reply with the instruction text itself — no JSON, no title, no preamble.`;
      const reply = await streamOrChatText(this.provider, system, promptAsk, { maxTokens: CampaignPlanner.STAGE_OUTPUT_TOKENS });
      // ROOM FOR THE DEMAND. Truncating to the cap, appending the capture
      // requirement and truncating again produced an 8 000-character prompt
      // with the requirement cut off — the gate unarmed and nobody the wiser
      // (Codex 2026-09-12 P#15).
      const prompt = stripLeakedReasoning(reply.text ?? "").text.trim()
        .slice(0, CampaignPlanner.PROMPT_CAP - CampaignPlanner.CAPTURE_DEMAND.length - 2);
      // A milestone with no instruction is not a milestone; the schema's own
      // floor (40 characters) is the measure.
      if (prompt.length < 40) continue;
      // AN INSTRUCTION IS PROSE. A model that answers step two with the
      // ladder-shaped JSON again produced a "sprint instruction" that was
      // literally {"milestones":[…]} — with the capture demand appended to it
      // (Codex 2026-09-12 P#9).
      if (looksLikeJsonEcho(prompt)) {
        getLoggerSafe().warn("Staged planning got JSON where a sprint instruction belongs — milestone dropped", {
          milestone: item.title.slice(0, 80),
        });
        continue;
      }
      // THE VISUAL GATE IS ARMED BY THE SPRINT'S OWN INSTRUCTION, and a model
      // writing one instruction at a time forgets to ask for the frame: the
      // live 14-sprint ladder left four sprints ungated (measured 2026-09-12
      // 02:56). Asked for above, and added here when it is still missing — so
      // the sprint genuinely demands the frame rather than the gate arming on
      // boilerplate nobody asked for (the 2026-09-04 audit).
      // …and the demand must be a demand for VISUAL PROOF, not the substring
      // "captur": "implement input capture" armed nothing and asked for
      // nothing (P#15).
      const gated = VISUAL_PROOF_RE.test(prompt)
        ? prompt
        : `${prompt.replace(/\s+$/, "")}${CampaignPlanner.CAPTURE_DEMAND}`;
      milestones.push({ title: item.title, prompt: gated, coveredSections: item.coveredSections, deliverables: [] });
    }
    const validated = milestoneLadderSchema.safeParse({ milestones, excluded: [] });
    if (!validated.success) {
      throw new Error(`staged planning produced no usable ladder (${z.prettifyError(validated.error).slice(0, 200)})`);
    }
    return validated.data;
  }

  /** Titles + sections out of a step-one reply, however it was wrapped. */
  private readStagedTitles(text: string): Array<{ title: string; coveredSections: string[] }> {
    for (const candidate of balancedJsonObjects(stripLeakedReasoning(text).text).reverse()) {
      try {
        const parsed = JSON.parse(candidate) as { milestones?: Array<{ title?: unknown; coveredSections?: unknown }> };
        const rows = Array.isArray(parsed.milestones) ? parsed.milestones : [];
        const titles = rows
          .map((r) => ({
            title: typeof r.title === "string" ? r.title.trim().slice(0, 200) : "",
            coveredSections: Array.isArray(r.coveredSections)
              ? r.coveredSections.filter((h): h is string => typeof h === "string" && h.length > 0).slice(0, 40)
              : [],
          }))
          .filter((r) => r.title.length > 0)
          .slice(0, 24);
        if (titles.length >= 2) return titles;
      } catch {
        continue;
      }
    }
    return [];
  }

  /**
   * The text the planner plans from: the document itself up to GDD_FULL_CHARS,
   * otherwise one model brief per section (see splitGddSections). Failed briefs
   * fall back to the section's structural outline and are counted.
   */
  async gddForPlanning(gddText: string): Promise<{ text: string; briefed: boolean; sections: number; failed: number }> {
    if (gddText.length <= GDD_FULL_CHARS || !this.provider) {
      return { text: gddText.length <= GDD_FULL_CHARS ? gddText : windowGdd(gddText), briefed: false, sections: 0, failed: 0 };
    }
    const chunks = splitGddSections(gddText);
    const briefs: string[] = [];
    let failed = 0;
    for (const chunk of chunks) {
      try {
        const response = await streamOrChatText(this.provider, BRIEF_SYSTEM, `<section heading="${chunk.heading.replace(/"/g, "'")}">\n${chunk.text}\n</section>`);
        const brief = stripLeakedReasoning(response.text ?? "").text.trim();
        if (brief.length === 0) throw new Error("empty brief");
        briefs.push(brief.slice(0, 6_000));
      } catch (err) {
        failed++;
        getLoggerSafe().warn("GDD section brief failed — using its structural outline", {
          heading: chunk.heading.slice(0, 80),
          error: err instanceof Error ? err.message : String(err),
        });
        briefs.push(`${chunk.heading}\n[brief could not be made — structural outline follows]\n${structuralOutline(chunk.text)}`);
      }
    }
    getLoggerSafe().info("GDD briefed section by section for planning", { chars: gddText.length, sections: chunks.length, failed });
    const text =
      `[This GDD is ${gddText.length} characters — beyond the whole-document window — so it was briefed section by section: ` +
      `${chunks.length} sections${failed > 0 ? `, ${failed} represented by outline only (brief failed)` : ""}. Every section is below.]\n\n` +
      briefs.join("\n\n---\n\n");
    return { text, briefed: true, sections: chunks.length, failed };
  }

  /** Output budget for a ladder reply (see planOnce). */
  private static readonly PLAN_OUTPUT_TOKENS = 8000;
  /** One stage of the staged plan: a short answer by construction. */
  private static readonly STAGE_OUTPUT_TOKENS = 2500;
  /** The schema's own ceiling for a sprint instruction. */
  private static readonly PROMPT_CAP = 8000;
  /** What arms the visual gate, appended when the model did not ask for it. */
  private static readonly CAPTURE_DEMAND =
    "\n\nFinish by CAPTURING A FRAME of what this sprint built (unity_capture_frame) and name the captured file in your report — a sprint that shows nothing is not done. " +
    // ONE LOCATION CONTRACT. The frame reader only counts what is under
    // Recordings/ — a picture in Assets/ is an art asset and must not stand in
    // for a frame of the running game — and a sprint told to write
    // "docs/sprints/m2_frame.png" left the visual gate with nothing to read
    // (Codex 2026-09-12 R#9).
    "The frame must land under Recordings/ (that is where the delivery gate reads it from); a picture written anywhere else is not evidence this system can see.";

  private async planOnce(system: string, userMessage: string): Promise<MilestoneLadder> {
    if (!this.provider) {
      throw new Error("campaign planning requires an LLM provider");
    }
    // A LADDER IS A LONG ANSWER. Sixteen to twenty milestones, each with a
    // prompt and its covered sections, does not fit in a provider's default
    // reply budget — and a model that thinks out loud first never reaches the
    // JSON at all: measured live 2026-09-12 00:52, the whole reply was an
    // unterminated <reasoning> block listing the GDD's headings.
    const response = await streamOrChatText(this.provider, system, userMessage, {
      maxTokens: CampaignPlanner.PLAN_OUTPUT_TOKENS,
    });
    const text = response.text ?? "";
    // EVERY balanced object, last first. Taking the first "{" in the reply
    // handed the parser whatever brace the model's prose happened to contain,
    // and the campaign failed at its first step with "returned no JSON
    // object" — measured live 2026-09-12 00:42 on a 1 458-line GDD.
    const stripped = stripLeakedReasoning(text);
    const candidates = balancedJsonObjects(stripped.text);
    if (candidates.length === 0) {
      getLoggerSafe().warn("Campaign planner reply carried no JSON object", {
        reply: text.slice(0, 400),
        reasoningOnly: stripped.reasoningOnly,
      });
      throw new Error(
        stripped.reasoningOnly
          ? "campaign planner spent its whole reply thinking out loud and never reached the JSON"
          : "campaign planner returned no JSON object",
      );
    }
    let lastIssues: string | undefined;
    for (const candidate of [...candidates].reverse()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const validated = milestoneLadderSchema.safeParse(parsed);
      if (validated.success) return validated.data;
      lastIssues = z.prettifyError(validated.error).slice(0, 300);
    }
    if (lastIssues !== undefined) {
      getLoggerSafe().warn("Campaign planner output failed validation", { issues: lastIssues });
      throw new Error("campaign planner output failed schema validation");
    }
    throw new Error("campaign planner returned malformed JSON");
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
    milestones: ReadonlyArray<{
      title: string;
      status?: string;
      resultExcerpt?: string;
      testVerdict?: string;
      testVerdictUnfiltered?: boolean;
      commitNote?: string;
      structureFindings?: readonly string[];
      gddClaims?: readonly string[];
      coverageGap?: string;
    }>,
  ): Promise<string[]> {
    if (!this.provider) {
      throw new Error("coverage audit requires an LLM provider");
    }
    // THE EVIDENCE, NOT THE TITLE. The audit used to see a title and 300
    // characters of prose, so a milestone whose plan mentioned an item read as
    // coverage of it — "plausibly includes it" was the instruction (Codex
    // 2026-09-12 R#15). What each sprint MEASURED travels now: its status, the
    // suite it ran, what it committed, what the structural and numeric checks
    // said about the shipped tree.
    const evidenceOf = (m: {
      status?: string; testVerdict?: string; testVerdictUnfiltered?: boolean; commitNote?: string;
      structureFindings?: readonly string[]; gddClaims?: readonly string[]; resultExcerpt?: string;
    }): string => {
      const facts: string[] = [];
      if (m.status) facts.push(`status: ${m.status}`);
      if (m.testVerdict) facts.push(`suite: ${m.testVerdict.slice(0, 160)}${m.testVerdictUnfiltered === true ? " (unfiltered)" : " (FILTERED or unknown scope)"}`);
      if (m.commitNote) facts.push(`landed: ${m.commitNote.slice(0, 200)}`);
      for (const line of (m.structureFindings ?? []).slice(0, 3)) facts.push(`shipped tree: ${line.slice(0, 160)}`);
      for (const line of (m.gddClaims ?? []).slice(0, 3)) facts.push(`document numbers: ${line.slice(0, 160)}`);
      if (m.resultExcerpt) facts.push(`report: ${m.resultExcerpt.slice(0, 300)}`);
      return facts.length > 0 ? facts.map((f) => `\n   ${f}`).join("") : "\n   (no evidence recorded)";
    };
    const ladderSummary = milestones
      .map((m, i) => `${i + 1}. ${m.title}${evidenceOf(m)}`)
      .join("\n");
    const userMessage =
      `<gdd>\n${windowGdd(gddText, GDD_AUDIT_FULL_CHARS)}\n</gdd>\n\n` +
      `<completed-ladder>\n${ladderSummary}\n</completed-ladder>\n\n` +
      `List the concrete items the GDD schedules (mechanics, game elements, blockers, set-pieces, screens, systems) that the EVIDENCE above does not show implemented and shipped. Respond ONLY with JSON: {"missing": ["<item>: <one-line what is missing>", ...]} — an empty array when every scheduled item has evidence behind it.`;

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

const COVERAGE_SYSTEM = `You audit whether a game design document's scheduled content is IMPLEMENTED AND SHIPPED, judged by the evidence each milestone carries.
Be strict about scheduled content (element tables, mechanics lists, screens, win/lose rules) and lenient about aspiration (KPIs, live-ops roadmaps, marketing).
A milestone's TITLE or PLAN is not coverage. Its evidence is: what it committed, what the suite measured, what the shipped tree and the document's own numbers say. An item whose only trace is a title, a plan or a promise in prose is MISSING.
Respond ONLY with the requested JSON.`;

const coverageResultSchema = z.object({
  missing: z.array(z.string().min(1).max(300)).max(30),
});

/** Tolerant extraction: find the outermost balanced {...} in the reply. */
/**
 * Every TOP-LEVEL balanced `{…}` span in the text, in order of appearance.
 *
 * The single-object extractor takes the first "{" and whatever balances it,
 * so a reply that explains itself before answering — or that shows a brace in
 * prose — hid the object entirely (measured live 2026-09-12).
 */
/**
 * A demand for VISUAL PROOF, which is what the gate is about. Testing for the
 * substring "captur" armed the gate on "implement input capture" and left it
 * unarmed on an instruction that asked for a screenshot (Codex 2026-09-12 P#15).
 */
const VISUAL_PROOF_RE =
  /\b(?:captur(?:e|ed|ing)\s+(?:a\s+)?(?:frame|screenshot|image|still)|screenshot|captured\s+frame|prerender(?:ed)?\s+frame|unity_capture_frame|unity_prerender_frames)\b/i;

export function balancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * The GDD's own shape as a ladder: consecutive headings in equal groups,
 * named by the first heading of each group.
 *
 * A ladder does not need a model to exist. When one cannot even group a list
 * of headings, this keeps the campaign moving and the model is asked only for
 * one sprint instruction at a time (measured live 2026-09-12).
 */
/** Is this reply the ladder JSON echoed back rather than an instruction? */
export function looksLikeJsonEcho(text: string): boolean {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  const objects = balancedJsonObjects(trimmed);
  if (objects.length === 0) return trimmed.startsWith("[");
  // A whole reply that IS one object, or that carries the ladder's own shape.
  return objects[0]!.length >= trimmed.length * 0.8 || /"milestones"\s*:/.test(trimmed);
}

export function groupHeadingsIntoMilestones(scope: GddScope): Array<{ title: string; coveredSections: string[] }> {
  const headings = scope.headings.filter((h) => h.trim().length > 0);
  if (headings.length === 0) return [];
  const target = Math.max(2, Math.min(scope.maxMilestones, Math.max(scope.minMilestones, Math.ceil(headings.length / 5))));
  const perGroup = Math.ceil(headings.length / target);
  const out: Array<{ title: string; coveredSections: string[] }> = [];
  for (let i = 0; i < headings.length; i += perGroup) {
    const group = headings.slice(i, i + perGroup);
    const first = group[0]!;
    out.push({
      // "3. CORE GAMEPLAY SYSTEM" → "Core gameplay system", with the number
      // dropped: a milestone title is a name, not a table-of-contents row.
      title: first.replace(/^\s*[\d.]+\s*/, "").slice(0, 200) || first.slice(0, 200),
      coveredSections: group.slice(0, 40),
    });
  }
  return out.slice(0, scope.maxMilestones);
}

function extractJsonObject(raw: string): string | undefined {
  // A leaked thinking block holds braces of its own; the audit used to
  // extract the first of them and report "malformed JSON" (2026-09-07).
  const text = stripLeakedReasoning(raw).text;
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
