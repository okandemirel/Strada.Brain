import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { SlackChannel } from "./app.js";

describe("SlackChannel disconnect", () => {
  it("rejects still-queued messages so awaiting callers don't hang", async () => {
    const channel = new SlackChannel(
      { botToken: "x", signingSecret: "x", appToken: "x" } as unknown as ConstructorParameters<
        typeof SlackChannel
      >[0],
    );
    const internal = channel as unknown as {
      messageQueue: Array<{ reject: (e: Error) => void }>;
    };
    const rejectA = vi.fn();
    const rejectB = vi.fn();
    internal.messageQueue.push({ reject: rejectA }, { reject: rejectB });

    await channel.disconnect();

    expect(rejectA).toHaveBeenCalledWith(expect.any(Error));
    expect(rejectB).toHaveBeenCalledWith(expect.any(Error));
    expect(internal.messageQueue).toHaveLength(0);
  });
});
