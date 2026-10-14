import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { detectCampaignIntent, type CampaignIntent } from "./campaign-intake.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";

/** A build that starts at once from the document at `path`: the one form that is plainly a request for it. */
const now = (path: string): CampaignIntent => ({ kind: "gdd-from-docs", path });
/** A build from the document at `path` that the user confirms at the approval gate first; `others` are the rest offered. */
const confirm = (path: string, ...others: string[]): CampaignIntent => ({ kind: "gdd-to-confirm", path, ...(others.length > 0 ? { others } : {}) });

function msg(text: string, attachments?: IncomingMessage["attachments"]): IncomingMessage {
  return {
    chatId: "cli-local",
    channelType: "cli",
    userId: "u1",
    text,
    timestamp: new Date(),
    ...(attachments ? { attachments } : {}),
  } as IncomingMessage;
}

const LONG_IDEA =
  "Bir match-3 oyunu yap: domuzlar uçuyor, her seviye renkli bloklarla dolu, kazanmak için tüm domuzları kurtarmak gerekiyor.";

describe("detectCampaignIntent", () => {
  it("matches a written game idea with build intent (TR)", () => {
    const intent = detectCampaignIntent(msg(LONG_IDEA));
    expect(intent).toEqual({ kind: "idea", ideaText: LONG_IDEA });
  });

  it("matches an English end-to-end build request", () => {
    const text = "Build this game from scratch: a roguelike deck-builder about time-traveling chefs, with daily runs and boss fights every 10 floors.";
    const intent = detectCampaignIntent(msg(text));
    expect(intent).toEqual({ kind: "idea", ideaText: text });
  });

  it("routes 'build the game in the GDD' to the docs-based ladder", () => {
    const intent = detectCampaignIntent(msg("GDD'deki oyunu baştan sona yap, sprint sprint ilerle."));
    expect(intent).toEqual({ kind: "gdd-from-docs" });
  });

  it("extracts a shared GDD document attachment", () => {
    const gddMd = `# Space Cat GDD\n\n${"Design content. ".repeat(30)}`;
    const intent = detectCampaignIntent(
      msg("işte gdd", [
        { type: "document", name: "SpaceCat_GDD.md", data: Buffer.from(gddMd, "utf8") },
      ]),
    );
    expect(intent).toMatchObject({ kind: "gdd-attachment", sourceName: "SpaceCat_GDD.md" });
  });

  it("does NOT hijack a feature-level request about an existing game", () => {
    expect(detectCampaignIntent(msg("Oyuna pause menüsü ekler misin? ESC ile açılsın."))).toBeUndefined();
    expect(detectCampaignIntent(msg("Can you add a settings screen to the game?"))).toBeUndefined();
  });

  it("ignores short messages and greetings", () => {
    expect(detectCampaignIntent(msg("oyun yap"))).toBeUndefined(); // too short to design from
    expect(detectCampaignIntent(msg("selam, nasılsın? bugün ne yaptın bana anlat lütfen"))).toBeUndefined();
  });

  it("ignores attachments without build intent and without a GDD name", () => {
    expect(
      detectCampaignIntent(
        msg("şu dosyaya bir bak", [
          { type: "document", name: "meeting-notes.md", data: Buffer.from("# notes\n" + "x".repeat(300)) },
        ]),
      ),
    ).toBeUndefined();
  });
});

/**
 * The idea-length minimum exists because an IDEA has to be long enough to
 * design from. It was applied to every message, so an instruction that points
 * at an existing document — "Build the game in the GDD", 25 characters — was
 * ignored entirely and fell through to ordinary task handling (Codex
 * 2026-09-12 X).
 */
describe("a short instruction that names the document (Codex 2026-09-12 X)", () => {
  it("is a campaign, however short", () => {
    expect(detectCampaignIntent(msg("Build the game in the GDD"))).toEqual({ kind: "gdd-from-docs" });
    expect(detectCampaignIntent(msg("GDD'deki oyunu yap"))).toEqual({ kind: "gdd-from-docs" });
  });

  it("and a short message that is only an idea still is not", () => {
    expect(detectCampaignIntent(msg("oyun yap"))).toBeUndefined();
    expect(detectCampaignIntent(msg("make a game"))).toBeUndefined();
    // …nor is a short mention of the GDD with no build intent.
    expect(detectCampaignIntent(msg("where is the GDD?"))).toBeUndefined();
  });
});

/**
 * Codex round AD#6, reproduced: both "Build the game from the GDD at
 * docs/Space_GDD.md" and "Build this game. GDD: <the design>" became a bare
 * `{kind: "gdd-from-docs"}`. The manager then chose a repository document by
 * filename distance and modification time, so a different, newer GDD could
 * win — and inline design text was discarded entirely.
 */
describe("what the message actually pointed at (Codex 2026-09-12 AD#6)", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it("keeps a path the message named", () => {
    expect(detectCampaignIntent(msg("Build the game from the GDD at docs/Space_GDD.md"))).toEqual({
      kind: "gdd-from-docs",
      path: "docs/Space_GDD.md",
    });
    expect(detectCampaignIntent(msg("GDD'deki oyunu yap: docs/Oyun_GDD.md"))).toMatchObject({
      kind: "gdd-from-docs",
      path: "docs/Oyun_GDD.md",
    });
  });

  it("keeps design text written in the message", () => {
    const intent = detectCampaignIntent(
      msg("Build this game. GDD: A puzzle where the player saves progress and restores it after exiting."),
    );
    expect(intent?.kind).toBe("idea");
    expect((intent as { ideaText: string }).ideaText).toContain("saves progress");
  });

  it("still means the repository's document when the message names neither", () => {
    expect(detectCampaignIntent(msg("Build the game in the GDD"))).toEqual({ kind: "gdd-from-docs" });
    expect(detectCampaignIntent(msg("GDD'deki oyunu yap"))).toEqual({ kind: "gdd-from-docs" });
    // A marker with nothing behind it is a reference, not a design — to one the build is not aimed at, so the
    // repository's GDD is confirmed before anything is built from it.
    expect(detectCampaignIntent(msg("Build this game. GDD: see above."))).toEqual({ kind: "gdd-to-confirm" });
  });
});

/**
 * A document that ARRIVED but whose text could not be read fell through to the
 * text rules: "build the game in this GDD" with the user's own PDF returned
 * `{kind: "gdd-from-docs"}` and the campaign built whatever design sat in
 * docs/ — a different game, with no word to the user (channel-attachments
 * review). The common shape is a Chrome / Google Docs export, whose text is
 * hex strings the extractor does not read; a scanned PDF, a few characters of
 * text, or a .csv end the same way.
 */
