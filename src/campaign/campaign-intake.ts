/**
 * Campaign Intake — the "GDD shared / game idea written" detection.
 *
 * Conservative on purpose: a false positive here hijacks a normal message
 * into a multi-day build. The three shapes that qualify, in priority order:
 *
 *   1. A document attachment that extracts to text (the GDD itself) — sharing
 *      the file IS the instruction ("direkt bir GDD paylaşıldığında").
 *   2. Free text asking for the game IN an existing GDD ("GDD'deki oyunu yap",
 *      "build the game in the GDD", "Bu oyunu yap: docs/Foo_GDD.md") → build
 *      from docs/, or from the document whose path the message named — at
 *      once only in the one plain form (see designAmong); any other
 *      whole-game build that points at a document is confirmed at the
 *      approval gate first.
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
  /** `confirm`: the caption asks for the build tentatively or reports one — the user confirms the document at the approval gate first. */
  | { kind: "gdd-attachment"; gddText: string; sourceName: string; confirm?: true }
  /** Build at once from the document the message named — or, with no path, the newest GDD under docs/. */
  | { kind: "gdd-from-docs"; path?: string }
  /**
   * A whole-game build pointed at a document in any other form: the user
   * confirms the document at the approval gate before Sprint 1. `others` are
   * the further documents the message offered as the design.
   */
  | { kind: "gdd-to-confirm"; path?: string; others?: string[] }
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
/** "Şu oyunu yapar mısın: P" asks for the build; only the definite object takes it, as "oyun yapar mısın" asks what you do. */
const TR_WOULD_YOU_MAKE = String.raw`yapar\s+mısın(?:ız)?|yapabilir\s+misin(?:iz)?`;
/**
 * The plain Turkish order, the document between the object and the verb:
 * "Oyunu P'ye göre yap", "Oyunu P'den yap", "Bu oyunu P dosyasına göre
 * geliştir". It is read with the document's name blanked (proseOf), so what
 * stands between "oyunu" and its suffix is only the space the name took.
 */
const TR_GAME_BY_DOCUMENT = String.raw`oyun(?:u|unu)\s+["'\x60“‘”’]*(?:['’](?:y?[ae]\s+göre|[dt][ae]n)|(?:dosya|belge|doküman|döküman)s[ıi]n(?:[ae]\s+göre|[dt][ae]n))(?:\s+(?:baştan\s+sona|sıfırdan))?\s+(?:${TR_MAKE}|${TR_WOULD_YOU_MAKE}|${TR_WOULD_YOU_WRITE}|${TR_DEVELOP}|${TR_CONSTRUCT}|${TR_CODE})`;
const BUILD_INTENT_RE = new RegExp(
  String.raw`(?<![\wçğıöşüÇĞİÖŞÜ])(baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan|build\s+(this|the|a|my)\s+game|make\s+(this|the|a|my)\s+game|develop\s+(this|the|a|my)\s+game|` +
    String.raw`oyunu?n?u?\s+(${TR_MAKE}|${TR_WOULD_YOU_WRITE}|${TR_DEVELOP}|${TR_CONSTRUCT}|${TR_CODE})|oyun(?:u|unu)\s+(?:${TR_WOULD_YOU_MAKE})|${TR_GAME_BY_DOCUMENT}|oyun\s+(${TR_MAKE}|${TR_DEVELOP}|${TR_WRITE}|${TR_CODE}))(?![\wçğıöşüÇĞİÖŞÜ])`,
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
  const words = withoutCodeFiles(text);
  return GDD_ACRONYM_RE.test(words) || GDD_SPELLED_RE.test(words);
}

const GDD_REFERENCES_RES = [GDD_ACRONYM_RE, GDD_SPELLED_RE].map((re) => new RegExp(re.source, `${re.flags}g`));

/**
 * "The GDD" the text speaks of — not one it says is not there: "I don't have
 * a GDD, but build a game where…" built whatever design docs/ held, ungated,
 * in place of the idea the message carried.
 */
function speaksOfTheGdd(text: string): boolean {
  const words = withoutCodeFiles(text);
  return GDD_REFERENCES_RES.some((re) => [...words.matchAll(re)].some((m) => !turnedAway(words, { at: m.index, end: m.index + m[0].length }, true)));
}

/**
 * The extensions a document is written in: those a design is read from, and
 * those the manager names back as no format it reads.
 */
