/**
 * Campaign Intake — the "GDD shared / game idea written" detection.
 *
 * Conservative on purpose: a false positive here hijacks a normal message
 * into a multi-day build. The three shapes that qualify, in priority order:
 *
 *   1. A document attachment that extracts to text (the GDD itself) — sharing
 *      the file IS the instruction ("direkt bir GDD paylaşıldığında").
 *   2. Free text asking for the game IN an existing GDD ("GDD'deki oyunu yap",
 *      "build the game in the GDD", "Bu oyunu yap: docs/Foo.md") → build from
 *      docs/, or from the document whose path the message named.
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
  | { kind: "gdd-from-docs"; path?: string }
  /** A document arrived with the request but no design could be read from it. */
  | { kind: "gdd-unreadable"; sourceName: string; reason: string };

/**
 * End-to-end build intent. Narrow verbs of whole-game creation, TR + EN.
 *
 * Bounded by letters of BOTH languages: `\b` is ASCII, so it found a word end
 * before every Turkish letter — "oyun yazılımı" (the game's software), "oyunu
 * yapılandır" (configure the game) and "oyun yapısı" (its structure) were
 * "make the game". The polite imperative "yapın" was matched only by that
 * accident, and is named instead.
 */
const BUILD_INTENT_RE =
  /(?<![\wçğıöşüÇĞİÖŞÜ])(baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan|build\s+(this|the|a|my)\s+game|make\s+(this|the|a|my)\s+game|develop\s+(this|the|a|my)\s+game|oyunu?n?u?\s+(yap(ın(ız)?)?|yazar\s+mısın|geliştir|inşa\s+et|kodla)|oyun\s+(yap|geliştir|yaz|kodla))(?![\wçğıöşüÇĞİÖŞÜ])/i;

/**
 * A reference to a GDD (in docs/, or "the GDD" generally), INSIDE A NAME TOO:
 * "Foo_GDD.md", "foo-gdd.md", "FooGDD.md", "GDD'deki". `\bgdd\b` never matched
 * the first ('_' is a word character), so "Build this game: docs/Foo_GDD.md"
 * was not a reference at all. …BUT AS A WORD OF ITS OWN: the letters inside
 * another word ("Rigddon") are none, or an idea that mentions such a word is
 * thrown away for whatever design docs/ holds.
 */
const GDD_ACRONYM_RE = /(?:(?<![\p{L}\p{N}])(?:gdd|Gdd|GDD)|(?<=\p{Ll})(?:Gdd|GDD))s?(?![\p{Ll}])/u;
const GDD_SPELLED_RE = /(?<![\p{L}\p{N}])game[\s_-]*design[\s_-]*doc(?:ument)?s?(?![\p{L}])/iu;

function refersToGdd(text: string): boolean {
  return GDD_ACRONYM_RE.test(text) || GDD_SPELLED_RE.test(text);
}

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
      if (!text || BUILD_INTENT_RE.test(text) || refersToGdd(attachment.name) || refersToGdd(text)) {
        return { kind: "gdd-attachment", gddText: extractedText, sourceName: attachment.name };
      }
    }
  }

  // A DOCUMENT THAT ARRIVED BUT COULD NOT BE READ IS NOT A REASON TO BUILD
  // ANOTHER DESIGN. Every rule below qualifies the document above too, so one
  // still attached here is one step 1 could not read — and "build the game in
  // this GDD" with the user's own PDF (hex-string text, a scan, a .csv) went on
  // to build whatever sat in docs/ (channel-attachments review).
  const intent = intentFromText(text);
  const unread = intent ? unreadDocumentIn(msg) : undefined;
  return unread ?? intent;
}

/** Steps 2 and 3: what the message's own text asks for. */
function intentFromText(text: string): CampaignIntent | undefined {
  if (!BUILD_INTENT_RE.test(text)) return undefined;

  // 2. "Build the game in the GDD" — the design already lives in the repo.
  // BEFORE the idea-length minimum: that minimum exists because an IDEA has
  // to be long enough to design from, and this instruction is not an idea —
  // it points at a document. "Build the game in the GDD" is 25 characters,
  // and it was ignored entirely (Codex 2026-09-12 X).
  // A PATH THE MESSAGE NAMED IS THE DOCUMENT IT MEANT, whatever the file is
  // called. "Build the game from the GDD at docs/Space_GDD.md" became a bare
  // "gdd-from-docs", and the manager then chose a repository document by
  // filename distance and modification time — a different, newer GDD could
  // win (Codex 2026-09-12 AD#6). Without "the GDD" spelled out the path did
  // not count at all: "Build this game: docs/Foo_GDD.md" was nothing, and
  // past 40 characters an IDEA — a new design drafted from the sentence that
  // pointed at the old one.
  const named = documentPathIn(text);
  if (named) return { kind: "gdd-from-docs", path: named };
  if (refersToGdd(text)) {
    // …AND DESIGN TEXT WRITTEN IN THE MESSAGE IS THE DESIGN. "Build this
    // game. GDD: <the design>" was read as a reference to a document in the
    // repository and the supplied design was discarded (AD#6).
    const inline = inlineDesignIn(text);
    if (inline) return { kind: "idea", ideaText: inline };
    return { kind: "gdd-from-docs" };
  }

  if (text.length < MIN_IDEA_LENGTH) return undefined;

  // 3. A written game idea with build intent.
  return { kind: "idea", ideaText: text };
}

