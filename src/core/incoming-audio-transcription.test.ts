import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeIncomingAudioMessage } from "./incoming-audio-transcription.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import { createLogger } from "../utils/logger.js";

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: "web",
    chatId: "chat-1",
    userId: "user-1",
    text: "",
    timestamp: new Date(),
    ...overrides,
  };
}

afterEach(() => {
  delete process.env["OPENAI_API_KEY"];
  delete process.env["GROQ_API_KEY"];
  delete process.env["STT_PROVIDER"];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

createLogger("error", "/dev/null");

describe("transcribeIncomingAudioMessage", () => {
  it("returns the original message when no audio attachment exists", async () => {
    const msg = makeMessage({ text: "hello" });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message).toEqual(msg);
  });

  it("replaces a voice placeholder with the transcribed text", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "merhaba dunya" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const msg = makeMessage({
      text: "(voice message)",
      attachments: [
        {
          type: "audio",
          name: "voice.wav",
          mimeType: "audio/wav",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("merhaba dunya");
  });

  it("normalizes codec-qualified WebM audio before transcription validation", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "normalized transcript" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const msg = makeMessage({
      text: "(voice message)",
      attachments: [
        {
          type: "audio",
          name: "voice.webm",
          mimeType: "audio/webm;codecs=opus",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("normalized transcript");
  });

  it("drops pure audio messages when transcription is unavailable", async () => {
    const msg = makeMessage({
      attachments: [
        {
          type: "audio",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(true);
    expect(result.userWarning).toContain("transcription");
  });

  it("recognises Turkish voice placeholder and replaces it with transcript", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "merhaba dünya" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const msg = makeMessage({
      text: "(sesli mesaj)",
      attachments: [
        {
          type: "audio",
          name: "voice.webm",
          mimeType: "audio/webm",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("merhaba dünya");
  });

  it("uses Groq Whisper when OpenAI is unavailable", async () => {
    process.env["GROQ_API_KEY"] = "gsk-test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello from groq" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const msg = makeMessage({
      text: "(voice message)",
      attachments: [
        {
          type: "audio",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("hello from groq");
    // Verify Groq endpoint was called
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toContain("groq.com");
  });

  it("respects explicit STT_PROVIDER=groq even when OpenAI key is available", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["GROQ_API_KEY"] = "gsk-test";
    process.env["STT_PROVIDER"] = "groq";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "groq transcript" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const msg = makeMessage({
      text: "",
      attachments: [
        {
          type: "audio",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          data: Buffer.from("voice-data"),
          size: 10,
        },
      ],
    });

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");

    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("groq transcript");
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toContain("groq.com");
  });

  it("recognises all i18n voice placeholders as non-meaningful text", async () => {
    const placeholders = [
      "(voice message)",
      "(sesli mesaj)",
      "(mensaje de voz)",
      "(Sprachnachricht)",
      "(음성 메시지)",
      "(message vocal)",
      "（语音消息）",
      "(音声メッセージ)",
    ];

    for (const placeholder of placeholders) {
      const msg = makeMessage({
        text: placeholder,
        attachments: [
          {
            type: "audio",
            name: "voice.ogg",
            mimeType: "audio/ogg",
            data: Buffer.from("voice-data"),
            size: 10,
          },
        ],
      });

      // Without any API key, voice-only messages with placeholder text should be dropped
      const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");
      expect(result.shouldDrop).toBe(true);
    }
  });
});