describe("a document that arrived but could not be read (channel-attachments review)", () => {
  const PROSE =
    "PacMan GDD. The player steers a yellow circle through a maze, eating pellets " +
    "while four ghosts chase it. Eating a power pellet turns the ghosts blue for eight " +
    "seconds so they can be eaten for points. Clearing every pellet advances the level.";

  /** A one-page PDF whose content stream shows `shown` (FlateDecode, as exporters write it). */
  function pdf(shown: string): Buffer {
    const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td ${shown} Tj ET`, "latin1"));
    return Buffer.concat([
      Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      content,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);
  }
  const hexPdf = pdf(`<${Buffer.from(PROSE, "latin1").toString("hex")}>`);
  const literalPdf = pdf(`(${PROSE})`);
  const doc = (name: string, data: Buffer): NonNullable<IncomingMessage["attachments"]>[number] => ({ type: "document", name, data });

  it("the same prose as literal strings IS the GDD (the control)", () => {
    expect(detectCampaignIntent(msg("build the game in this GDD", [doc("PacMan_GDD.pdf", literalPdf)]))).toMatchObject({
      kind: "gdd-attachment",
      sourceName: "PacMan_GDD.pdf",
    });
  });

  it("as hex strings it is reported unreadable, never built from docs/ in its place", () => {
    const intent = detectCampaignIntent(msg("build the game in this GDD", [doc("PacMan_GDD.pdf", hexPdf)]));
    expect(intent).toMatchObject({ kind: "gdd-unreadable", sourceName: "PacMan_GDD.pdf" });
    expect((intent as { reason: string }).reason).toMatch(/no text/);
  });

  it("names how little it read, and a format it does not read a design from", () => {
    const short = detectCampaignIntent(msg("GDD'deki oyunu yap", [doc("Oyun_GDD.txt", Buffer.from("TODO: write the design"))]));
    expect(short).toMatchObject({ kind: "gdd-unreadable", sourceName: "Oyun_GDD.txt" });
    expect((short as { reason: string }).reason).toContain("22 characters");

    const csv = detectCampaignIntent(msg("Build the game in the GDD", [{ type: "file", name: "tuning.csv", data: Buffer.from(PROSE) }]));
    expect(csv).toMatchObject({ kind: "gdd-unreadable", sourceName: "tuning.csv" });
  });

  it("a named path or an idea in the caption does not replace the document that arrived", () => {
    expect(
      detectCampaignIntent(msg("Build the game from the GDD at docs/Space_GDD.md", [doc("PacMan_GDD.pdf", hexPdf)])),
    ).toMatchObject({ kind: "gdd-unreadable" });
    expect(detectCampaignIntent(msg(LONG_IDEA, [doc("domuzlar.pdf", hexPdf)]))).toMatchObject({ kind: "gdd-unreadable" });
  });

  it("is no campaign at all where the message never asked for one", () => {
    expect(detectCampaignIntent(msg("şu dosyaya bir bak", [doc("scan.pdf", hexPdf)]))).toBeUndefined();
    expect(detectCampaignIntent(msg("", [doc("scan.pdf", hexPdf)]))).toBeUndefined();
    // An image beside an idea is not a document the idea replaced.
    expect(
      detectCampaignIntent(msg(LONG_IDEA, [{ type: "image", name: "mood.png", data: Buffer.from("89504e47", "hex") }])),
    ).toEqual({ kind: "idea", ideaText: LONG_IDEA });
  });
});

/**
 * A message that points at the design by its path was read as an idea, or as
 * nothing: "Build this game: docs/Foo_GDD.md" became `{kind: "idea"}` once it
 * ran past the idea-length minimum (the campaign drafted a NEW design from
 * that one sentence) and `undefined` below it. Only a message that also spelled
 * out "the GDD" was a pointer: `\bgdd\b` never matches inside Foo_GDD ('_' is a
 * word character), and a path without GDD in its name did not count at all.
 * An absolute path was not extracted, so the campaign went on to discover
 * whichever design docs/ held.
 */
describe("a message that names the design document by its path", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    ["Build this game: docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Build the game in docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Build the game in docs/Quillmoor_GDD.md, sprint by sprint, until it is done.", now("docs/Quillmoor_GDD.md")],
    ["build the game from the GDD at docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Build this game: quill-moor-gdd.md", now("quill-moor-gdd.md")],
    ["Build this game: docs/QuillmoorGDD.md", now("docs/QuillmoorGDD.md")],
    ["Make this game: design/quillmoor-notes.docx", confirm("design/quillmoor-notes.docx")],
    ["Develop my game from docs/quillmoor.markdown", confirm("docs/quillmoor.markdown")],
    ["Build the game described in ./quillmoor.txt", confirm("./quillmoor.txt")],
    ["Build the game in /Users/someone/Desktop/Quillmoor_GDD.pdf", now("/Users/someone/Desktop/Quillmoor_GDD.pdf")],
    ["Build the game in ~/Desktop/Quillmoor_GDD.rtf", now("~/Desktop/Quillmoor_GDD.rtf")],
    ["Build the game in C:\\Games\\Quillmoor_GDD.odt", now("C:\\Games\\Quillmoor_GDD.odt")],
    ['Build the game in "docs/Quill Moor GDD.md"', now("docs/Quill Moor GDD.md")],
    ["docs/Quillmoor_GDD.md oyununu baştan sona yap", now("docs/Quillmoor_GDD.md")],
    ["Bu oyunu yap: docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Quillmoor_GDD.odt'deki oyunu baştan sona yap", now("Quillmoor_GDD.odt")],
    ["docs/quillmoor.pdf dosyasındaki oyunu geliştir", confirm("docs/quillmoor.pdf")],
    // Called the GDD outside the build's own clause, it is confirmed first.
    ["GDD'li dosya docs/quillmoor.txt, bu oyunu yap", confirm("docs/quillmoor.txt")],
    // A word before "tasarımı" other than "oyun" may name a part as well as the game: confirmed first.
    ["Bu oyunu yap: docs/Kuşkonmaz_Tasarımı.md", confirm("docs/Kuşkonmaz_Tasarımı.md")],
    ["Quillmoor_GDD.md’deki oyunu baştan sona yap", now("Quillmoor_GDD.md")],
    // Beside a style sheet or a changelog, the design — wherever it stands.
    ["Build the game in docs/art-style.md and docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Following docs/art-style.md, build the game in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["CHANGELOG.md'yi güncel tut, docs/quillmoor.md'deki oyunu baştan sona yap", confirm("docs/quillmoor.md")],
    // Named alone, it is the one the message meant, whatever it is called.
    ["Build this game: docs/README.md", confirm("docs/README.md")],
    // A workbook is a format the document extractor reads; this sentence was an idea to draft.
    ["Build this game: design/quillmoor-balance.xlsx", confirm("design/quillmoor-balance.xlsx")],
    ["Build this game: **docs/quillmoor.md**", confirm("docs/quillmoor.md")],
  ])("%s → %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  /**
   * A GDD named with no extension, in a format the path pattern did not know,
   * or by a link was a bare "the GDD": discovery then built docs/Game_GDD.md,
   * another document. The name is the document the message meant; the
   * manager finds it or says it could not.
   */
  it.each([
    ["Quillmoor_GDD'deki oyunu yap", now("Quillmoor_GDD")],
    ["Build the game in QuillmoorGDD", now("QuillmoorGDD")],
    ["Build the game in the quillmoor_game_design_document", now("quillmoor_game_design_document")],
    ["Build the game in docs/Quillmoor_GDD", now("docs/Quillmoor_GDD")],
    ["Build the game in docs/Quillmoor_GDD.", now("docs/Quillmoor_GDD")],
    ["Build the game in docs/design/GDD", now("docs/design/GDD")],
    ["Build this game: docs/Quillmoor_GDD.pptx", now("docs/Quillmoor_GDD.pptx")],
    ["Build this game: design/quillmoor-deck.pptx", confirm("design/quillmoor-deck.pptx")],
    ["Build this game: docs/Quillmoor_GDD.html", now("docs/Quillmoor_GDD.html")],
    ["Build this game: https://example.com/files/Quillmoor_GDD.md", now("https://example.com/files/Quillmoor_GDD.md")],
    // The punctuation that closes the sentence is no part of the link.
    ["Build this game: https://example.com/files/Quillmoor_GDD.md.", now("https://example.com/files/Quillmoor_GDD.md")],
    ["Build this game (https://example.com/files/Quillmoor_GDD.md), thanks!", now("https://example.com/files/Quillmoor_GDD.md")],
    ["Bu oyunu yap: https://example.com/d/quillmoor.pdf", confirm("https://example.com/d/quillmoor.pdf")],
    ["https://example.com/files/Quillmoor_GDD.md'deki oyunu yap", now("https://example.com/files/Quillmoor_GDD.md")],
    // A download copy was read as the name before its "(1)" — the original beside it.
    ["Build this game: docs/Quillmoor_GDD (1).md", now("docs/Quillmoor_GDD (1).md")],
    ["Build the game in docs/Quillmoor_GDD (final copy).md", now("docs/Quillmoor_GDD (final copy).md")],
    ["Quillmoor_GDD (2).md'deki oyunu yap", now("Quillmoor_GDD (2).md")],
    ["Build the game in docs/Quill Moor GDD (1).md", now("docs/Quill Moor GDD (1).md")],
    // A name with a character the path pattern did not know, or in bold, was no name at all.
    ["Build this game: docs/Quill+Moor_GDD.md", now("docs/Quill+Moor_GDD.md")],
    ["Build this game: docs/Quill&Moor_GDD.md", now("docs/Quill&Moor_GDD.md")],
    ["Build this game: docs/Quill#Moor_GDD.md", now("docs/Quill#Moor_GDD.md")],
    ["Build this game: docs/Quillmoor_GDD[v2].md", now("docs/Quillmoor_GDD[v2].md")],
    // …while a Markdown link is its target, not its text.
    ["Build the game in [Quillmoor_GDD.md](docs/design/Quillmoor_GDD.md)", now("docs/design/Quillmoor_GDD.md")],
    ["Build this game: **docs/Quillmoor_GDD.md**", now("docs/Quillmoor_GDD.md")],
    ["Bu oyunu yap: <docs/Quillmoor_GDD.md>", now("docs/Quillmoor_GDD.md")],
    // A section anchor is no part of the file's name.
    ["Build the game in docs/Quillmoor_GDD.md#combat", now("docs/Quillmoor_GDD.md")],
  ])("%s → the document it names, %j, not the repository's other design", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it.each([
    // "the GDD" itself, and a word built on it, are no name.
    ["Build the game in the GDD", { kind: "gdd-from-docs" }],
    ["GDD'deki oyunu yap", { kind: "gdd-from-docs" }],
    // …and "the GDD" the build is not plainly aimed at is confirmed first.
    ["Build the game following the GDD/TDD split", { kind: "gdd-to-confirm" }],
    // A link beside an idea is a reference, like a path.
    [
      "Build this game from scratch: a bakery town where every loaf sold buys another oven; mood board at https://example.com/board",
      { kind: "idea", ideaText: "Build this game from scratch: a bakery town where every loaf sold buys another oven; mood board at https://example.com/board" },
    ],
  ])("%s → no named document", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it.each([
    "Build this game. Quillmoor_GDD: a puzzle where the player saves progress and restores it after exiting.",
    "Build this game. QuillmoorGDD: a puzzle where the player saves progress and restores it after exiting.",
  ])("design text after a GDD-named marker is still the design, not a pointer: %s", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  // The letters inside another word are no reference: the idea is the design.
  it.each([
    "Build this game from scratch: a city builder named Rigddon where tides flood the streets every night.",
    "Sıfırdan bir oyun yap: Bigdda kasabasında geçen, gelgitle sokakları su basan bir şehir kurma oyunu.",
  ])("%s → the idea", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it.each([
    "add a pause menu to my game",
    "fix the GDD typo",
    "fix the GDD typo in docs/Quillmoor_GDD.md",
    "update docs/Quillmoor_GDD.md section 3",
    "open docs/Quillmoor_GDD.md",
    "where is Quillmoor_GDD.md?",
    "Can you summarize docs/quillmoor-notes.pdf for me?",
    "docs/Quillmoor_GDD.md dosyasına bak",
    "docs/Quillmoor_GDD.md dosyasının 3. bölümünü güncelle",
    "Quillmoor_GDD.md'deki yazım hatasını düzelt",
    "Oyuna pause menüsü ekle, docs/ui-notes.md'deki gibi",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it("a GDD-named attachment is the design even when the caption says nothing", () => {
    const design = `# Quillmoor\n\n${"Design content. ".repeat(30)}`;
    expect(
      detectCampaignIntent({ chatId: "c", text: "bak", attachments: [{ type: "document", name: "QuillmoorGDD.md", data: Buffer.from(design) }] } as never),
    ).toMatchObject({ kind: "gdd-attachment", sourceName: "QuillmoorGDD.md" });
    // …and the letters inside another word do not make one.
    expect(
      detectCampaignIntent({ chatId: "c", text: "bak", attachments: [{ type: "document", name: "Rigddon-notes.md", data: Buffer.from(design) }] } as never),
    ).toBeUndefined();
  });

  /**
   * A GDD-shaped name or a GDD in the caption made ANY caption the
   * instruction: "fix the typo in this" with Quillmoor_GDD.md attached was an
   * immediate multi-day build of that document, with no approval gate.
   */
  describe("a caption that asks for work on the attached document", () => {
    const design = `# Quillmoor\n\n${"Design content. ".repeat(30)}`;
    const shared = (text: string, name: string): ReturnType<typeof detectCampaignIntent> =>
      detectCampaignIntent({ chatId: "c", text, attachments: [{ type: "document", name, data: Buffer.from(design) }] } as never);

    it.each([
      ["fix the typo in this", "Quillmoor_GDD.md"],
      ["fix the typo in this", "quillmoor-gdd.md"],
      ["fix the GDD typo", "notes.md"],
      ["can you proofread this?", "Quillmoor_GDD.md"],
      ["summarize it for the team", "QuillmoorGDD.md"],
      ["bunu özetle", "Quillmoor_GDD.md"],
      ["GDD'deki yazım hatalarını düzelt", "Quillmoor_GDD.md"],
      ["şu GDD'yi bir incele", "Quillmoor_GDD.md"],
      ["update section 3 of the GDD", "Quillmoor_GDD.md"],
      // An adverb beside the work is no build of the document it rides on…
      ["Read it end to end", "notes.md"],
      ["Rewrite this from scratch", "Quillmoor_GDD.md"],
      ["bunu baştan sona oku", "Quillmoor_GDD.md"],
      ["Baştan sona oku", "notes.md"],
      ["Bunu sıfırdan yeniden yaz", "Quillmoor_GDD.md"],
      // …nor, past the idea minimum, an idea drafted or a document called unreadable in its place.
      ["Rewrite this from scratch, the late chapters contradict each other and the tone drifts", "Quillmoor_GDD.md"],
    ])("%s (%s attached) → no campaign", (text, name) => {
      expect(shared(text, name)).toBeUndefined();
    });

    it.each([
      ["", "Quillmoor_GDD.md"],
      ["işte gdd", "Quillmoor_GDD.md"],
      ["bak", "QuillmoorGDD.md"],
      ["build the game in this GDD", "Quillmoor_GDD.md"],
      // Build intent wins over a word of review beside it.
      ["GDD'yi oku ve oyunu yap", "Quillmoor_GDD.md"],
      ["Read it and build the game from scratch", "notes.md"],
      ["Baştan sona oku ve oyunu yap", "notes.md"],
    ])("%s (%s attached) → the design", (text, name) => {
      expect(shared(text, name)).toMatchObject({ kind: "gdd-attachment", sourceName: name });
    });
  });
});

