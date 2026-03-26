import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MatrixChannel } from "./channel.js";

const mockDownloadMedia = vi.fn().mockResolvedValue({
  data: Buffer.from("voice"),
  mimeType: "audio/ogg",
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

describe("MatrixChannel", () => {
  it("denies inbound events by default when no allowlists are configured", () => {
    const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");

    expect((channel as any).isAllowedInboundMessage("@alice:example", "!room:example")).toBe(false);
  });

  it("supports explicit open access when configured", () => {
    const channel = new MatrixChannel(
      "https://matrix.example",
      "token",
      "@bot:example",
      [],
      [],
      true,
    );

    expect((channel as any).isAllowedInboundMessage("@alice:example", "!room:example")).toBe(true);
  });

  it("requires both allowed user and allowed room when allowlists are configured", () => {
    const channel = new MatrixChannel(
      "https://matrix.example",
      "token",
      "@bot:example",
      ["@alice:example"],
      ["!allowed:example"],
    );

    expect((channel as any).isAllowedInboundMessage("@alice:example", "!allowed:example")).toBe(true);
    expect((channel as any).isAllowedInboundMessage("@bob:example", "!allowed:example")).toBe(false);
    expect((channel as any).isAllowedInboundMessage("@alice:example", "!other:example")).toBe(false);
  });

  it("converts audio timeline events into incoming messages with attachments", async () => {
    const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example", [], [], true);

    const msg = await (channel as any).toIncomingMessage(
      {
        getType: () => "m.room.message",
        getSender: () => "@alice:example",
        getRoomId: () => "!room:example",
        getTs: () => 123,
        getContent: () => ({
          msgtype: "m.audio",
          body: "voice.ogg",
          url: "mxc://example.org/voice",
          info: {
            mimetype: "audio/ogg",
            size: 5,
          },
        }),
      },
      {
        mxcUrlToHttp: () => "https://cdn.example.org/voice.ogg",
      },
    );

    expect(msg).toMatchObject({
      channelType: "matrix",
      chatId: "!room:example",
      userId: "@alice:example",
      text: "(voice message)",
      attachments: [
        expect.objectContaining({
          type: "audio",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          url: "https://cdn.example.org/voice.ogg",
        }),
      ],
    });
  });

  it("decrypts encrypted Matrix audio attachments before routing", async () => {
    const plaintext = Buffer.from("voice-clear");
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const sha256 = createHash("sha256").update(ciphertext).digest("base64url");
    mockDownloadMedia.mockResolvedValueOnce({
      data: ciphertext,
      mimeType: "application/octet-stream",
      size: ciphertext.length,
    });

    const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example", [], [], true);

    const msg = await (channel as any).toIncomingMessage(
      {
        getType: () => "m.room.message",
        getSender: () => "@alice:example",
        getRoomId: () => "!room:example",
        getTs: () => 123,
        getContent: () => ({
          msgtype: "m.audio",
          body: "secret.ogg",
          file: {
            url: "mxc://example.org/secret",
            iv: iv.toString("base64url"),
            hashes: { sha256 },
            key: {
              alg: "A256CTR",
              k: key.toString("base64url"),
            },
          },
          info: {
            mimetype: "audio/ogg",
          },
        }),
      },
      {
        mxcUrlToHttp: () => "https://cdn.example.org/secret.ogg",
      },
    );

    expect(msg?.attachments?.[0]).toMatchObject({
      type: "audio",
      mimeType: "audio/ogg",
      data: plaintext,
    });
  });
});
