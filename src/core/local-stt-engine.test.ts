import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

describe("local-stt-engine", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { createLogger: initLogger } = await import("../utils/logger.js");
    initLogger("error", "/dev/null");
    delete process.env["STT_MODE"];
    delete process.env["STT_MODEL"];
    delete process.env["STT_CACHE_DIR"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["STT_MODE"];
    delete process.env["STT_MODEL"];
    delete process.env["STT_CACHE_DIR"];
  });

  describe("transcribeLocal", () => {
    it("returns null when STT_MODE is disabled", async () => {
      process.env["STT_MODE"] = "disabled";
      const { transcribeLocal } = await import("./local-stt-engine.js");
      const result = await transcribeLocal(Buffer.from("audio"), "audio/webm");
      expect(result).toBeNull();
    });

    it("returns null when STT_MODE is cloud", async () => {
      process.env["STT_MODE"] = "cloud";
      const { transcribeLocal } = await import("./local-stt-engine.js");
      const result = await transcribeLocal(Buffer.from("audio"), "audio/webm");
      expect(result).toBeNull();
    });

    it("returns null when @huggingface/transformers is not installed", async () => {
      vi.doMock("@huggingface/transformers", () => { throw new Error("not installed"); });
      const { transcribeLocal } = await import("./local-stt-engine.js");
      const result = await transcribeLocal(Buffer.from("audio"), "audio/webm");
      expect(result).toBeNull();
    });
  });

  describe("isLocalSttAvailable", () => {
    it("returns false when STT_MODE is disabled", async () => {
      process.env["STT_MODE"] = "disabled";
      const { isLocalSttAvailable } = await import("./local-stt-engine.js");
      expect(await isLocalSttAvailable()).toBe(false);
    });

    it("returns false when STT_MODE is cloud", async () => {
      process.env["STT_MODE"] = "cloud";
      const { isLocalSttAvailable } = await import("./local-stt-engine.js");
      expect(await isLocalSttAvailable()).toBe(false);
    });

    it("returns false when @huggingface/transformers is not available", async () => {
      vi.doMock("@huggingface/transformers", () => { throw new Error("not installed"); });
      const { isLocalSttAvailable } = await import("./local-stt-engine.js");
      expect(await isLocalSttAvailable()).toBe(false);
    });
  });

  describe("disposeLocalStt", () => {
    it("does not throw when called with no active pipeline", async () => {
      const { disposeLocalStt } = await import("./local-stt-engine.js");
      expect(() => disposeLocalStt()).not.toThrow();
    });
  });
});

describe("incoming-audio-transcription with local STT", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { createLogger: initLogger } = await import("../utils/logger.js");
    initLogger("error", "/dev/null");
    delete process.env["OPENAI_API_KEY"];
    delete process.env["GROQ_API_KEY"];
    delete process.env["STT_PROVIDER"];
    delete process.env["STT_MODE"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env["OPENAI_API_KEY"];
    delete process.env["GROQ_API_KEY"];
    delete process.env["STT_PROVIDER"];
    delete process.env["STT_MODE"];
  });

  it("updated error message mentions local and cloud options", async () => {
    const { transcribeIncomingAudioMessage } = await import("./incoming-audio-transcription.js");

    const msg = {
      channelType: "web" as const,
      chatId: "c1",
      userId: "u1",
      text: "",
      timestamp: new Date(),
      attachments: [{
        type: "audio" as const,
        name: "voice.ogg",
        mimeType: "audio/ogg",
        data: Buffer.from("audio-data"),
        size: 10,
      }],
    };

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");
    expect(result.shouldDrop).toBe(true);
    expect(result.userWarning).toContain("@huggingface/transformers");
    expect(result.userWarning).toContain("OPENAI_API_KEY");
  });

  it("drops audio when STT_MODE is disabled", async () => {
    process.env["STT_MODE"] = "disabled";
    const { transcribeIncomingAudioMessage } = await import("./incoming-audio-transcription.js");

    const msg = {
      channelType: "web" as const,
      chatId: "c1",
      userId: "u1",
      text: "",
      timestamp: new Date(),
      attachments: [{
        type: "audio" as const,
        name: "voice.ogg",
        mimeType: "audio/ogg",
        data: Buffer.from("audio-data"),
        size: 10,
      }],
    };

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");
    expect(result.shouldDrop).toBe(true);
    expect(result.userWarning).toContain("disabled");
  });

  it("uses cloud when STT_MODE is cloud", async () => {
    process.env["STT_MODE"] = "cloud";
    process.env["OPENAI_API_KEY"] = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "cloud transcript" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const { transcribeIncomingAudioMessage } = await import("./incoming-audio-transcription.js");

    const msg = {
      channelType: "web" as const,
      chatId: "c1",
      userId: "u1",
      text: "(voice message)",
      timestamp: new Date(),
      attachments: [{
        type: "audio" as const,
        name: "voice.ogg",
        mimeType: "audio/ogg",
        data: Buffer.from("audio-data"),
        size: 10,
      }],
    };

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");
    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("cloud transcript");
  });

  it("preserves text alongside untranscribable audio", async () => {
    const { transcribeIncomingAudioMessage } = await import("./incoming-audio-transcription.js");

    const msg = {
      channelType: "web" as const,
      chatId: "c1",
      userId: "u1",
      text: "Here is a voice note",
      timestamp: new Date(),
      attachments: [{
        type: "audio" as const,
        name: "voice.ogg",
        mimeType: "audio/ogg",
        data: Buffer.from("audio-data"),
        size: 10,
      }],
    };

    const result = await transcribeIncomingAudioMessage(msg, "/tmp/project");
    expect(result.shouldDrop).toBe(false);
    expect(result.message.text).toBe("Here is a voice note");
  });
});
