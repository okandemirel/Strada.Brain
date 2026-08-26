import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramChannel } from "./bot.js";
import { GrammyError } from "grammy";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../utils/media-processor.js", () => ({
  downloadMedia: vi.fn().mockResolvedValue({
    data: Buffer.from([0xff, 0xd8, 0xff]),
    mimeType: "image/jpeg",
    size: 3,
  }),
  validateMediaAttachment: vi.fn().mockReturnValue({ valid: true }),
  validateMagicBytes: vi.fn().mockReturnValue(true),
}));

// Mock grammy's Bot
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
  setMyCommands: vi.fn().mockResolvedValue(undefined),
  getFile: vi.fn().mockResolvedValue({ file_id: "file-1", file_path: "photos/photo.jpg" }),
};

const mockMiddlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
const mockHandlers = new Map<string, (ctx: any) => Promise<void>>();

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function () {
    return {
      token: "test-token",
      api: mockBotApi,
      use: vi.fn((middleware: any) => mockMiddlewares.push(middleware)),
      on: vi.fn((event: string, handler: any) => mockHandlers.set(event, handler)),
      command: vi.fn((name: string, handler: any) => mockHandlers.set(`command:${name}`, handler)),
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      isInited: vi.fn().mockReturnValue(true),
    };
  }),
  InlineKeyboard: vi.fn().mockImplementation(function () {
    const kb: Record<string, unknown> = {};
    kb.text = vi.fn().mockReturnValue(kb);
    kb.row = vi.fn().mockReturnValue(kb);
    return kb;
  }),
  // Minimal stand-in so `err instanceof GrammyError` works under the mock and the
  // 429 flood-control retry path can be exercised.
  GrammyError: class GrammyError extends Error {
    error_code: number;
    parameters: { retry_after?: number };
    constructor(message: string, error_code: number, retry_after?: number) {
      super(message);
      this.error_code = error_code;
      this.parameters = retry_after !== undefined ? { retry_after } : {};
    }
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
}));

import { AuthManager } from "../../security/auth.js";

