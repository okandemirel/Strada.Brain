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
