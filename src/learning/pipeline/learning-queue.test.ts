/**
 * LearningQueue Tests -- Serial async processor with bounded FIFO eviction
 *
 * Tests: serial execution, FIFO ordering, bounded capacity, graceful shutdown,
 * error isolation, and idle behavior.
 */

import { describe, it, expect, afterEach } from "vitest";
import { LearningQueue } from "./learning-queue.js";

/** Helper: create a function that resolves after delayMs and records its id */
function delayed(id: string, order: string[], delayMs: number): () => Promise<void> {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    order.push(id);
  };
}

/**
 * Helper: enqueue a sentinel as the last item that resolves a promise.
 * Call `await done` to wait for all items before the sentinel to complete.
 */
function withDrainSignal(
  queue: LearningQueue,
): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.enqueue(async () => {
      resolve();
    });
  });
}

describe("LearningQueue", () => {
  let queue: LearningQueue;

  afterEach(async () => {
    if (queue) await queue.shutdown();
  });

  it("enqueued functions execute serially (second waits for first to complete)", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      order.push("start-1");
      await new Promise((r) => setTimeout(r, 30));
      order.push("end-1");
    });
    queue.enqueue(async () => {
      order.push("start-2");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end-2");
    });

    const done = withDrainSignal(queue);
    await done;

    // Second task should NOT start before first ends
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("multiple rapid enqueues process in FIFO order", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    queue.enqueue(delayed("a", order, 5));
    queue.enqueue(delayed("b", order, 5));
    queue.enqueue(delayed("c", order, 5));
    queue.enqueue(delayed("d", order, 5));
    queue.enqueue(delayed("e", order, 5));

    const done = withDrainSignal(queue);
    await done;

    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("queue size bounded at maxQueueSize, oldest item dropped on overflow", async () => {
    queue = new LearningQueue({ maxQueueSize: 3 });
    const order: string[] = [];

    // Enqueue a slow first item to block the queue
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("blocker");
    });

    // While "blocker" is processing, enqueue 4 more items.
    // Queue capacity is 3, so pushing item-4 evicts item-1.
    queue.enqueue(delayed("item-1", order, 1));
    queue.enqueue(delayed("item-2", order, 1));
    queue.enqueue(delayed("item-3", order, 1));
    queue.enqueue(delayed("item-4", order, 1)); // This pushes item-1 out

    // Drain signal is another enqueue -- but queue is already at 3 (item-2, item-3, item-4).
    // Adding drain signal evicts item-2 now. Let's use a different approach.
    // Instead, just wait long enough for everything to process.
    await new Promise((r) => setTimeout(r, 200));

    // "blocker" was already processing (not in queue), so it runs.
    // Of the queued items, item-1 was evicted by item-4.
    expect(order).toEqual(["blocker", "item-2", "item-3", "item-4"]);
  });

  it("enqueue after shutdown is silently ignored", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    await queue.shutdown();

    // Should not throw and should not execute
    queue.enqueue(async () => {
      order.push("should-not-run");
    });

    // Small delay to see if anything fires
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toHaveLength(0);
  });

  it("shutdown() awaits currently processing item before resolving", async () => {
    queue = new LearningQueue();
    let completed = false;

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
    });

    // Give processNext a chance to start
    await new Promise((r) => setTimeout(r, 5));
    expect(completed).toBe(false);

    await queue.shutdown();
    expect(completed).toBe(true);
  });

  it("shutdown() discards remaining queued items (does not process them)", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    // Slow blocker
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("blocker");
    });

    // These are queued behind the blocker
    queue.enqueue(delayed("discarded-1", order, 1));
    queue.enqueue(delayed("discarded-2", order, 1));

    // Give the blocker time to start
    await new Promise((r) => setTimeout(r, 5));

    await queue.shutdown();
    // Only the in-flight blocker should have completed
    expect(order).toEqual(["blocker"]);
  });

  it("processing error is caught and logged, queue continues with next item", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      throw new Error("task-1 exploded");
    });
    queue.enqueue(async () => {
      order.push("task-2-ok");
    });
    queue.enqueue(async () => {
      order.push("task-3-ok");
    });

    const done = withDrainSignal(queue);
    await done;

    // task-1 threw, but tasks 2 and 3 should still have executed
    expect(order).toEqual(["task-2-ok", "task-3-ok"]);
  });

  it("empty queue does not spin or consume CPU", async () => {
    queue = new LearningQueue();
    const startTime = Date.now();

    // Wait a bit with empty queue
    await new Promise((r) => setTimeout(r, 50));
    const elapsed = Date.now() - startTime;

    // The queue should be idle -- verify it hasn't consumed unreasonable time
    // (this is more of a sanity check than a precise measurement)
    expect(elapsed).toBeLessThan(200);

    // Enqueue and process something after idle period to confirm it works
    const order: string[] = [];
    queue.enqueue(delayed("after-idle", order, 1));
    const done = withDrainSignal(queue);
    await done;
    expect(order).toEqual(["after-idle"]);
  });
});
