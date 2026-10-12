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
    String.raw`|(?<![\p{L}])(?:düzelt|güncelle|özet|çevir|[iİ]ncele|kontrol\s+e|gözden\s+geçir|kısalt|düzenle|yazım\s+hata|oku(?:r|yun(?:uz)?|yabilir|yup)?(?![\p{L}]))`,
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
      if (!text || BUILD_INTENT_RE.test(text) || (!asksForWork && (refersToGdd(attachment.name) || refersToGdd(text)))) {
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
  // …BUT ONLY A WHOLE-GAME BUILD AIMED AT IT MAKES A PATH THE DESIGN. An
  // adverb or a feature request beside a path was an immediate build with no
  // approval gate: "README.md'yi baştan sona oku" (read the README end to end)
  // built the game from the README, and an idea that mentioned its style sheet
  // was thrown away for the style sheet. A document named without a
  // whole-game build is the user's task, not a campaign.
  const named = namedDocumentsIn(text);
  if (named.length > 0 && !WHOLE_GAME_BUILD_RE.test(text)) return undefined;
  const design = designAmong(text, named);
  if (design) return { kind: "gdd-from-docs", path: design };
  // A document the message only mentions is no part of what it asks for.
  const rest = withoutDocuments(text, named);
  if (refersToGdd(rest)) {
    // …AND DESIGN TEXT WRITTEN IN THE MESSAGE IS THE DESIGN. "Build this
    // game. GDD: <the design>" was read as a reference to a document in the
    // repository and the supplied design was discarded (AD#6).
    const inline = inlineDesignIn(text);
    if (inline) return { kind: "idea", ideaText: inline };
    return { kind: "gdd-from-docs" };
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

/**
 * A document path in quotes or backticks, which may hold spaces. Unquoted,
 * "docs/My Game GDD.md" yielded only its last word, "GDD.md" — another file.
 * The opening quote stands after a space so a Turkish suffix apostrophe
 * ("GDD'li … docs/x.md'yi") is not read as one.
 */
const QUOTED_DOCUMENT_PATH_RE = /(?:^|[\s(:])["'`“‘]([^"'`“”‘’\n]+\.(?:md|markdown|txt|docx|odt|rtf|pdf|pptx))["'`”’]/giu;

/**
 * A document path the message names: relative, absolute (/x, C:\x) or from
 * home (~/x), in any script (Oyun_Tasarımı.md), ended by a Turkish suffix in
 * either apostrophe ("x.md'deki", "x.md’deki"). An absolute path was not
 * extracted at all, and the campaign discovered whichever design docs/ held.
 */
const DOCUMENT_PATH_RE =
  /(?:^|[\s"'`(:“‘])((?:[a-z]:[\\/]|[\\/])?(?:[\p{L}\p{N}_.~-]+[\\/])*[\p{L}\p{N}_.~-]+\.(?:md|markdown|txt|docx|odt|rtf|pdf|pptx))(?=$|[\s"'`),.:;!?”’])/giu;

/** A link, which the manager refuses by name rather than reading another design in its place. */
const LINK_RE = /(?:^|[\s"'`(:“‘<])((?:https?|ftp|file):\/\/[^\s"'`<>()“”‘’]+?)(?=[.,;:!?]*(?:$|[\s"'`<>)”’]))/giu;

/**
 * A name with GDD in it and no extension the path pattern reads — "docs/Foo_GDD",
 * "FooGDD", "Foo_GDD.html". It was a bare "the GDD", and discovery built
 * another document.
 */
const NAME_TOKEN_RE =
  /(?:^|[\s"'`(:“‘])((?:[a-z]:[\\/]|[\\/]|~[\\/])?(?:[\p{L}\p{N}_.~-]+[\\/])*[\p{L}\p{N}_.~-]*[\p{L}\p{N}_~-])(?=$|[\s"'`),.:;!?”’])/giu;
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
  return /\.(?:md|markdown|txt|docx|odt|rtf|pdf|pptx)$/i.test(last) || refersToGdd(last);
}

/** Documents that sit beside a design — a style sheet, a changelog, a readme — and are not it when the message names it too. */
const SUPPORT_DOCUMENT_WORDS = new Set(["style", "styles", "stylesheet", "styleguide", "stil", "changelog", "readme", "license", "licence", "contributing"]);

function isSupportDocument(path: string): boolean {
  const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
  return name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).some((word) => SUPPORT_DOCUMENT_WORDS.has(word.toLowerCase()));
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
  const blank = (s: string, spans: readonly NamedDocument[]): string =>
    spans.reduce((acc, span) => acc.slice(0, span.at) + " ".repeat(span.end - span.at) + acc.slice(span.end), s);
  let unread = blank(text, named);
  const links: NamedDocument[] = [];
  for (const m of unread.matchAll(LINK_RE)) {
    const end = m.index + m[0].length;
    links.push({ path: m[1]!, at: end - m[1]!.length, end });
  }
  named.push(...links.filter((link) => linkNamesDocument(link.path)));
  unread = blank(unread, links);
  const paths: NamedDocument[] = [];
  for (const m of unread.matchAll(DOCUMENT_PATH_RE)) {
    const end = m.index + m[0].length;
    let at = end - m[1]!.length;
    const head = /[\\/]/.test(m[1]!) ? null : SPLIT_PATH_HEAD_RE.exec(unread.slice(0, at));
    if (head) at = head.index + head[0].indexOf(head[1]!);
    paths.push({ path: text.slice(at, end), at, end });
  }
  named.push(...paths);
  for (const m of blank(unread, paths).matchAll(NAME_TOKEN_RE)) {
    const end = m.index + m[0].length;
    if (isGddName(m[1]!)) named.push({ path: m[1]!, at: end - m[1]!.length, end });
  }
  return named.sort((a, b) => a.at - b.at);
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
        String.raw`(?:['’]\p{L}+)?(?:\s+(?:dosya(?:sı)?|belge(?:si)?|file|document|doc))?(?:\s+(?:at|in|is)|\s*[:=(—–-])?\s*["'\x60“‘(]?$`,
      re.flags,
    ),
);

/** "P and Q", "P, Q", "P ve Q": named together, aimed at together. */
const NAMED_TOGETHER_RE = /^\s*["'`”’)]?\s*(?:,\s*(?:(?:and|or|ve|veya)\s+)?|\s+(?:and|or|ve|veya|&|\+)\s+)["'`“‘(]?$/iu;

/**
 * The design among the documents the message names: one the build is aimed
 * at (and one named together with it); beside them, the one whose name says
 * GDD, else the first that is not a style sheet, changelog or readme. A GDD
 * named anywhere else is the design when the message asks for "the GDD" or
 * holds nothing else to build from — otherwise it is a reference beside an
 * idea, and the idea is the design. A path the build is not aimed at was
 * taken anyway: an idea that mentioned docs/art-style.md was built from it.
 */
function designAmong(text: string, named: readonly NamedDocument[]): string | undefined {
  if (named.length === 0) return undefined;
  const wholeGame = WHOLE_GAME_BUILD_RE.test(text);
  const aimed = named.map(
    (doc) =>
      BUILDS_FROM_NEXT_RE.test(text.slice(0, doc.at)) ||
      GAME_IN_PREVIOUS_RE.test(text.slice(doc.end)) ||
      (wholeGame && GDD_NAMES_NEXT_RES.some((re) => re.test(text.slice(0, doc.at)))),
  );
  for (let spread = true; spread; ) {
    spread = false;
    for (let i = 1; i < named.length; i++) {
      if (aimed[i - 1] !== aimed[i] && NAMED_TOGETHER_RE.test(text.slice(named[i - 1]!.end, named[i]!.at))) {
        aimed[i - 1] = aimed[i] = true;
        spread = true;
      }
    }
  }
  const paths = named.filter((_, i) => aimed[i]).map((doc) => doc.path);
  if (paths.length > 0) return paths.find(refersToGdd) ?? paths.find((path) => !isSupportDocument(path)) ?? paths[0];
  const gdd = named.find((doc) => refersToGdd(doc.path));
  if (!gdd || !wholeGame) return undefined;
  const rest = withoutDocuments(text, named);
  return refersToGdd(rest) || rest.trim().length < MIN_IDEA_LENGTH ? gdd.path : undefined;
}

/** The design document the message names, when it names one. */
export function documentPathIn(text: string): string | undefined {
  return designAmong(text, namedDocumentsIn(text));
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
