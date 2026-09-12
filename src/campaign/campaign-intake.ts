/**
 * Campaign Intake — the "GDD shared / game idea written" detection.
 *
 * Conservative on purpose: a false positive here hijacks a normal message
 * into a multi-day build. The three shapes that qualify, in priority order:
 *
 *   1. A document attachment that extracts to text (the GDD itself) — sharing
 *      the file IS the instruction ("direkt bir GDD paylaşıldığında").
 *   2. Free text asking for the game IN an existing GDD ("GDD'deki oyunu yap",
 *      "build the game in the GDD") → build from docs/.
 *   3. Free text with an end-to-end build intent around a game idea
 *      ("şöyle bir oyun yap", "build this game: ...") → idea mode, which
 *      drafts the GDD first and stops at the single approval gate.
 *
 * Feature-level requests ("add a pause menu to my game") must NOT match:
 * those stay ordinary tasks.
 */

import type { IncomingMessage, Attachment } from "../channels/channel-messages.interface.js";
import { extractDocumentText } from "../agents/tools/document-text.js";

export type CampaignIntent =
  | { kind: "idea"; ideaText: string }
  | { kind: "gdd-attachment"; gddText: string; sourceName: string }
  | { kind: "gdd-from-docs"; path?: string };

/** End-to-end build intent. Narrow verbs of whole-game creation, TR + EN. */
const BUILD_INTENT_RE =
  /\b(baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan|build\s+(this|the|a|my)\s+game|make\s+(this|the|a|my)\s+game|develop\s+(this|the|a|my)\s+game|oyunu?n?u?\s+(yap|yazar\s+mısın|geliştir|inşa\s+et|kodla)|oyun\s+(yap|geliştir|yaz|kodla))\b/i;

/** Reference to an existing GDD document (in docs/, or "the GDD" generally). */
const GDD_REFERENCE_RE = /\b(gdd|game\s+design\s+doc(ument)?)\b/i;

/** A message that is ONLY an idea is long enough to design from. */
const MIN_IDEA_LENGTH = 40;

function isExtractableDocument(attachment: Attachment): boolean {
  if (attachment.type !== "document" && attachment.type !== "file") return false;
  return /\.(docx|odt|rtf|pdf|md|markdown|txt)$/i.test(attachment.name);
}

export function detectCampaignIntent(msg: IncomingMessage): CampaignIntent | undefined {
  const text = msg.text.trim();

  // 1. GDD as an attachment — the strongest, least ambiguous signal.
  for (const attachment of msg.attachments ?? []) {
    if (!isExtractableDocument(attachment) || !attachment.data) continue;
    const extractedText = extractDocumentText(attachment.name, attachment.data);
    if (extractedText && extractedText.trim().length >= 200) {
      // A document with real prose + (build intent OR a GDD-shaped name or no text at all).
      if (!text || BUILD_INTENT_RE.test(text) || GDD_REFERENCE_RE.test(attachment.name) || GDD_REFERENCE_RE.test(text)) {
        return { kind: "gdd-attachment", gddText: extractedText, sourceName: attachment.name };
      }
    }
  }

  // 2. "Build the game in the GDD" — the design already lives in the repo.
  // BEFORE the idea-length minimum: that minimum exists because an IDEA has
  // to be long enough to design from, and this instruction is not an idea —
  // it points at a document. "Build the game in the GDD" is 25 characters,
  // and it was ignored entirely (Codex 2026-09-12 X).
  if (GDD_REFERENCE_RE.test(text) && BUILD_INTENT_RE.test(text)) {
    // A PATH THE MESSAGE NAMED IS THE DOCUMENT IT MEANT. "Build the game
    // from the GDD at docs/Space_GDD.md" became a bare "gdd-from-docs", and
    // the manager then chose a repository document by filename distance and
    // modification time — a different, newer GDD could win (Codex 2026-09-12
    // AD#6).
    const named = documentPathIn(text);
    if (named) return { kind: "gdd-from-docs", path: named };
    // …AND DESIGN TEXT WRITTEN IN THE MESSAGE IS THE DESIGN. "Build this
    // game. GDD: <the design>" was read as a reference to a document in the
    // repository and the supplied design was discarded (AD#6).
    const inline = inlineDesignIn(text);
    if (inline) return { kind: "idea", ideaText: inline };
    return { kind: "gdd-from-docs" };
  }

  if (text.length < MIN_IDEA_LENGTH) return undefined;

  // 3. A written game idea with build intent.
  if (BUILD_INTENT_RE.test(text)) {
    return { kind: "idea", ideaText: text };
  }

  return undefined;
}

/** A document path the message names, when it names one. */
const DOCUMENT_PATH_RE = /(?:^|[\s"'`(])((?:[\w.-]+[/\\])*[\w.-]+\.(?:md|markdown|txt|docx|odt|rtf|pdf))(?=$|[\s"'`),.])/i;

export function documentPathIn(text: string): string | undefined {
  const match = DOCUMENT_PATH_RE.exec(text);
  return match?.[1];
}

/**
 * The design written INSIDE the message, after a "GDD:" marker — as opposed to
 * a reference to a document that already exists.
 */
export function inlineDesignIn(text: string): string | undefined {
  const marker = /\b(?:gdd|game\s+design\s+doc(?:ument)?)\b\s*[:\-—]\s*/i.exec(text);
  if (!marker) return undefined;
  const after = text.slice(marker.index + marker[0].length).trim();
  return after.length >= MIN_IDEA_LENGTH ? text : undefined;
}