describe("TelegramChannel", () => {
  let channel: TelegramChannel;
  let auth: AuthManager;

  beforeEach(() => {
    mockMiddlewares.length = 0;
    mockHandlers.clear();
    auth = new AuthManager([123, 456]);
    channel = new TelegramChannel("test-token", auth);
  });

  it("has correct name", () => {
    expect(channel.name).toBe("telegram");
  });

  it("registers auth middleware", () => {
    // The constructor calls setupMiddleware which calls bot.use()
    expect(mockMiddlewares.length).toBeGreaterThan(0);
  });

  it("auth middleware blocks unauthorized user", async () => {
    const middleware = mockMiddlewares[0]!;
    const ctx = {
      from: { id: 999 },
      reply: vi.fn(),
    };
    const next = vi.fn();

    await middleware(ctx, next);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
    expect(next).not.toHaveBeenCalled();
  });

  it("auth middleware allows authorized user", async () => {
    const middleware = mockMiddlewares[0]!;
    const ctx = { from: { id: 123 } };
    const next = vi.fn();

    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("sendText calls bot API", async () => {
    await channel.sendText("42", "Hello");
    expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "Hello");
  });

  it("sendMarkdown with fallback on error", async () => {
    mockBotApi.sendMessage
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce(undefined);

    await channel.sendMarkdown("42", "**bold**");
    // First call with Markdown, second without
    expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockBotApi.sendMessage).toHaveBeenNthCalledWith(1, 42, "**bold**", { parse_mode: "Markdown" });
    expect(mockBotApi.sendMessage).toHaveBeenNthCalledWith(2, 42, "**bold**");
  });

  it("sendTypingIndicator sends typing action", async () => {
    await channel.sendTypingIndicator("42");
    expect(mockBotApi.sendChatAction).toHaveBeenCalledWith(42, "typing");
  });

  describe("sendMarkdown chunking (M8)", () => {
    function restoreSendMessage() {
      mockBotApi.sendMessage.mockReset();
      mockBotApi.sendMessage.mockResolvedValue(undefined);
    }

    it("chunks messages over 4096 chars so no body is ever oversized", async () => {
      // Mimic Telegram's real behavior: reject any body longer than 4096.
      mockBotApi.sendMessage.mockImplementation((_id: number, text: string) =>
        text.length > 4096
          ? Promise.reject(new Error("Bad Request: message is too long"))
          : Promise.resolve(undefined),
      );

      const long = "x".repeat(10000);
      // TEETH: unfixed sendMarkdown sends the full 10000-char body, then the
      // fallback re-sends the same oversized body → both reject → this rejects.
      await expect(channel.sendMarkdown("42", long)).resolves.toBeUndefined();

      const calls = mockBotApi.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect((call[1] as string).length).toBeLessThanOrEqual(4096);
      }
      expect(calls.map((c) => c[1] as string).join("")).toBe(long);

      restoreSendMessage();
    });

    it("keeps the plain-text fallback within the 4096 limit", async () => {
      // Reject every Markdown attempt; resolve plain-text sends.
      mockBotApi.sendMessage.mockImplementation(
        (_id: number, _text: string, opts?: { parse_mode?: string }) =>
          opts?.parse_mode
            ? Promise.reject(new Error("can't parse entities"))
            : Promise.resolve(undefined),
      );

      const long = "y".repeat(10000);
      await expect(channel.sendMarkdown("42", long)).resolves.toBeUndefined();

      const plainCalls = mockBotApi.sendMessage.mock.calls.filter((c) => c[2] === undefined);
      expect(plainCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of plainCalls) {
        // TEETH: unfixed fallback re-sends the full 10000-char body in one plain call.
        expect((call[1] as string).length).toBeLessThanOrEqual(4096);
      }

      restoreSendMessage();
    });
  });

  describe("outbound flood-control / 429 retry", () => {
    afterEach(() => {
      vi.useRealTimers();
      mockBotApi.sendMessage.mockReset();
      mockBotApi.sendMessage.mockResolvedValue(undefined);
    });

    it("retries a throttled chunk honoring retry_after instead of aborting the message", async () => {
      vi.useFakeTimers();
      mockBotApi.sendMessage.mockReset();
      // First send is 429 (retry_after 2s); the retry succeeds.
      mockBotApi.sendMessage
        .mockRejectedValueOnce(new (GrammyError as any)("Too Many Requests", 429, 2))
        .mockResolvedValue(undefined);

      const sendPromise = channel.sendText("42", "hello");
      // Flush microtasks so the first (rejected) attempt runs and schedules its
      // retry timer, then advance past retry_after to trigger the retry.
      await vi.advanceTimersByTimeAsync(2100);
      await sendPromise;

      // Both the failed attempt and the successful retry were issued.
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockBotApi.sendMessage).toHaveBeenNthCalledWith(2, 42, "hello");
    });

    it("propagates non-429 errors without retrying", async () => {
      mockBotApi.sendMessage.mockReset();
      mockBotApi.sendMessage.mockRejectedValue(new (GrammyError as any)("Forbidden", 403));

      await expect(channel.sendText("42", "hello")).rejects.toBeInstanceOf(GrammyError);
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("serializes concurrent sends to the same chat in order", async () => {
    mockBotApi.sendMessage.mockReset();
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    mockBotApi.sendMessage
      // First message: block until we release it.
      .mockImplementationOnce((_id: number, text: string) => {
        order.push(`start:${text}`);
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            order.push(`end:${text}`);
            resolve();
          };
        });
      })
      // Subsequent messages: resolve immediately.
      .mockImplementation((_id: number, text: string) => {
        order.push(`start:${text}`);
        order.push(`end:${text}`);
        return Promise.resolve(undefined);
      });

    const p1 = channel.sendText("42", "A");
    const p2 = channel.sendText("42", "B");
    // Wait until A's send has actually started (chained via microtasks).
    while (!resolveFirst) {
      await Promise.resolve();
    }
    // At this point B must NOT have started yet (serialized behind A).
    expect(order).toEqual(["start:A"]);
    // B must not start until A finished — release A now.
    resolveFirst();
    await Promise.all([p1, p2]);

    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
    mockBotApi.sendMessage.mockReset();
    mockBotApi.sendMessage.mockResolvedValue(undefined);
  });

  it("onMessage stores handler", () => {
    const handler = vi.fn();
    channel.onMessage(handler);
    // Handler is stored internally
  });

  it("routes message:text to handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const textHandler = mockHandlers.get("message:text");
    expect(textHandler).toBeDefined();

    await textHandler!({
      chat: { id: 42 },
      from: { id: 123 },
      message: { text: "hello", date: 1700000000 },
      api: { sendChatAction: vi.fn().mockResolvedValue(undefined) },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "telegram",
        chatId: "42",
        userId: "123",
        text: "hello",
      })
    );
  });

  it("callback_query auth check blocks unauthorized user", async () => {
    const callbackHandler = mockHandlers.get("callback_query:data");
    expect(callbackHandler).toBeDefined();

    const answerCallbackQuery = vi.fn();
    await callbackHandler!({
      from: { id: 999 },
      callbackQuery: { data: "confirm_test:Yes" },
      answerCallbackQuery,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Unauthorized" });
  });

  it("only allows the original requester to answer a confirmation", async () => {
    const callbackHandler = mockHandlers.get("callback_query:data");
    expect(callbackHandler).toBeDefined();

    const promise = channel.requestConfirmation({
      chatId: "42",
      userId: "123",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    await Promise.resolve();

    const answerCallbackQuery = vi.fn();
    await callbackHandler!({
      chat: { id: 42 },
      from: { id: 456 },
      callbackQuery: { data: "confirm_test-uuid-1234:Yes" },
      answerCallbackQuery,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "Only the original requester can respond.",
    });
    expect(
      (channel as unknown as {
        pendingConfirmations: Map<string, unknown>;
      }).pendingConfirmations.has("confirm_test-uuid-1234"),
    ).toBe(true);

    await channel.disconnect();
    await expect(promise).resolves.toBe("cancelled");
  });

  it("isHealthy reflects polling liveness, not just init state", async () => {
    // The old isInited()-only check kept reporting healthy for days after a
    // fatal poll error killed long-polling. Before connect() no poll loop is
    // running, so the channel must read unhealthy despite isInited() === true.
    expect(channel.isHealthy()).toBe(false);
    await channel.connect();
    expect(channel.isHealthy()).toBe(true);
  });

  describe("polling recovery", () => {
    const getStartMock = () =>
      (channel as unknown as { bot: { start: ReturnType<typeof vi.fn> } }).bot.start;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("restarts long-polling after a fatal 409 conflict", async () => {
      vi.useFakeTimers();
      const start = getStartMock();
      let calls = 0;
      start.mockImplementation(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("409 Conflict: terminated by other getUpdates request"))
          : new Promise(() => {}); // the restarted poller stays up
      });

      await channel.connect();
      // Let the fatal rejection reach the catch handler.
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.isHealthy()).toBe(false);

      // The retry backoff (30s initial) fires and polling restarts.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(start).toHaveBeenCalledTimes(2);
      expect(channel.isHealthy()).toBe(true);
    });

    it("does not retry auth-class fatal errors", async () => {
      vi.useFakeTimers();
      const start = getStartMock();
      start.mockRejectedValue(new Error("401 Unauthorized"));

      await channel.connect();
      // Well past the max backoff: a retry would have fired if one were scheduled.
      await vi.advanceTimersByTimeAsync(600_000);

      expect(start).toHaveBeenCalledTimes(1);
      expect(channel.isHealthy()).toBe(false);
    });

    it("disconnect cancels a scheduled polling retry", async () => {
      vi.useFakeTimers();
      const start = getStartMock();
      start.mockRejectedValue(new Error("409 Conflict"));

      await channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      await channel.disconnect();
      await vi.advanceTimersByTimeAsync(600_000);

      expect(start).toHaveBeenCalledTimes(1);
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe("media handling", () => {
    it("registers media handlers", () => {
      expect(mockHandlers.has("message:photo")).toBe(true);
      expect(mockHandlers.has("message:document")).toBe(true);
      expect(mockHandlers.has("message:video")).toBe(true);
      expect(mockHandlers.has("message:voice")).toBe(true);
      expect(mockHandlers.has("message:audio")).toBe(true);
    });

    it("routes photo message with attachment to handler", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      const photoHandler = mockHandlers.get("message:photo")!;
      await photoHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: {
          photo: [
            { file_id: "small", width: 90, height: 90 },
            { file_id: "large", width: 800, height: 600 },
          ],
          caption: "check this image",
          date: 1700000000,
        },
        reply: vi.fn(),
        api: {
          getFile: vi.fn().mockResolvedValue({ file_id: "large", file_path: "photos/photo.jpg" }),
          sendChatAction: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          chatId: "42",
          userId: "123",
          text: "check this image",
          attachments: expect.arrayContaining([
            expect.objectContaining({
              type: "image",
              name: "photo.jpg",
              mimeType: "image/jpeg",
            }),
          ]),
        })
      );
    });

    it("routes document message with attachment to handler", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      const docHandler = mockHandlers.get("message:document")!;
      await docHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: {
          document: {
            file_id: "doc-1",
            file_name: "report.pdf",
            mime_type: "application/pdf",
          },
          caption: "here is the report",
          date: 1700000000,
        },
        reply: vi.fn(),
        api: {
          getFile: vi.fn().mockResolvedValue({ file_id: "doc-1", file_path: "documents/report.pdf" }),
          sendChatAction: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          chatId: "42",
          text: "here is the report",
          attachments: expect.arrayContaining([
            expect.objectContaining({
              type: "document",
              name: "report.pdf",
              mimeType: "application/pdf",
            }),
          ]),
        })
      );
    });

    it("replies not ready when no handler is set", async () => {
      const photoHandler = mockHandlers.get("message:photo")!;
      const replyMock = vi.fn();
      await photoHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: {
          photo: [{ file_id: "f1", width: 100, height: 100 }],
          date: 1700000000,
        },
        reply: replyMock,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_id: "f1", file_path: "photos/p.jpg" }),
          sendChatAction: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(replyMock).toHaveBeenCalledWith("Brain is not ready yet. Please try again later.");
    });

    it("sends media message without attachments when download fails", async () => {
      const { downloadMedia: mockDownload } = await import("../../utils/media-processor.js");
      (mockDownload as any).mockResolvedValueOnce(null);

      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      const photoHandler = mockHandlers.get("message:photo")!;
      await photoHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: {
          photo: [{ file_id: "f1", width: 100, height: 100 }],
          caption: "broken image",
          date: 1700000000,
        },
        reply: vi.fn(),
        api: {
          getFile: vi.fn().mockResolvedValue({ file_id: "f1", file_path: "photos/p.jpg" }),
          sendChatAction: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "broken image",
          attachments: undefined,
        })
      );
    });
  });
});
