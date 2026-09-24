import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const fetchWithPolicy = vi.fn();
vi.mock("../../security/browser-security.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../security/browser-security.js")>()),
  fetchWithPolicy: (...args: unknown[]) => fetchWithPolicy(...args),
}));
const fetchWithRetry = vi.fn();
vi.mock("../../common/fetch-with-retry.js", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));

const { SpeechToTextTool } = await import("./speech-to-text.js");

const context = { projectPath: "/tmp/project" } as never;

function streamOf(totalBytes: number, chunkBytes = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

describe("SpeechToTextTool audio download", () => {
  beforeEach(() => {
    fetchWithPolicy.mockReset();
    fetchWithRetry.mockReset();
  });

  it("downloads a remote clip through the address-pinned transport, with redirects refused", async () => {
    const dispose = vi.fn(async () => {});
    fetchWithPolicy.mockResolvedValue({ response: new Response(streamOf(1000)), dispose });
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));

    const tool = new SpeechToTextTool("sk-test");
    const result = await tool.execute({ audio_url: "https://cdn.example.com/voice.ogg" }, context);

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(fetchWithPolicy).toHaveBeenCalledWith(
      "https://cdn.example.com/voice.ogg",
      expect.objectContaining({ maxRedirects: 0 }),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    // The only plain fetch left is the call to the transcription API itself.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(String(fetchWithRetry.mock.calls[0]?.[0])).toContain("/audio/transcriptions");
  });

  it("refuses a body past the size cap even when Content-Length is absent", async () => {
    const dispose = vi.fn(async () => {});
    fetchWithPolicy.mockResolvedValue({ response: new Response(streamOf(30 * 1024 * 1024)), dispose });

    const tool = new SpeechToTextTool("sk-test");
    const result = await tool.execute({ audio_url: "https://cdn.example.com/huge.ogg" }, context);

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/exceeds 25MB/);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
