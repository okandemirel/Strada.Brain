import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { detectCampaignIntent } from "./campaign-intake.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";

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
    // A marker with nothing behind it is a reference, not a design.
    expect(detectCampaignIntent(msg("Build this game. GDD: see above."))).toEqual({ kind: "gdd-from-docs" });
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
    ["Build this game: docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Build the game in docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Build the game in docs/Quillmoor_GDD.md, sprint by sprint, until it is done.", "docs/Quillmoor_GDD.md"],
    ["build the game from the GDD at docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Build this game: quill-moor-gdd.md", "quill-moor-gdd.md"],
    ["Build this game: docs/QuillmoorGDD.md", "docs/QuillmoorGDD.md"],
    ["Make this game: design/quillmoor-notes.docx", "design/quillmoor-notes.docx"],
    ["Develop my game from docs/quillmoor.markdown", "docs/quillmoor.markdown"],
    ["Build the game described in ./quillmoor.txt", "./quillmoor.txt"],
    ["Build the game in /Users/someone/Desktop/Quillmoor_GDD.pdf", "/Users/someone/Desktop/Quillmoor_GDD.pdf"],
    ["Build the game in ~/Desktop/Quillmoor_GDD.rtf", "~/Desktop/Quillmoor_GDD.rtf"],
    ["Build the game in C:\\Games\\Quillmoor_GDD.odt", "C:\\Games\\Quillmoor_GDD.odt"],
    ['Build the game in "docs/Quill Moor GDD.md"', "docs/Quill Moor GDD.md"],
    ["docs/Quillmoor_GDD.md oyununu baştan sona yap", "docs/Quillmoor_GDD.md"],
    ["Bu oyunu yap: docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Quillmoor_GDD.odt'deki oyunu baştan sona yap", "Quillmoor_GDD.odt"],
    ["docs/quillmoor.pdf dosyasındaki oyunu geliştir", "docs/quillmoor.pdf"],
    ["GDD'li dosya docs/quillmoor.txt, bu oyunu yap", "docs/quillmoor.txt"],
    ["Bu oyunu yap: docs/Kuşkonmaz_Tasarımı.md", "docs/Kuşkonmaz_Tasarımı.md"],
    ["Quillmoor_GDD.md’deki oyunu baştan sona yap", "Quillmoor_GDD.md"],
    // Beside a style sheet or a changelog, the design — wherever it stands.
    ["Build the game in docs/art-style.md and docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Following docs/art-style.md, build the game in docs/quillmoor.md", "docs/quillmoor.md"],
    ["CHANGELOG.md'yi güncel tut, docs/quillmoor.md'deki oyunu baştan sona yap", "docs/quillmoor.md"],
    // Named alone, it is the one the message meant, whatever it is called.
    ["Build this game: docs/README.md", "docs/README.md"],
    // A workbook is a format the document extractor reads; this sentence was an idea to draft.
    ["Build this game: design/quillmoor-balance.xlsx", "design/quillmoor-balance.xlsx"],
    ["Build this game: **docs/quillmoor.md**", "docs/quillmoor.md"],
  ])("%s → that path", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs", path });
  });

  /**
   * A GDD named with no extension, in a format the path pattern did not know,
   * or by a link was a bare "the GDD": discovery then built docs/Game_GDD.md,
   * another document. The name is the document the message meant; the
   * manager finds it or says it could not.
   */
  it.each([
    ["Quillmoor_GDD'deki oyunu yap", "Quillmoor_GDD"],
    ["Build the game in QuillmoorGDD", "QuillmoorGDD"],
    ["Build the game in the quillmoor_game_design_document", "quillmoor_game_design_document"],
    ["Build the game in docs/Quillmoor_GDD", "docs/Quillmoor_GDD"],
    ["Build the game in docs/Quillmoor_GDD.", "docs/Quillmoor_GDD"],
    ["Build the game in docs/design/GDD", "docs/design/GDD"],
    ["Build this game: docs/Quillmoor_GDD.pptx", "docs/Quillmoor_GDD.pptx"],
    ["Build this game: design/quillmoor-deck.pptx", "design/quillmoor-deck.pptx"],
    ["Build this game: docs/Quillmoor_GDD.html", "docs/Quillmoor_GDD.html"],
    ["Build this game: https://example.com/files/Quillmoor_GDD.md", "https://example.com/files/Quillmoor_GDD.md"],
    ["Bu oyunu yap: https://example.com/d/quillmoor.pdf", "https://example.com/d/quillmoor.pdf"],
    ["https://example.com/files/Quillmoor_GDD.md'deki oyunu yap", "https://example.com/files/Quillmoor_GDD.md"],
    // A download copy was read as the name before its "(1)" — the original beside it.
    ["Build this game: docs/Quillmoor_GDD (1).md", "docs/Quillmoor_GDD (1).md"],
    ["Build the game in docs/Quillmoor_GDD (final copy).md", "docs/Quillmoor_GDD (final copy).md"],
    ["Quillmoor_GDD (2).md'deki oyunu yap", "Quillmoor_GDD (2).md"],
    ["Build the game in docs/Quill Moor GDD (1).md", "docs/Quill Moor GDD (1).md"],
    // A name with a character the path pattern did not know, or in bold, was no name at all.
    ["Build this game: docs/Quill+Moor_GDD.md", "docs/Quill+Moor_GDD.md"],
    ["Build this game: docs/Quill&Moor_GDD.md", "docs/Quill&Moor_GDD.md"],
    ["Build this game: docs/Quill#Moor_GDD.md", "docs/Quill#Moor_GDD.md"],
    ["Build this game: docs/Quillmoor_GDD[v2].md", "docs/Quillmoor_GDD[v2].md"],
    // …while a Markdown link is its target, not its text.
    ["Build the game in [Quillmoor_GDD.md](docs/design/Quillmoor_GDD.md)", "docs/design/Quillmoor_GDD.md"],
    ["Build this game: **docs/Quillmoor_GDD.md**", "docs/Quillmoor_GDD.md"],
    ["Bu oyunu yap: <docs/Quillmoor_GDD.md>", "docs/Quillmoor_GDD.md"],
    // A section anchor is no part of the file's name.
    ["Build the game in docs/Quillmoor_GDD.md#combat", "docs/Quillmoor_GDD.md"],
  ])("%s → the document it names, %s, not the repository's other design", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs", path });
  });

  it.each([
    // "the GDD" itself, and a word built on it, are no name.
    ["Build the game in the GDD", { kind: "gdd-from-docs" }],
    ["GDD'deki oyunu yap", { kind: "gdd-from-docs" }],
    ["Build the game following the GDD/TDD split", { kind: "gdd-from-docs" }],
    // A link beside an idea is a reference, like a path.
    [
      "Build this game from scratch: a lantern city where the fog retreats from every lit street; mood board at https://example.com/board",
      { kind: "idea", ideaText: "Build this game from scratch: a lantern city where the fog retreats from every lit street; mood board at https://example.com/board" },
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
    const polite = "Şu oyunu yapınız: fener bekçisi her gece bir sokağı aydınlatır, sis aydınlanan sokaklardan çekilir.";
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

  it.each([
    "Build this game from scratch: a cozy farming sim where you grow glowing mushrooms; follow the art direction in docs/art-style.md.",
    "Sıfırdan bir oyun yap: fener bekçisi her gece bir sokağı aydınlatır ve sis geri çekilir; görseller docs/art-style.md'deki gibi olsun.",
    "Build this game: a lantern keeper lights one street per night and the fog retreats from it. Put the notes into docs/notes.md.",
    "Build this game from scratch: a city of lanterns where every lit street pushes the fog back; keep docs/Old_GDD.md only as a tone reference.",
    "Build the game from scratch: a lantern keeper writes every street she lights into log.txt, and the fog retreats from those streets.",
  ])("%s → the idea it carries, not the document it mentions", (text) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "idea", ideaText: text });
  });

  it.each([
    // The name that says GDD wins over another design-looking document…
    ["Build the game in docs/notes.md and docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Following docs/notes.md, build the game in docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    // …the one the build is aimed at over a GDD the message turns away…
    ["Don't use docs/Old_GDD.md, build the game in docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["docs/Old_GDD.md'yi kullanma, docs/Quillmoor_GDD.md'deki oyunu yap", "docs/Quillmoor_GDD.md"],
    // …a design over a style sheet named beside it…
    ["Build the game in docs/art-style.md and docs/quillmoor.md", "docs/quillmoor.md"],
    // …and a path written with spaces is the whole path, not its last word.
    ["Build the game in docs/Quill Moor GDD.md", "docs/Quill Moor GDD.md"],
    ["docs/Quill Moor GDD.md'deki oyunu yap", "docs/Quill Moor GDD.md"],
    // The document a short build instruction names is the design.
    ["Bu oyunu yap, tasarım docs/Quillmoor_GDD.md içinde", "docs/Quillmoor_GDD.md"],
    ["docs/quillmoor.md'ye göre oyunu baştan sona yap", "docs/quillmoor.md"],
    ["Build the game per docs/quillmoor.md", "docs/quillmoor.md"],
    // A build aimed at the design document itself, with only an adverb for build intent.
    ["Implement the GDD at docs/quillmoor.md end-to-end", "docs/quillmoor.md"],
    ["GDD'yi baştan sona uygula: docs/quillmoor.md", "docs/quillmoor.md"],
  ])("%s → %s", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs", path });
  });

  it("a GDD the message names beside its idea is still the design when it says so", () => {
    expect(detectCampaignIntent(msg("Build the game in the GDD; follow the art direction in docs/art-style.md"))).toEqual({ kind: "gdd-from-docs" });
    expect(detectCampaignIntent(msg("GDD'li dosya docs/quillmoor.txt, bu oyunu yap"))).toEqual({ kind: "gdd-from-docs", path: "docs/quillmoor.txt" });
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
  const IDEA = "fener bekçisi her gece bir sokağı aydınlatır, sis aydınlanan sokaklardan çekilir.";

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
    ["Can you build the game in docs/quillmoor.md?", "docs/quillmoor.md"],
    ["Could you please build this game: docs/Quillmoor_GDD.md?", "docs/Quillmoor_GDD.md"],
    ["Please build the game in docs/quillmoor.md", "docs/quillmoor.md"],
    ["Build the game in docs/quillmoor.md. Can you keep me posted?", "docs/quillmoor.md"],
    ["Build the game in docs/quillmoor.md, okay?", "docs/quillmoor.md"],
    ["If you can, build the game in docs/quillmoor.md", "docs/quillmoor.md"],
    ["Don't build the game in docs/Old_GDD.md; build the game in docs/Quillmoor_GDD.md", "docs/Quillmoor_GDD.md"],
    ["Don't wait for me, build the game in docs/quillmoor.md", "docs/quillmoor.md"],
    ["Bu oyunu yap: docs/quillmoor.md, tamam mı?", "docs/quillmoor.md"],
    ["docs/quillmoor.md'deki oyunu yazar mısın?", "docs/quillmoor.md"],
  ])("%s → %s (asked for, politely or plainly)", (text, path) => {
    expect(detectCampaignIntent(msg(text))).toEqual({ kind: "gdd-from-docs", path });
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
  });
});
