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
    expect(result.userWarning).toContain("speech-to-text provider");
  });
});