/**
 * The build verbs ended at an ASCII `\b`, which sees a boundary before every
 * Turkish letter: "oyun yazılımı" (the game's software), "oyunu yapılandır"
 * (configure the game) and "oyun yapısı" (its structure) all read as "make
 * the game". A bug report past 40 characters drafted a new game, and an edit
 * to one section of a named design built the whole game from it.
 */
describe("a Turkish word that only begins like a build verb", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    "docs/Quillmoor_GDD.md'deki oyun yazılımı bölümünü güncelle",
    "Quillmoor_GDD.md'ye göre oyunu yapılandır",
    "Oyun yapısını docs/mimari-notlar.md'deki gibi düzenle",
    "Oyun yazılımında bir hata var, menüden çıkınca kilitleniyor, bakar mısın?",
    "Oyun yapımı sürecini anlatan kısa bir not yazar mısın, ekibe göndereceğim?",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it("…while the build verb itself, plain or polite, still is one", () => {
    expect(detectCampaignIntent(msg("Bu oyunu yap: docs/Quillmoor_GDD.md"))).toEqual({ kind: "gdd-from-docs", path: "docs/Quillmoor_GDD.md" });
    expect(detectCampaignIntent(msg("Bu oyunu yapın: docs/Quillmoor_GDD.md"))).toEqual({ kind: "gdd-from-docs", path: "docs/Quillmoor_GDD.md" });
    const polite = "Şu oyunu yapınız: bir fırıncı her sabah yeni bir tarif açar, satılan her somun yeni bir fırın getirir.";
    expect(detectCampaignIntent(msg(polite))).toEqual({ kind: "idea", ideaText: polite });
  });
});

/**
 * Once a named path became a pointer at any length, BUILD_INTENT_RE alone
 * decided whether a message built the game from it — and that pattern also
 * matches adverbs ("baştan sona", "end-to-end", "from scratch", "sıfırdan")
 * and feature phrasing ("make the game <adjective>", "develop the game
 * further"). "README.md'yi baştan sona oku" (read the README end to end)
 * answered "Building from `README.md` … Sprint 1 starts now", with no
 * approval gate. And `?? paths[0]` took a style sheet an IDEA mentioned for
 * the design: the idea was thrown away and the build ran from
 * docs/art-style.md.
 */
describe("a named document is the design only when the build is aimed at it", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    "README.md'yi baştan sona oku",
    "Run the end-to-end tests in docs/e2e.md",
    "Run the end-to-end tests in docs/e2e.md and tell me which of them still fail on the CI runners",
    "Rewrite docs/save-notes.md from scratch",
    "Make the game follow docs/ui.md",
    "Make the game harder, the way docs/Quillmoor_GDD.md describes the late levels",
    "Develop the game further as docs/roadmap.md says, starting with the cavern chapter",
    "docs/notes.md dosyasını sıfırdan yaz",
    "docs/geri-bildirim.md'deki notlara göre oyunu geliştir",
    // Reading, rewriting, implementing or testing a file, with only an adverb beside it.
    "Read docs/notes.md end to end",
    "Baştan sona docs/notes.md dosyasını oku",
    "Implement docs/notes.md from scratch",
    "Rewrite README.md from scratch",
    "docs/cache.md'yi sıfırdan yaz",
    "Rewrite docs/Quillmoor_GDD.md from scratch",
    "Write end-to-end tests described in docs/notes.md",
    "The end-to-end tests in docs/notes.md fail",
    // A code identifier that says GDD is no design to build from.
    "Rewrite loadGDD from scratch",
    "Rewrite readGddFile from scratch",
    "GddParser end to end test",
    "loadGDD fonksiyonunu sıfırdan yaz",
  ])("%s → no campaign (no whole-game build is aimed at the document)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  /**
   * A file name with an extension counted as a named design whenever "gdd"
   * stood in it as a word: "Build the game and fix my_gdd_parser.ts" was a
   * build from my_gdd_parser.ts, and the manager took the message over to say
   * it could not read it — the user's task never ran. A source or data file
   * is no design, nor is the "gdd" inside its name "the GDD".
   */
  it.each([
    "Build the game and fix my_gdd_parser.ts",
    "Build the game; load_gdd.py fails",
    "Oyunu yap, gdd_schema.json bozuk",
  ])("%s → no campaign (a code file is no design)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each([
    "Build the game after updating gdd_schema.json",
    "Build the game, then fix src/gdd_loader.cs",
    "Build the game, then run tools/check_gdd_links.sh over the scenes",
  ])("%s → neither a named design nor the repository's GDD", (text) => {
    expect(detectCampaignIntent(msg(text))?.kind).not.toMatch(/^gdd-/);
  });

  it.each([
    "Build this game from scratch: a cozy farming sim where you grow glowing mushrooms; follow the art direction in docs/art-style.md.",
    "Sıfırdan bir oyun yap: bir fırıncı her sabah yeni bir tarif açar ve satılan her somun yeni bir fırın getirir; görseller docs/art-style.md'deki gibi olsun.",
    "Build this game: a baker opens one new recipe every morning and every loaf sold buys another oven. Put the notes into docs/notes.md.",
    "Build this game from scratch: a town of bakeries where every loaf sold buys another oven; keep docs/Old_GDD.md only as a tone reference.",
    "Build the game from scratch: a baker writes every recipe she unlocks into log.txt, and each loaf sold buys another oven.",
  ])("%s → the idea it carries, not the document it mentions", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it.each([
    // The name that says GDD wins over another design-looking document…
    ["Build the game in docs/notes.md and docs/Quillmoor_GDD.md", confirm("docs/Quillmoor_GDD.md", "docs/notes.md")],
    ["Following docs/notes.md, build the game in docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    // …the one the build is aimed at over a GDD the message turns away…
    ["Don't use docs/Old_GDD.md, build the game in docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["docs/Old_GDD.md'yi kullanma, docs/Quillmoor_GDD.md'deki oyunu yap", now("docs/Quillmoor_GDD.md")],
    // …a design over a style sheet named beside it…
    ["Build the game in docs/art-style.md and docs/quillmoor.md", confirm("docs/quillmoor.md")],
    // …and a path written with spaces is the whole path, not its last word.
    ["Build the game in docs/Quill Moor GDD.md", now("docs/Quill Moor GDD.md")],
    ["docs/Quill Moor GDD.md'deki oyunu yap", now("docs/Quill Moor GDD.md")],
    // The document a short build instruction names is the design.
    ["Bu oyunu yap, tasarım docs/Quillmoor_GDD.md içinde", now("docs/Quillmoor_GDD.md")],
    ["docs/quillmoor.md'ye göre oyunu baştan sona yap", confirm("docs/quillmoor.md")],
    ["Build the game per docs/quillmoor.md", confirm("docs/quillmoor.md")],
    // A build aimed at the design document itself, with only an adverb for build intent.
    ["Implement the GDD at docs/quillmoor.md end-to-end", now("docs/quillmoor.md")],
    ["GDD'yi baştan sona uygula: docs/quillmoor.md", now("docs/quillmoor.md")],
  ])("%s → %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it("a GDD the message names beside its idea is still the design when it says so", () => {
    expect(detectCampaignIntent(msg("Build the game in the GDD; follow the art direction in docs/art-style.md"))).toEqual({ kind: "gdd-from-docs" });
    expect(detectCampaignIntent(msg("GDD'li dosya docs/quillmoor.txt, bu oyunu yap"))).toEqual(confirm("docs/quillmoor.txt"));
  });
});

