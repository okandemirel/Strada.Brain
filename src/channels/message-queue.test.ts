import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageQueue } from "./message-queue.js";

function makeOpts<T>(
  overrides: Partial<Parameters<typeof MessageQueue<T>>[0]> = {},
): Parameters<typeof MessageQueue<T>>[0] {
  return {
    maxRetries: 3,
    baseDelayMs: 100,
    batchSize: 5,
    ordering: "fifo",
    rateLimitBackoffMs: 500,
    processItem: vi.fn().mockResolvedValue(undefined),
    isRateLimitError: () => false,
    extractRetryAfter: () => null,
    ...overrides,
  };
}

describe("MessageQueue – FIFO ordering", () => {
  it("processes items in enqueue order", async () => {
    const order: string[] = [];
    const q = new MessageQueue<string>(
      makeOpts<string>({
        processItem: async (item) => {
          order.push(item);
        },
      }),
    );

    void q.enqueue("A");
    void q.enqueue("B");
    void q.enqueue("C");

    await q.processQueue();

    expect(order).toEqual(["A", "B", "C"]);
  });
});

describe("MessageQueue – queue mutation during an in-flight send", () => {
  it("removes the entry it actually sent, not whatever is at the head", async () => {
    // The FIFO branch reads entries[0], awaits the send, then removes. A retry
    // timer legitimately unshifts its entry back to the HEAD during that await
    // (it must, to preserve in-order delivery). A positional shift() then
    // removed the WRONG entry: the re-queued message vanished — never sent,
    // never resolved or rejected, so its caller hung forever — and the message
    // that had just been sent stayed queued and went out a second time.
    const sent: string[] = [];
    const q = new MessageQueue<string>(
      makeOpts<string>({
        processItem: async (item) => {
          sent.push(item);
          if (item === "B") {
            // Simulate the retry timer firing mid-await.
            q.entries.unshift({
              id: "requeued-A",
              item: "A-retry",
              priority: 0,
              retries: 1,
              enqueuedAt: Date.now(),
              resolve: () => {},
              reject: () => {},
            });
          }
        },
      }),
    );

    void q.enqueue("B");
    await q.processQueue();

    // The re-queued entry must survive — it was never sent.
    expect(q.entries.map((e) => e.id)).toContain("requeued-A");
    // ...and B must not still be queued for a second delivery.
    expect(q.entries.some((e) => e.item === "B")).toBe(false);
    expect(sent.filter((s) => s === "B")).toHaveLength(1);
  });

  it("removes the correct entry when the send fails and exhausts retries", async () => {
    const q = new MessageQueue<string>(
      makeOpts<string>({
        maxRetries: 1,
        processItem: async (item) => {
          if (item === "B") {
            q.entries.unshift({
              id: "requeued-A",
              item: "A-retry",
              priority: 0,
              retries: 1,
              enqueuedAt: Date.now(),
              resolve: () => {},
              reject: () => {},
            });
            throw new Error("send failed");
          }
        },
      }),
    );

    void q.enqueue("B").catch(() => undefined);
    await q.processQueue();

    expect(q.entries.map((e) => e.id)).toContain("requeued-A");
    expect(q.entries.some((e) => e.item === "B")).toBe(false);
  });
});

describe("MessageQueue – priority ordering", () => {
  it("sorts lower-priority-number items before higher", async () => {
    const order: number[] = [];
    const q = new MessageQueue<string>(
      makeOpts<string>({
        ordering: "priority",
        skipBackedOff: true,
        processItem: async (item) => {
          order.push(Number(item));
        },
      }),
    );

    // Enqueue in reverse priority order
    void q.enqueue("10", 10);
    void q.enqueue("1", 1);
    void q.enqueue("5", 5);

    await q.processQueue();

    // Lower number = higher priority = processed first
    expect(order).toEqual([1, 5, 10]);
  });
});

