/**
 * CHN-17: stdin EOF shuts down through the process's graceful SIGINT handler,
 * not with process.kill (an unconditional termination on Windows).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const rlHandlers = vi.hoisted(() => new Map<string, (input?: string) => void>());

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    close: vi.fn(),
    on: vi.fn((event: string, handler: (input?: string) => void) => rlHandlers.set(event, handler)),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
  })),
}));

import { CLIChannel } from "./repl.js";

describe("CLI EOF shutdown (CHN-17)", () => {
  const listener = vi.fn();

  afterEach(() => {
    process.removeListener("SIGINT", listener);
    vi.restoreAllMocks();
  });

  it("invokes the registered SIGINT handler instead of killing the process", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.on("SIGINT", listener);

    const channel = new CLIChannel();
    await channel.connect();
    rlHandlers.get("close")?.();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(channel.isHealthy()).toBe(false);
  });
});