/** The first document the message carried bytes for, and why no design came out of it. */
function unreadDocumentIn(msg: IncomingMessage): Extract<CampaignIntent, { kind: "gdd-unreadable" }> | undefined {
  for (const attachment of msg.attachments ?? []) {
    if ((attachment.type !== "document" && attachment.type !== "file") || !attachment.data) continue;
    if (!isExtractableDocument(attachment)) {
      return { kind: "gdd-unreadable", sourceName: attachment.name, reason: "it is not a format a design is read from (PDF, TXT, Markdown, Word, ODT or RTF)" };
    }
    const readable = extractDocumentText(attachment.name, attachment.data)?.trim().length ?? 0;
    return {
      kind: "gdd-unreadable",
      sourceName: attachment.name,
      reason: readable === 0 ? "no text could be read from it" : `only ${readable} characters of text could be read from it`,
    };
  }
  return undefined;
}

/**
 * A document path in quotes or backticks, which may hold spaces. Unquoted,
 * "docs/My Game GDD.md" yielded only its last word, "GDD.md" — another file.
 * The opening quote stands after a space so a Turkish suffix apostrophe
 * ("GDD'li … docs/x.md'yi") is not read as one.
 */
const QUOTED_DOCUMENT_PATH_RE = /(?:^|[\s(:])["'`“‘]([^"'`“”‘’\n]+\.(?:md|markdown|txt|docx|odt|rtf|pdf))["'`”’]/giu;

/**
 * A document path the message names: relative, absolute (/x, C:\x) or from
 * home (~/x), in any script (Oyun_Tasarımı.md), ended by a Turkish suffix in
 * either apostrophe ("x.md'deki", "x.md’deki"). An absolute path was not
 * extracted at all, and the campaign discovered whichever design docs/ held.
 */
const DOCUMENT_PATH_RE =
  /(?:^|[\s"'`(:“‘])((?:[a-z]:[\\/]|[\\/])?(?:[\p{L}\p{N}_.~-]+[\\/])*[\p{L}\p{N}_.~-]+\.(?:md|markdown|txt|docx|odt|rtf|pdf))(?=$|[\s"'`),.:;!?”’])/giu;

/** Documents that sit beside a design — a style sheet, a changelog, a readme — and are not it when the message names it too. */
const SUPPORT_DOCUMENT_WORDS = new Set(["style", "styles", "stylesheet", "styleguide", "stil", "changelog", "readme", "license", "licence", "contributing"]);

function isSupportDocument(path: string): boolean {
  const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
  return name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).some((word) => SUPPORT_DOCUMENT_WORDS.has(word.toLowerCase()));
}

/**
 * The design document the message names, when it names one. Beside a style
 * sheet or a changelog, the design: the one whose name says GDD, else the
 * first that is not a support document, in the order the message wrote them.
 * Taking the first path built the game from "docs/art-style.md" when the
 * message said "Following docs/art-style.md, build the game in docs/x.md".
 */
export function documentPathIn(text: string): string | undefined {
  const named: Array<{ at: number; path: string }> = [];
  for (const m of text.matchAll(QUOTED_DOCUMENT_PATH_RE)) named.push({ at: m.index, path: m[1]! });
  // Quoted spans blanked to the same length, so every position still holds.
  const unquoted = text.replace(QUOTED_DOCUMENT_PATH_RE, (span) => " ".repeat(span.length));
  for (const m of unquoted.matchAll(DOCUMENT_PATH_RE)) named.push({ at: m.index, path: m[1]! });
  const paths = named.sort((a, b) => a.at - b.at).map((n) => n.path);
  return paths.find(refersToGdd) ?? paths.find((path) => !isSupportDocument(path)) ?? paths[0];
}

/** The reference followed by a "GDD:" marker, read exactly as refersToGdd reads one. */
const INLINE_DESIGN_MARKER_RES = [
  new RegExp(`(?:${GDD_ACRONYM_RE.source})\\s*[:\\-—]\\s*`, "u"),
  new RegExp(`(?:${GDD_SPELLED_RE.source})\\s*[:\\-—]\\s*`, "iu"),
];

/**
 * The design written INSIDE the message, after a "GDD:" marker — as opposed to
 * a reference to a document that already exists. "Foo_GDD: <the design>" is a
 * reference too, so its design is not taken for a pointer to docs/.
 */
export function inlineDesignIn(text: string): string | undefined {
  const markers = INLINE_DESIGN_MARKER_RES.map((re) => re.exec(text)).filter((m): m is RegExpExecArray => m !== null);
  const marker = markers.sort((a, b) => a.index - b.index)[0];
  if (!marker) return undefined;
  const after = text.slice(marker.index + marker[0].length).trim();
  return after.length >= MIN_IDEA_LENGTH ? text : undefined;
}
