import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageRouter } from "./message-router.js";
import { CommandHandler } from "./command-handler.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import { createLogger } from "../utils/logger.js";

const TEST_ROUTER_OPTIONS = {
  burstWindowMs: 25,
  maxBurstMessages: 8,
} as const;

function createMessage(text: string): IncomingMessage {
  return {
    channelType: "cli",
    chatId: "chat-1",
    userId: "user-1",
    text,
    timestamp: new Date(),
  };
}

function createTaskManager(
  submitMock: ReturnType<typeof vi.fn>,
  overrides: Partial<{
    submit: ReturnType<typeof vi.fn>;
    listActiveTasks: () => Array<{
      chatId: string;
      channelType: string;
      conversationId?: string;
    }>;
  }> = {},
) {
  return {
    submit: submitMock,
    listActiveTasks: () => [],
    ...overrides,
  };
}

describe("MessageRouter", () => {
  const submit = vi.fn();
  const handle = vi.fn();
  const sendMarkdown = vi.fn().mockResolvedValue(undefined);
  const sendText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    createLogger("error", "/tmp/strada-message-router-test.log");
    submit.mockReset();
    handle.mockReset();
    sendMarkdown.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockReset();
    sendText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends startup notices once before the first task", async () => {
    const router = new MessageRouter(
      createTaskManager(submit) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [
        "RAG disabled: no compatible embedding provider found.",
        "Daemon disabled: budget is missing.",
      ],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("analyze the project"));
    await router.route(createMessage("list systems"));
    await vi.advanceTimersByTimeAsync(TEST_ROUTER_OPTIONS.burstWindowMs);

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*System Status*"),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      "chat-1",
      "cli",
      expect.stringContaining("[User message 1]"),
      expect.any(Object),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("still routes commands after sending startup notices", async () => {
    const router = new MessageRouter(
      createTaskManager(submit) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      ["Instinct embeddings disabled."],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("/help"));

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("chat-1", "help", [], "user-1");
    expect(submit).not.toHaveBeenCalled();
  });

  it("flushes a pending batch before handling a command", async () => {
    const router = new MessageRouter(
      createTaskManager(submit) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("first"));
    await router.route(createMessage("/status"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("chat-1", "cli", "first", {
      attachments: undefined,
      conversationId: undefined,
      userId: "user-1",
    });
    expect(handle).toHaveBeenCalledWith("chat-1", "status", [], "user-1");
  });

  it("keeps different channel conversations isolated even when chat IDs match", async () => {
    const router = new MessageRouter(
      createTaskManager(submit) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("cli message"));
    await router.route({
      ...createMessage("web message"),
      channelType: "web",
    });
    await vi.advanceTimersByTimeAsync(TEST_ROUTER_OPTIONS.burstWindowMs);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, "chat-1", "cli", "cli message", {
      attachments: undefined,
      conversationId: undefined,
      userId: "user-1",
    });
    expect(submit).toHaveBeenNthCalledWith(2, "chat-1", "web", "web message", {
      attachments: undefined,
      conversationId: undefined,
      userId: "user-1",
    });
  });

  it("acknowledges consecutive messages as one request", async () => {
    const router = new MessageRouter(
      createTaskManager(submit) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("ilk mesaj"));
    await router.route(createMessage("ikinci mesaj"));
    await vi.advanceTimersByTimeAsync(TEST_ROUTER_OPTIONS.burstWindowMs);

    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      "Arka arkaya gelen 2 mesajını tek bir istek olarak birleştiriyorum.",
    );
  });

  it("acknowledges when a new message is queued behind an active task", async () => {
    const router = new MessageRouter(
      createTaskManager(submit, {
        listActiveTasks: () => [{
          chatId: "chat-1",
          channelType: "cli",
          conversationId: undefined,
        }],
      }) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("follow-up"));
    await vi.advanceTimersByTimeAsync(TEST_ROUTER_OPTIONS.burstWindowMs);

    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      "I queued your latest message and will pick it up as soon as the current task finishes.",
    );
  });

  it("batches consecutive follow-ups into one queued task while a task is active", async () => {
    const router = new MessageRouter(
      createTaskManager(submit, {
        listActiveTasks: () => [{
          chatId: "chat-1",
          channelType: "cli",
          conversationId: undefined,
        }],
      }) as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown, sendText } as never,
      [],
      TEST_ROUTER_OPTIONS,
    );

    await router.route(createMessage("ilk düzeltme"));
    await router.route(createMessage("bir de şu hataya bak"));
    await vi.advanceTimersByTimeAsync(TEST_ROUTER_OPTIONS.burstWindowMs);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      "chat-1",
      "cli",
      expect.stringContaining("[User message 2]\nbir de şu hataya bak"),
      expect.objectContaining({
        userId: "user-1",
      }),
    );
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      "Son 2 mesajını birlikte kuyruğa aldım. Mevcut işi bitirir bitirmez bunları sırayla işleyeceğim.",
    );
  });
});