/**
 * The Turkish word boundary dropped the polite forms that had matched only
 * through the ASCII `\b` accident ("oyun yazın", "oyunu yapıver", "yazar
 * mısınız"), so those ideas became ordinary tasks. And a GDD reference that
 * allowed an uppercase letter after it read "GDDR6" and "GDDLint" as "the
 * GDD": an idea that mentioned either was thrown away for whatever design
 * docs/ held, with no approval gate.
 */
describe("the build verbs and the GDD reference, word by word", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;
  const IDEA = "bir fırıncı her sabah yeni bir tarif açar, satılan her somun yeni bir fırın getirir.";

  it.each([
    `Bana şöyle bir oyun yazın: ${IDEA}`,
    `Bana şöyle bir oyun yazınız: ${IDEA}`,
    `Şu oyunu yapıver: ${IDEA}`,
    `Şu oyunu yapıverin: ${IDEA}`,
    `Şu oyunu yazar mısınız? ${IDEA}`,
    `Şu oyunu geliştirin: ${IDEA}`,
    `Şu oyunu kodlayın: ${IDEA}`,
    `Şu oyunu inşa edin: ${IDEA}`,
  ])("%s → the idea (a polite build verb)", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it("a polite verb aimed at a named design builds from it", () => {
    expect(detectCampaignIntent(msg("docs/Quillmoor_GDD.md'deki oyunu kodlayın"))).toEqual({ kind: "gdd-from-docs", path: "docs/Quillmoor_GDD.md" });
  });

  it.each([
    "Build the game using the GDDR6 memory profile",
    "Build the game and run GDDLint on every scene before it ships",
  ])("%s → the idea, not the repository's GDD", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it("a plural, or a Turkish suffix, is still the GDD", () => {
    expect(detectCampaignIntent(msg("Build the game in the GDDs"))).toEqual({ kind: "gdd-from-docs" });
    expect(detectCampaignIntent(msg("GDD'deki oyunu yapın"))).toEqual({ kind: "gdd-from-docs" });
  });
});

/**
 * "The GDD" is a pointer too, and it took the same shortcut a path did: with
 * only an adverb or a feature phrase for build intent, "Read the GDD end to
 * end", "GDD'yi baştan sona oku" and "Develop the game further, as the GDD
 * says" built whatever design docs/ held — an immediate multi-day build with
 * no approval gate.
 */
describe("a bare reference to the GDD needs a whole-game build", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    "Read the GDD end to end",
    "Rewrite the GDD from scratch",
    "Review the game design document end-to-end before the playtest",
    "Develop the game further, as the GDD says",
    "Make the game harder, the way the GDD describes the late levels",
    "GDD'yi baştan sona oku",
    "GDD'yi sıfırdan yaz",
    "Baştan sona GDD'yi gözden geçir",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  /**
   * "The GDD" a message says it does not have is no pointer at one: "I don't
   * have a GDD, but build a game where…" was a bare gdd-from-docs, and the
   * manager built whatever design docs/ held — ungated, in place of the idea
   * the message carried.
   */
  it.each([
    "I don't have a GDD, but build a game where the beekeeper moves her hives between meadows as the seasons turn",
    "There is no GDD yet, so build a game where the beekeeper moves her hives between meadows as the seasons turn",
    "We have no game design document — build this game from scratch: a beekeeper moves her hives between meadows",
    "Without a GDD, build a game where the beekeeper moves her hives between meadows as the seasons turn",
    "GDD'm yok, şöyle bir oyun yap: arıcı kovanlarını mevsim döndükçe çayırdan çayıra taşır, her çiçek başka bir bal verir.",
    "Henüz bir GDD yok; sıfırdan bir oyun yap: arıcı kovanlarını mevsim döndükçe çayırdan çayıra taşır.",
  ])("%s → the idea, not a GDD discovered in docs/", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  /**
   * "Implement the GDD" with a noun after it is work on the document's parts,
   * not a build of the game: "Implement the GDD changes in the HUD" took the
   * user's task over into a campaign gate on the newest GDD (main left it an
   * ordinary task).
   */
  it.each([
    "Implement the GDD changes in the HUD",
    "Implement the GDD feedback from yesterday",
    "Build the GDD tooling first",
    "Implement the game design document review notes",
  ])("%s → no campaign (a feature request on the GDD)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each(["Implement the GDD", "Implement the GDD for Android", "Implement the GDD, then send me the APK", "Implement the GDD now"])(
    "%s → the repository's GDD, at once",
    (text) => {
      expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs" });
    },
  );

  // The build's clause goes on past the GDD or the verb: the user confirms first.
  it.each([
    ["Implement the GDD in the HUD", { kind: "gdd-to-confirm" }],
    ["Build the game and implement the GDD changes in the HUD", { kind: "gdd-to-confirm" }],
    ["GDD'yi uygula dedim ama Unity çöktü", { kind: "gdd-to-confirm" }],
    ["Oyunu docs/Quillmoor_GDD.md'ye göre yap Android için", confirm("docs/Quillmoor_GDD.md")],
  ])("%s → %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  // …nor one it says is not written yet, or to forget: each was offered at the gate as the newest GDD in docs/, and the idea was not drafted.
  const GARDEN = "a gardener plants one new bed each season and every harvest buys a bigger greenhouse";
  it.each([
    `The GDD doesn't exist yet; build a game where ${GARDEN}`,
    `The GDD isn't written yet, build the game where ${GARDEN}`,
    `The GDD has not been written, so build a game where ${GARDEN}`,
    `The game design document was never written, so build a game where ${GARDEN}`,
    `Forget the GDD and build a game where ${GARDEN}`,
    `Disregard the GDD and build a game where ${GARDEN}`,
    `GDD henüz yazılmadı, şöyle bir oyun yap: bir bahçıvan her mevsim yeni bir tarh eker, her hasat daha büyük bir sera getirir`,
    `GDD hazırlanmamış; şöyle bir oyun yap: bir bahçıvan her mevsim yeni bir tarh eker, her hasat daha büyük bir sera getirir`,
    `GDD olmadan şöyle bir oyun yap: bir bahçıvan her mevsim yeni bir tarh eker, her hasat daha büyük bir sera getirir`,
    `GDD'yi unut, şöyle bir oyun yap: bir bahçıvan her mevsim yeni bir tarh eker, her hasat daha büyük bir sera getirir`,
    `GDD'siz bir oyun yap: bir bahçıvan her mevsim yeni bir tarh eker, her hasat daha büyük bir sera getirir`,
  ])("%s → the idea, not a GDD discovered in docs/", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  // …nor one it says is lost or deleted, by every word for it: "I lost my GDD, build the game where…" was offered the newest GDD in docs/.
  const BAKER = "bir fırıncı her sabah yeni bir tarif açar, satılan her somun yeni bir fırın getirir";
  it.each([
    `I lost my GDD, build the game where ${GARDEN}`,
    `I deleted the GDD; build a game where ${GARDEN}`,
    `I removed the GDD, so build a game where ${GARDEN}`,
    `I misplaced the GDD, build a game where ${GARDEN}`,
    `My GDD was deleted, build the game where ${GARDEN}`,
    `The GDD got lost, build a game where ${GARDEN}`,
    `The GDD was removed, so build a game where ${GARDEN}`,
    `The GDD is missing, build a game where ${GARDEN}`,
    `The GDD is gone, build a game where ${GARDEN}`,
    `GDD'yi kaybettim, şöyle bir oyun yap: ${BAKER}`,
    `GDD kayboldu, şöyle bir oyun yap: ${BAKER}`,
    `GDD'm kayıp, şöyle bir oyun yap: ${BAKER}`,
    `GDD silindi, şöyle bir oyun yap: ${BAKER}`,
    `GDD'yi sildim, şöyle bir oyun yap: ${BAKER}`,
  ])("%s → the idea, not a GDD discovered in docs/", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it.each(["GDD isn't written, build the game", "GDD henüz yazılmadı, oyunu yap"])("%s → no campaign (nothing to build from)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  // A document's own clause is held to the narrower list: a caveat after its name is no ruling-out, so it is still confirmed first.
  it("Build the game from docs/Bramble_GDD.md that isn't done → confirmed first", () => {
    expect(detectCampaignIntent(msg("Build the game from docs/Bramble_GDD.md that isn't done"))).toEqual(confirm("docs/Bramble_GDD.md"));
  });

  it.each(["I don't have a GDD, build the game", "GDD yok, oyunu yap"])("%s → no campaign (nothing to build from)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each([
    "Build the game in the GDD from scratch",
    "Implement the GDD end to end",
    "GDD'yi baştan sona uygula",
    "GDD'deki oyunu sıfırdan yap",
    "Baştan sona GDD'deki oyunu geliştir",
  ])("%s → the repository's GDD", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs" });
  });
});

/**
 * A build the message turns down or asks about is no request for one. The
 * whole-game test looked only at the build verb, never at what stood before
 * it: "Don't build the game in docs/Old_GDD.md — use the new one" built the
 * very document the user ruled out, and "How do I build the game in
 * docs/q.md?" answered "Building from `docs/q.md` … Sprint 1 starts now" —
 * an immediate build with no approval gate. "The GDD" had the same blind spot.
 */
describe("a build the message turns down or asks about", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    "Don't build the game in docs/Old_GDD.md — use the new one",
    "Do not build the game from docs/Quillmoor_GDD.md yet, I am still editing it",
    "Wait, don't build the game in docs/Quillmoor_GDD.md",
    "Don't, for now, build the game in docs/quillmoor.md",
    "Never build the game from docs/quillmoor.md",
    "I don't want you to build the game in docs/quillmoor.md",
    "Let's not build the game in docs/quillmoor.md",
    "How do I build the game in docs/quillmoor.md?",
    "Did you build the game in docs/quillmoor.md?",
    "Should we build the game in docs/quillmoor.md?",
    "Should we build the game in docs/quillmoor.md",
    "Hey, should we build the game in docs/quillmoor.md?",
    "Can you tell me how to build the game in docs/quillmoor.md?",
    "If you build the game in docs/quillmoor.md, keep the save system",
    "Build the game in docs/quillmoor.md?",
    "Bu oyunu yap: docs/quillmoor.md mı?",
    "docs/quillmoor.md'deki oyunu yap mı?",
    "Don't build the game in the GDD",
    "How do I build the game in the GDD?",
    "Should I build the game from scratch: a beekeeper moves her hives between meadows as the seasons turn?",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each([
    ["Can you build the game in docs/quillmoor.md?", confirm("docs/quillmoor.md")],
    ["Could you please build this game: docs/Quillmoor_GDD.md?", now("docs/Quillmoor_GDD.md")],
    ["Please build the game in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    // A polite word makes the question mark a request, in either language.
    ["Please build this game: docs/Quillmoor_GDD.md?", now("docs/Quillmoor_GDD.md")],
    ["Lütfen bu oyunu yap: docs/Quillmoor_GDD.md?", now("docs/Quillmoor_GDD.md")],
    ["Build the game in docs/quillmoor.md. Can you keep me posted?", confirm("docs/quillmoor.md")],
    ["Build the game in docs/quillmoor.md, okay?", confirm("docs/quillmoor.md")],
    ["If you can, build the game in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Don't build the game in docs/Old_GDD.md; build the game in docs/Quillmoor_GDD.md", now("docs/Quillmoor_GDD.md")],
    ["Don't wait for me, build the game in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Bu oyunu yap: docs/quillmoor.md, tamam mı?", confirm("docs/quillmoor.md")],
    ["docs/quillmoor.md'deki oyunu yazar mısın?", confirm("docs/quillmoor.md")],
  ])("%s → %j (asked for, politely or plainly)", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  /**
   * A request put as a wish, or as a question about whether it can be done,
   * started nothing: the "if", "what" and question-opener rules read "I was
   * wondering if you could build a game where…", "Is it possible to…?" and
   * "Can we build the game in P?" as a build asked about. Main drafted them at
   * the gate. They are requests, but tentative ones: an idea is drafted at
   * the gate as any idea is, and a document is confirmed there first, never
   * built at once.
   */
  const IDEA = "the beekeeper moves her hives between meadows as the seasons turn";
  it.each([
    `I was wondering if you could build a game where ${IDEA}`,
    `Hi, I was wondering if you could build this game: ${IDEA}`,
    `I'm wondering whether you could make a game where ${IDEA}`,
    `Is it possible to build a game where ${IDEA}?`,
    `Would it be possible to make a game where ${IDEA}?`,
    `Would it be possible for you to build a game where ${IDEA}?`,
    `What I want is to build a game where ${IDEA}`,
    `What I'd like is for you to build a game where ${IDEA}`,
    `Can we build a game where ${IDEA}?`,
  ])("%s → the idea, drafted at the gate (a tentative request)", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it.each([
    ["Can we build the game in docs/Quillmoor_GDD.md?", confirm("docs/Quillmoor_GDD.md")],
    ["Could we build this game: docs/Quillmoor_GDD.md?", confirm("docs/Quillmoor_GDD.md")],
    ["Is it possible to build the game in docs/Quillmoor_GDD.md?", confirm("docs/Quillmoor_GDD.md")],
    ["I was wondering if you could build the game in docs/Quillmoor_GDD.md", confirm("docs/Quillmoor_GDD.md")],
    ["Can we build the game in the GDD?", { kind: "gdd-to-confirm" }],
  ])("%s → %j (a tentative request is confirmed first)", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it.each([
    "I was wondering how to build the game in docs/Quillmoor_GDD.md",
    "What I want to know is how to build the game in docs/Quillmoor_GDD.md",
    "Can we not build the game in docs/Quillmoor_GDD.md yet?",
  ])("%s → no campaign (a question about the build is still none)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  // "Yapar mısın?" asks for the build with an adverb beside it too: only the adverb was read, and the request was lost.
  it.each([
    ["docs/Quillmoor_GDD.md'deki oyunu baştan sona yapar mısın?", "docs/Quillmoor_GDD.md"],
    ["Quillmoor_GDD.md'deki oyunu sıfırdan yazar mısın?", "Quillmoor_GDD.md"],
  ])("%s → %s, at once (a polite Turkish request)", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual(now(path));
  });

  it("an idea whose own sentence carries a question further on is still the idea", () => {
    const text = "Build this game: a beekeeper moves her hives between meadows each season, can the swarms grow slowly?";
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  describe("with the design attached", () => {
    const design = `# Quillmoor\n\n${"Design content. ".repeat(30)}`;
    const shared = (text: string): ReturnType<typeof detectCampaignIntent> =>
      detectCampaignIntent({ chatId: "c", text, attachments: [{ type: "document", name: "Quillmoor_GDD.md", data: Buffer.from(design) }] } as never);

    it.each([
      "Don't build the game from this yet, I am still editing it",
      "Should I build the game in this GDD?",
      "Bu GDD'deki oyunu yap mı?",
    ])("%s → no campaign", (text) => {
      expect(shared(text)).toBeUndefined();
    });

    it("…while a polite request still builds it", () => {
      expect(shared("Can you build the game in this GDD?")).toMatchObject({ kind: "gdd-attachment", sourceName: "Quillmoor_GDD.md" });
    });

    /**
     * A caption that asks tentatively, or reports a build, is confirmed at the
     * gate: "Can we build the game from this?" and "We'd like you to build the
     * game from this" started nothing at all, and a bug report that carried the
     * GDD ("When I build the game from this GDD, Unity crashes") nothing too —
     * where main built each at once.
     */
    it.each([
      "Can we build the game from this?",
      "I was wondering if you could build the game from this GDD",
      "We'd like you to build the game from this",
      "When I build the game from this GDD, Unity crashes",
    ])("%s → the attached design, confirmed first", (text) => {
      expect(shared(text)).toEqual({ kind: "gdd-attachment", gddText: design, sourceName: "Quillmoor_GDD.md", confirm: true });
    });

    it.each(["Build the game from this", "Please build the game from this", "Bu GDD'deki oyunu yap"])("%s → the attached design, at once", (text) => {
      expect(shared(text)).toEqual({ kind: "gdd-attachment", gddText: design, sourceName: "Quillmoor_GDD.md" });
    });

    it("…and a caption that asks for work on the document is still no build", () => {
      expect(shared("I tried to build the game from this, please fix the typo")).toBeUndefined();
    });
  });
});

/**
 * A style sheet the build connective landed on was the design, whatever the
 * message named beside it: "Build the game per docs/art-style.md, see
 * docs/Quillmoor_GDD.md" answered "Building from `docs/art-style.md` … Sprint
 * 1 starts now", with no approval gate. Only the documents the build was
 * aimed at were weighed, and when every one of them sat beside a design the
 * first was taken anyway.
 */
describe("a build aimed only at a document that sits beside the design", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    ["Build this game: docs/art-style.md (design: docs/Quillmoor_GDD.md)", now("docs/Quillmoor_GDD.md")],
    ["Build the game per docs/art-style.md, see docs/Quillmoor_GDD.md", confirm("docs/Quillmoor_GDD.md")],
    // Only called the design, outside the build's own clause, it is confirmed first whatever its name.
    ["Build the game in docs/art-style.md; the design is docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Build the game in CHANGELOG.md; the GDD is in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Build the game per docs/art-style.md, see docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Bu oyunu yap: docs/art-style.md, tasarım docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["docs/art-style.md'deki oyunu yap, docs/Quillmoor_GDD.md'ye de bak", confirm("docs/Quillmoor_GDD.md")],
    // Named as the design, with no style sheet beside it, it is the design too — confirmed first.
    ["Please build this game, design is in docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Bu oyunu yap, tasarım docs/quillmoor.md içinde", confirm("docs/quillmoor.md")],
  ])("%s → the design beside it, %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it.each([
    // The only design beside it is the one the message turns away…
    "Build the game per docs/art-style.md, not docs/Old_GDD.md",
    "Build the game per docs/art-style.md; docs/Old_GDD.md is outdated",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md'yi kullanma",
    // …by every word the turned-away lists hold: with any one of them gone, the GDD the message rules out was built.
    "Build the game per docs/art-style.md, ignore docs/Old_GDD.md",
    "Build the game per docs/art-style.md, skip docs/Old_GDD.md",
    "Build the game per docs/art-style.md, except docs/Old_GDD.md",
    "Build the game per docs/art-style.md, excluding docs/Old_GDD.md",
    "Build the game per docs/art-style.md, without docs/Old_GDD.md",
    "Build the game per docs/art-style.md, I deleted docs/Old_GDD.md",
    "Build the game per docs/art-style.md; docs/Old_GDD.md is obsolete",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md değil",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md yerine",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md hariç",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md geçersiz",
    "docs/art-style.md'deki oyunu yap, docs/Old_GDD.md'yi görmezden gel",
    // A GDD the message turns away is no design when nothing is aimed either.
    "Build the game, don't use docs/Old_GDD.md",
    "Build the game, but not from docs/Old_GDD.md",
    // "The art design" is the style sheet's subject, not the game's design.
    "Build this game. The art design is in docs/art-style.md",
  ])("%s → no campaign (no design the message settled on)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  // Two designs beside it, and the message does not say which: the first is offered at the gate, the other named.
  it.each([
    ["Build the game per docs/art-style.md, see docs/Quillmoor_GDD.md or docs/Fernwick_GDD.md", confirm("docs/Quillmoor_GDD.md", "docs/Fernwick_GDD.md")],
    ["Build the game per docs/art-style.md, see docs/quillmoor.md and docs/fernwick.md", confirm("docs/quillmoor.md", "docs/fernwick.md")],
  ])("%s → %j (two candidates)", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  /**
   * In a Unity project "build the game" is also the player build: "Build the
   * game per docs/BUILD.md" (no campaign on main) became an immediate,
   * ungated campaign that read the build instructions as the design.
   */
  it.each([
    "Build the game per docs/BUILD.md",
    "Build the game per docs/android-build.md",
    "Make the game per docs/release-checklist.md",
    "Build the game per docs/BUILD.md, then upload the APK to the internal testing track",
    "docs/android-build.md'ye göre oyunu yap",
  ])("%s → no campaign (build instructions are no design)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each([
    ["Build the game per docs/BUILD.md, see docs/Quillmoor_GDD.md", confirm("docs/Quillmoor_GDD.md")],
    ["Build the game in docs/BUILD.md and docs/quillmoor.md", confirm("docs/quillmoor.md")],
    ["Build the game per docs/Quillmoor_Build_GDD.md", now("docs/Quillmoor_Build_GDD.md")],
    ["Build the game per docs/city-builder.md", confirm("docs/city-builder.md")],
    ["Build this game: docs/deck-building.md", confirm("docs/deck-building.md")],
  ])("%s → %j (a design beside build instructions, or one only named like them)", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  // Named alone, a style sheet, a changelog or a licence is still no design (none of these built on main).
  it.each([
    "Build the game per docs/art-style.md",
    "Build this game: CHANGELOG.md",
    "Build the game in docs/LICENSE.md",
    "docs/art-style.md'ye göre oyunu yap",
  ])("%s → no campaign (a document that is never the design)", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it("a readme, which may hold the design, is still offered when it is named alone or beside a style sheet", () => {
    expect(detectCampaignIntent(msg("Build this game: docs/README.md"))).toEqual(confirm("docs/README.md"));
    expect(detectCampaignIntent(msg("Build the game in docs/art-style.md and docs/README.md"))).toEqual(confirm("docs/README.md"));
  });

  /**
   * A design named without GDD in its name counted only for the connectives
   * the patterns listed: "Build the game using P", "P: build this game",
   * "P ile oyunu yap" and the plain Turkish order "Oyunu P'ye göre yap" were
   * ordinary tasks, while the same sentences with docs/Quillmoor_GDD.md built.
   */
  const AIMED_FORMS = [
    "Build the game using P",
    "Build the game following P",
    // "With P" was read only when P was called the design: "Build the game with docs/quillmoor.md" started nothing.
    "Build the game with P",
    "Develop this game with P, for Android",
    "Build the game (P)",
    "Build the game (P) and send me the APK",
    "P: build this game end to end",
    "P — build the game from it",
    "P ile oyunu yap",
    "P'yi kullanarak oyunu yap",
    "P dosyasına göre oyunu yap",
    "Oyunu P'ye göre yap",
    "Oyunu P'den yap",
    "Bu oyunu P dosyasına göre baştan sona geliştir",
    "Şu oyunu yapar mısın: P",
    "P'deki oyunu yapar mısın?",
  ];
  // …the connective decides that the build is aimed at P; the name decides whether it starts at once.
  it.each(AIMED_FORMS)("%s, P a design's name → that design, at once", (form) => {
    expect(detectCampaignIntent(msg(form.replace("P", "docs/Quillmoor_GDD.md")))).toEqual(now("docs/Quillmoor_GDD.md"));
  });
  it.each(AIMED_FORMS)("%s, P any other name → that document, confirmed first", (form) => {
    expect(detectCampaignIntent(msg(form.replace("P", "docs/quillmoor.md")))).toEqual(confirm("docs/quillmoor.md"));
  });
  it("…and a document the message calls the design is confirmed first, whatever its name", () => {
    expect(detectCampaignIntent(msg("Build this game with the design in docs/quillmoor.md"))).toEqual(confirm("docs/quillmoor.md"));
  });

  it.each([
    // "With P" is how the build goes, not what it builds, unless P is called the design.
    "Build the game with docs/ui-notes.md in mind",
    "Build the game following docs/art-style.md",
    // A path before "build the game" is the subject of a bug report unless the build is all that follows.
    "docs/quillmoor.md: build the game fails on Android",
    // A feature request in the Turkish order, and a build the verb turns down.
    "Oyunu docs/geri-bildirim.md'deki notlara göre geliştir",
    "Oyunu docs/quillmoor.md'ye göre yapma",
    "Oyunu Ayşe'ye göre yap",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  /**
   * An unquoted name with spaces and no folder yielded only its last word:
   * "Build the game in Quill Moor GDD.md" named "GDD.md", and the manager
   * built docs/GDD.md — another file — with no gate.
   */
  it.each([
    ["Build the game in Quill Moor GDD.md", now("Quill Moor GDD.md")],
    ["Build the game from the Quill Moor GDD.md", now("Quill Moor GDD.md")],
    ["Bu oyunu yap: Quill Moor GDD.md", now("Quill Moor GDD.md")],
    ["Quill Moor GDD.md'deki oyunu yap", now("Quill Moor GDD.md")],
    ["Thanks! Quill Moor GDD.md'deki oyunu yap", now("Quill Moor GDD.md")],
    // The words a sentence builds with are no part of the name, nor is its capitalised first word.
    ["Fetch GDD.md and build the game from it", confirm("GDD.md")],
    ["Build The Game In GDD.md", now("GDD.md")],
    ["Build the game in GDD.md", now("GDD.md")],
    ["Build the game in my GDD.md", now("GDD.md")],
  ])("%s → the whole name, %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  it("an idea written beside the style sheet the build is aimed at is the design", () => {
    const text = "Build this game from scratch per docs/art-style.md: a beekeeper moves her hives between meadows as the seasons turn.";
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });
});

/**
 * A build aimed at a document was checked only by the text BEFORE the
 * document, never by the rest of its clause: "Make the game (docs/perf.md
 * explains the frame drops) faster", "Build the game (docs/troubleshooting.md
 * has the fix) and send me the APK" and "Build this game: docs/notes.md is
 * where I keep my todo list" each answered "Building from … Sprint 1 starts
 * now" with no approval gate, and "following P" did the same for a procedure
 * document. A build starts at once only in the one plain form — a whole-game
 * build asked for, aimed at one document whose name (or the message) says it
 * is the design, the document ending its clause; any other whole-game build
 * that points at a document is confirmed at the approval gate first; a
 * feature request is no campaign.
 */
describe("a document the build names, read to the end of its clause", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;
  const IDEA = "idea";

  it.each([
    // "Make the game … faster" is causative through a parenthesis too: a feature request.
    ["Make the game (docs/perf.md explains the frame drops) faster", undefined],
    ["Make the game (docs/Quillmoor_GDD.md has the new level) longer", undefined],
    ["Make the game (per docs/perf.md) faster", undefined],
    // A document with only a qualifier after it, and nothing else to build from.
    ["Make the game in docs/perf.md faster", undefined],
    ["Bu oyunu yap: docs/notlar.md yapılacaklar listem", undefined],
    // Inside a parenthesis only its closing bracket may follow the document.
    ["Build the game (docs/setup.md, step 4 fails)", undefined],
    ["Build the game (docs/Quillmoor_GDD.md, step 4 fails)", confirm("docs/Quillmoor_GDD.md")],
    // The document is the subject of its own predicate, not what the build is aimed at: the sentence is an idea, drafted at the gate (as on main).
    ["Build the game (docs/troubleshooting.md has the fix) and send me the APK", IDEA],
    ["Make the game: docs/perf.md explains the frame drops, fix them", IDEA],
    ["Build this game: docs/notes.md is where I keep my todo list", IDEA],
    ["Build the game for Android. The design is in docs/ui-mockups.md for the buttons.", IDEA],
    // A design with a qualifier after its name, or "the GDD" the build is not aimed at, is confirmed first.
    ["Build the game in docs/Quillmoor_GDD.md for the buttons", confirm("docs/Quillmoor_GDD.md")],
    ["Make the game in docs/Quillmoor_GDD.md faster", confirm("docs/Quillmoor_GDD.md")],
    ["Bu oyunu yap: docs/Quillmoor_GDD.md'de hata var", confirm("docs/Quillmoor_GDD.md")],
    // A document named together with the one the build is aimed at is held to its own clause too.
    ["Build the game in docs/art-style.md and docs/Quillmoor_GDD.md has the new levels", IDEA],
    ["Build the game (the GDD has the fix) and send me the APK", { kind: "gdd-to-confirm" }],
    ["Build the game and fix the GDD typo", { kind: "gdd-to-confirm" }],
    ["Make the game in the GDD faster", { kind: "gdd-to-confirm" }],
    ["Bu oyunu yap, GDD'de hata var", { kind: "gdd-to-confirm" }],
  ])("%s → %j, never an immediate build", (text, expected) => {
    const intent = detectCampaignIntent(msg(text));
    expect(intent).toEqual(expected === IDEA ? { kind: "idea", ideaText: text } : expected);
  });

  // A procedure cited with "using" or "following" is no design by its name: the user confirms it first.
  it.each([
    ["Build the game following docs/android-signing.md", "docs/android-signing.md"],
    ["Build the game using docs/unity-setup.md", "docs/unity-setup.md"],
    ["Build the game following docs/coding-standards.md", "docs/coding-standards.md"],
    ["Build my game using docs/test-plan.md", "docs/test-plan.md"],
    ["docs/unity-setup.md'yi kullanarak oyunu yap", "docs/unity-setup.md"],
  ])("%s → %s, confirmed first", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual(confirm(path));
  });

  /**
   * What says design is the name's own word for the game's design: "design"
   * alone, or after "game" — never a part's design. Any other word before it
   * may name a part as well as the game ("hud-design", "menu-design"), and
   * one after it makes it notes or a library ("design-notes",
   * "design_system"): each started at once, and is confirmed first.
   */
  it.each([
    ["Build the game in docs/game-design.docx", now("docs/game-design.docx")],
    ["Build the game following docs/GameDesign.md", now("docs/GameDesign.md")],
    ["Build the game following docs/design.md", now("docs/design.md")],
    ["Build this game: docs/Game_Design_v2.md", now("docs/Game_Design_v2.md")],
    ["Build this game: docs/design-doc.md", now("docs/design-doc.md")],
    ["Bu oyunu yap: docs/Oyun_Tasarımı.md", now("docs/Oyun_Tasarımı.md")],
    ["Bu oyunu yap: docs/Tasarım.md", now("docs/Tasarım.md")],
    ["Bu oyunu yap: docs/Oyun_Tasarım_Belgesi.md", now("docs/Oyun_Tasarım_Belgesi.md")],
    ["Build this game: docs/ui-design.md", confirm("docs/ui-design.md")],
    ["Build this game: docs/level-design.md", confirm("docs/level-design.md")],
    ["Bu oyunu yap: docs/Arayüz_Tasarımı.md", confirm("docs/Arayüz_Tasarımı.md")],
    ["Build the game following docs/hud-design.md", confirm("docs/hud-design.md")],
    ["Build the game from docs/design_system.md", confirm("docs/design_system.md")],
    ["Build the game from docs/design-notes.md", confirm("docs/design-notes.md")],
    ["Build this game: docs/Quillmoor-Design.md", confirm("docs/Quillmoor-Design.md")],
    ["Bu oyunu yap: docs/Menü_Tasarımı.md", confirm("docs/Menü_Tasarımı.md")],
  ])("%s → %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });

  // The clause ends — a stop, a comma, "and", a closing bracket, the platform, an adverb, a new line: the build starts at once.
  it.each([
    "Build the game in docs/Quillmoor_GDD.md for Android",
    "Build the game in docs/Quillmoor_GDD.md and send me the APK",
    "Build the game (docs/Quillmoor_GDD.md) and send me the APK",
    "Build the game in docs/Quillmoor_GDD.md now",
    "Build the game in docs/Quillmoor_GDD.md from scratch, then ship it",
    "Build the game in docs/Quillmoor_GDD.md - it is the latest",
    "Build this game: docs/Quillmoor_GDD.md\nThanks!",
    "Bu oyunu yap: docs/Quillmoor_GDD.md, sonra APK'yı gönder",
    "docs/Quillmoor_GDD.md'deki oyunu yap ve APK'yı gönder",
  ])("%s → that design, at once", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual(now("docs/Quillmoor_GDD.md"));
  });

  it.each(["Build the game in the GDD for Android", "Build the game in the GDD, then send me the APK", "GDD'deki oyunu yap ve APK'yı gönder"])(
    "%s → the repository's GDD, at once",
    (text) => {
      expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs" });
    },
  );
});

/**
 * A document the message only CALLS the design started at once whatever its
 * name: "Polish the menu, the design is in docs/menu.md, then build the game
 * for Android" answered "Building from `docs/menu.md`" — the call was read
 * anywhere in the message, and the build it was tied to was any whole-game
 * request anywhere else. Only a name that says design starts at once, or the
 * build's own clause calling the document the GDD ("build the game from the
 * GDD at P"); a document called the design in any other way is confirmed at
 * the gate.
 */
describe("a document the message only calls the design", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;

  it.each([
    ["Polish the menu, the design is in docs/menu.md, then build the game for Android", "docs/menu.md"],
    ["Fix the HUD. The design is in docs/hud.md. Then build the game.", "docs/hud.md"],
    ["Rework the inventory screen. Design: docs/inventory.md. Then build the game for iOS.", "docs/inventory.md"],
    ["Update the shop UI, design is in docs/shop.md, and build the game", "docs/shop.md"],
    ["Polish the menu (design: docs/menu.md), then build the game for Android", "docs/menu.md"],
    ["Menüyü düzelt, tasarım docs/menu.md içinde, sonra oyunu yap", "docs/menu.md"],
    ["Build the game. The design is in docs/levels.md.", "docs/levels.md"],
    ["Build the game, the GDD is docs/hud.md", "docs/hud.md"],
    ["Build the game from the design in docs/signing.md", "docs/signing.md"],
    ["Build the game from the design doc at docs/hud.md", "docs/hud.md"],
  ])("%s → %s, confirmed first", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual(confirm(path));
  });

  it("…and of two documents the message calls GDDs, neither is built at once", () => {
    expect(detectCampaignIntent(msg("Build the game. My old GDD is in docs/a.md, the new one is in docs/b.md"))?.kind).toBe("gdd-to-confirm");
  });

  // The build's own clause calling it the GDD is as plain as a name that says so.
  it.each([
    ["Build the game from the GDD at docs/quillmoor.md", "docs/quillmoor.md"],
    ["Build the game from the game design document in docs/quillmoor.md", "docs/quillmoor.md"],
    ["Implement the GDD at docs/quillmoor.md", "docs/quillmoor.md"],
  ])("%s → %s, at once", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual(now(path));
  });
});

/**
 * A build that starts at once is an order: its verb opens its clause. "When I
 * build the game in docs/Bramble_GDD.md, Unity crashes." and "I tried to
 * build the game in … but the editor freezes" each answered "Building from …"
 * and the planner ran — bug reports, read as orders because nothing before
 * the verb was a "not", an "if" or a question word. Any other opening asks
 * the user at the gate. Turkish orders by the verb's own form ("yap"); a
 * report there is another form ("yaparken", "yaptığımda") or words after the
 * verb ("yap dedim").
 */
describe("a build the message reports, not orders", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;
  const P = "docs/Bramble_GDD.md";

  it.each([
    `When I build the game in ${P}, Unity crashes.`,
    `Unity crashes when I build the game from ${P}`,
    `I tried to build the game in ${P} but the editor freezes`,
    `The CI fails every time we build the game in ${P}.`,
    `It took me two weeks to build the game in ${P}`,
    `My friend will build the game in ${P}`,
    `Once you build the game in ${P}, tell me the size.`,
    `I tried to build this game: ${P}`,
    `We want to build the game in ${P}`,
    `When I make the game in ${P}, the build is 2 GB`,
    `I tried to develop the game in ${P}`,
    `${P}'deki oyunu yap dedim ama Unity çöktü`,
  ])("%s → confirmed first, never built at once", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual(confirm(P));
  });

  it.each(["When I build the game in the GDD, Unity crashes", "The editor freezes when I implement the GDD"])(
    "%s → the repository's GDD, confirmed first",
    (text) => {
      expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-to-confirm" });
    },
  );

  // A Turkish report is a verb form no build pattern reads: no campaign.
  it.each([`${P}'deki oyunu yaparken Unity çöktü`, `${P}'deki oyunu yaptığımda editör donuyor`])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  // An order, after a greeting, a "please", a "can you", an "I want you to", a "let's" or a "help me".
  it.each([
    `Build the game in ${P}`,
    `Please build the game in ${P}`,
    `Now build the game from ${P}`,
    `OK so build the game in ${P}`,
    `Hey, just build the game in ${P}`,
    `Can you build the game in ${P}`,
    `Could you please build the game in ${P}`,
    `I want you to build the game in ${P}`,
    `I'd like you to build the game in ${P}`,
    `Let's build the game in ${P}`,
    `Help me build the game in ${P}`,
    `Go build the game in ${P}`,
    `- Build the game in ${P}`,
    `Hi pls build the game in ${P}`,
    `Also kindly build the game in ${P}`,
    `Would you build the game in ${P}`,
    `I need you to build the game in ${P}`,
    `I would like you to build the game in ${P}`,
    `Let us build the game in ${P}`,
    `Lütfen bu oyunu yap: ${P}`,
    `Şimdi ${P}'deki oyunu yap`,
    `Unity'de ${P}'deki oyunu yap`,
  ])("%s → that design, at once", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual(now(P));
  });

  it.each(["Please build the game in the GDD", "Let's implement the GDD"])("%s → the repository's GDD, at once", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs" });
  });

  /**
   * The Turkish "let's", the colloquial order and the wish started nothing at
   * all, where "Let's build the game in P" built and "I want to build the game
   * in P" was confirmed at the gate: "P'deki oyunu yapalım", "…yapsana" and
   * "…yapmak istiyorum" are the same requests.
   */
  it.each([
    `${P}'deki oyunu yapalım`,
    `${P}'deki oyunu yapsana`,
    `${P}'deki oyunu yazalım`,
    `${P}'deki oyunu yazsana`,
    `Bu oyunu geliştirelim: ${P}`,
    `${P}'deki oyunu geliştirsene`,
    `${P}'deki oyunu kodlayalım`,
    `${P}'deki oyunu kodlasana`,
    `Bu oyunu inşa edelim: ${P}`,
    `Bu oyunu inşa etsene: ${P}`,
    `${P}'deki oyunu yapmanı istiyorum`,
    `${P}'deki oyunu yapmanızı istiyoruz`,
    `${P}'deki oyunu geliştirmeni istiyorum`,
  ])("%s → that design, at once", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual(now(P));
  });

  it.each([
    `${P}'deki oyunu yapmak istiyorum`,
    `${P}'deki oyunu yapmak istiyoruz`,
    `${P}'deki oyunu geliştirmek istiyoruz`,
    `Bu oyunu inşa etmek istiyorum: ${P}`,
  ])("%s → confirmed first (a wish, as \"I want to build\" is)", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual(confirm(P));
  });

  it.each([`${P}'deki oyunu yapalım mı?`, `Oyun yapmak zor`])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it("…and a game idea asked for so is drafted at the gate", () => {
    const text = "Şöyle bir oyun yapalım: bir fırıncı her sabah yeni bir tarif açar, satılan her somun yeni bir fırın getirir.";
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });
});

