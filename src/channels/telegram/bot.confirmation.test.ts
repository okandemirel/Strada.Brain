/**
 * CHN-7: Telegram confirmation prompts fit the platform's limits (64-byte
 * callback_data, 4096-character messages), resolve the clicked option by
 * index, and a prompt that could not be sent is "not answered", never an answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const sendMessage = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (ctx: unknown) => Promise<void>>());
const buttons = vi.hoisted(() => [] as Array<{ label: string; data: string }>);

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function () {
    return {
      token: "t",
      api: { sendMessage, sendChatAction: vi.fn(), setMyCommands: vi.fn() },
      use: vi.fn(),
      on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => handlers.set(event, handler)),
      command: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      isInited: vi.fn().mockReturnValue(true),
    };
  }),
  InlineKeyboard: vi.fn().mockImplementation(function () {
    const kb: { text: (label: string, data: string) => unknown } = {
      text: (label: string, data: string) => {
        buttons.push({ label, data });
        return kb;
      },
    };
    return kb;
  }),
  GrammyError: class GrammyError extends Error {},
}));

import { TelegramChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";

const LONG_OPTIONS = Array.from({ length: 5 }, (_, i) => `${i} ${"Yeniden kullan: EnemySystem ".repeat(4)}`.slice(0, 100));
const LONG_QUESTION = "Plan step. ".repeat(600);

function channel(): TelegramChannel {
  return new TelegramChannel("token", new AuthManager([123]));
}

describe("Telegram confirmation prompts (CHN-7)", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ message_id: 1 });
    buttons.length = 0;
    handlers.clear();
  });

  it("sends a sendable payload for five 100-char options and a 6600-char question, then resolves the clicked option", async () => {
    const ch = channel();
    const answer = ch.requestConfirmation({ chatId: "42", userId: "123", question: LONG_QUESTION, options: LONG_OPTIONS });
    await vi.waitFor(() => expect(buttons).toHaveLength(5));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    for (const button of buttons) expect(Buffer.byteLength(button.data, "utf8")).toBeLessThanOrEqual(64);
    for (const call of sendMessage.mock.calls) expect(String(call[1]).length).toBeLessThanOrEqual(4096);
    // The keyboard rides on the last chunk only.
    const last = sendMessage.mock.calls[sendMessage.mock.calls.length - 1]!;
    expect(last[2]).toHaveProperty("reply_markup");

    const answerCallbackQuery = vi.fn();
    await handlers.get("callback_query:data")!({
      chat: { id: 42 },
      from: { id: 123 },
      callbackQuery: { data: buttons[3]!.data },
      answerCallbackQuery,
    });
    await expect(answer).resolves.toBe(LONG_OPTIONS[3]);
  });

  it("a prompt that cannot be sent is not answered — never an option-like word", async () => {
    sendMessage.mockRejectedValue(new Error("Bad Request: BUTTON_DATA_INVALID"));
    await expect(
      channel().requestConfirmation({ chatId: "42", question: "Confirm?", options: ["Yes", "No"] }),
    ).resolves.toBe("timeout");
  });

  it("a prompt pending at disconnect is not answered", async () => {
    const ch = channel();
    const answer = ch.requestConfirmation({ chatId: "42", question: "Confirm?", options: ["Yes", "No"] });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await Promise.resolve();
    await ch.disconnect();
    await expect(answer).resolves.toBe("timeout");
  });
});
