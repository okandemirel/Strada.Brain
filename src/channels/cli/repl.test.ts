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

  it("requestConfirmation returns 'timeout' (never auto-approves) when rl is null", async () => {
    // When readline is unavailable (e.g. after EOF/shutdown) the channel must
    // NOT return the first option ("Yes"), which the write-gate would treat as
    // approval and silently auto-confirm destructive writes/pushes.
    const result = await channel.requestConfirmation({
      chatId: "cli",
      question: "Confirm?",
      options: ["Yes", "No"],
    });
    expect(result).toBe("timeout");
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

  it("requestConfirmation passes free-form text through verbatim", async () => {
    // ask_user tells the user they can "write your own answer", so a non-numeric
    // answer must be returned as-is rather than coerced to the first option.
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
      question: "Which database?",
      options: ["sqlite", "mysql"],
    });
    handlers.get("line")?.("use postgres");
    const result = await resultPromise;
    expect(result).toBe("use postgres");
  });

  it("requestConfirmation falls back to 'timeout' for empty confirmation input", async () => {
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
    handlers.get("line")?.("   ");
    const result = await resultPromise;
    expect(result).toBe("timeout");
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

  it("stdin EOF with nothing in flight shuts down immediately", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input?: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input?: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    await channel.connect();

    handlers.get("close")?.();

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(channel.isHealthy()).toBe(false);
    killSpy.mockRestore();
  });

  it("stdin EOF defers shutdown until the in-flight message is answered (audited 2026-09-02)", async () => {
    // `printf 'build it\n' | strada cli`: readline emits 'line' then 'close'
    // while the handler is still running. The old close handler SIGINTed at
    // once, killing the run mid-task with exit 0 and no answer.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let releaseFirst: (() => void) | undefined;
    const handler = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input?: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input?: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    handlers.get("line")?.("build it");
    expect(handler).toHaveBeenCalledTimes(1);

    handlers.get("close")?.();

    // In flight: no SIGINT yet.
    expect(killSpy).not.toHaveBeenCalled();

    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Drained: now the deferred shutdown fires.
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(channel.isHealthy()).toBe(false);
    killSpy.mockRestore();
  });

  it("stdin EOF drains every queued line before shutting down (audited 2026-09-02)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let releaseFirst: (() => void) | undefined;
    const handler = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.connect();
    const rl = getMockRl()!;
    const handlers = new Map<string, (input?: string) => void>();
    rl.on.mockImplementation((event: string, handler: (input?: string) => void) => {
      handlers.set(event, handler);
      return rl as never;
    });
    await channel.disconnect();
    channel.onMessage(handler);
    await channel.connect();

    handlers.get("line")?.("add the inventory system");
    handlers.get("line")?.("add the crafting system");
    handlers.get("close")?.();
    expect(killSpy).not.toHaveBeenCalled();

    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ text: "add the crafting system" }),
    );
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    killSpy.mockRestore();
  });

  it("does not route queued input after disconnect", async () => {
    let releaseFirst: (() => void) | undefined;
    const handler = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValue(undefined);

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

    // First input starts processing (handler pending); second input queues.
    handlers.get("line")?.("first");
    handlers.get("line")?.("second");
    expect(handler).toHaveBeenCalledTimes(1);

    // Shut down while the second input is still queued, then let the first
    // handler resolve. The queued "second" input must NOT be routed.
    await channel.disconnect();
    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
