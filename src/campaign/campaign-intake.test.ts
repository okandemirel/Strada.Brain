import { describe, it, expect } from "vitest";
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