/**
 * A design the message calls the GDD and rules out in the same breath is no
 * design: "Build the game. Ignore the GDD at docs/Old_GDD.md." answered
 * "Building from `docs/Old_GDD.md`", and an idea written beside it was
 * thrown away. The turned-away words were read only for a document named
 * beside the build, never for one the message calls the design.
 */
describe("a design the message calls the GDD and rules out", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;
  const IDEA = "Build a game where a gardener plants one new bed each season and every harvest buys a bigger greenhouse.";

  it.each([
    "Build the game. Ignore the GDD at docs/Old_GDD.md.",
    "Build the game without the GDD at docs/Old_GDD.md",
    "Build the game, not from the GDD at docs/Old_GDD.md.",
    "Build the game, except the GDD in docs/Old_GDD.md.",
    "Build the game; never the GDD at docs/Old_GDD.md.",
    "Build the game. Don't use the GDD at docs/Old_GDD.md.",
    "Build the game. Skip the GDD at docs/Old_GDD.md.",
    "Build the game, excluding the GDD at docs/Old_GDD.md",
    "Build the game, no GDD: docs/Old_GDD.md",
    // Ruled out after it, with the GDD's own clause closed by its colon.
    "Build the game, the GDD: docs/Old_GDD.md is outdated",
    "Oyunu yap; GDD: docs/Old_GDD.md hariç",
    "Oyunu yap; GDD: docs/Old_GDD.md geçersiz",
  ])("%s → no campaign", (text) => {
    expect(detectCampaignIntent(msg(text))).toBeUndefined();
  });

  it.each([`${IDEA} Ignore the GDD at docs/Old_GDD.md.`, `${IDEA} The GDD: docs/Old_GDD.md is outdated.`])("%s → the idea", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  // The design the message does settle on is still built at once.
  it.each([
    ["Build the game. The GDD is docs/New_GDD.md", now("docs/New_GDD.md")],
    ["Build the game without asking, the GDD is docs/New_GDD.md", now("docs/New_GDD.md")],
    ["Oyunu yap, GDD: docs/New_GDD.md", now("docs/New_GDD.md")],
    ["Ignore the GDD at docs/Old_GDD.md; the GDD is docs/New_GDD.md, build the game", now("docs/New_GDD.md")],
    ["Build the game in docs/New_GDD.md, not docs/Old_GDD.md", now("docs/New_GDD.md")],
  ])("%s → %j", (text, intent) => {
    expect(detectCampaignIntent(msg(text))).toEqual(intent);
  });
});

