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
 * "make the game". The polite forms — "yapın", "yapıver", "yazın", "yazar
 * mısınız" — were matched only by that accident, and are named instead, with
 * "geliştirin", "kodlayın" and "inşa edin" beside them.
 */
const TR_MAKE = String.raw`yap(?:ın(?:ız)?|ıver(?:in)?)?`;
const TR_WRITE = String.raw`yaz(?:ın(?:ız)?|ıver(?:in)?)?`;
const TR_WOULD_YOU_WRITE = String.raw`yazar\s+mısın(?:ız)?`;
const TR_DEVELOP = String.raw`geliştir(?:in(?:iz)?)?`;
const TR_CONSTRUCT = String.raw`inşa\s+(?:et|edin(?:iz)?)`;
const TR_CODE = String.raw`kodla(?:yın(?:ız)?)?`;
const BUILD_INTENT_RE = new RegExp(
  String.raw`(?<![\wçğıöşüÇĞİÖŞÜ])(baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan|build\s+(this|the|a|my)\s+game|make\s+(this|the|a|my)\s+game|develop\s+(this|the|a|my)\s+game|` +
    String.raw`oyunu?n?u?\s+(${TR_MAKE}|${TR_WOULD_YOU_WRITE}|${TR_DEVELOP}|${TR_CONSTRUCT}|${TR_CODE})|oyun\s+(${TR_MAKE}|${TR_DEVELOP}|${TR_WRITE}|${TR_CODE}))(?![\wçğıöşüÇĞİÖŞÜ])`,
  "i",
);

/**
 * A reference to a GDD (in docs/, or "the GDD" generally), INSIDE A NAME TOO:
 * "Foo_GDD.md", "foo-gdd.md", "FooGDD.md", "GDD'deki". `\bgdd\b` never matched
 * the first ('_' is a word character), so "Build this game: docs/Foo_GDD.md"
 * was not a reference at all. …BUT AS A WORD OF ITS OWN: the letters inside
 * another word ("Rigddon") are none, or an idea that mentions such a word is
 * thrown away for whatever design docs/ holds. Nor is a word that only begins
 * with it: "GDDR6" and "GDDLint" were "the GDD".
 */
const GDD_ACRONYM_RE = /(?:(?<![\p{L}\p{N}])(?:gdd|Gdd|GDD)|(?<=\p{Ll})(?:Gdd|GDD))s?(?![\p{L}])/u;
const GDD_SPELLED_RE = /(?<![\p{L}\p{N}])game[\s_-]*design[\s_-]*doc(?:ument)?s?(?![\p{L}])/iu;

function refersToGdd(text: string): boolean {
  return GDD_ACRONYM_RE.test(text) || GDD_SPELLED_RE.test(text);
}

/**
 * A caption asking for work on the document itself — fix, proofread,
 * summarize, translate, review, update; düzelt, özetle, çevir, incele,
 * güncelle — not for the game it describes. Turkish verbs take suffixes
 * ("düzeltir misin"), so only their start is bounded.
 */
