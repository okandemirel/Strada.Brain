import { describe, it, expect } from "vitest";
import { HnswWriteMutex } from "./hnsw-write-mutex.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HnswWriteMutex", () => {
  it("serializes two concurrent withLock() calls (second waits for first)", async () => {
    const mutex = new HnswWriteMutex();
    const order: number[] = [];

    const p1 = mutex.withLock(async () => {
      order.push(1);
      await delay(50);
      order.push(2);
    });

    const p2 = mutex.withLock(async () => {
      order.push(3);
      await delay(10);
      order.push(4);
    });

    await Promise.all([p1, p2]);

    // First operation completes entirely before second starts
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("executes three queued operations in FIFO order", async () => {
    const mutex = new HnswWriteMutex();
    const order: string[] = [];

    const p1 = mutex.withLock(async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    });

    const p2 = mutex.withLock(async () => {
      order.push("b-start");
      await delay(20);
      order.push("b-end");
    });

    const p3 = mutex.withLock(async () => {
      order.push("c-start");
      await delay(10);
      order.push("c-end");
    });

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([
      "a-start",
      "a-end",
      "b-start",
      "b-end",
      "c-start",
      "c-end",
    ]);
  });

  it("propagates errors from the locked operation and continues the queue", async () => {
    const mutex = new HnswWriteMutex();
    const order: string[] = [];

    const p1 = mutex.withLock(async () => {
      order.push("throwing");
      throw new Error("boom");
    });

    const p2 = mutex.withLock(async () => {
      order.push("after-throw");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    const result = await p2;

    expect(result).toBe("ok");
    expect(order).toEqual(["throwing", "after-throw"]);
  });

  it("returns the value from the callback", async () => {
    const mutex = new HnswWriteMutex();

    const result = await mutex.withLock(async () => {
      await delay(5);
      return 42;
    });

    expect(result).toBe(42);
  });

  it("does not block operations outside withLock while a write lock is held", async () => {
    const mutex = new HnswWriteMutex();
    const order: string[] = [];

    // Start a long-running lock
    const lockPromise = mutex.withLock(async () => {
      order.push("lock-start");
      await delay(80);
      order.push("lock-end");
    });

    // Simulate a "read" that runs outside the mutex — should not wait
    await delay(10);
    order.push("read-during-lock");

    await lockPromise;

    // The read should have happened during the lock, not after
    expect(order).toEqual(["lock-start", "read-during-lock", "lock-end"]);
  });
});
