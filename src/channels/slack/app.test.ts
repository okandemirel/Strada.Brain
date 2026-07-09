import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

// ---------------------------------------------------------------------------
// Characterization tests: verify queue behaviour preserved after any refactor.
// These tests use enqueueMessage() rather than direct array manipulation so
// they remain valid after the MessageQueue delegation refactor.
// ---------------------------------------------------------------------------
describe("SlackChannel queue behaviour (characterization)", () => {
  function makeChannel(): SlackChannel {
    return new SlackChannel(
      { botToken: "x", signingSecret: "x", appToken: "x" } as unknown as ConstructorParameters<
        typeof SlackChannel
      >[0],
    );
  }

  type InternalSlack = {
    enqueueMessage: (
      type: string,
      channelId: string,
      data: Record<string, unknown>,
      priority: number,
    ) => Promise<unknown>;
    processMessageQueue: () => Promise<void>;
    processQueuedMessage: (m: unknown) => Promise<void>;
    messageQueue: Array<Record<string, unknown>>;
  };

  it("priority insertion: lower-priority-number items come before higher", () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalSlack;

    // Enqueue high-priority (low number) after low-priority (high number).
    const pLow = internal.enqueueMessage("text", "ch1", { content: "low" }, 10);
    const pHigh = internal.enqueueMessage("text", "ch1", { content: "high" }, 1);
    pLow.catch(() => {});
    pHigh.catch(() => {});

    // The high-priority (priority=1) message should appear first in the queue.
    expect(internal.messageQueue[0]!["priority"]).toBe(1);
    expect(internal.messageQueue[1]!["priority"]).toBe(10);
  });

  it("HOL-skip: backed-off first item is skipped; second item is processed", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalSlack;
    const processed: string[] = [];

    // Stub processQueuedMessage and call msg.resolve() to settle the enqueue promise.
    internal.processQueuedMessage = async (m: unknown) => {
      const msg = m as { channelId?: string; resolve?: (v: unknown) => void };
      if (msg.channelId) processed.push(msg.channelId);
      if (typeof msg.resolve === "function") msg.resolve(undefined);
    };

    // Enqueue two messages via the semi-public method.
    const pFirst = internal.enqueueMessage("text", "backed-off-ch", { content: "a" }, 1);
    const pSecond = internal.enqueueMessage("text", "ready-ch", { content: "b" }, 2);
    pFirst.catch(() => {});
    pSecond.catch(() => {});

    // Back off the first item by setting retryAfter directly on the queue entry.
    // After delegation, messageQueue returns QueueEntry<T>[] and entry.retryAfter
    // is the field checked by MessageQueue.processQueue().
    const arr = internal.messageQueue as Array<Record<string, unknown>>;
    const firstEntry = arr[0]!;
    firstEntry["retryAfter"] = Date.now() + 60_000;

    await internal.processMessageQueue();

    // The backed-off "backed-off-ch" should be skipped; "ready-ch" should run.
    expect(processed).toContain("ready-ch");
    expect(processed).not.toContain("backed-off-ch");
  });

  it("retry with jitter: retryAfter is set beyond now after a transient failure", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalSlack;

    const now = Date.now();

    // Stub processQueuedMessage to always fail.
    internal.processQueuedMessage = async () => {
      throw new Error("transient");
    };

    const p = internal.enqueueMessage("text", "ch1", { content: "x" }, 1);
    p.catch(() => {});

    await internal.processMessageQueue();

    // The item should still be in the queue with retryAfter set.
    expect(internal.messageQueue).toHaveLength(1);
    const entry = internal.messageQueue[0]!;
    // Support both pre-delegation flat layout and post-delegation QueueEntry layout.
    const retryAfter = ("retryAfter" in entry
      ? entry["retryAfter"]
      : (entry["item"] as Record<string, unknown>)?.["retryAfter"]) as number | undefined;
    expect(retryAfter).toBeDefined();
    expect(retryAfter!).toBeGreaterThan(now);
  });
});
