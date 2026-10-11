/**
 * Discord attachments against the REAL media validation, and the mention
 * policy on everything the bot sends.
 *
 * Audit channels#1: Discord downloaded bytes only for images and audio, and
 * skipped a file that failed validation with a bare `continue`. A shared GDD
 * therefore reached campaign intake without its bytes (or not at all), the
 * caption "build the game in this GDD" matched gdd-from-docs, and the campaign
 * built whatever document already sat in docs/.
 *
 * Audit channels#6: the client set no allowedMentions, so "@everyone" in an
 * agent reply pinged the whole server.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DiscordChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";
import { detectCampaignIntent } from "../../campaign/campaign-intake.js";
import type { IncomingMessage } from "../channel-messages.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Only the network is faked; validation, magic bytes and type mapping are real.
const mockDownloadMedia = vi.fn();
vi.mock("../../utils/media-processor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/media-processor.js")>()),
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
}));

const clientOptions: Array<Record<string, unknown>> = [];
vi.mock("discord.js", async () => {
  const actual = await vi.importActual("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
      clientOptions.push(options);
      return {
        login: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(true),
        user: { tag: "TestBot#1234", id: "123456789" },
        ws: { ping: 50 },
        on: vi.fn(),
        once: vi.fn(),
        channels: { fetch: vi.fn() },
      };
    }),
  };
});

/** A real (uncompressed) PDF whose content stream holds a design's prose. */
function gddPdf(): Buffer {
  const prose =
    "PacMan GDD. The player steers a yellow circle through a maze, eating pellets " +
    "while four ghosts chase it. Eating a power pellet turns the ghosts blue for eight " +
    "seconds so they can be eaten for points. Clearing every pellet advances the level.";
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${prose.length + 20} >>\nstream\nBT (${prose}) Tj ET\nendstream\nendobj\n%%EOF\n`,
    "latin1",
  );
}

describe("DiscordChannel attachments reach campaign intake or the user is told", () => {
  let channel: DiscordChannel;
  let messageCreate: (message: Record<string, unknown>) => Promise<void>;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDownloadMedia.mockReset();
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["allowed123"]),
      allowedDiscordRoles: new Set(),
    });
    channel = new DiscordChannel("fake-token", auth, { guildId: "guild123" });
    handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    const onCalls = (channel.getClient().on as ReturnType<typeof vi.fn>).mock.calls;
    messageCreate = onCalls.find((c: unknown[]) => c[0] === "messageCreate")![1] as typeof messageCreate;
  });

  function discordMessage(text: string, files: Array<Record<string, unknown>>) {
    return {
      author: { bot: false, id: "allowed123" },
      channelId: "ch1",
      content: text,
      reference: null,
      createdAt: new Date(),
      attachments: new Map(files.map((f, i) => [String(i), f])),
      channel: { isTextBased: () => true, sendTyping: vi.fn() },
      reply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("a shared PDF GDD reaches intake with its bytes, so the campaign builds THAT document", async () => {
    const pdf = gddPdf();
    mockDownloadMedia.mockResolvedValue({ data: pdf, mimeType: "application/pdf", size: pdf.length });

    const message = discordMessage("build the game in this GDD", [
      { name: "PacMan_GDD.pdf", url: "https://cdn.discordapp.com/a/PacMan_GDD.pdf", contentType: "application/pdf", size: pdf.length },
    ]);
    await messageCreate(message);

    expect(mockDownloadMedia).toHaveBeenCalledWith("https://cdn.discordapp.com/a/PacMan_GDD.pdf");
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0]![0] as IncomingMessage;
    expect(msg.attachments?.[0]?.data).toBeInstanceOf(Buffer);
    // Without the bytes this was { kind: "gdd-from-docs" }: a different game.
    expect(detectCampaignIntent(msg)).toMatchObject({ kind: "gdd-attachment", sourceName: "PacMan_GDD.pdf" });
  });

  it("a GDD in a format the bot cannot take is refused out loud, not dropped while the caption goes on", async () => {
    const message = discordMessage("build the game in this GDD", [
      {
        name: "PacMan_GDD.docx",
        url: "https://cdn.discordapp.com/a/PacMan_GDD.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 40_000,
      },
    ]);
    await messageCreate(message);

    expect(handler).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledTimes(1);
    const reply = String(message.reply.mock.calls[0]![0]);
    expect(reply).toContain("PacMan_GDD.docx");
    expect(reply).toContain("not accepted");
  });

  it("a document whose download fails is refused, not forwarded as a bare link", async () => {
    mockDownloadMedia.mockResolvedValue(null);

    const message = discordMessage("build the game in this GDD", [
      { name: "PacMan_GDD.pdf", url: "https://cdn.discordapp.com/a/PacMan_GDD.pdf", contentType: "application/pdf", size: 9_000 },
    ]);
    await messageCreate(message);

    expect(handler).not.toHaveBeenCalled();
    expect(String(message.reply.mock.calls[0]?.[0])).toContain("PacMan_GDD.pdf");
  });

  it("one refused file stops the whole message, even next to a file that was accepted", async () => {
    mockDownloadMedia.mockResolvedValue(null); // the image keeps its CDN URL

    const message = discordMessage("build the game in this GDD", [
      { name: "concept.png", url: "https://cdn.discordapp.com/a/concept.png", contentType: "image/png", size: 1_000 },
      { name: "PacMan_GDD.md", url: "https://cdn.discordapp.com/a/PacMan_GDD.md", contentType: "text/markdown; charset=utf-8", size: 4_000 },
    ]);
    await messageCreate(message);

    expect(handler).not.toHaveBeenCalled();
    expect(String(message.reply.mock.calls[0]?.[0])).toContain("PacMan_GDD.md");
  });

  it("an image whose download fails still goes through on its CDN URL", async () => {
    mockDownloadMedia.mockResolvedValue(null);

    await messageCreate(discordMessage("what is this?", [
      { name: "photo.png", url: "https://cdn.discordapp.com/a/photo.png", contentType: "image/png", size: 1_000 },
    ]));

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]![0] as IncomingMessage).attachments?.[0]).toMatchObject({
      type: "image",
      url: "https://cdn.discordapp.com/a/photo.png",
    });
  });
});

describe("DiscordChannel mention policy", () => {
  it("sends with no parsed mentions, so @everyone, @here and role pings in a reply stay inert", async () => {
    clientOptions.length = 0;
    const auth = new AuthManager([], { allowedDiscordIds: new Set(["u"]), allowedDiscordRoles: new Set() });
    new DiscordChannel("fake-token", auth, { guildId: "guild123" });
    const options = clientOptions.at(-1)!;

    // What discord.js actually puts on the wire for a plain-string send.
    const { MessagePayload } = await vi.importActual<typeof import("discord.js")>("discord.js");
    const payload = MessagePayload.create(
      { client: { options } } as never,
      "deploy finished @everyone @here <@&123456789012345678>",
    ).resolveBody();

    expect((payload.body as { allowed_mentions?: { parse?: unknown[] } }).allowed_mentions?.parse).toEqual([]);
  });
});
