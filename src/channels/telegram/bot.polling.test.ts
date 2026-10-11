/**
 * The channel under grammY's REAL long-polling loop (bot.start), with only the
 * HTTP layer faked by an API transformer. bot.start() handles one update at a
 * time and sends no getUpdates until the middleware returns, so what a handler
 * awaits decides what the bot can still receive. The other Telegram tests mock
 * the Bot and never run that loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, Transformer } from "grammy";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

import { TelegramChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";

const USER = { id: 123, is_bot: false, first_name: "Okan" };

type FakeUpdate = { update_id: number } & Record<string, unknown>;

/**
 * A Bot API server in miniature: getUpdates returns the queued updates at or
 * after `offset` (the offset confirms what came before), and deleteWebhook
 * with drop_pending_updates throws the queue away, as Telegram does.
 */
function fakeTelegram() {
  const queue: FakeUpdate[] = [];
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;

  const push = (update: Record<string, unknown>): void => {
    queue.push({ update_id: nextUpdateId++, ...update });
  };
  const chat = (chatId: number) => ({ id: chatId, type: "private", first_name: "Okan" });

  const transformer: Transformer = async (_prev, method, rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload });
    const ok = (result: unknown) => ({ ok: true as const, result }) as never;
    switch (method) {
      case "getMe":
        return ok({
          id: 1,
          is_bot: true,
          first_name: "Strada",
          username: "strada_test_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case "deleteWebhook":
        if (payload.drop_pending_updates) queue.length = 0;
        return ok(true);
      case "getUpdates": {
        const offset = Number(payload.offset ?? 0);
        const limit = Number(payload.limit ?? 100);
        const ready = queue.filter((u) => u.update_id >= offset).slice(0, limit);
        // Long poll, shortened: an empty answer after a beat, like a timeout.
        if (ready.length === 0) await new Promise((r) => setTimeout(r, 5));
        return ok(ready);
      }
      case "sendMessage":
        return ok({
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: chat(Number(payload.chat_id)),
          text: payload.text,
        });
      default:
        // setMyCommands, sendChatAction, answerCallbackQuery
        return ok(true);
    }
  };

  return {
    transformer,
    calls,
    sendText(chatId: number, text: string): void {
      push({
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: chat(chatId),
          from: USER,
          text,
          ...(text.startsWith("/")
            ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }
            : {}),
        },
      });
    },
    click(chatId: number, data: string): void {
      push({
        callback_query: {
          id: `cb-${nextUpdateId}`,
          from: USER,
          chat_instance: "ci",
          data,
          message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: chat(chatId), text: "Run it?" },
        },
      });
    },
    /** The callback_data of each button on the keyboards sent to `chatId`. */
    buttons(chatId: number): string[] {
      return calls
        .filter((c) => c.method === "sendMessage" && Number(c.payload.chat_id) === chatId)
        .flatMap((c) => {
          const markup = c.payload.reply_markup as
            | { inline_keyboard: Array<Array<{ callback_data: string }>> }
            | undefined;
          return markup ? markup.inline_keyboard.flat().map((b) => b.callback_data) : [];
        });
    },
    /** True once a getUpdates offset has confirmed every queued update: the bot fetched them all. */
    fetchedAll(): boolean {
      return calls.some((c) => c.method === "getUpdates" && Number(c.payload.offset ?? 0) >= nextUpdateId);
    },
    answeredCallbacks(): string[] {
      return calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.payload.text));
    },
  };
}

function channelOn(server: ReturnType<typeof fakeTelegram>): TelegramChannel {
  const channel = new TelegramChannel("123:fake-token", new AuthManager([USER.id]));
  (channel as unknown as { bot: Bot }).bot.api.config.use(server.transformer);
  return channel;
}

