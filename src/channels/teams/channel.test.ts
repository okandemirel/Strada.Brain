import { describe, expect, it, vi } from "vitest";
import { TeamsChannel } from "./channel.js";

const mockDownloadMedia = vi.fn().mockResolvedValue({
  data: Buffer.from("voice"),
  mimeType: "audio/mpeg",
  size: 5,
});

vi.mock("../../utils/media-processor.js", () => ({
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
  mimeToAttachmentType: (mime: string | undefined | null) => {
    if (!mime) return "document";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  },
  validateMediaAttachment: () => ({ valid: true }),
  validateMagicBytes: () => true,
}));

describe("TeamsChannel", () => {
  it("denies inbound users by default when no allowlist is configured", () => {
    const channel = new TeamsChannel("app-id", "app-password");

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(false);
  });

  it("supports explicit open access when configured", () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
  });

  it("restricts inbound users to the configured allowlist", () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, ["user-1", "user-2"]);

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
    expect((channel as any).isAllowedInboundUser("user-3")).toBe(false);
  });

  it("uses the active Teams turn context to send replies during a conversation", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (text: string) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    await channel.sendText("chat-1", "hello from teams");

    expect(sendActivity).toHaveBeenCalledWith("hello from teams");
  });

  it("fails explicitly when no active Teams turn context is available", async () => {
    const channel = new TeamsChannel("app-id", "app-password");

    await expect(channel.sendText("missing-chat", "hello")).rejects.toThrow(
      "No active Teams turn context for conversation: missing-chat",
    );
  });

  it("builds an incoming voice message from Teams attachments even without text", async () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    const msg = await (channel as any).toIncomingMessage({
      type: "message",
      conversation: { id: "chat-1" },
      from: { id: "user-1" },
      attachments: [
        {
          name: "voice.mp3",
          contentType: "audio/mpeg",
          contentUrl: "https://files.example.org/voice.mp3",
        },
      ],
    });

    expect(msg).toMatchObject({
      channelType: "teams",
      chatId: "chat-1",
      userId: "user-1",
      text: "(voice message)",
      attachments: [
        expect.objectContaining({
          type: "audio",
          name: "voice.mp3",
          mimeType: "audio/mpeg",
          url: "https://files.example.org/voice.mp3",
        }),
      ],
    });
  });

  it("infers voice attachment metadata from Teams download info payloads", async () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    const msg = await (channel as any).toIncomingMessage({
      type: "message",
      conversation: { id: "chat-2" },
      from: { id: "user-2" },
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.file.download.info",
          content: {
            downloadUrl: "https://files.example.org/voice-special",
            fileType: "mp3",
          },
        },
      ],
    });

    expect(msg).toMatchObject({
      text: "(voice message)",
      attachments: [
        expect.objectContaining({
          type: "audio",
          name: "attachment.mp3",
          mimeType: "audio/mpeg",
          url: "https://files.example.org/voice-special",
        }),
      ],
    });
  });
});
