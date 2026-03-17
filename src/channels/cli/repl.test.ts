import { describe, it, expect, vi, beforeEach } from "vitest";
import { CLIChannel } from "./repl.js";
import { MAX_INCOMING_TEXT_LENGTH } from "../channel-messages.interface.js";

// vi.mock factory must not reference variables defined outside it
vi.mock("node:readline", () => {
  return {
    createInterface: vi.fn().mockReturnValue({
      question: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    }),
  };
});

import * as readline from "node:readline";

function getMockRl() {
  return vi.mocked(readline.createInterface).mock.results[0]?.value as {
    question: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } | undefined;
}

describe("CLIChannel", () => {
  let channel: CLIChannel;

  beforeEach(() => {
    // Reset the mock so createInterface returns a fresh mock
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as any);
    channel = new CLIChannel();
  });

  it("has correct name", () => {
    expect(channel.name).toBe("cli");
  });

  it("is not healthy before connect", () => {
    expect(channel.isHealthy()).toBe(false);
  });

  it("becomes healthy after connect", async () => {
    await channel.connect();
    expect(channel.isHealthy()).toBe(true);
  });

  it("becomes unhealthy after disconnect", async () => {
    await channel.connect();
    await channel.disconnect();
    expect(channel.isHealthy()).toBe(false);
  });

  it("stores message handler", () => {
    const handler = vi.fn();
    channel.onMessage(handler);
  });

  it("sendText outputs to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await channel.sendText("cli", "Hello");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Hello"));
    spy.mockRestore();
  });

  it("sendMarkdown outputs to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await channel.sendMarkdown("cli", "**bold**");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("**bold**"));
    spy.mockRestore();
  });

  it("sendTypingIndicator is no-op", async () => {
    await channel.sendTypingIndicator("cli");
  });

  it("requestConfirmation returns first option when rl is null", async () => {
    const result = await channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    expect(result).toBe("Yes");
  });

  it("requestConfirmation returns selected option", async () => {
    await channel.connect();
    const rl = getMockRl()!;

    // The first question() call is the "you> " prompt from connect()
    // We need the requestConfirmation call, which is the second question() call
    rl.question.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb("2"); // Select option 2
    });

    const result = await channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    expect(result).toBe("No");
  });

  it("requestConfirmation defaults to first option for invalid input", async () => {
    await channel.connect();
    const rl = getMockRl()!;

    rl.question.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb("invalid");
    });

    const result = await channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    expect(result).toBe("Yes");
  });

  it("routes user input to handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;

    // The first question call is the "you> " prompt
    const promptCallback = rl.question.mock.calls[0]![1] as (input: string) => Promise<void>;
    await promptCallback("hello world");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "cli",
        chatId: "cli-local",
        userId: "cli-user",
        text: "hello world",
      })
    );
  });

  it("truncates oversized user input before handing it to the agent", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;

    const promptCallback = rl.question.mock.calls[0]![1] as (input: string) => Promise<void>;
    await promptCallback("a".repeat(MAX_INCOMING_TEXT_LENGTH + 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "a".repeat(MAX_INCOMING_TEXT_LENGTH),
      })
    );
  });

  it("handles exit command", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await channel.connect();
    const rl = getMockRl()!;

    const promptCallback = rl.question.mock.calls[0]![1] as (input: string) => Promise<void>;
    await promptCallback("exit");

    expect(channel.isHealthy()).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    killSpy.mockRestore();
  });

  it("skips empty input", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;

    const promptCallback = rl.question.mock.calls[0]![1] as (input: string) => Promise<void>;
    await promptCallback("");

    expect(handler).not.toHaveBeenCalled();
  });
});