const WORK_ON_DOCUMENT_RE = new RegExp(
  String.raw`(?<![\p{L}])(?:fix|correct|proofread|typos?|review|summari[sz]e|summary|translate|update|edit|check|read|reword|rewrite|shorten|comment\s+on|feedback)(?![\p{L}])` +
    String.raw`|(?<![\p{L}])(?:düzelt|güncelle|özet|çevir|[iİ]ncele|kontrol\s+e|gözden\s+geçir|kısalt|düzenle|yazım\s+hata|yeniden\s+yaz|oku(?:r|yun(?:uz)?|yabilir|yup)?(?![\p{L}]))`,
  "iu",
);

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
      // …UNLESS THE CAPTION ASKS FOR WORK ON THE DOCUMENT: "fix the typo in
      // this" with Foo_GDD.md attached was an immediate build of the game.
      const asksForWork = WORK_ON_DOCUMENT_RE.test(text);
      const prose = proseOf(withoutEmphasis(text));
      // …AND AN ADVERB BESIDE THAT WORK IS NO BUILD: "Read it end to end",
      // "Rewrite this from scratch" and "bunu baştan sona oku" built the game
      // from the document they asked to have read or rewritten.
      const buildsGame = asksForWholeGame(prose) || (!asksForWork && asksToBuild(prose));
      // …NOR IS A BUILD THE CAPTION TURNS DOWN OR ASKS ABOUT: "Don't build the
      // game from this yet" built it, through the GDD in the file's name.
      const declined = !buildsGame && BUILD_INTENT_RE.test(prose);
      if (!text || buildsGame || (!asksForWork && !declined && (refersToGdd(attachment.name) || refersToGdd(text)))) {
        return { kind: "gdd-attachment", gddText: extractedText, sourceName: attachment.name };
      }
      // The message is about the document it carried, which was read: the
      // rules below would draft its caption as an idea, or call it unreadable.
      if (asksForWork || declined) return undefined;
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
  const plain = withoutEmphasis(text);
  const named = namedDocumentsIn(plain);
  const prose = proseOf(plain, named);
  if (!asksToBuild(prose)) return undefined;

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
  // …BUT ONLY A WHOLE-GAME BUILD AIMED AT IT MAKES A PATH THE DESIGN. An
  // adverb or a feature request beside a path was an immediate build with no
  // approval gate: "README.md'yi baştan sona oku" (read the README end to end)
  // built the game from the README, and an idea that mentioned its style sheet
  // was thrown away for the style sheet. A document named without a
  // whole-game build is the user's task, not a campaign.
  const wholeGame = asksForWholeGame(prose);
  if (named.length > 0 && !wholeGame) return undefined;
  const design = designAmong(plain, named);
  if (design === null) return undefined;
  if (design) return { kind: "gdd-from-docs", path: design };
  // A document the message only mentions is no part of what it asks for.
  const rest = withoutDocuments(plain, named);
  if (refersToGdd(rest)) {
    // …AND DESIGN TEXT WRITTEN IN THE MESSAGE IS THE DESIGN. "Build this
    // game. GDD: <the design>" was read as a reference to a document in the
    // repository and the supplied design was discarded (AD#6).
    const inline = inlineDesignIn(text);
    if (inline) return { kind: "idea", ideaText: inline };
    // "THE GDD" IS A POINTER TOO, held to the rule a path is: "Read the GDD
    // end to end" and "GDD'yi baştan sona oku" built whatever design docs/
    // held, with no approval gate. A message about the document without a
    // whole-game build is the user's task, not an idea to draft from either.
    return wholeGame ? { kind: "gdd-from-docs" } : undefined;
  }

  if (rest.trim().length < MIN_IDEA_LENGTH) return undefined;

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

/** What a named design is read from: as text, or through the document extractor (a workbook included). */
const DOCUMENT_EXTENSIONS = "md|markdown|txt|docx|odt|rtf|pdf|pptx|xlsx";

/**
 * A document path in quotes or backticks, which may hold spaces. Unquoted,
 * "docs/My Game GDD.md" yielded only its last word, "GDD.md" — another file.
 * The opening quote stands after a space so a Turkish suffix apostrophe
 * ("GDD'li … docs/x.md'yi") is not read as one.
 */
const QUOTED_DOCUMENT_PATH_RE = new RegExp(
  String.raw`(?:^|[\s(:])["'\x60“‘]([^"'\x60“”‘’\n]+\.(?:${DOCUMENT_EXTENSIONS}))["'\x60”’]`,
  "giu",
);

/**
 * A character of a path segment. "+", "&" and "@" are in file names too:
 * "docs/Quill+Moor_GDD.md" was no path, its GDD a bare "the GDD", and
 * discovery built another document.
 */
const PATH_CHAR = String.raw`[\p{L}\p{N}_.~+&@-]`;

/**
 * A download or export copy's mark before the extension — "Foo_GDD (1).md",
 * "Foo_GDD (final copy).md". The name before it was taken instead, and the
 * manager found the ORIGINAL beside the copy the user named.
 */
const COPY_MARK = String.raw`(?:\s?\([\p{L}\p{N}_. -]{1,24}\))?`;