/**
 * Intake runs synchronously on every incoming message, and its cost grew with
 * the square of the message's length: each pattern anchored at a document was
 * run against the whole text before it, each span blanked by copying the
 * whole text, each clause read from the start of the text, and a token was
 * searched for a file name from every one of its characters — a pasted
 * 396 KB design took 5.4 s, a 50 KB unbroken token 7.8 s. A generous bound:
 * linear intake takes a few milliseconds per hundred kilobytes.
 */
describe("intake cost grows with the message's length, not its square", () => {
  const msg = (text: string): Parameters<typeof detectCampaignIntent>[0] =>
    ({ chatId: "c", text, attachments: [] }) as never;
  const timed = (text: string): number => {
    const started = performance.now();
    detectCampaignIntent(msg(text));
    return performance.now() - started;
  };

  it.each([
    ["a pasted design naming a document in every sentence", "Build this game: " + "The beekeeper moves hives between meadows as seasons turn, see docs/hives.md for details; ".repeat(4400)],
    ["names with spaces, over and over", "Build the game. " + "Quill Moor GDD.md ".repeat(11000)],
    ["one unbroken token", "Build the game " + "x".repeat(200_000)],
    ["one unbroken path", "Build the game in " + "a/".repeat(100_000) + "x"],
    ["a build asked for in every sentence", "Build the game in docs/Quillmoor_GDD.md, then ".repeat(5000) + "send it?"],
  ])("%s", (_what, text) => {
    expect(text.length).toBeGreaterThan(190_000);
    expect(timed(text)).toBeLessThan(2000);
  });

  // A run of dots ended a file name's token, and a link's body stopped lazily before its trailing punctuation: 40 KB took 4.5 s and 7.1 s.
  it.each([
    ["a run of dots in a word", "Build the game in a" + ".".repeat(60_000) + "x"],
    ["a run of dots in a link", "Build the game from http://" + ".".repeat(60_000) + "x"],
    ["a run of commas in a link", "Build the game from http://x" + ",".repeat(60_000) + "x"],
    ["a link that ends in a run of stops", "Build the game from http://example.com/Quillmoor_GDD.md" + ".".repeat(60_000)],
  ])("%s", (_what, text) => {
    expect(timed(text)).toBeLessThan(1000);
  });
});