describe("TelegramChannel under grammY's real polling loop", () => {
  const open: TelegramChannel[] = [];
  afterEach(async () => {
    // Settles any prompt still pending as "timeout", so no handler outlives the test.
    await Promise.all(open.splice(0).map((c) => c.disconnect()));
  });

  it("a handler that awaits a confirmation receives the click: /run is approved, not 'Command cancelled' after 2 minutes", async () => {
    const server = fakeTelegram();
    const channel = channelOn(server);
    open.push(channel);
    const answers: string[] = [];
    // The production chain: message-router -> command-handler handleRun ->
    // requestWriteConfirmation -> channel.requestConfirmation, all awaited.
    channel.onMessage(async (msg) => {
      answers.push(
        await channel.requestConfirmation({
          chatId: msg.chatId,
          userId: msg.userId,
          question: `Run \`${msg.text.slice(5)}\`?`,
          options: ["Yes", "No"],
        }),
      );
    });

    await channel.connect();
    server.sendText(42, "/run dotnet build");
    await vi.waitFor(() => expect(server.buttons(42)).toHaveLength(2), { timeout: 2_000 });

    server.click(42, server.buttons(42)[0]!);
    await vi.waitFor(() => expect(answers).toEqual(["Yes"]), { timeout: 2_000 });
    expect(server.answeredCallbacks()).toEqual(["Selected: Yes"]);
  });

  it("a confirmation pending in one chat does not stall every other chat", async () => {
    const server = fakeTelegram();
    const channel = channelOn(server);
    open.push(channel);
    const routed: string[] = [];
    channel.onMessage(async (msg) => {
      routed.push(`${msg.chatId}:${msg.text}`);
      if (msg.text.startsWith("/run")) {
        await channel.requestConfirmation({ chatId: msg.chatId, userId: msg.userId, question: "Run?", options: ["Yes", "No"] });
      }
    });

    await channel.connect();
    server.sendText(42, "/run dotnet build");
    await vi.waitFor(() => expect(server.buttons(42)).toHaveLength(2), { timeout: 2_000 });

    server.sendText(43, "kampanya devam");
    await vi.waitFor(() => expect(routed).toContain("43:kampanya devam"), { timeout: 2_000 });
  });

  it("keeps one chat's messages in the order they were sent while its prompt waits", async () => {
    const server = fakeTelegram();
    const channel = channelOn(server);
    open.push(channel);
    const routed: string[] = [];
    channel.onMessage(async (msg) => {
      routed.push(msg.text);
      if (msg.text.startsWith("/run")) {
        await channel.requestConfirmation({ chatId: msg.chatId, userId: msg.userId, question: "Run?", options: ["Yes", "No"] });
        routed.push("approved");
      }
    });

    await channel.connect();
    server.sendText(42, "/run dotnet build");
    await vi.waitFor(() => expect(server.buttons(42)).toHaveLength(2), { timeout: 2_000 });
    server.sendText(42, "and then the tests");
    // The second message is fetched, but waits for the first to finish routing.
    await vi.waitFor(() => expect(server.fetchedAll()).toBe(true), { timeout: 2_000 });
    expect(routed).toEqual(["/run dotnet build"]);

    server.click(42, server.buttons(42)[0]!);
    await vi.waitFor(() => expect(routed).toEqual(["/run dotnet build", "approved", "and then the tests"]), {
      timeout: 2_000,
    });
  });

  it("a message sent while the daemon was down is delivered on connect, not deleted", async () => {
    const server = fakeTelegram();
    const channel = channelOn(server);
    open.push(channel);
    const routed: string[] = [];
    channel.onMessage(async (msg) => {
      routed.push(msg.text);
    });

    server.sendText(42, "kampanya devam");
    await channel.connect();

    await vi.waitFor(() => expect(routed).toEqual(["kampanya devam"]), { timeout: 2_000 });
    const deleteWebhook = server.calls.find((c) => c.method === "deleteWebhook");
    expect(deleteWebhook?.payload.drop_pending_updates).not.toBe(true);
  });

  it("answers a click on a prompt that is no longer pending instead of leaving it spinning", async () => {
    const server = fakeTelegram();
    const channel = channelOn(server);
    open.push(channel);
    channel.onMessage(async () => {});
    await channel.connect();

    // A prompt from before a restart, or one that already timed out.
    server.click(42, "confirm_0123456789ab:0");
    await vi.waitFor(() => expect(server.answeredCallbacks()).toHaveLength(1), { timeout: 2_000 });
    expect(server.answeredCallbacks()[0]).toMatch(/no longer/i);
  });
});
