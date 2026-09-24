/**
 * Does the delivered game LOOK like the GDD says it should?
 *
 * The capture gate proves a frame exists (size + a distinct hash). It cannot
 * say what is in it: 11351 frames of a flat coloured grid satisfied it while
 * the GDD asked for pixel-art canvases and glossy 3D-feel pigs (audited
 * 2026-09-03).
 *
 * This is DISCLOSURE, not a gate. A stylised look is a judgement call, the
 * model answering is fallible, and the structural check already refuses the
 * hard case (scenes that render nothing of the project's own art). What this
 * owes the reader is an honest sentence: what the GDD asks for, what the
 * newest frame of the running game shows, or exactly why neither could be
 * measured.
 *
 * Two defects sank the earlier attempts and are the contract here:
 *   1. The look description was read from the GDD's TABLE OF CONTENTS,
 *      because the extractor took the first heading match. The real section
 *      sits ~1100 lines below its TOC entry, so the LAST/longest candidate
 *      wins and a block that is mostly numbered headings is rejected.
 *   2. The vision question was routed through the fallback chain, whose
 *      capability flag is an OR across members and which strips the image for
 *      a text-only member — "yes I can see", answered blind. The caller must
 *      hand in a provider that claims vision on its OWN capabilities.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { getLoggerSafe } from "../utils/logger.js";
import { writtenBefore } from "./file-freshness.js";

/** Headings whose body describes how the game should look. */
const LOOK_HEADINGS = /^\s*(?:#{1,6}\s+)?(?:\d+[.\s]*)*\s*(art direction|visual (?:style|direction|identity)|look and feel|art style)\b/i;
/** A body this short is a table-of-contents line, not a description. */
const MIN_LOOK_CHARS = 200;
/** …and the floor for a short section that plainly describes the look. */
const MIN_SHORT_LOOK_CHARS = 8;
/** How much of the section to carry into the prompt. */
const MAX_LOOK_CHARS = 2000;
/** Directory entries the frame scan will walk before disclosing truncation. */
const FRAME_SCAN_BUDGET = 20_000;

export interface LookDescription {
  found: boolean;
  heading?: string;
  line?: number;
  text?: string;
  /** Why nothing usable was extracted, when found is false. */
  reason?: string;
}

/**
 * The GDD's own description of how the game should look.
 *
 * Candidates are every heading match; the winner is the LAST one whose body
 * is prose, because a document lists its sections before it writes them.
 */
/**
 * The art direction a gate should judge against: the document's own section
 * when it has one, and otherwise THE WHOLE DOCUMENT.
 *
 * extractLookDescription requires a prose section of at least MIN_LOOK_CHARS,
 * which a short, perfectly explicit brief fails — "Minimalist flat geometric
 * art: use solid colored squares." is 44 characters. Dropping it refused the
 * flat sprites the document asked for, and the only repair was to replace the
 * requested style (Codex 2026-09-11 F#3).
 */
export function artDirectionText(look: LookDescription | undefined, gddText: string | undefined): string | undefined {
  if (look?.found === true && look.text) return look.text;
  if (gddText === undefined) return undefined;
  // NOT the whole document. Handing everything to the style check made
  // "Solve geometric puzzles." in a Gameplay section read as a request for
  // flat geometric art, and the placeholder-art refusal was waived for a
  // document asking for hand-painted watercolour (Codex 2026-09-11 H#13).
  // Only the sentences that talk about the LOOK speak for the look.
  const sentences = gddText
    .split(/(?<=[.!?])\s+|\n+/)
    // A HEADING IS NOT A BRIEF: "## Art Direction" with nothing under it
    // reduced to "Art Direction", which contains an art word and became the
    // whole art direction (Codex 2026-09-11 J#22).
    // A HEADING IS NOT A BRIEF, numbered ("1. ART DIRECTION") as well as
    // markdown (Codex 2026-09-11 J#22, K#11).
    // A HEADING IS NOT A BRIEF: markdown ("## Art Direction"), numbered
    // ("1. ART DIRECTION") — and an ALL-CAPS fragment, because the sentence
    // splitter cuts a numbered title at its own full stop and the rest of it
    // arrives on its own (Codex 2026-09-11 J#22, K#11).
    .filter((line) => {
      const t = line.trim();
      if (/^#{1,6}\s+\S/.test(t)) return false;
      if (NUMBERED_HEADING_RE.test(t)) return false;
      // An ALL-CAPS line is a HEADING only when it reads like one: a few
      // words and no sentence punctuation. Demanding a lower-case letter threw
      // away "MINIMALIST FLAT GEOMETRIC ART: USE SOLID COLORED SQUARES." —
      // the entire requested style (Codex 2026-09-11 L#16).
      if (!/[a-z]/.test(t)) return !isShoutedHeading(t);
      return true;
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && ART_WORD_RE.test(line));
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * A numbered section title, in ANY case. Requiring ALL CAPS meant "2. Gameplay"
 * did not end the art section, and the gameplay text below it became the art
 * brief (Codex 2026-09-11 L#15).
 */
const NUMBERED_HEADING_RE = /^\s*\d+[.)]\s+[A-Z][^.!?:;]{2,48}$/;

/** A rule, a divider, a row of dashes: structure, not prose (L#15). */
const STRUCTURAL_LINE_RE = /^\s*(?:[-*_=~]\s*){3,}$|^\s*\|[\s|:-]*\|\s*$/;

/** Is this shouted line a TITLE rather than an instruction? */
function isShoutedHeading(line: string): boolean {
  if (/[.!?]$/.test(line)) return false;
  return line.split(/\s+/).filter(Boolean).length <= 6;
}

/** Words that make a sentence about the game's LOOK rather than its play. */
const ART_WORD_RE =
  // "look" is NOT here: "Players look for geometric clues" is a gameplay
  // sentence, and admitting it handed gameplay vocabulary to the style check
  // (Codex 2026-09-11 I#10). Only words that are about the artwork itself.
  /\b(?:art|artwork|arts|visual|visuals|sprite|sprites|palette|colour|color|colours|colors|monochrome|greyscale|grayscale|style|styles|aesthetic|illustration|illustrated|texture|textures|shading|shaded|pixel|painted|painting|watercolou?r|silhouette|line[- ]art)\b/i;

export function extractLookDescription(gddText: string): LookDescription {
  if (typeof gddText !== "string" || gddText.trim().length === 0) {
    return { found: false, reason: "the GDD text was empty" };
  }
  const lines = gddText.split("\n");
  const candidates: Array<{ heading: string; line: number; body: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = LOOK_HEADINGS.exec(lines[i] ?? "");
    if (!match) continue;
    // The art heading's own depth; a numbered top-level title counts as one.
    const headingDepth = /^\s*(#{1,6})\s+/.exec(lines[i] ?? "")?.[1]?.length ?? 1;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && body.join("\n").length < MAX_LOOK_CHARS * 2; j++) {
      const line = lines[j] ?? "";
      // Stop at the next heading of the same shape (a numbered top-level title)
      // …and at ANY markdown heading: the body used to run past "## Gameplay"
      // and swallow "Solve geometric puzzles.", which then read as a request
      // for flat geometric art (Codex 2026-09-11 I#10).
      // …whatever the body holds so far: the numbered guard kept the
      // body.length condition, so "1. ART DIRECTION" followed straight by
      // "2. GAMEPLAY" took the gameplay text as the art brief (Codex
      // 2026-09-11 K#11).
      if (NUMBERED_HEADING_RE.test(line)) break;
      // A SIBLING OR PARENT heading ends the section, even when the body is
      // still empty: "## Art Direction" immediately followed by "## Gameplay"
      // took that heading and its text as the art brief (Codex 2026-09-11
      // J#22). A DEEPER heading is a subsection of the art direction
      // ("### Palette") and belongs to it (B#23).
      const nextDepth = /^\s*(#{1,6})\s+\S/.exec(line)?.[1]?.length;
      if (nextDepth !== undefined && nextDepth <= headingDepth) break;
      body.push(line);
    }
    // Markdown heading markers are not prose: "## Art Direction" bodies full of
    // "### Palette" lines were rejected as a contents listing (Codex 2026-09-11 B#23).
    // A BRIEF WRITTEN INTO THE HEADING: "## Art Direction: Richly painted
    // watercolour environments." is the whole description, and taking only
    // the lines under it discarded the requested style (Codex 2026-09-11
    // K#11).
    const inline = /:\s*(\S.*)$/.exec((lines[i] ?? "").replace(/^\s*#{1,6}\s+/, ""))?.[1]?.trim();
    // …and a body made only of SUBHEADINGS is not a brief: "### Palette and
    // references" with nothing under it invented one (K#11).
    const prose = body.filter((l) => !/^\s*#{1,6}\s+\S/.test(l) && !STRUCTURAL_LINE_RE.test(l));
    const substantive = prose.join("\n").trim().length > 0;
    const bodyText = body.map((l) => l.replace(/^\s*#{1,6}\s+/, "")).join("\n").trim();
    candidates.push({
      heading: (match[1] ?? "").trim(),
      line: i + 1,
      // The inline brief is part of the description whether or not a body
      // follows it: dropping it the moment one line existed discarded the
      // requested style ("## Art Direction: Monochrome.") (L#16).
      body: inline ? `${inline}\n${bodyText}`.trim() : substantive ? bodyText : "",
    });
  }

  if (candidates.length === 0) {
    return { found: false, reason: "the GDD names no art-direction/visual-style section" };
  }

  // Reject a block that is mostly numbered headings: that is the contents
  // page, and quoting it as the look description is how the previous attempt
  // asked a model to compare a frame against a list of chapter titles.
  const isProse = (body: string): boolean => {
    const rows = body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (rows.length === 0) return false;
    const headingRows = rows.filter((l) => /^\d+[.\s]/.test(l) && l.length < 60).length;
    return headingRows / rows.length < 0.5;
  };

  // The LAST usable candidate wins, not the longest: a document puts its
  // contents page first and the real section later, and a TOC entry followed
  // by unrelated text can be longer than the section it points at.
  // A SHORT, EXPLICIT brief is still a brief: "Minimalist flat geometric art:
  // use solid colored squares." is 57 characters and says everything the gate
  // needs, while the 200-character floor exists to reject contents listings
  // (Codex 2026-09-11 F#3, H#13). Prose about the look, at least one
  // sentence's worth, counts.
  const usable = candidates
    // The HEADING already said this is art direction, so a short body under it
    // needs no art vocabulary of its own: "## Art Direction / Monochrome."
    // was dropped and the legitimate flat-art exemption lost (Codex I#10).
    .filter((c) => (c.body.length >= MIN_LOOK_CHARS || c.body.length >= MIN_SHORT_LOOK_CHARS) && isProse(c.body))
    .sort((a, b) => b.line - a.line);

  const best = usable[0];
  if (!best) {
    return {
      found: false,
      reason:
        `the ${candidates.length} art-direction heading(s) found held no prose — ` +
        "the longest was a contents listing or shorter than a description",
    };
  }
  return {
    found: true,
    heading: best.heading,
    line: best.line,
    text: best.body.slice(0, MAX_LOOK_CHARS),
  };
}

export interface FrameSelection {
  path?: string;
  capturedAtMs?: number;
  reason?: string;
  /** True when the walk hit its budget, so "newest" may not be the newest. */
  truncated?: boolean;
}

/**
 * The newest frame THIS sprint captured of the running game.
 *
 * Only under Recordings/: a picture in Assets/Art/Prerendered is an art asset,
 * and letting one stand in for a frame would prove the opposite of what this
 * measures. Bounded by the sprint's own start, the same rule the capture gate
 * uses, so a frame from an earlier campaign cannot answer for this one.
 */
export function selectGameplayFrame(projectRoot: string, sinceMs: number): FrameSelection {
  const root = join(projectRoot, "Recordings");
  if (!existsSync(root)) {
    return { reason: "the project has no Recordings/ directory" };
  }
  let scanned = 0;
  let truncated = false;
  let best: { path: string; mtime: number } | undefined;
  const stack = [root];
  while (stack.length > 0) {
    if (scanned >= FRAME_SCAN_BUDGET) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned++;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(png|jpg|jpeg)$/i.test(entry.name)) continue;
      try {
        const stat = statSync(full);
        // The same coarse-clock allowance as every evidence reader: a frame
        // written just after the sprint began can read a tick older than it.
        if (writtenBefore(stat.mtimeMs, sinceMs)) continue;
        if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs };
      } catch {
        /* unreadable entry */
      }
    }
  }
  if (!best) {
    return {
      reason: "no frame under Recordings/ was captured during this sprint",
      ...(truncated ? { truncated } : {}),
    };
  }
  return { path: best.path, capturedAtMs: best.mtime, ...(truncated ? { truncated } : {}) };
}

export interface VisualConformance {
  /** "checked" | "not-checked" — never a silent pass. */
  status: "checked" | "not-checked";
  /** The model's one-line answer, or why nothing was asked. */
  detail: string;
  /**
   * The model's yes/no on "does the frame show the described game" (2026-09-10).
   * Absent when unchecked or when the model gave no verdict line; only an
   * explicit `false` ever refuses anything, and only once.
   */
  matches?: boolean;
  framePath?: string;
  provider?: string;
  /**
   * WHY nothing was checked, as a token rather than a sentence (plan 6.12).
   * The delivery verdict must not classify a failure by grepping prose.
   */
  reason?: VisualNotMeasuredReason;
}

/**
 * The media type a frame actually is (CMP-18): its magic bytes when they are
 * at hand, else its extension. Frames may be PNG or JPEG, and a provider that
 * checks the declared type against the bytes refused every JPEG sent as
 * image/png — the look gate then never measured anything.
 */
export function frameMediaType(path: string, bytes?: Uint8Array): "image/png" | "image/jpeg" {
  if (bytes !== undefined && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes !== undefined && bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}

const VISION_SYSTEM =
  "You are shown one frame captured from a running game, and the game design document's own " +
  "description of how that game should look. Answer in ONE sentence: does the frame plausibly " +
  "show the described game, and what is the most visible difference? Judge the SUBJECT, not the " +
  "polish — an unfinished but correct scene is a match. Do not speculate about anything outside " +
  "the frame. Then, on a second line, write exactly `MATCH: yes` or `MATCH: no`.";

/** The verdict line, when the model wrote one. */
export function parseMatchLine(text: string): boolean | undefined {
  const m = /\bMATCH:\s*(yes|no)\b/i.exec(text);
  return m ? m[1]!.toLowerCase() === "yes" : undefined;
}

/**
 * Ask a provider that can actually see. `visionProvider` must claim vision on
 * its own capabilities — see ProviderManager.getVisionProvider, and never pass
 * a fallback chain.
 */
export async function judgeVisualConformance(params: {
  look: LookDescription;
  frame: FrameSelection;
  visionProvider: { provider: IAIProvider; name: string } | null;
}): Promise<VisualConformance> {
  const { look, frame, visionProvider } = params;
  if (!look.found) {
    return { status: "not-checked", reason: "no-look-description", detail: `visual conformance not checked — ${look.reason ?? "no look description"}` };
  }
  if (!frame.path) {
    return { status: "not-checked", reason: "no-frame", detail: `visual conformance not checked — ${frame.reason ?? "no frame"}` };
  }
  if (!visionProvider) {
    return {
      status: "not-checked",
      reason: "no-vision-provider",
      detail: "visual conformance not checked — no configured provider reports vision support",
    };
  }

  let imageBase64: string;
  let mediaType: "image/png" | "image/jpeg";
  try {
    const bytes = readFileSync(frame.path);
    imageBase64 = bytes.toString("base64");
    mediaType = frameMediaType(frame.path, bytes);
  } catch (err) {
    return {
      status: "not-checked",
      reason: "frame-unreadable",
      detail: `visual conformance not checked — the frame could not be read (${err instanceof Error ? err.message : String(err)})`,
      framePath: frame.path,
    };
  }

  try {
    const response = await visionProvider.provider.chat(
      VISION_SYSTEM,
      [
        {
          role: "user",
          content: [
            { type: "text", text: `The GDD says the game should look like this:\n\n${look.text ?? ""}` },
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          ],
        } as never,
      ],
      [],
    );
    const fullText = (response.text ?? "").trim();
    const answer = fullText.split("\n").find((l) => l.trim().length > 0 && !/^\s*MATCH:/i.test(l))?.trim().slice(0, 300) ?? "";
    const matches = parseMatchLine(fullText);
    if (answer.length === 0) {
      return {
        status: "not-checked",
        reason: "no-answer",
        detail: "visual conformance not checked — the vision provider returned no answer",
        framePath: frame.path,
        provider: visionProvider.name,
      };
    }
    return { status: "checked", detail: answer, ...(matches !== undefined ? { matches } : {}), framePath: frame.path, provider: visionProvider.name };
  } catch (err) {
    getLoggerSafe().warn("Visual conformance check failed", {
      provider: visionProvider.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "not-checked",
      reason: "provider-failed",
      detail: `visual conformance not checked — the vision provider failed (${err instanceof Error ? err.message : String(err)})`,
      framePath: frame.path,
      provider: visionProvider.name,
    };
  }
}

/** The delivery-report block. A not-checked result is stated, never omitted. */
export function renderVisualConformance(result: VisualConformance, frame: FrameSelection): string {
  const lines = ["**Does it look like the GDD?**"];
  if (result.status === "checked") {
    lines.push(
      `- ${result.matches === undefined ? "" : result.matches ? "MATCH — " : "NO MATCH — "}${result.detail}`,
      `- Judged from \`${result.framePath ?? "?"}\` by ${result.provider ?? "a vision provider"}.`,
    );
  } else {
    lines.push(`- ⚠️ ${result.detail}.`);
  }
  if (frame.truncated) {
    lines.push("- The frame scan hit its budget, so the frame judged may not be the newest one captured.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// VISUAL ACCEPTANCE — the verdict, not the paragraph (plan 6.12)
// ---------------------------------------------------------------------------
//
// "done" used to imply that what was produced also LOOKS right. Nothing
// measured that: the look check writes a prose block, and when it never ran —
// no vision provider, no frame, a throw, or a delivery that failed before
// reaching it — the delivery report simply said nothing about the look, which
// reads exactly like a check that passed.
//
// Visual fitness is therefore carried the way the other delivery proofs are
// (compileVerdict, playthroughVerdict, buildVerdict): a structured verdict on
// the milestone with three states and no fourth, silent one.
//
//   accepted     — a vision provider saw the frame and said it shows the game
//   refused      — it saw the frame and said it does NOT
//   not-measured — nobody judged it, and the reason is named
//
// A refusal is NEVER downgraded to "not measured": the mismatch is the
// measurement. And not-measured is never rendered as an absence — the report
// says so in words. This is disclosure plus one bounce, not a veto: the
// second mismatch is reported, never auto-refused (deliberate policy).

export type VisualAcceptanceStatus = "accepted" | "refused" | "not-measured";

/** Why nothing was measured. Machine-readable so no prose classifier is needed. */
export type VisualNotMeasuredReason =
  | "no-look-description"
  | "no-frame"
  | "no-vision-provider"
  | "frame-unreadable"
  | "provider-failed"
  | "no-answer"
  | "no-verdict-line"
  | "check-threw"
  | "never-ran";

export interface VisualAcceptance {
  status: VisualAcceptanceStatus;
  /** The model's sentence, or the reason nothing could be judged. */
  detail: string;
  reason?: VisualNotMeasuredReason;
  framePath?: string;
  provider?: string;
  /** A refusal that still stood when delivery went ahead (bounce budget spent). */
  unresolved?: boolean;
  /** Mismatch bounces spent on this milestone. */
  bounces?: number;
  /** The frame walk hit its budget, so the frame judged may not be the newest. */
  frameScanTruncated?: boolean;
}

/**
 * The verdict for a completed look check.
 *
 * `unresolved` is the caller's: only the gate knows whether it still had a
 * bounce to spend on a mismatch.
 */
export function visualAcceptance(
  result: VisualConformance,
  frame: FrameSelection,
  opts?: { unresolved?: boolean; bounces?: number },
): VisualAcceptance {
  const common = {
    ...(result.framePath ? { framePath: result.framePath } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(frame.truncated ? { frameScanTruncated: true } : {}),
    ...(opts?.bounces ? { bounces: opts.bounces } : {}),
  };
  if (result.status === "checked" && result.matches === true) {
    return { status: "accepted", detail: result.detail, ...common };
  }
  if (result.status === "checked" && result.matches === false) {
    // THE MISMATCH IS THE MEASUREMENT. Reporting it as "not measured" would
    // hide the one visual failure the system can actually see.
    return { status: "refused", detail: result.detail, ...(opts?.unresolved ? { unresolved: true } : {}), ...common };
  }
  if (result.status === "checked") {
    // An answer with no `MATCH:` line is not a verdict — and the sentence the
    // model did write is carried, because it may well describe a mismatch.
    return {
      status: "not-measured",
      reason: "no-verdict-line",
      detail: `the vision provider answered without a verdict line: "${result.detail}"`,
      ...common,
    };
  }
  return {
    status: "not-measured",
    reason: result.reason ?? "never-ran",
    detail: result.detail,
    ...common,
  };
}

/** The verdict when the look check never ran at all (a throw, or a delivery that failed first). */
export function visualAcceptanceNotRun(detail: string, reason: VisualNotMeasuredReason = "never-ran"): VisualAcceptance {
  return { status: "not-measured", reason, detail };
}

/** One sentence, for a status snapshot or a log line. Never silent. */
export function describeVisualAcceptance(a: VisualAcceptance | undefined): string {
  if (!a) return "visual acceptance NOT MEASURED: the look was never judged against the GDD";
  if (a.status === "accepted") return `visual acceptance: the frame shows the described game — ${a.detail}`;
  if (a.status === "refused") {
    return (
      `visual acceptance REFUSED: ${a.detail}` +
      (a.unresolved ? " (delivered with the refusal standing — the visual bounce was spent)" : "")
    );
  }
  return `visual acceptance NOT MEASURED: ${a.detail}`;
}

/**
 * The delivery-report block. ALWAYS rendered — an unmeasured look is stated,
 * never omitted, because omission reads as a pass.
 */
export function renderVisualAcceptance(a: VisualAcceptance | undefined): string {
  const lines = ["**Does it look like the GDD?**"];
  if (!a) {
    lines.push(
      "- ⚠️ VISUAL ACCEPTANCE NOT MEASURED — nothing judged the delivered look against the GDD, so nothing here says it looks right.",
    );
    return lines.join("\n");
  }
  if (a.status === "accepted") {
    lines.push(`- ✅ VISUAL ACCEPTANCE: MATCH — ${a.detail}`);
  } else if (a.status === "refused") {
    lines.push(
      `- ❌ VISUAL ACCEPTANCE: NO MATCH — ${a.detail}`,
      a.unresolved
        ? `- The refusal STANDS: the look was bounced ${a.bounces ?? 1}× and delivery went ahead anyway.`
        : "- The sprint was sent back to fix the look.",
    );
  } else {
    lines.push(`- ⚠️ VISUAL ACCEPTANCE NOT MEASURED — ${a.detail}. Nothing here says the delivery looks right.`);
  }
  if (a.status !== "not-measured") {
    lines.push(`- Judged from \`${a.framePath ?? "?"}\` by ${a.provider ?? "a vision provider"}.`);
  }
  if (a.frameScanTruncated) {
    lines.push("- The frame scan hit its budget, so the frame judged may not be the newest one captured.");
  }
  return lines.join("\n");
}

/** The caveat line for the delivery report's "how these greens were reached" list. */
export function visualAcceptanceCaveat(a: VisualAcceptance | undefined): string | undefined {
  if (!a) return "the delivered look was NEVER judged against the GDD — no visual acceptance was measured";
  if (a.status === "accepted") return undefined;
  if (a.status === "refused") {
    return a.unresolved
      ? `a vision model judged the delivered frame against the GDD's look and REFUSED it: ${a.detail}`
      : undefined;
  }
  return `visual acceptance was NOT measured — ${a.detail}`;
}

/**
 * The look block for a delivery report, from the milestones as persisted.
 *
 * Three cases, all of them explicit:
 *   a verdict was recorded  — render it
 *   only the old prose block exists (a row written before 6.12) — show it and
 *     say the verdict itself was not recorded, rather than reading it as a pass
 *   neither — say NOT MEASURED
 */
export function deliveryVisualBlock(
  milestones: ReadonlyArray<{ visualVerdict?: VisualAcceptance; visualConformance?: string }>,
): string {
  const reversed = [...milestones].reverse();
  const verdict = reversed.find((m) => m.visualVerdict)?.visualVerdict;
  if (verdict) return renderVisualAcceptance(verdict);
  const legacy = reversed.find((m) => m.visualConformance)?.visualConformance;
  if (legacy) {
    return `${legacy}\n- ⚠️ This disclosure predates the visual-acceptance verdict, so whether the look was ACCEPTED is not recorded.`;
  }
  return renderVisualAcceptance(undefined);
}
