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
  | { kind: "gdd-from-docs" };

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

  if (text.length < MIN_IDEA_LENGTH) return undefined;

  // 2. "Build the game in the GDD" — the design already lives in the repo.
  if (GDD_REFERENCE_RE.test(text) && BUILD_INTENT_RE.test(text)) {
    return { kind: "gdd-from-docs" };
  }

  // 3. A written game idea with build intent.
  if (BUILD_INTENT_RE.test(text)) {
    return { kind: "idea", ideaText: text };
  }

  return undefined;
}
