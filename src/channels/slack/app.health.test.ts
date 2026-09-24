/**
 * CHN-10: one failed Slack health probe must not mark the channel unhealthy
 * for the life of the process — the next successful probe restores it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authTest = vi.hoisted(() => vi.fn());

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

vi.mock("./commands.js", () => ({ registerSlashCommands: vi.fn() }));

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      message: vi.fn(),
      action: vi.fn(),
      event: vi.fn(),
      error: vi.fn(),
      command: vi.fn(),
      client: {
        auth: { test: authTest },
        chat: { postMessage: vi.fn().mockResolvedValue({ ts: "1.1" }) },
      },
    };
  }),
  directMention: vi.fn(),
}));

import { SlackChannel } from "./app.js";

describe("SlackChannel health check (CHN-10)", () => {
  let channel: SlackChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    authTest.mockReset();
    authTest.mockResolvedValue({ user_id: "U1" });
    channel = new SlackChannel({ botToken: "xoxb-t", signingSecret: "s", appToken: "xapp-t", socketMode: true });
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.useRealTimers();
  });

  it("recovers on the next successful probe after a failed one", async () => {
    await channel.connect();
    expect(channel.isHealthy()).toBe(true);

    authTest.mockRejectedValueOnce(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.isHealthy()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.isHealthy()).toBe(true);
  });

  it("stays unhealthy after disconnect even if a probe succeeds", async () => {
    await channel.connect();
    await channel.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.isHealthy()).toBe(false);
  });
});