describe("MessageQueue – timeout eviction (FIFO/Discord mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects items whose enqueuedAt exceeds timeoutMs", async () => {
    const q = new MessageQueue<string>(
      makeOpts<string>({
        timeoutMs: 30_000,
        processItem: async () => { /* no-op */ },
      }),
    );

    // Enqueue and then wind time forward beyond the timeout
    const p = q.enqueue("stale");
    // Manually set enqueuedAt to the past
    const entry = q.entries[0]!;
    entry.enqueuedAt = Date.now() - 31_000;

    await q.processQueue();

    await expect(p).rejects.toThrow("timed out");
    expect(q.size).toBe(0);
  });

  it("keeps items whose enqueuedAt is within timeoutMs", async () => {
    const processed: string[] = [];
    const q = new MessageQueue<string>(
      makeOpts<string>({
        timeoutMs: 30_000,
        processItem: async (item) => {
          processed.push(item);
        },
      }),
    );

    void q.enqueue("fresh");

    await q.processQueue();

    expect(processed).toEqual(["fresh"]);
  });
});

describe("MessageQueue – retry backoff (FIFO mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments retries and re-enqueues via timer on transient failure", async () => {
    let callCount = 0;
    const q = new MessageQueue<string>(
      makeOpts<string>({
        baseDelayMs: 1000,
        processItem: async () => {
          callCount++;
          throw new Error("transient");
        },
      }),
    );

    void q.enqueue("item");
    await q.processQueue();

    // After first failure retries=1 and a timer is set; item is NOT in queue yet.
    expect(callCount).toBe(1);
    expect(q.timerMap.size).toBe(1);
    expect(q.size).toBe(0); // removed from queue pending re-push

    // Advance time so the retry timer fires and re-pushes the item.
    await vi.runAllTimersAsync();
    expect(q.size).toBe(1);
    const entry = q.entries[0]!;
    expect(entry.retries).toBe(1);
  });

  it("re-inserts a transiently-failed entry at the HEAD to preserve FIFO order", async () => {
    // "A" fails transiently on its first attempt; while it is backing off, "B"
    // is enqueued. When the retry timer fires, "A" must be re-inserted ahead of
    // "B" (FIFO), not pushed to the tail.
    let failA = true;
    const q = new MessageQueue<string>(
      makeOpts<string>({
        baseDelayMs: 1000,
        processItem: async (item) => {
          if (item === "A" && failA) {
            failA = false;
            throw new Error("transient");
          }
        },
      }),
    );

    const pA = q.enqueue("A");
    pA.catch(() => {});
    await q.processQueue(); // "A" fails, removed from queue pending re-push
    expect(q.size).toBe(0);
    expect(q.timerMap.size).toBe(1);

    // A later message arrives during "A"'s backoff window.
    void q.enqueue("B");
    expect(q.entries.map((e) => e.item)).toEqual(["B"]);

    // Retry timer fires — "A" must land at the front, ahead of "B".
    await vi.runAllTimersAsync();
    expect(q.entries.map((e) => e.item)).toEqual(["A", "B"]);
  });

  it("rejects the item after maxRetries exceeded", async () => {
    const q = new MessageQueue<string>(
      makeOpts<string>({
        maxRetries: 2,
        processItem: async () => {
          throw new Error("permanent");
        },
      }),
    );

    const p = q.enqueue("item");

    // Manually set retries to max so next failure rejects immediately.
    q.entries[0]!.retries = 2;

    await q.processQueue();

    await expect(p).rejects.toThrow("permanent");
    expect(q.size).toBe(0);
  });
});

describe("MessageQueue – HOL-skip (Slack/priority mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips backed-off items and processes the next ready item", async () => {
    const processed: string[] = [];
    const q = new MessageQueue<string>(
      makeOpts<string>({
        ordering: "priority",
        skipBackedOff: true,
        processItem: async (item) => {
          processed.push(item);
        },
      }),
    );

    void q.enqueue("A", 1);
    void q.enqueue("B", 2);

    // Back off "A" so it is not ready
    q.entries[0]!.retryAfter = Date.now() + 60_000;

    await q.processQueue();

    // "B" should be processed; "A" was skipped
    expect(processed).toEqual(["B"]);
  });
});

