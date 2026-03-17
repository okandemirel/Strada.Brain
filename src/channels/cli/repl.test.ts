import { describe, it, expect, vi, beforeEach } from "vitest";
import { CLIChannel } from "./repl.js";
import { MAX_INCOMING_TEXT_LENGTH } from "../channel-messages.interface.js";

// vi.mock factory must not reference variables defined outside it
vi.mock("node:readline", () => {
  return {
    createInterface: vi.fn().mockReturnValue({
      close: vi.fn(),
      on: vi.fn(),
      prompt: vi.fn(),
      setPrompt: vi.fn(),
    }),
  };
});

import * as readline from "node:readline";

function getMockRl() {
  return vi.mocked(readline.createInterface).mock.results[0]?.value as {
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    setPrompt: ReturnType<typeof vi.fn>;
  } | undefined;
}

describe("CLIChannel", () => {
  let channel: CLIChannel;

  beforeEach(() => {
    // Reset the mock so createInterface returns a fresh mock
    vi.mocked(readline.createInterface).mockReturnValue({
      close: vi.fn(),
      on: vi.fn(),
      prompt: vi.fn(),
      setPrompt: vi.fn(),
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
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    await channel.connect();

    const resultPromise = channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    handlers.get("line")?.("2");
    const result = await resultPromise;
    expect(result).toBe("No");
  });

  it("requestConfirmation defaults to first option for invalid input", async () => {
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    await channel.connect();

    const resultPromise = channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    handlers.get("line")?.("invalid");
    const result = await resultPromise;
    expect(result).toBe("Yes");
  });

  it("routes user input to handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    await handlers.get("line")?.("hello world");

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
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    await handlers.get("line")?.("a".repeat(MAX_INCOMING_TEXT_LENGTH + 50));

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
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    await channel.connect();

    await handlers.get("line")?.("exit");

    expect(channel.isHealthy()).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    killSpy.mockRestore();
  });

  it("skips empty input", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    await handlers.get("line")?.("");

    expect(handler).not.toHaveBeenCalled();
  });

  it("queues consecutive user inputs while a previous message is still processing", async () => {
    let releaseFirst: (() => void) | undefined;
    const handler = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    handlers.get("line")?.("first");
    handlers.get("line")?.("second");

    expect(handler).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ text: "second" }),
    );
  });
});
