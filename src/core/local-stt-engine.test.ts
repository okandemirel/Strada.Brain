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

  // COR-18
  describe("pipeline load failures and timers", () => {
    function mockWhisper(factory: (task: string, model: string) => Promise<(audio: Float32Array) => Promise<{ text: string }>>) {
      vi.doMock("@huggingface/transformers", () => ({ pipeline: factory, env: {} }));
      vi.doMock("wavefile", () => ({
        WaveFile: class {
          toBitDepth(): void {}
          toSampleRate(): void {}
          getSamples(): Float32Array { return new Float32Array([0.1, 0.2, 0.3]); }
        },
      }));
    }

    afterEach(() => {
      vi.doUnmock("@huggingface/transformers");
      vi.doUnmock("wavefile");
      vi.useRealTimers();
    });

    it("retries the model load after a transient failure instead of caching it", async () => {
      const factory = vi.fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce(async () => ({ text: "hello world" }));
      mockWhisper(factory);
      const { transcribeLocal } = await import("./local-stt-engine.js");

      expect(await transcribeLocal(Buffer.from("RIFF"), "audio/wav")).toBeNull();
      expect(await transcribeLocal(Buffer.from("RIFF"), "audio/wav")).toBe("hello world");
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it("leaves no 30 s timeout timer behind after a transcription", async () => {
      mockWhisper(async () => async () => ({ text: "done" }));
      const { transcribeLocal } = await import("./local-stt-engine.js");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      expect(await transcribeLocal(Buffer.from("RIFF"), "audio/wav")).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("ffmpegInputArgs", () => {
    it("pins the demuxer to the validated MIME type and allows file access only", async () => {
      const { ffmpegInputArgs } = await import("./local-stt-engine.js");
      expect(ffmpegInputArgs("audio/ogg; codecs=opus", "/tmp/x/input.ogg")).toEqual([
        "-protocol_whitelist", "file", "-f", "ogg", "-i", "/tmp/x/input.ogg",
      ]);
      expect(ffmpegInputArgs("audio/mpeg", "in.mp3")).toEqual(["-protocol_whitelist", "file", "-f", "mp3", "-i", "in.mp3"]);
      expect(ffmpegInputArgs("audio/webm", "in.webm")?.slice(0, 4)).toEqual(["-protocol_whitelist", "file", "-f", "webm"]);
      expect(ffmpegInputArgs("audio/mp4", "in.m4a")?.slice(2, 4)).toEqual(["-f", "mp4"]);
    });

    it("refuses a type it has no demuxer for rather than letting ffmpeg guess", async () => {
      const { ffmpegInputArgs } = await import("./local-stt-engine.js");
      expect(ffmpegInputArgs("audio/x-unknown", "in.audio")).toBeUndefined();
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
