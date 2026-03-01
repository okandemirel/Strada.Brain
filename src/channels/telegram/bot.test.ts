import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramChannel } from "./bot.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock grammy's Bot
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
  setMyCommands: vi.fn().mockResolvedValue(undefined),
};

const mockMiddlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
const mockHandlers = new Map<string, (ctx: any) => Promise<void>>();

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: mockBotApi,
    use: vi.fn((middleware: any) => mockMiddlewares.push(middleware)),
    on: vi.fn((event: string, handler: any) => mockHandlers.set(event, handler)),
    command: vi.fn((name: string, handler: any) => mockHandlers.set(`command:${name}`, handler)),
    start: vi.fn(),
    stop: vi.fn(),
    catch: vi.fn(),
    isInited: vi.fn().mockReturnValue(true),
  })),
  InlineKeyboard: vi.fn().mockImplementation(() => ({
    text: vi.fn().mockReturnThis(),
  })),
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

  it("isHealthy returns bot init state", () => {
    expect(channel.isHealthy()).toBe(true);
  });
});
