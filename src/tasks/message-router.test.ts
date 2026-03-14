import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageRouter } from "./message-router.js";
import { CommandHandler } from "./command-handler.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import { createLogger } from "../utils/logger.js";

function createMessage(text: string): IncomingMessage {
  return {
    channelType: "cli",
    chatId: "chat-1",
    userId: "user-1",
    text,
    timestamp: new Date(),
  };
}

describe("MessageRouter", () => {
  const submit = vi.fn();
  const handle = vi.fn();
  const sendMarkdown = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    createLogger("error", "/tmp/strada-message-router-test.log");
    submit.mockReset();
    handle.mockReset();
    sendMarkdown.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
  });

  it("sends startup notices once before the first task", async () => {
    const router = new MessageRouter(
      { submit } as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown } as never,
      [
        "RAG disabled: no compatible embedding provider found.",
        "Daemon disabled: budget is missing.",
      ],
    );

    await router.route(createMessage("analyze the project"));
    await router.route(createMessage("list systems"));

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*System Status*"),
    );
    expect(submit).toHaveBeenCalledTimes(2);
    expect(handle).not.toHaveBeenCalled();
  });

  it("still routes commands after sending startup notices", async () => {
    const router = new MessageRouter(
      { submit } as never,
      { handle } as unknown as CommandHandler,
      { sendMarkdown } as never,
      ["Instinct embeddings disabled."],
    );

    await router.route(createMessage("/help"));

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("chat-1", "help", []);
    expect(submit).not.toHaveBeenCalled();
  });
});
