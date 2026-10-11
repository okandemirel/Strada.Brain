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