const DOCUMENT_NAME_EXTENSION_RE = /\.(?:md|markdown|txt|docx|odt|rtf|pdf|pptx|xlsx|html?|pages|gdoc|epub|doc|ppt|xls|od[ps]|key|numbers)$/iu;
/** A word as a file name is written, and the extension that ends one — with a letter in it ("1.2" is a version). */
const FILE_TOKEN_RE = /[^\s"'`“”‘’()<>,;:!?]+/gu;
const FILE_EXTENSION_RE = /\.(?=\p{N}*\p{L})[\p{L}\p{N}]{1,8}$/u;

/**
 * The text with every source, data or script file name blanked: the "gdd" in
 * "my_gdd_parser.ts" or "gdd_schema.json" is no GDD. "Build the game and fix
 * my_gdd_parser.ts" was a build from that file, and the manager took the
 * message over to say it could not read it — the user's task never ran. Each
 * word is read once: a name searched for from each of its characters made a
 * long unbroken word cost its length squared — and so did a pattern for the
 * dots that end it, tried from every dot of a long run of them.
 */
function withoutCodeFiles(text: string): string {
  return text.replace(FILE_TOKEN_RE, (token) => {
    let cut = token.length;
    while (cut > 0 && token[cut - 1] === ".") cut--;
    const name = token.slice(0, cut);
    if (!FILE_EXTENSION_RE.test(name) || DOCUMENT_NAME_EXTENSION_RE.test(name)) return token;
    return " ".repeat(name.length) + token.slice(name.length);
  });
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
      const prose = proseOf(withoutMarkup(text));
      // …AND AN ADVERB BESIDE THAT WORK IS NO BUILD: "Read it end to end",
      // "Rewrite this from scratch" and "bunu baştan sona oku" built the game
      // from the document they asked to have read or rewritten.
      const whole = wholeGameRequest(prose);
      const request = whole === "firm" || asksForWork ? whole : buildRequest(prose);
      const buildsGame = request === "firm";
      // …NOR IS A BUILD THE CAPTION TURNS DOWN OR ASKS ABOUT: "Don't build the
      // game from this yet" built it, through the GDD in the file's name.
      const declined = !buildsGame && BUILD_INTENT_RE.test(prose);
      if (!text || buildsGame || (!asksForWork && !declined && (refersToGdd(attachment.name) || refersToGdd(text)))) {
        return { kind: "gdd-attachment", gddText: extractedText, sourceName: attachment.name };
      }
      // …AND ONE ASKED FOR TENTATIVELY, OR REPORTED, IS CONFIRMED AT THE GATE:
      // "Can we build the game from this?" started nothing, and "When I build
      // the game from this GDD, Unity crashes" nothing either.
      if (request === "tentative" && !asksForWork) {
        return { kind: "gdd-attachment", gddText: extractedText, sourceName: attachment.name, confirm: true };
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
  const plain = withoutMarkup(text);
  const named = namedDocumentsIn(plain);
  const prose = proseOf(plain, named);
  if (!buildRequest(prose)) return undefined;

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
  const request = wholeGameRequest(prose);
  if (named.length > 0 && !request) return undefined;
  // …AND AT ONCE ONLY IN THE PLAIN FORM (designAmong). "Build the game
  // following docs/android-signing.md" and "Build the game
  // (docs/troubleshooting.md has the fix) and send me the APK" started an
  // ungated build from those documents: a build aimed at one that is not
  // plainly the design is confirmed at the gate the idea path stops at.
  const design = designAmong(plain, named);
  if (design === null) return undefined;
  if (design) return design.now ? { kind: "gdd-from-docs", path: design.path } : toConfirm(design);
  // A document the message only mentions is no part of what it asks for.
  const rest = withoutDocuments(plain, named);
  if (speaksOfTheGdd(rest)) {
    // …AND DESIGN TEXT WRITTEN IN THE MESSAGE IS THE DESIGN. "Build this
    // game. GDD: <the design>" was read as a reference to a document in the
    // repository and the supplied design was discarded (AD#6).
    const inline = inlineDesignIn(text);
    if (inline) return { kind: "idea", ideaText: inline };
    // "THE GDD" IS A POINTER TOO, held to the rule a path is: "Read the GDD
    // end to end" and "GDD'yi baştan sona oku" built whatever design docs/
    // held, with no approval gate. A message about the document without a
    // whole-game build is the user's task, not an idea to draft from either.
    // …AND IS HELD TO ITS CLAUSE AS A PATH IS: "Build the game and fix the
    // GDD typo" built whatever docs/ held, at once.
    if (!request) return undefined;
    return aimAtTheGdd(rest, request) === "firm" ? { kind: "gdd-from-docs" } : { kind: "gdd-to-confirm" };
  }

  if (rest.trim().length < MIN_IDEA_LENGTH) return undefined;

  // 3. A written game idea with build intent.
  return { kind: "idea", ideaText: text };
}

function toConfirm(design: Design): CampaignIntent {
  return { kind: "gdd-to-confirm", path: design.path, ...(design.others.length > 0 ? { others: design.others } : {}) };
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

/**
 * A link, which the manager refuses by name rather than reading another
 * design in its place: the whole run of the characters a link holds, its
 * sentence's closing punctuation trimmed by linkEnd. A lazy body that looked
 * ahead past that punctuation tried every length of a long run of dots.
 */
const LINK_RE = /(?:^|[\s"'`(:“‘<])((?:https?|ftp|file):\/\/[^\s"'`<>()“”‘’]+)/giu;
const SENTENCE_PUNCTUATION = ".,;:!?";

/** Where a link that runs to `to` ends: before the punctuation that closes its sentence. */
function linkEnd(text: string, to: number): number {
  let end = to;
  while (SENTENCE_PUNCTUATION.includes(text[end - 1]!)) end--;
  return end;
}

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

/**
 * Documents that sit beside a design — a style sheet, a changelog, a licence
 * — and are never it: named alone, "Build the game per docs/art-style.md"
 * (no campaign on main) was an immediate build with the style sheet for the
 * design. A readme sits beside one too, but may hold it when it is all the
 * message names.
 */
const NOT_A_DESIGN_WORDS = new Set(["style", "styles", "stylesheet", "styleguide", "stil", "changelog", "license", "licence", "contributing"]);
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

function isNeverTheDesign(path: string): boolean {
  return isBuildInstructions(path) || documentWords(path).some((word) => NOT_A_DESIGN_WORDS.has(word));
}

function isSupportDocument(path: string): boolean {
  return isNeverTheDesign(path) || documentWords(path).includes("readme");
}

/**
 * The folders and words an unquoted path with spaces began with:
 * "docs/Quill Moor GDD.md" — DOCUMENT_PATH_RE sees only "GDD.md", and the
 * manager's docs/ lookup then found docs/GDD.md, another file. A joining word
 * ("docs/ui and GDD.md") is two names, not one.
 */
const SPLIT_PATH_HEAD_RE =
  /(?:^|[\s"'`(:“‘])((?:[a-z]:[\\/]|[\\/]|~[\\/])?(?:[\p{L}\p{N}_.~-]+[\\/])+[\p{L}\p{N}_~-]+(?:\s+(?!(?:and|or|ve|veya|ile|in|from|at|the|then|to|of|for)\s)[\p{L}\p{N}_~-]+){0,3})\s+$/iu;

/**
 * …and with no folder at all: "Build the game in Quill Moor GDD.md" named
 * "GDD.md", and the manager built docs/GDD.md — another file — with no gate.
 * Where such a name begins is unknowable in lower case; in a title-cased
 * name it is the first of the capitalised words before it, up to three, that
 * are not the sentence's own ("Build The Game In GDD.md" names "GDD.md") —
 * and only where a connective, a colon or a quote leads into the name, or it
 * opens a sentence as its Turkish topic ("Quill Moor GDD.md'deki oyunu yap").
 * A sentence's first word is capitalised too: "Fetch GDD.md and build the
 * game from it" names "GDD.md".
 */
const NAME_WORD_BEFORE_RE = /(?<![^\s"'`(:“‘])(\p{Lu}[\p{L}\p{N}_~+&-]*) $/u;
const SENTENCE_WORDS = new Set([
  "build", "make", "develop", "implement", "use", "using", "read", "open", "see", "follow", "following", "please", "game",
  "the", "this", "that", "my", "our", "a", "an", "in", "from", "at", "per", "of", "for", "to", "and", "or", "with", "it", "is", "now", "then", "so", "ok", "okay", "hey", "hi", "also", "just",
  "bu", "şu", "oyunu", "oyun", "yap", "ve", "ile", "lütfen", "tasarım",
]);

const LEADS_INTO_NAME_RE = /(?:(?<![\p{L}])(?:in|from|at|per|using|following|with|of|on|the|my|our|this)\s|[:("'\x60“‘]\s*)$/iu;
const TOPIC_SUFFIX_RE = /^(?:['’]|\s+(?:oyun|dosya|belge|ile)(?![\p{L}]))/iu;

function titledNameStart(text: string, at: number, end: number): number {
  let start = at;
  for (let words = 0; words < 3; words++) {
    const word = execBefore(NAME_WORD_BEFORE_RE, text, start)?.[1];
    // Both lower cases: in Turkish "In" is "ın", and in English "İle" keeps its dot.
    if (word === undefined || SENTENCE_WORDS.has(word.toLowerCase()) || SENTENCE_WORDS.has(word.toLocaleLowerCase("tr"))) break;
    start -= word.length + 1;
  }
  const topic = testBefore(/(?:^|[.!?\n])\s*$/u, text, start) && TOPIC_SUFFIX_RE.test(text.slice(end));
  return start < at && (testBefore(LEADS_INTO_NAME_RE, text, start) || topic) ? start : at;
}

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
    const run = m.index + m[0].length;
    const at = run - m[1]!.length;
    const end = linkEnd(unread, run);
    links.push({ path: unread.slice(at, end), at, end });
  }
  named.push(...links.filter((link) => linkNamesDocument(link.path)));
  unread = blankSpans(unread, links);
  const paths: NamedDocument[] = [];
  for (const m of unread.matchAll(DOCUMENT_PATH_RE)) {
    const end = m.index + m[0].length;
    let at = end - m[1]!.length;
    const head = /[\\/]/.test(m[1]!) ? null : execBefore(SPLIT_PATH_HEAD_RE, unread, at);
    if (head) at = head.index + head[0].indexOf(head[1]!);
    else if (!/[\\/]/.test(m[1]!)) at = titledNameStart(unread, at, end);
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
 * and its GDD was a bare "the GDD" — discovery built another document. A
 * link keeps only its target, so the build is aimed at the document the
 * link opens, ended by the bracket that closed it.
 */
function withoutMarkup(text: string): string {
  return text
    .replace(/\*/g, " ")
    .replace(/\[([^\]\n]*)\]\(([^()\s]+)\)/g, (_link, label: string, target: string) => `${" ".repeat(label.length + 3)}${target} `);
}

/** Each span blanked to its own length, so every position still holds — in one pass, not one copy of the text per span. */
function blankSpans(text: string, spans: readonly NamedDocument[]): string {
  let blanked = "";
  let from = 0;
  for (const span of [...spans].sort((a, b) => a.at - b.at)) {
    const at = Math.max(span.at, from);
    if (span.end <= at) continue;
    blanked += text.slice(from, at) + " ".repeat(span.end - at);
    from = span.end;
  }
  return blanked + text.slice(from);
}

/** The message's own words: the documents it names blanked, so no file name reads as a verb, a "not" or a full stop. */
function proseOf(plain: string, named: readonly NamedDocument[] = namedDocumentsIn(plain)): string {
  return blankSpans(plain, named);
}

/** The message without the documents it names (in their order), each a single space. */
function withoutDocuments(text: string, named: readonly NamedDocument[]): string {
  let rest = "";
  let from = 0;
  for (const doc of named) {
    rest += `${text.slice(from, doc.at)} `;
    from = doc.end;
  }
  return rest + text.slice(from);
}

/**
 * How far before a document the words that aim a build at it are read. Each
 * pattern anchored there ran against the whole text before it, so a message
 * that named many documents cost the square of its length — 396 KB took
 * 5.4 s, synchronously, on every message.
 */
const BEFORE_WINDOW = 256;

/**
 * The text just before `at` as a pattern anchored there reads it, and where
 * it starts in the text. A window cut short starts at a space, behind a mark
 * that is no letter, no space and no start of the text, so no word is read
 * from its middle and no clause seems to open where the cut fell.
 */
function textBefore(text: string, at: number): { before: string; offset: number } {
  if (at <= BEFORE_WINDOW) return { before: text.slice(0, at), offset: 0 };
  const from = at - BEFORE_WINDOW;
  const space = text.slice(from, at).search(/\s/u);
  const cut = space < 0 ? at : from + space;
  return { before: `\u0001${text.slice(cut, at)}`, offset: cut - 1 };
}

function execBefore(re: RegExp, text: string, at: number): RegExpExecArray | null {
  const { before, offset } = textBefore(text, at);
  const m = re.exec(before);
  if (m) m.index += offset;
  return m;
}

function testBefore(re: RegExp, text: string, at: number): boolean {
  return re.test(textBefore(text, at).before);
}

/** How a build runs — never, on its own, a request for one. */
const BUILD_ADVERB = String.raw`(?:baştan\s+sona|end[- ]?to[- ]?end|from\s+scratch|sıfırdan)`;
const TR_BUILD_VERB = `(?:${TR_MAKE}|${TR_WRITE}|${TR_WOULD_YOU_WRITE}|${TR_DEVELOP}|${TR_CONSTRUCT}|${TR_CODE})`;
/** …with the polite question beside them, where the object is definite ("şu oyunu yapar mısın"). */
const TR_BUILD_THE_GAME_VERB = `(?:${TR_BUILD_VERB}|${TR_WOULD_YOU_MAKE})`;
const BUILD_GAME_EN = String.raw`(?<![\p{L}\p{N}_])(?:build|develop|make)\s+(?:this|the|a|my)\s+game(?![\p{L}\p{N}_'’])`;
const BUILD_GDD_EN = String.raw`(?<![\p{L}\p{N}_])(?:build|implement)\s+(?:the|this|my|our)\s+(?:GDD|game\s+design\s+doc(?:ument)?)(?![\p{L}\p{N}_'’])`;
/**
 * …as a whole-game request: what follows the GDD ends the phrase. A noun
 * after it makes it work on the document's parts — "Implement the GDD
 * changes in the HUD", "Build the GDD tooling first" took the user's task
 * over into a campaign gate (main left them ordinary tasks).
 */
const BUILD_THE_WHOLE_GDD_EN =
  BUILD_GDD_EN +
  String.raw`(?=\s*(?:$|[:.,;!?()—–]|-\s)|\s+(?:in|at|from|per|for|on|with|now|please|fully|completely|exactly|today|first|as|and|then|so|end[- ]?to[- ]?end|from\s+scratch)(?![\p{L}]))`;
const BUILD_GDD_TR = String.raw`(?<![\p{L}\p{N}_])GDD['’]y[iı](?:\s+${BUILD_ADVERB})?\s+(?:uygula|hayata\s+geçir|kodla)(?![\p{L}\p{N}_])`;
const BUILD_GAME_TR =
  String.raw`(?<![\p{L}\p{N}_])(?:oyun(?:u|unu)?(?:\s+${BUILD_ADVERB})?\s+${TR_BUILD_VERB}|oyun(?:u|unu)(?:\s+${BUILD_ADVERB})?\s+(?:${TR_WOULD_YOU_MAKE})|${TR_GAME_BY_DOCUMENT})(?![\p{L}\p{N}_])`;

/**
 * Whole-game build intent, which BUILD_INTENT_RE alone is not: it also takes
 * an adverb ("baştan sona oku", "end-to-end tests", "rewrite from scratch")
 * and a feature request. "Make the game <adjective / verb>" is causative, so
 * only a build's own shape may follow "make the game" — past a parenthesis
 * too: "Make the game (docs/perf.md explains the frame drops) faster" built
 * the game from docs/perf.md, ungated. "Develop the game further" is work on
 * a game that exists.
 */
const WHOLE_GAME_BUILD_RE = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_])(?:build|develop)\s+(?:this|the|a|my)\s+game(?![\p{L}\p{N}_'’])(?!\s+(?:further|more|beyond|better)(?![\p{L}]))`,
    String.raw`(?<![\p{L}\p{N}_])make\s+(?:this|the|a|my)\s+game(?=(?:\s*\([^()\n]*\))?(?:\s*(?:$|[:.,;!?)—–])|\s+(?:in|from|at|per|about|where|set|called|named|that|which|for|exactly|fully|completely|(?:described|defined|outlined|specified|documented|written)\s+in|based\s+on|according\s+to|as\s+(?:described|specified|defined|outlined|written)|end[- ]?to[- ]?end)(?![\p{L}])))`,
    BUILD_THE_WHOLE_GDD_EN,
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
  const clause = clauseStart(prose, at);
  const sentence = sentenceStart(prose, at);
  if (
    matchesInside(prose, TURNS_DOWN_RE, clause, at) ||
    matchesInside(prose, ASKS_ABOUT_RE, clause, at) ||
    QUESTION_OPENER_RE.test(prose.slice(clause, at)) ||
    matchesInside(prose, DANGLING_NOT_RE, sentence, at)
  ) {
    return false;
  }
  // A question mark that closes the build's own clause asks about it ("Build
  // the game in P?", "Bu oyunu yap: P mı?"); one past a comma belongs to
  // another clause ("…, okay?", "…, can the swarms grow slowly?").
  const ends = matchesOf(prose, SENTENCE_BREAK_RE).at;
  const close = ends[countBelow(ends, end)];
  if (close === undefined || prose[close] !== "?" || matchesInside(prose, PAUSE_RE, end, close)) return true;
  return POLITE_REQUEST_RE.test(prose.slice(sentence, at)) || /m[ıiuü]s[ıiuü]n/iu.test(prose.slice(at, end));
}

/** A word that turns down what follows it in its clause. */
const TURNS_DOWN_RE = /(?<![\p{L}])(?:not|never|dont|cannot|rather\s+than|instead\s+of|\p{L}+n['’]t)(?![\p{L}])/giu;
/** A word that makes the build a condition or a question about it. */
const ASKS_ABOUT_RE = /(?<![\p{L}])(?:if|unless|whether|how|why|what|which|where)(?![\p{L}])/giu;
/** A clause opened as a yes/no question; "can you" and its kin are requests. */
const QUESTION_OPENER_RE =
  /^\s*(?:(?:hey|so|ok(?:ay)?|wait|well|also|now)\s+)*(?:should|shall|did|does|do|is|are|was|were|am|have|has|had|may|might|must|(?:can|could|would|will)(?!\s+(?:you|u|ya)(?![\p{L}])))(?![\p{L}])/iu;
/** "Don't, for now, build …": a "not" cut off from its verb by a comma or a dash. */
const DANGLING_NOT_RE = /(?<![\p{L}])(?:not|never|dont|\p{L}+n['’]t)\s*[,—–(]/giu;
const POLITE_REQUEST_RE =
  /^\s*(?:(?:hey|hi|ok(?:ay)?|so|now|alright|also|well)[\s,!]+)*(?:(?:please|pls|plz|kindly|lütfen)(?![\p{L}])|(?:(?:please|pls|plz)[\s,]+)?(?:can|could|would|will)\s+(?:you|u|ya)(?![\p{L}]))/iu;
/** A comma, a semicolon or a dash: what puts a later question mark in another clause. */
const PAUSE_RE = /[,;—–]|\s-\s/gu;
const CLAUSE_BREAK_RE = /[,;:()[\]—–\n]|[.!?](?=\s|$)|\s-\s|(?<![\p{L}])(?:and|but|then|or|ve|ama|fakat|sonra)(?![\p{L}])/giu;
/** The end of a sentence: a stop, a bang or a question mark before a space, or a line break. */
const SENTENCE_BREAK_RE = /[.!?](?=["'\x60”’)\]]*(?:\s|$))|\n/gu;

/**
 * Every match of the global `re` in `text`, found once for the text being
 * read. Each build and each document read its clause, its sentence and the
 * words in them again from the start of the text, so a message that named
 * many documents cost the square of its length.
 */
let readText: string | undefined;
let readMatches = new Map<RegExp, { at: number[]; end: number[] }>();

function matchesOf(text: string, re: RegExp): { at: number[]; end: number[] } {
  if (readText !== text) readMatches = new Map();
  // The same text in another string is compared in full: keep the one asked for, so the next call compares it by reference.
  readText = text;
  let found = readMatches.get(re);
  if (found === undefined) {
    found = { at: [], end: [] };
    for (const m of text.matchAll(re)) {
      found.at.push(m.index);
      found.end.push(m.index + m[0].length);
    }
    readMatches.set(re, found);
  }
  return found;
}

/** How many of the ascending `list` are below `value` — the index of the first at or above it. */
function countBelow(list: readonly number[], value: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (list[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether a match of the global `re` lies wholly inside `text` from `from` to `to`. */
function matchesInside(text: string, re: RegExp, from: number, to: number): boolean {
  const { at, end } = matchesOf(text, re);
  const first = countBelow(at, from);
  return first < at.length && end[first]! <= to;
}

/** Where the clause that `at` stands in begins — after the last break before it, a stop just before it included. */
function clauseStart(prose: string, at: number): number {
  const ends = matchesOf(prose, CLAUSE_BREAK_RE).end;
  const last = countBelow(ends, at + 1);
  const start = last > 0 ? ends[last - 1]! : 0;
  return at > start && /[.!?]/u.test(prose[at - 1]!) ? at : start;
}

/** Where the sentence that `at` stands in begins (see clauseStart). */
function sentenceStart(prose: string, at: number): number {
  const ends = matchesOf(prose, SENTENCE_BREAK_RE).end;
  const last = countBelow(ends, at + 1);
  const start = last > 0 ? ends[last - 1]! : 0;
  const stop = /[.!?]["'\x60”’)\]]*$/u.exec(prose.slice(Math.max(start, at - 16), at));
  return stop ? Math.max(start, at - 16) + stop.index + 1 : start;
}

function sentenceBefore(prose: string, at: number): string {
  return prose.slice(sentenceStart(prose, at), at);
}

/**
 * A request put as a wish, or as a question about whether it can be done:
 * "I was wondering if you could build…", "Is it possible to build…?", "What
 * I want is to build…", "Can we build…?". The "if", "what" and question
 * rules read each as a build asked about, and it started nothing — main
 * drafted them at the gate. A request, but a tentative one: an idea is
 * drafted at the gate as any idea is, and a document is confirmed there
 * first, never built at once.
 */
const TENTATIVE_REQUEST_RE =
  /^\s*(?:(?:hey|hi|hello|so|ok(?:ay)?|well|also|now)[\s,!]+)*(?:i(?:\s+was|\s+am|['’]m)?\s+wonder(?:ing)?\s+(?:if|whether)\s+(?:you|u|we)\s+(?:could|can|would|might)|(?:is|would)\s+it\s+(?:be\s+)?possible\s+(?:for\s+(?:you|us|me)\s+)?to|what\s+i(?:['’]d|\s+would)?\s+(?:want|like)\s+is\s+(?:for\s+(?:you|us)\s+)?to|(?:can|could)\s+we)(?:\s+(?:please|maybe|perhaps))?\s*$/iu;

/**
 * What may stand before an English build verb that is an order: a greeting, a
 * "now" or a "please", then at most a "can you", an "I want you to", a "let's"
 * or a "help me". A subject or a time clause there makes the sentence a
 * report about a build: "When I build the game in P, Unity crashes", "I tried
 * to build the game in P but the editor freezes" and "My friend will build
 * the game in P" each started a campaign at once. Turkish orders by the
 * verb's own form ("yap"); its reports are other forms ("yaparken") or words
 * after the verb ("yap dedim"), which the patterns and clause ends refuse.
 */
const ORDER_OPENER_RE = new RegExp(
  String.raw`^[^\p{L}\p{N}]*(?:(?:hey|hi|hello|ok(?:ay)?|so|now|alright|also|well|just|then|go|please|pls|plz|kindly)[^\p{L}\p{N}]+)*` +
    String.raw`(?:(?:(?:can|could|would|will)\s+(?:you|u|ya)|i(?:\s+(?:want|need|would\s+like)|['’]d\s+like)\s+you\s+to|let['’]?s|let\s+us|help\s+me(?:\s+to)?)\s+(?:(?:please|pls|plz|kindly|just|now)\s+)*)?$`,
  "iu",
);
const ORDER_OPENER_MAX = 80;
const ENGLISH_BUILD_VERB_RE = /^(?:build|develop|make|implement)(?![\p{L}])/iu;

/** How firmly a build is asked for: plainly, or tentatively (see TENTATIVE_REQUEST_RE and ORDER_OPENER_RE). */
type Request = "firm" | "tentative";

function requestAt(prose: string, at: number, end: number): Request | undefined {
  if (TENTATIVE_REQUEST_RE.test(sentenceBefore(prose, at))) return "tentative";
  if (!buildIsAsked(prose, at, end)) return undefined;
  if (!ENGLISH_BUILD_VERB_RE.test(prose.slice(at, at + 12))) return "firm";
  // An opener is a few words: a longer run before the verb is read no further.
  const clause = clauseStart(prose, at);
  return at - clause <= ORDER_OPENER_MAX && ORDER_OPENER_RE.test(prose.slice(clause, at)) ? "firm" : "tentative";
}

const WHOLE_GAME_BUILDS_RE = new RegExp(WHOLE_GAME_BUILD_RE.source, "giu");
const BUILD_INTENTS_RE = new RegExp(BUILD_INTENT_RE.source, "gi");

/** The firmest request among the builds `re` finds in the prose. */
function strongestRequest(prose: string, re: RegExp): Request | undefined {
  let found: Request | undefined;
  for (const m of prose.matchAll(re)) {
    const request = requestAt(prose, m.index, m.index + m[0].length);
    if (request === "firm") return request;
    found ??= request;
  }
  return found;
}

/** A whole-game build the message asks for (see buildIsAsked). */
function wholeGameRequest(prose: string): Request | undefined {
  return strongestRequest(prose, WHOLE_GAME_BUILDS_RE);
}

/**
 * Any build intent — an adverb included — the message asks for. The
 * whole-game builds count in their own right: in "P'deki oyunu baştan sona
 * yapar mısın?" the first build intent is the adverb alone, its question
 * mark read as a question, and the polite request was lost.
 */
function buildRequest(prose: string): Request | undefined {
  const any = strongestRequest(prose, BUILD_INTENTS_RE);
  return any === "firm" ? any : (wholeGameRequest(prose) ?? any);
}

/**
 * The build is aimed at the document written right after it: "Build this
 * game: P", "build the game in / from / per / using / following P", "build
 * the game (P)", "build the game from the GDD at P", "Bu oyunu yap: P".
 * "With P" too: read only when P was called the design, "Build the game
 * with docs/quillmoor.md" started nothing at all, where "using P" was
 * confirmed at the gate. How a build goes ("with docs/ui-notes.md in mind")
 * is no aim, as its document does not end its clause. The groups say when
 * the build's own clause calls P the GDD: `gdd`, the build is of the GDD
 * itself ("implement the GDD at P"); `calledGdd`, P is introduced as it
 * ("from the GDD at P"). "From the design in P" says no more than P's name
 * does.
 */
const BUILDS_FROM_NEXT_RE = new RegExp(
  `(?:${BUILD_GAME_EN}|(?<gdd>${BUILD_GDD_EN}|${BUILD_GDD_TR})|${BUILD_GAME_TR})(?:\\s+${BUILD_ADVERB})*` +
    String.raw`(?:\s*[:(]|\s+(?:in|from|at|per|using|following|with|(?:described|defined|outlined|specified|documented|written)\s+in|based\s+on|according\s+to|as\s+(?:described|specified|defined|outlined|written)\s+in))` +
    String.raw`(?:\s+(?:the|this|that|my|our))?` +
    String.raw`(?:\s+(?:(?<calledGdd>GDD|game\s+design\s+doc(?:ument)?)|design(?:\s+doc(?:ument)?)?|document|doc|spec(?:ification)?|file)(?:\s+(?:at|in)|\s*:)?)?` +
    String.raw`\s*["'\x60“‘(<]?$`,
  "iu",
);

/**
 * …or written right before it, the build the whole of the next clause: "P:
 * build this game", "P — build the game from it". Only that: "P: build the
 * game fails on Android" is a bug report about P.
 */
const BUILDS_FROM_PREVIOUS_RE = new RegExp(
  String.raw`^["'\x60”’)]*\s*(?:[:—–]|\s-)\s*(?:(?:now|please|so|ok(?:ay)?|then)[\s,]+)*(${BUILD_GAME_EN}|${BUILD_GDD_EN})` +
    String.raw`(?:\s+(?:${BUILD_ADVERB}|from\s+(?:it|this|that)|now|please))*\s*(?:[.!]|$)`,
  "iu",
);

/**
 * The game the build is aimed at is the one IN the document just written:
 * "P'deki oyunu yap", "P dosyasındaki oyunu geliştir", "P oyununu baştan sona
 * yap", "P'ye göre oyunu yap", "P ile oyunu yap", "P'yi kullanarak oyunu
 * yap". "P'deki notlara göre oyunu geliştir" (improve the game by the notes
 * in P) is not.
 */
const GAME_IN_PREVIOUS_RE = new RegExp(
  String.raw`^(?:['’](?:[dt][ae]ki|[dt][ae]n|y?[ae]\s+göre|y?[ıiuü]\s+kullanarak)|\s+(?:dosya|belge|doküman|döküman)s[ıi]n(?:[dt][ae]ki|[dt][ae]n|[ae]\s+göre|[ıi]\s+kullanarak)|\s+içindeki|\s+ile)?` +
    String.raw`\s+(?:bu\s+|şu\s+)?oyun(?:u|unu)(?:\s+${BUILD_ADVERB})?\s+${TR_BUILD_THE_GAME_VERB}(?![\p{L}\p{N}_])`,
  "iu",
);

/** "Oyunu P'ye göre yap": the object before the document, its verb after (see TR_GAME_BY_DOCUMENT). */
const GAME_BEFORE_RE = /(?<![\p{L}\p{N}_])(?:bu\s+|şu\s+)?oyun(?:u|unu)\s+["'\x60“‘]?$/iu;
const BY_DOCUMENT_AFTER_RE = new RegExp(
  String.raw`^["'\x60”’]?(?:['’](?:y?[ae]\s+göre|[dt][ae]n)|\s+(?:dosya|belge|doküman|döküman)s[ıi]n(?:[ae]\s+göre|[dt][ae]n))(?:\s+${BUILD_ADVERB})?\s+${TR_BUILD_THE_GAME_VERB}(?![\p{L}\p{N}_])`,
  "iu",
);

/** The document is the GDD the message speaks of: "the GDD at P", "GDD: P", "GDD'li dosya P". */
const GDD_NAMES_NEXT_RES = [GDD_ACRONYM_RE, GDD_SPELLED_RE].map(
  (re) =>
    new RegExp(
      `(?:${re.source})` +
        String.raw`(?:['’]\p{L}+)?(?:\s+(?:dosya(?:sı)?|belge(?:si)?|file|document|doc))?(?:\s+(?:is\s+(?:at|in)|at|in|is)|\s*[:=(—–-])?\s*["'\x60“‘(<]?$`,
      re.flags,
    ),
);

/**
 * The document is the design, said at the start of a clause: "the design is
 * P", "design: P", "(design: P)", "tasarım P". A modifier makes it another
 * design: "the art design is in P" names the style sheet.
 */
const DESIGN_NAMES_NEXT_RE =
  /(?:^|[,;:(—–]\s*|[.!?]\s+|(?<![\p{L}])(?:and|ve)\s+)(?:(?:the|its|our|my)\s+)?(?:(?:game\s+)?design(?:\s+(?:doc(?:ument)?|file|spec))?\s*(?:(?:is|lives|sits)(?:\s+(?:in|at))?|at|in|[:=—–])|(?:oyunun\s+)?tasarım(?:ı)?(?:\s+(?:dosyası|belgesi))?\s*[:=—–]?)\s*["'\x60“‘(<]?$/iu;

/** "P and Q", "P, Q", "P ve Q": named together, aimed at together. */
const NAMED_TOGETHER_RE = /^\s*["'`”’)]?\s*(?:,\s*(?:(?:and|or|ve|veya)\s+)?|\s+(?:and|or|ve|veya|&|\+)\s+)["'`“‘(]?$/iu;

/** A word, before a document in its clause, that turns it away: "not P", "don't use P", "ignore P", "no GDD", "forget the GDD", "I lost my GDD". */
const TURNS_AWAY_BEFORE_RE = /(?<![\p{L}])(?:ignore|skip|except|excluding|without|no|forget|disregard|lost|deleted|removed|misplaced)(?![\p{L}])/giu;
/** …and after it: "P is outdated", "P'yi kullanma", "P değil", "P yerine", "GDD yok", "GDD olmadan", "GDD'yi unut", "GDD'siz". */
const TURNS_AWAY_AFTER_RE =
  /(?<![\p{L}])(?:outdated|obsolete|deprecated|superseded|stale|old|wrong|retired|ignored?|eski|geçersiz|değil|yerine|hariç|kullanma\p{L}*|görmezden|yok|olmadan|unut\p{L}*|(?<=['’])s[ıiuü]z)(?![\p{L}])/giu;
/**
 * …and, after "the GDD" itself, a verb that says it is not there: "the GDD
 * doesn't exist yet", "has not been written", "was never written", "henüz
 * yazılmadı", "hazırlanmamış" — or that it was lost: "was deleted", "is
 * missing", "kayboldu", "silindi". Each was offered at the gate as the newest
 * GDD in docs/, and the idea beside it was not drafted. A named document is
 * not held to these: "P that isn't done" is a caveat, confirmed at the gate.
 */
const NOT_THERE_AFTER_RE =
  /(?<![\p{L}])(?:\p{L}+n['’]t|(?:is|are|was|were|has|have|had|does|do|did)\s+not|never|lost|deleted|removed|missing|gone|\p{L}+m[ae](?:d[ıi]|m[ıi]ş)\p{L}*|kayıp|kayb(?:ol|et)\p{L}*|sil(?:in|di)\p{L}*)(?![\p{L}])/giu;

/** Only quotes, brackets and spaces between a name and the colon beside it. */
const BESIDE_A_COLON_RE = /^[\s"'\x60“”‘’(<>]*$/u;

/**
 * A colon introduces what follows it, so a name on either side of one is read
 * with the clause on the other side too: in "no GDD: P" the "no" is P's, and
 * in "the GDD: P is outdated" the "outdated" is the GDD's. `theGdd` holds a
 * reference to "the GDD" to NOT_THERE_AFTER_RE too.
 */
function turnedAway(prose: string, doc: Pick<NamedDocument, "at" | "end">, theGdd = false): boolean {
  const besideColon = (from: number, to: number): boolean => to - from <= 8 && BESIDE_A_COLON_RE.test(prose.slice(from, to));
  let start = clauseStart(prose, doc.at);
  if (prose[start - 1] === ":" && besideColon(start, doc.at)) start = clauseStart(prose, start - 1);
  if (matchesInside(prose, TURNS_DOWN_RE, start, doc.at) || matchesInside(prose, TURNS_AWAY_BEFORE_RE, start, doc.at)) return true;
  const breaks = matchesOf(prose, CLAUSE_BREAK_RE).at;
  const next = countBelow(breaks, doc.end);
  let clauseEnd = breaks[next] ?? prose.length;
  if (prose[clauseEnd] === ":" && besideColon(doc.end, clauseEnd)) clauseEnd = breaks[next + 1] ?? prose.length;
  return matchesInside(prose, TURNS_AWAY_AFTER_RE, doc.end, clauseEnd) || (theGdd && matchesInside(prose, NOT_THERE_AFTER_RE, doc.end, clauseEnd));
}

/**
 * What may follow a document for the build to be aimed at it plainly: the
 * end of its clause — a stop, a comma, "and", a closing bracket, a line
 * break, the end — after a closing quote, a section anchor or a Turkish case
 * ending, with at most an adverb of the build or the platform it is for in
 * between. The build was checked only by the words BEFORE its document:
 * "Build the game (docs/troubleshooting.md has the fix) and send me the APK"
 * and "Build this game: docs/notes.md is where I keep my todo list" built
 * from a document that is the subject of its own predicate, and "Make the
 * game in docs/perf.md faster" from one the build only qualifies.
 */
const BUILD_PLATFORM = String.raw`android|ios|iphone|ipad|mobile|pc|mac(?:os)?|windows|linux|desktop|web(?:gl)?|the\s+web|browsers?|steam|switch|consoles?|me|us`;
const ENDS_ITS_CLAUSE_RE = new RegExp(
  String.raw`^["'\x60”’>]*(?:#[^\s,;)]*)?(?:['’]\p{L}+)?` +
    String.raw`(?:[^\S\n]+(?:${BUILD_ADVERB}|now|please|lütfen|hemen|şimdi|içinde|for\s+(?:${BUILD_PLATFORM}))(?![\p{L}]))*` +
    String.raw`[^\S\n]*(?:$|[\n.!?,;)—–]|-\s|(?:and|then|but|or|ve|sonra|ama|fakat)(?![\p{L}]))`,
  "iu",
);

function endsItsClause(after: string): boolean {
  return ENDS_ITS_CLAUSE_RE.test(after);
}

/**
 * …and a document inside a parenthesis is followed by the bracket that
 * closes it: "(P)", never "(P, step 4 fails)".
 */
function documentEndsItsClause(text: string, doc: Span): boolean {
  const after = text.slice(doc.end);
  if (!/\([^()]*$/.test(text.slice(Math.max(0, doc.at - 300), doc.at))) return endsItsClause(after);
  const close = /^["'\x60”’>]*\)/.exec(after);
  return close !== null && endsItsClause(after.slice(close[0].length));
}

interface Span {
  at: number;
  end: number;
}

interface Aim {
  /** How firmly the build aimed at the document is asked for. */
  request: Request;
  /** The build's own clause calls the document the GDD ("build the game from the GDD at P"), whatever its name. */
  calledGdd: boolean;
}

/**
 * How a build the message asks for is aimed at the document at
 * `doc.at`..`doc.end`, when it is — and only when the document ends its
 * clause. A build aimed at a document counts only when it is asked for:
 * "Don't build the game in docs/Old_GDD.md; build the game in
 * docs/New_GDD.md". `request` is the message's whole-game request, which a
 * document the message calls the design is aimed at by — never at once, as
 * that call may sit in another clause than the build: "Polish the menu, the
 * design is in docs/menu.md, then build the game" built the menu's notes.
 */
function aimAt(text: string, prose: string, doc: Span, request: Request | undefined): Aim | undefined {
  const after = text.slice(doc.end);
  const before = execBefore(BUILDS_FROM_NEXT_RE, text, doc.at);
  const beforeAsked = before && requestAt(prose, before.index, doc.at);
  if (beforeAsked && documentEndsItsClause(text, doc)) {
    return { request: beforeAsked, calledGdd: before.groups?.gdd !== undefined || before.groups?.calledGdd !== undefined };
  }
  const game = GAME_IN_PREVIOUS_RE.exec(after);
  const gameAsked = game && requestAt(prose, doc.at, doc.end + game[0].length);
  if (gameAsked && endsItsClause(after.slice(game[0].length))) return { request: gameAsked, calledGdd: false };
  const next = BUILDS_FROM_PREVIOUS_RE.exec(after);
  const nextAsked = next && requestAt(prose, doc.end + next[0].length - next[1]!.length, doc.end + next[0].length);
  if (nextAsked) return { request: nextAsked, calledGdd: false };
  const object = execBefore(GAME_BEFORE_RE, text, doc.at);
  const verb = object && BY_DOCUMENT_AFTER_RE.exec(after);
  const verbAsked = object && verb && requestAt(prose, object.index, doc.end + verb[0].length);
  if (verbAsked && endsItsClause(after.slice(verb[0].length))) return { request: verbAsked, calledGdd: false };
  const called = request !== undefined && [...GDD_NAMES_NEXT_RES, DESIGN_NAMES_NEXT_RE].some((re) => testBefore(re, text, doc.at));
  return called && documentEndsItsClause(text, doc) ? { request, calledGdd: false } : undefined;
}

/**
 * The words a document's name says it is the game's design by: alone, or
 * after "game" — "design.md", "Game_Design_v2.md", "Oyun_Tasarımı.md". A
 * denylist of the parts a design may be of let every other word through:
 * "hud-design.md", "design_system.md" (a component library) and
 * "design-notes.md" each started at once. Any other word before it may name
 * a part as well as the game, and one after it notes or a library, so those
 * are confirmed first.
 */
const DESIGN_WORDS = new Set(["design", "gamedesign", "tasarım", "tasarımı", "tasarim", "tasarimi"]);
const GAME_WORDS = new Set(["game", "oyun", "oyunun"]);
const DOCUMENT_WORDS = new Set(["doc", "document", "belge", "belgesi", "doküman", "dokümanı"]);

/** A document whose own name says it is the game's design: GDD, game design, tasarım. */
function nameSaysDesign(path: string): boolean {
  if (refersToGdd(path.split(/[\\/]/).pop()!)) return true;
  const words = documentWords(path).filter((word) => !/^v?\p{N}+$/u.test(word));
  const at = words.findIndex((word) => DESIGN_WORDS.has(word));
  return at >= 0 && words.slice(0, at).every((word) => GAME_WORDS.has(word)) && words.slice(at + 1).every((word) => DOCUMENT_WORDS.has(word));
}

/** The document a build is to be made from, whether it starts at once, and the others the message offered. */
interface Design {
  path: string;
  now: boolean;
  others: string[];
}

function offered(docs: readonly NamedDocument[], design: NamedDocument, now = false): Design {
  return { path: design.path, now, others: docs.filter((doc) => doc !== design).map((doc) => doc.path) };
}

/**
 * The design among the documents the message names, and whether the build
 * starts from it at once.
 *
 * AT ONCE ONLY IN THE PLAIN FORM: a whole-game build asked for, aimed at one
 * document that could hold the design (no style sheet, changelog, licence,
 * readme or build instructions beside it counts), whose name says it is the
 * design or which the build's own clause calls the GDD, and which ends its
 * clause. Every
 * other document the build points at is offered at the approval gate first:
 * one with any other name ("following docs/android-signing.md"), one of two
 * the build is aimed at together, and one only named beside the documents it
 * is aimed at.
 *
 * Beside them: a build aimed only at a style sheet or a changelog is aimed at
 * no design. "Build the game per docs/art-style.md, see docs/Quillmoor_GDD.md"
 * built the style sheet, ungated; the design offered is then the one named
 * beside it — a GDD first, else any other document — unless the message
 * turns it away. A GDD named anywhere else is the design when the message
 * asks for "the GDD" or holds nothing else to build from — otherwise it is a
 * reference beside an idea, and the idea is the design. Named alone, with
 * nothing else to build from, a readme may still hold the design; a style
 * sheet, a changelog or a licence is no design at all; and build or release
 * instructions make the build the player build — `null` says no campaign,
 * however long the message is (it is no idea to draft either).
 */
function designAmong(text: string, named: readonly NamedDocument[]): Design | null | undefined {
  if (named.length === 0) return undefined;
  const prose = proseOf(text, named);
  const request = wholeGameRequest(prose);
  // A DOCUMENT THE MESSAGE RULES OUT IS AIMED AT BY NOTHING. "Build the game.
  // Ignore the GDD at docs/Old_GDD.md." built it at once: the turned-away
  // words were read only for a document named beside the build, never for
  // one the message calls the design.
  const away = named.map((doc) => turnedAway(prose, doc));
  const aims = named.map((doc, i) => (away[i] ? undefined : aimAt(text, prose, doc, request)));
  // "P and Q", "P ve Q": named together, aimed at together — as long as the
  // one the aim spreads to ends its clause too.
  // One sweep each way reaches every document of a chain: a pass repeated
  // until nothing moved went one step per pass, its length squared.
  const spread = (from: number, to: number): void => {
    const [left, right] = from < to ? [from, to] : [to, from];
    if (!aims[from] || aims[to] || !NAMED_TOGETHER_RE.test(text.slice(named[left]!.end, named[right]!.at))) return;
    if (documentEndsItsClause(text, named[to]!)) aims[to] = { request: aims[from]!.request, calledGdd: false };
  };
  for (let i = 1; i < named.length; i++) spread(i - 1, i);
  for (let i = named.length - 1; i > 0; i--) spread(i, i - 1);
  const aimedDocs = named.filter((_, i) => aims[i]);
  const designs = aimedDocs.filter((doc) => refersToGdd(doc.path) || !isSupportDocument(doc.path));
  if (designs.length > 0) {
    const design = designs.find((doc) => refersToGdd(doc.path)) ?? designs[0]!;
    const aim = aims[named.indexOf(design)]!;
    return offered(designs, design, designs.length === 1 && aim.request === "firm" && (aim.calledGdd || nameSaysDesign(design.path)));
  }
  const playerBuild = aimedDocs.length > 0 && aimedDocs.every((doc) => isBuildInstructions(doc.path));
  const rest = withoutDocuments(text, named);
  if (!request || !(speaksOfTheGdd(rest) || rest.trim().length < MIN_IDEA_LENGTH)) return playerBuild ? null : undefined;
  const beside = named.filter((_, i) => !aims[i]);
  const candidates = named.filter((_, i) => !aims[i] && !away[i]);
  const gdds = candidates.filter((doc) => refersToGdd(doc.path));
  if (gdds.length > 0) return offered(gdds, gdds[0]!);
  if (aimedDocs.length === 0) return undefined;
  const others = candidates.filter((doc) => !isSupportDocument(doc.path));
  if (others.length > 0) return offered(others, others[0]!);
  if (beside.some((doc) => !isSupportDocument(doc.path))) return undefined;
  if (playerBuild) return null;
  const readme = aimedDocs.find((doc) => !isNeverTheDesign(doc.path));
  return readme && offered([readme], readme);
}

const BUILDS_THE_GDD_RE = new RegExp(`${BUILD_GDD_EN}|${BUILD_GDD_TR}`, "giu");

/** How firmly a build is aimed plainly at "the GDD" the message speaks of (see aimAt), when one is. */
function aimAtTheGdd(text: string, request: Request): Request | undefined {
  const words = withoutCodeFiles(text);
  const references = GDD_REFERENCES_RES.flatMap((re) => [...words.matchAll(re)].map((m) => ({ at: m.index, end: m.index + m[0].length })));
  const aimed = references.filter((ref) => !turnedAway(words, ref)).map((ref) => aimAt(words, words, ref, request)?.request);
  for (const m of words.matchAll(BUILDS_THE_GDD_RE)) {
    const end = m.index + m[0].length;
    if (endsItsClause(words.slice(end))) aimed.push(requestAt(words, m.index, end));
  }
  return aimed.includes("firm") ? "firm" : aimed.find((asked) => asked !== undefined);
}

/** The design document the message names, when it names one. */
export function documentPathIn(text: string): string | undefined {
  const plain = withoutMarkup(text);
  return designAmong(plain, namedDocumentsIn(plain))?.path;
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