describe("MessageQueue – retry with jitter (Slack mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets retryAfter > now on transient failure with jitter", async () => {
    const now = Date.now();
    const q = new MessageQueue<string>(
      makeOpts<string>({
        ordering: "priority",
        skipBackedOff: true,
        jitter: true,
        baseDelayMs: 1000,
        processItem: async () => {
          throw new Error("transient");
        },
      }),
    );

    void q.enqueue("item", 1);
    await q.processQueue();

    // Item stays in queue (retryAfter set, not removed)
    expect(q.size).toBe(1);
    const entry = q.entries[0]!;
    expect(entry.retryAfter).toBeGreaterThan(now);
    expect(entry.retries).toBe(1);
  });
});

describe("MessageQueue – rejectAll", () => {
  it("drains the queue and rejects all entries", async () => {
    const q = new MessageQueue<string>(makeOpts<string>());

    const pA = q.enqueue("A");
    const pB = q.enqueue("B");

    q.rejectAll("Channel disconnected");

    await expect(pA).rejects.toThrow("Channel disconnected");
    await expect(pB).rejects.toThrow("Channel disconnected");
    expect(q.size).toBe(0);
  });
});

describe("MessageQueue – rejectRetryTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears timers and rejects their entries", async () => {
    const q = new MessageQueue<string>(
      makeOpts<string>({
        processItem: async () => {
          throw new Error("err");
        },
      }),
    );

    const p = q.enqueue("item");
    await q.processQueue(); // retries=1, timer set

    expect(q.timerMap.size).toBe(1);

    q.rejectRetryTimers("Shutdown");

    await expect(p).rejects.toThrow("Shutdown");
    expect(q.timerMap.size).toBe(0);
  });

  it("does not fire the rejected timer", async () => {
    const q = new MessageQueue<string>(
      makeOpts<string>({
        processItem: async () => {
          throw new Error("err");
        },
      }),
    );

    const p = q.enqueue("item");
    // Suppress unhandled rejection from the enqueue promise.
    p.catch(() => {});
    await q.processQueue();

    q.rejectRetryTimers("Shutdown");
    await expect(p).rejects.toThrow("Shutdown");

    // Advance time; the cleared timer should not push back onto the queue.
    await vi.runAllTimersAsync();
    expect(q.size).toBe(0);
  });
});

describe("MessageQueue – rate limit handling", () => {
  it("stops processing and sets rateLimited when isRateLimitError returns true", async () => {
    let callCount = 0;
    const q = new MessageQueue<string>(
      makeOpts<string>({
        isRateLimitError: () => true,
        extractRetryAfter: () => 5000,
        processItem: async () => {
          callCount++;
          throw new Error("rate limit");
        },
      }),
    );

    const pA = q.enqueue("A");
    const pB = q.enqueue("B");
    pA.catch(() => {});
    pB.catch(() => {});

    await q.processQueue();

    // Only first item attempted; processing stopped due to rate limit.
    expect(callCount).toBe(1);
  });
});

describe("MessageQueue – disconnect-reject via isConnected", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the retry entry when isConnected returns false at timer fire", async () => {
    let connected = true;
    const q = new MessageQueue<string>(
      makeOpts<string>({
        isConnected: () => connected,
        processItem: async () => {
          throw new Error("transient");
        },
      }),
    );

    const p = q.enqueue("item");
    // Attach early to suppress unhandled-rejection warnings — the rejection
    // happens asynchronously when the retry timer fires.
    const caught = p.catch((e: unknown) => e);
    await q.processQueue(); // sets retry timer

    connected = false;
    await vi.runAllTimersAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Discord channel disconnected");
  });
});