/**
 * A document path the message names: relative, absolute (/x, C:\x) or from
 * home (~/x), in any script (Oyun_Tasarımı.md), ended by a Turkish suffix in
 * either apostrophe ("x.md'deki", "x.md’deki"). An absolute path was not
 * extracted at all, and the campaign discovered whichever design docs/ held.
 */
const DOCUMENT_PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'\x60(:“‘<])((?:[a-z]:[\\/]|[\\/])?(?:${PATH_CHAR}+[\\/])*${PATH_CHAR}+${COPY_MARK}\.(?:${DOCUMENT_EXTENSIONS}))(?=$|[\s"'\x60),.:;!?”’>#])`,
  "giu",
);

/** A link, which the manager refuses by name rather than reading another design in its place. */
const LINK_RE = /(?:^|[\s"'`(:“‘<])((?:https?|ftp|file):\/\/[^\s"'`<>()“”‘’]+?)(?=[.,;:!?]*(?:$|[\s"'`<>)”’]))/giu;

/**
 * A name with GDD in it and no extension the path pattern reads — "docs/Foo_GDD",
 * "FooGDD", "Foo_GDD.html". It was a bare "the GDD", and discovery built
 * another document. ANY CHARACTER A FILE NAME MAY HOLD: a GDD inside a word
 * the path pattern cannot read whole ("Foo#GDD.md", "Foo_GDD[v2].md") is
 * still a name the manager finds or refuses, never a reason to discover
 * another design. A bracket opens no name: "[Foo_GDD.md](docs/Foo_GDD.md)"
 * is a Markdown link's text.
 */
const NAME_TOKEN_RE = new RegExp(
  String.raw`(?:^|[\s"'\x60(:“‘<])((?:[a-z]:[\\/])?(?!\[)[^\s"'\x60“”‘’()<>:,;!?]*[^\s"'\x60“”‘’()<>:,;!?.])(?=$|[\s"'\x60),.:;!?”’>])`,
  "giu",
);
const GDD_ENDS_NAME_RE = /[\p{L}\p{N}][_-]?(?:gdd|game[_-]*design[_-]*doc(?:ument)?)s?(?:[_-]?v?\d+)?$|^(?:gdd|game[_-]*design[_-]*doc(?:ument)?)s?_/iu;

/** A file name that says GDD — not "the GDD" itself, a word built on it ("GDD-driven"), nor "GDD/TDD". */
function isGddName(token: string): boolean {
  const file = token.split(/[\\/]/).pop()!;
  if (!refersToGdd(file)) return false;
  return file !== token || /\.[\p{L}\p{N}]{1,8}$/u.test(file) || GDD_ENDS_NAME_RE.test(file);
}

/** A link names a document when its last segment does: an extension the path pattern reads, or GDD. */
function linkNamesDocument(link: string): boolean {
  const last = link.replace(/[?#].*$/, "").split("/").pop() ?? "";
  return new RegExp(String.raw`\.(?:${DOCUMENT_EXTENSIONS})$`, "i").test(last) || refersToGdd(last);
}

/** Documents that sit beside a design — a style sheet, a changelog, a readme — and are not it when the message names it too. */
const SUPPORT_DOCUMENT_WORDS = new Set(["style", "styles", "stylesheet", "styleguide", "stil", "changelog", "readme", "license", "licence", "contributing"]);
/**
 * Instructions for compiling or shipping the game. In a Unity project "build
 * the game per docs/BUILD.md" is the player build: it started no campaign on
 * main, and a named path made it an immediate one with the instructions for
 * the design. Whole words only — "city-builder.md" and "deck-building.md" are
 * designs.
 */
const BUILD_INSTRUCTION_WORDS = new Set(["build", "builds", "release", "releases", "deploy", "deployment", "ci", "checklist", "packaging", "compile"]);

function documentWords(path: string): string[] {
  const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
  return name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).map((word) => word.toLowerCase());
}

function isBuildInstructions(path: string): boolean {
  return documentWords(path).some((word) => BUILD_INSTRUCTION_WORDS.has(word));
}

function isSupportDocument(path: string): boolean {
  return isBuildInstructions(path) || documentWords(path).some((word) => SUPPORT_DOCUMENT_WORDS.has(word));
}

/**
 * The folders and words an unquoted path with spaces began with:
 * "docs/Quill Moor GDD.md" — DOCUMENT_PATH_RE sees only "GDD.md", and the
 * manager's docs/ lookup then found docs/GDD.md, another file. A joining word
 * ("docs/ui and GDD.md") is two names, not one.
 */
const SPLIT_PATH_HEAD_RE =
  /(?:^|[\s"'`(:“‘])((?:[a-z]:[\\/]|[\\/]|~[\\/])?(?:[\p{L}\p{N}_.~-]+[\\/])+[\p{L}\p{N}_~-]+(?:\s+(?!(?:and|or|ve|veya|ile|in|from|at|the|then|to|of|for)\s)[\p{L}\p{N}_~-]+){0,3})\s+$/iu;

interface NamedDocument {
  path: string;
  /** Where the path begins and ends in the message. */
  at: number;
  end: number;
}

/** Every document path the message names, in the order it wrote them. */
function namedDocumentsIn(text: string): NamedDocument[] {
  const named: NamedDocument[] = [];
  for (const m of text.matchAll(QUOTED_DOCUMENT_PATH_RE)) {
    const at = m.index + m[0].length - 1 - m[1]!.length;
    named.push({ path: m[1]!, at, end: at + m[1]!.length });
  }
  // Each span found is blanked to the same length, so every position still
  // holds and no later pattern reads a part of it again.
  let unread = blankSpans(text, named);
  const links: NamedDocument[] = [];
  for (const m of unread.matchAll(LINK_RE)) {
    const end = m.index + m[0].length;
    links.push({ path: m[1]!, at: end - m[1]!.length, end });
  }
  named.push(...links.filter((link) => linkNamesDocument(link.path)));
  unread = blankSpans(unread, links);
  const paths: NamedDocument[] = [];
  for (const m of unread.matchAll(DOCUMENT_PATH_RE)) {
    const end = m.index + m[0].length;
    let at = end - m[1]!.length;
    const head = /[\\/]/.test(m[1]!) ? null : SPLIT_PATH_HEAD_RE.exec(unread.slice(0, at));
    if (head) at = head.index + head[0].indexOf(head[1]!);
    paths.push({ path: text.slice(at, end), at, end });
  }
  named.push(...paths);
  for (const m of blankSpans(unread, paths).matchAll(NAME_TOKEN_RE)) {
    const end = m.index + m[0].length;
    if (isGddName(m[1]!)) named.push({ path: m[1]!, at: end - m[1]!.length, end });
  }
  return named.sort((a, b) => a.at - b.at);
}

/**
 * The message with Markdown emphasis blanked to the same length, so every
 * position still holds: "Build this game: **docs/Foo_GDD.md**" named no path,
 * and its GDD was a bare "the GDD" — discovery built another document.
 */
function withoutEmphasis(text: string): string {
  return text.replace(/\*/g, " ");
}

/** Each span blanked to its own length, so every position still holds. */
function blankSpans(text: string, spans: readonly NamedDocument[]): string {
  return spans.reduce((acc, span) => acc.slice(0, span.at) + " ".repeat(span.end - span.at) + acc.slice(span.end), text);
}

/** The message's own words: the documents it names blanked, so no file name reads as a verb, a "not" or a full stop. */
function proseOf(plain: string, named: readonly NamedDocument[] = namedDocumentsIn(plain)): string {
  return blankSpans(plain, named);
}

/** The message without the documents it names, each a single space. */
function withoutDocuments(text: string, named: readonly NamedDocument[]): string {
  let rest = text;
  for (const doc of [...named].reverse()) rest = `${rest.slice(0, doc.at)} ${rest.slice(doc.end)}`;
  return rest;
}

/** How a build runs — never, on its own, a request for one. */
const BUILD_ADVERB = String.raw`(?:baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan)`;
const TR_BUILD_VERB = `(?:${TR_MAKE}|${TR_WRITE}|${TR_WOULD_YOU_WRITE}|${TR_DEVELOP}|${TR_CONSTRUCT}|${TR_CODE})`;
const BUILD_GAME_EN = String.raw`(?<![\p{L}\p{N}_])(?:build|develop|make)\s+(?:this|the|a|my)\s+game(?![\p{L}\p{N}_'’])`;
const BUILD_GDD_EN = String.raw`(?<![\p{L}\p{N}_])(?:build|implement)\s+(?:the|this|my|our)\s+(?:GDD|game\s+design\s+doc(?:ument)?)(?![\p{L}\p{N}_'’])`;
const BUILD_GDD_TR = String.raw`(?<![\p{L}\p{N}_])GDD['’]y[iı](?:\s+${BUILD_ADVERB})?\s+(?:uygula|hayata\s+geçir|kodla)(?![\p{L}\p{N}_])`;
const BUILD_GAME_TR = String.raw`(?<![\p{L}\p{N}_])oyun(?:u|unu)?(?:\s+${BUILD_ADVERB})?\s+${TR_BUILD_VERB}(?![\p{L}\p{N}_])`;

/**
 * Whole-game build intent, which BUILD_INTENT_RE alone is not: it also takes
 * an adverb ("baştan sona oku", "end-to-end tests", "rewrite from scratch")
 * and a feature request. "Make the game <adjective / verb>" is causative, so
 * only a build's own shape may follow "make the game"; "develop the game
 * further" is work on a game that exists.
 */
const WHOLE_GAME_BUILD_RE = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_])(?:build|develop)\s+(?:this|the|a|my)\s+game(?![\p{L}\p{N}_'’])(?!\s+(?:further|more|beyond|better)(?![\p{L}]))`,
    String.raw`(?<![\p{L}\p{N}_])make\s+(?:this|the|a|my)\s+game(?=\s*(?:$|[:.,;!?()—–])|\s+(?:in|from|at|per|about|where|set|called|named|that|which|for|exactly|fully|completely|(?:described|defined|outlined|specified|documented|written)\s+in|based\s+on|according\s+to|as\s+(?:described|specified|defined|outlined|written)|end[- ]?to[- ]?end)(?![\p{L}]))`,
    BUILD_GDD_EN,
    BUILD_GDD_TR,
    BUILD_GAME_TR,
  ].join("|"),
  "iu",
);

/**
 * Whether the build written at `at`..`end` is asked for, not turned down or
 * asked about. The whole-game test looked only at the verb: "Don't build the
 * game in docs/Old_GDD.md — use the new one" built the document the user
 * ruled out, and "How do I build the game in docs/q.md?" was an immediate
 * build with no approval gate. A "not" ANYWHERE in the verb's clause counts
 * ("I don't want you to build…"), so "Don't stop until you build…" is no
 * campaign either — the side that costs a rephrase, not a multi-day build.
 * Turkish turns a verb down inside the word ("yapma"), which the verb
 * patterns already refuse; its question particle stands apart ("…mı?").
 */
function buildIsAsked(prose: string, at: number, end: number): boolean {
  const clause = clauseBefore(prose, at);
  const sentence = sentenceBefore(prose, at);
  if (TURNS_DOWN_RE.test(clause) || ASKS_ABOUT_RE.test(clause) || QUESTION_OPENER_RE.test(clause) || DANGLING_NOT_RE.test(sentence)) return false;
  // A question mark that closes the build's own clause asks about it ("Build
  // the game in P?", "Bu oyunu yap: P mı?"); one past a comma belongs to
  // another clause ("…, okay?", "…, can the fog roll back?").
  const close = SENTENCE_END_RE.exec(prose.slice(end));
  const tail = close ? prose.slice(end, end + close.index) : prose.slice(end);
  if (close?.[0] !== "?" || /[,;—–]|\s-\s/.test(tail)) return true;
  return POLITE_REQUEST_RE.test(sentence) || /m[ıiuü]s[ıiuü]n/iu.test(prose.slice(at, end));
}

/** A word that turns down what follows it in its clause. */
const TURNS_DOWN_RE = /(?<![\p{L}])(?:not|never|dont|cannot|rather\s+than|instead\s+of|\p{L}+n['’]t)(?![\p{L}])/iu;
/** A word that makes the build a condition or a question about it. */
const ASKS_ABOUT_RE = /(?<![\p{L}])(?:if|unless|whether|how|why|what|which|where)(?![\p{L}])/iu;
/** A clause opened as a yes/no question; "can you" and its kin are requests. */
const QUESTION_OPENER_RE =
  /^\s*(?:(?:hey|so|ok(?:ay)?|wait|well|also|now)\s+)*(?:should|shall|did|does|do|is|are|was|were|am|have|has|had|may|might|must|(?:can|could|would|will)(?!\s+(?:you|u|ya)(?![\p{L}])))(?![\p{L}])/iu;
/** "Don't, for now, build …": a "not" cut off from its verb by a comma or a dash. */
const DANGLING_NOT_RE = /(?<![\p{L}])(?:not|never|dont|\p{L}+n['’]t)\s*[,—–(]/iu;
const POLITE_REQUEST_RE =
  /^\s*(?:(?:hey|hi|ok(?:ay)?|so|now|alright|also|well)[\s,!]+)*(?:(?:please|pls|plz|kindly|lütfen)(?![\p{L}])|(?:(?:please|pls|plz)[\s,]+)?(?:can|could|would|will)\s+(?:you|u|ya)(?![\p{L}]))/iu;
/** The end of a sentence: a stop, a bang or a question mark before a space, or a line break. */
const SENTENCE_END_RE = /[.!?](?=["'\x60”’)\]]*(?:\s|$))|\n/u;
const CLAUSE_BREAK_RE = /[,;:()[\]—–\n]|[.!?](?=\s|$)|\s-\s|(?<![\p{L}])(?:and|but|then|or|ve|ama|fakat|sonra)(?![\p{L}])/giu;
const SENTENCE_BREAK_RE = /[.!?](?=["'\x60”’)\]]*(?:\s|$))|\n/gu;

function clauseBefore(prose: string, at: number): string {
  let start = 0;
  for (const m of prose.slice(0, at).matchAll(CLAUSE_BREAK_RE)) start = m.index + m[0].length;
  return prose.slice(start, at);
}

function sentenceBefore(prose: string, at: number): string {
  let start = 0;
  for (const m of prose.slice(0, at).matchAll(SENTENCE_BREAK_RE)) start = m.index + m[0].length;
  return prose.slice(start, at);
}

const WHOLE_GAME_BUILDS_RE = new RegExp(WHOLE_GAME_BUILD_RE.source, "giu");
const BUILD_INTENTS_RE = new RegExp(BUILD_INTENT_RE.source, "gi");

/** A whole-game build the message asks for (see buildIsAsked). */
function asksForWholeGame(prose: string): boolean {
  return [...prose.matchAll(WHOLE_GAME_BUILDS_RE)].some((m) => buildIsAsked(prose, m.index, m.index + m[0].length));
}

/** Any build intent — an adverb included — the message asks for. */
function asksToBuild(prose: string): boolean {
  return [...prose.matchAll(BUILD_INTENTS_RE)].some((m) => buildIsAsked(prose, m.index, m.index + m[0].length));
}

/**
 * The build is aimed at the document written right after it: "Build this
 * game: P", "build the game in / from / per P", "build the game from the GDD
 * at P", "Bu oyunu yap: P".
 */
const BUILDS_FROM_NEXT_RE = new RegExp(
  `(?:${BUILD_GAME_EN}|${BUILD_GDD_EN}|${BUILD_GDD_TR}|${BUILD_GAME_TR})(?:\\s+${BUILD_ADVERB})*` +
    String.raw`(?:\s*:|\s+(?:in|from|at|per|(?:described|defined|outlined|specified|documented|written)\s+in|based\s+on|according\s+to|as\s+(?:described|specified|defined|outlined|written)\s+in))` +
    String.raw`(?:\s+(?:the|this|that|my|our))?` +
    String.raw`(?:\s+(?:GDD|game\s+design\s+doc(?:ument)?|design(?:\s+doc(?:ument)?)?|document|doc|spec(?:ification)?|file)(?:\s+(?:at|in)|\s*:)?)?` +
    String.raw`\s*["'\x60“‘(]?$`,
  "iu",
);

/**
 * The game the build is aimed at is the one IN the document just written:
 * "P'deki oyunu yap", "P dosyasındaki oyunu geliştir", "P oyununu baştan sona
 * yap", "P'ye göre oyunu yap". "P'deki notlara göre oyunu geliştir" (improve
 * the game by the notes in P) is not.
 */
const GAME_IN_PREVIOUS_RE = new RegExp(
  String.raw`^(?:['’](?:[dt][ae]ki|[dt][ae]n|y?[ae]\s+göre)|\s+(?:dosya|belge|doküman|döküman)s[ıi]n(?:[dt][ae]ki|[dt][ae]n)|\s+içindeki)?` +
    String.raw`\s+(?:bu\s+|şu\s+)?oyun(?:u|unu)(?:\s+${BUILD_ADVERB})?\s+${TR_BUILD_VERB}(?![\p{L}\p{N}_])`,
  "iu",
);

/** The document is the GDD the message speaks of: "the GDD at P", "GDD: P", "GDD'li dosya P". */
const GDD_NAMES_NEXT_RES = [GDD_ACRONYM_RE, GDD_SPELLED_RE].map(
  (re) =>
    new RegExp(
      `(?:${re.source})` +
        String.raw`(?:['’]\p{L}+)?(?:\s+(?:dosya(?:sı)?|belge(?:si)?|file|document|doc))?(?:\s+(?:is\s+(?:at|in)|at|in|is)|\s*[:=(—–-])?\s*["'\x60“‘(]?$`,
      re.flags,
    ),
);

/**
 * The document is the design, said at the start of a clause: "the design is
 * P", "design: P", "(design: P)", "tasarım P". A modifier makes it another
 * design: "the art design is in P" names the style sheet.
 */
const DESIGN_NAMES_NEXT_RE =
  /(?:^|[,;:(—–]\s*|[.!?]\s+|(?<![\p{L}])(?:and|ve)\s+)(?:(?:the|its|our|my)\s+)?(?:(?:game\s+)?design(?:\s+(?:doc(?:ument)?|file|spec))?\s*(?:(?:is|lives|sits)(?:\s+(?:in|at))?|at|in|[:=—–])|(?:oyunun\s+)?tasarım(?:ı)?(?:\s+(?:dosyası|belgesi))?\s*[:=—–]?)\s*["'\x60“‘(]?$/iu;

/** "P and Q", "P, Q", "P ve Q": named together, aimed at together. */
const NAMED_TOGETHER_RE = /^\s*["'`”’)]?\s*(?:,\s*(?:(?:and|or|ve|veya)\s+)?|\s+(?:and|or|ve|veya|&|\+)\s+)["'`“‘(]?$/iu;

/** A word, before a document in its clause, that turns it away: "not P", "don't use P", "ignore P". */
const TURNS_AWAY_BEFORE_RE = /(?<![\p{L}])(?:ignore|skip|except|excluding|without)(?![\p{L}])/iu;
/** …and after it: "P is outdated", "P'yi kullanma", "P değil", "P yerine". */
const TURNS_AWAY_AFTER_RE =
  /(?<![\p{L}])(?:outdated|obsolete|deprecated|superseded|stale|old|wrong|retired|ignored?|eski|geçersiz|değil|yerine|hariç|kullanma\p{L}*|görmezden)(?![\p{L}])/iu;

function turnedAway(prose: string, doc: NamedDocument): boolean {
  const before = clauseBefore(prose, doc.at);
  if (TURNS_DOWN_RE.test(before) || TURNS_AWAY_BEFORE_RE.test(before)) return true;
  const after = prose.slice(doc.end);
  const clauseEnd = [...after.matchAll(CLAUSE_BREAK_RE)][0]?.index ?? after.length;
  return TURNS_AWAY_AFTER_RE.test(after.slice(0, clauseEnd));
}

/**
 * The design among the documents the message names: one the build is aimed
 * at (and one named together with it); beside them, the one whose name says
 * GDD, else the first that is not a style sheet, changelog or readme. A GDD
 * named anywhere else is the design when the message asks for "the GDD" or
 * holds nothing else to build from — otherwise it is a reference beside an
 * idea, and the idea is the design. A path the build is not aimed at was
 * taken anyway: an idea that mentioned docs/art-style.md was built from it.
 *
 * …AND A BUILD AIMED ONLY AT A STYLE SHEET OR A CHANGELOG IS AIMED AT NO
 * DESIGN. "Build the game per docs/art-style.md, see docs/Quillmoor_GDD.md"
 * built the style sheet, ungated: the design is then the one named beside it
 * — the only GDD, else the only other document — unless the message turns it
 * away or names two, and then there is no campaign to start (the user's task
 * asks which). Named alone, with nothing else to build from, it is still the
 * document the message meant — unless it is build or release instructions:
 * then the build is the player build, and `null` says no campaign at all,
 * however long the message is (it is no idea to draft either).
 */
function designAmong(text: string, named: readonly NamedDocument[]): string | null | undefined {
  if (named.length === 0) return undefined;
  const prose = proseOf(text, named);
  const wholeGame = asksForWholeGame(prose);
  // A build aimed at a document counts only when it is asked for: "Don't
  // build the game in docs/Old_GDD.md; build the game in docs/New_GDD.md".
  const aimed = named.map((doc) => {
    const before = BUILDS_FROM_NEXT_RE.exec(text.slice(0, doc.at));
    if (before && buildIsAsked(prose, before.index, doc.at)) return true;
    const after = GAME_IN_PREVIOUS_RE.exec(text.slice(doc.end));
    if (after && buildIsAsked(prose, doc.at, doc.end + after[0].length)) return true;
    return wholeGame && [...GDD_NAMES_NEXT_RES, DESIGN_NAMES_NEXT_RE].some((re) => re.test(text.slice(0, doc.at)));
  });
  for (let spread = true; spread; ) {
    spread = false;
    for (let i = 1; i < named.length; i++) {
      if (aimed[i - 1] !== aimed[i] && NAMED_TOGETHER_RE.test(text.slice(named[i - 1]!.end, named[i]!.at))) {
        aimed[i - 1] = aimed[i] = true;
        spread = true;
      }
    }
  }
  const aimedDocs = named.filter((_, i) => aimed[i]);
  const design = aimedDocs.find((doc) => refersToGdd(doc.path)) ?? aimedDocs.find((doc) => !isSupportDocument(doc.path));
  if (design) return design.path;
  const playerBuild = aimedDocs.length > 0 && aimedDocs.every((doc) => isBuildInstructions(doc.path));
  const rest = withoutDocuments(text, named);
  if (!wholeGame || !(refersToGdd(rest) || rest.trim().length < MIN_IDEA_LENGTH)) return playerBuild ? null : undefined;
  const beside = named.filter((doc) => !aimedDocs.includes(doc));
  const candidates = beside.filter((doc) => !turnedAway(prose, doc));
  const gdds = candidates.filter((doc) => refersToGdd(doc.path));
  if (gdds.length > 0) return gdds.length === 1 ? gdds[0]!.path : undefined;
  if (aimedDocs.length === 0) return undefined;
  const designs = candidates.filter((doc) => !isSupportDocument(doc.path));
  if (designs.length > 0) return designs.length === 1 ? designs[0]!.path : undefined;
  if (beside.some((doc) => !isSupportDocument(doc.path))) return undefined;
  return playerBuild ? null : aimedDocs.find((doc) => !isBuildInstructions(doc.path))!.path;
}

/** The design document the message names, when it names one. */
export function documentPathIn(text: string): string | undefined {
  const plain = withoutEmphasis(text);
  return designAmong(plain, namedDocumentsIn(plain)) ?? undefined;
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
