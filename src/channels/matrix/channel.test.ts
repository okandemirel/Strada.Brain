import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("only treats genuinely live timeline events as live (skips backfill/removed/non-live)", () => {
    const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example", [], [], true);
    const isLive = (channel as any).isLiveTimelineEvent.bind(channel);

    // Live: flags absent or explicitly live.
    expect(isLive(false, false, { liveEvent: true })).toBe(true);
    expect(isLive(false, false, {})).toBe(true);
    expect(isLive(undefined, undefined, undefined)).toBe(true);

    // Not live: backfill, removal, or explicit non-live flag.
    expect(isLive(true, false, {})).toBe(false);
    expect(isLive(false, true, {})).toBe(false);
    expect(isLive(false, false, { liveEvent: false })).toBe(false);
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

  describe("sendMarkdown HTML rendering (M9)", () => {
    function withFakeClient() {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const sendHtmlMessage = vi.fn().mockResolvedValue(undefined);
      (channel as any).client = { sendHtmlMessage };
      return { channel, sendHtmlMessage };
    }

    it("renders the markdown subset to HTML instead of passing it through raw", async () => {
      const { channel, sendHtmlMessage } = withFakeClient();
      await channel.sendMarkdown("!room:example", "**bold** and *italic* and `code`");

      const [, plain, html] = sendHtmlMessage.mock.calls[0];
      // TEETH: unfixed code passed the raw markdown verbatim → "**bold** ..." with no tags.
      expect(html).toBe("<strong>bold</strong> and <em>italic</em> and <code>code</code>");
      // Plain-text body still strips the markers (guard, unchanged by the fix).
      expect(plain).toBe("bold and italic and code");
    });

    it("escapes HTML-significant characters in the formatted body (no injection)", async () => {
      const { channel, sendHtmlMessage } = withFakeClient();
      await channel.sendMarkdown("!room:example", "<script>alert(1)</script> & <b>x</b>");

      const html = sendHtmlMessage.mock.calls[0][2];
      // TEETH: unfixed code injected the raw "<script>" and bare "&" into formatted_body.
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&amp;");
    });

    it("converts newlines to <br/> so multi-line replies keep their line breaks", async () => {
      const { channel, sendHtmlMessage } = withFakeClient();
      await channel.sendMarkdown("!room:example", "line one\nline two");

      const html = sendHtmlMessage.mock.calls[0][2];
      // TEETH: unfixed renderer left raw "\n" which Matrix clients collapse to whitespace.
      expect(html).toBe("line one<br/>line two");
    });
  });

  describe("send chunking (M-message-length)", () => {
    it("splits an oversized sendText payload into multiple chunked sends", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const sendTextMessage = vi.fn().mockResolvedValue(undefined);
      (channel as any).client = { sendTextMessage };

      // Two ~32000-char lines force >1 chunk (MATRIX_MAX_CHARS === 32000).
      const longText = `${"a".repeat(32000)}\n${"b".repeat(32000)}`;
      await channel.sendText("!room:example", longText);

      // TEETH: unfixed code made a single unbounded send that the homeserver rejects.
      expect(sendTextMessage.mock.calls.length).toBeGreaterThan(1);
      for (const [, chunk] of sendTextMessage.mock.calls) {
        expect((chunk as string).length).toBeLessThanOrEqual(32000);
      }
      // No content dropped: reassembled chunks contain every original character.
      const reassembled = sendTextMessage.mock.calls.map(([, c]) => c as string).join("");
      expect(reassembled.replace(/\n/g, "")).toBe("a".repeat(32000) + "b".repeat(32000));
    });

    it("skips empty sendText input (never posts a blank event)", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const sendTextMessage = vi.fn().mockResolvedValue(undefined);
      (channel as any).client = { sendTextMessage };

      await channel.sendText("!room:example", "");

      expect(sendTextMessage).not.toHaveBeenCalled();
    });
  });

  describe("send retry / rate-limit (M-rate-limit)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a 429 send honoring retry_after_ms and eventually succeeds", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const sendTextMessage = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("rate limited"), {
            errcode: "M_LIMIT_EXCEEDED",
            httpStatus: 429,
            data: { retry_after_ms: 1000 },
          }),
        )
        .mockResolvedValueOnce(undefined);
      (channel as any).client = { sendTextMessage };

      const promise = channel.sendText("!room:example", "hello");
      // Let the first (rejecting) attempt settle, then advance past retry_after_ms.
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      // TEETH: unfixed code threw the 429 straight to the caller (reply dropped).
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("inbound m.notice / m.emote (M-error-handling)", () => {
    it("routes m.notice body as text instead of dropping it", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example", [], [], true);

      const msg = await (channel as any).toIncomingMessage(
        {
          getType: () => "m.room.message",
          getSender: () => "@alice:example",
          getRoomId: () => "!room:example",
          getTs: () => 123,
          getContent: () => ({ msgtype: "m.notice", body: "bridged notice text" }),
        },
        {},
      );

      // TEETH: unfixed code only read m.text, so m.notice yielded text="" → null.
      expect(msg).toMatchObject({ text: "bridged notice text", chatId: "!room:example" });
    });

    it("drops events with undefined sender/roomId", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example", [], [], true);

      const msg = await (channel as any).toIncomingMessage(
        {
          getType: () => "m.room.message",
          getSender: () => undefined,
          getRoomId: () => undefined,
          getTs: () => 123,
          getContent: () => ({ msgtype: "m.text", body: "orphan" }),
        },
        {},
      );

      expect(msg).toBeNull();
    });
  });

  describe("sendAttachment (M-unimplemented)", () => {
    it("uploads the file and sends a media message with the mxc:// uri", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const uploadContent = vi.fn().mockResolvedValue({ content_uri: "mxc://example.org/abc" });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      (channel as any).client = { uploadContent, sendMessage };

      await channel.sendAttachment("!room:example", {
        type: "image",
        name: "pic.png",
        data: Buffer.from("imgbytes"),
        mimeType: "image/png",
        size: 8,
      });

      // TEETH: unfixed stub ignored the bytes and only posted "[Attachment: pic.png]".
      expect(uploadContent).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [roomId, content] = sendMessage.mock.calls[0];
      expect(roomId).toBe("!room:example");
      expect(content).toMatchObject({
        msgtype: "m.image",
        body: "pic.png",
        url: "mxc://example.org/abc",
      });
    });

    it("falls back to a text placeholder when no bytes are available", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const sendTextMessage = vi.fn().mockResolvedValue(undefined);
      const uploadContent = vi.fn();
      (channel as any).client = { sendTextMessage, uploadContent };

      await channel.sendAttachment("!room:example", { type: "file", name: "data.bin" });

      expect(uploadContent).not.toHaveBeenCalled();
      expect(sendTextMessage).toHaveBeenCalledWith("!room:example", "[Attachment: data.bin]");
    });
  });

  describe("disconnect cleanup (M-leak)", () => {
    it("removes the timeline + sync listeners, nulls the client, and clears instinct state", async () => {
      const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");
      const removeListener = vi.fn();
      const stopClient = vi.fn();
      const timelineHandler = () => {};
      const syncHandler = () => {};
      (channel as any).client = { removeListener, stopClient };
      (channel as any).timelineHandler = timelineHandler;
      (channel as any).syncHandler = syncHandler;
      channel.setAppliedInstinctIds("!room:example", ["instinct-1"]);

      await channel.disconnect();

      // TEETH: unfixed disconnect only called stopClient(), leaking the listener.
      expect(removeListener).toHaveBeenCalledWith("Room.timeline", timelineHandler);
      expect(removeListener).toHaveBeenCalledWith("sync", syncHandler);
      expect(stopClient).toHaveBeenCalledTimes(1);
      expect((channel as any).client).toBeNull();
      expect((channel as any).timelineHandler).toBeNull();
      expect((channel as any).appliedInstinctIds.size).toBe(0);
      expect(channel.isHealthy()).toBe(false);
    });
  });
});
