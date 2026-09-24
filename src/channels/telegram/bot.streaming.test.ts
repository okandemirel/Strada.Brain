/**
 * CHN-22: a streamed Telegram answer over the 4096-character limit ends as the
 * placeholder holding the first chunk plus the rest as new messages — not a
 * frozen partial with the whole answer re-sent underneath it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const TELEGRAM_LIMIT = 4096;
const editMessageText = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function () {
    return {
      token: "t",
      api: { sendMessage, editMessageText, sendChatAction: vi.fn(), setMyCommands: vi.fn() },
      use: vi.fn(),
      on: vi.fn(),
      command: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      isInited: vi.fn().mockReturnValue(true),
    };
  }),
  InlineKeyboard: vi.fn(),
  GrammyError: class GrammyError extends Error {},
}));

import { TelegramChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";

const ANSWER = Array.from({ length: 180 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`).join("\n"); // ~9000 chars

describe("Telegram streaming past the message limit (CHN-22)", () => {
  beforeEach(() => {
    editMessageText.mockReset();
    editMessageText.mockImplementation(async (_chat: number, _msg: number, text: string) => {
      if (text.length > TELEGRAM_LIMIT) throw new Error("Bad Request: MESSAGE_TOO_LONG");
      return true;
    });
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ message_id: 2 });
  });

  it("keeps the preview within the limit", async () => {
    const channel = new TelegramChannel("t", new AuthManager([1]));
    await channel.updateStreamingMessage("42", "1", ANSWER);
    const previews = editMessageText.mock.calls.map((call) => String(call[2]));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });

  it("puts the first chunk in the placeholder and sends only the rest", async () => {
    const channel = new TelegramChannel("t", new AuthManager([1]));
    await channel.finalizeStreamingMessage("42", "1", ANSWER);

    const edited = editMessageText.mock.calls.map((call) => String(call[2]));
    const sent = sendMessage.mock.calls.map((call) => String(call[1]));
    for (const text of [...edited, ...sent]) expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);

    // The placeholder took the opening of the answer...
    expect(edited.at(-1)!.startsWith("Line 0:")).toBe(true);
    // ...and nothing already shown there is sent again.
    expect(sent.some((text) => text.startsWith("Line 0:"))).toBe(false);
    expect([edited.at(-1)!, ...sent].join("\n").replace(/\s+/g, "")).toBe(ANSWER.replace(/\s+/g, ""));
  });
});
