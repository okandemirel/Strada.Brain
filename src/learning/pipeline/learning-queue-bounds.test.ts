/**
 * ROUND 12 #7 + #8 — NON-DROPPABLE IS NOT THE SAME AS UNBOUNDED.
 *
 * Round 11 #7 made a run's terminal settlement durable: never evicted to make
 * room, drained at shutdown. Both halves were paid for with a missing bound.
 *
 *  - #7 THE QUEUE BOUND IS GONE. With nothing droppable left to evict the queue
 *    grew "on purpose", so a blocked processor and a stream of settlements let a
 *    queue configured for TWO hold a hundred pending items, with no upper limit
 *    at all and nowhere for the work to go.
 *  - #8 THE SHUTDOWN PASS LIMIT COULD NOT BOUND ITS OWN DRAIN. The 32-pass
 *    counter only advances between calls to `processNext`, and `processNext`
 *    loops while the queue is non-empty — so a durable item that enqueues
 *    another one never let the counter move. `shutdown()` never returned, and
 *    the daemon's 60-second force-exit killed the process with the pending
 *    settlements still in memory.
 *
 * What replaces the missing bound is not dropping. A durable item is REFUSED at
 * the bound and the refusal is reported, and the shutdown drain runs under a
 * deadline and an item budget — and in both cases the item's `onAbandoned`
 * fallback runs, synchronously, so the work is done here and now instead of
 * being carried in memory or lost at exit.
 */

import { describe, it, expect, afterEach } from "vitest";
import { LearningQueue } from "./learning-queue.js";

let queue: LearningQueue;

afterEach(async () => {
  if (queue) await queue.shutdown();
});

/** A gate the test opens by hand, so "the processor is blocked" is deterministic. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("the durable backlog is bounded, and nothing is silently dropped (r12 #7)", () => {
  it("PROOF: a queue configured for two does not hold a hundred pending settlements", async () => {
    queue = new LearningQueue({ maxQueueSize: 2 });
    const blocker = gate();
    const ran: string[] = [];
    const settledByFallback: string[] = [];

    // Block the processor: everything enqueued now piles up behind it.
    queue.enqueue(async () => {
      await blocker.wait;
      ran.push("blocker");
    });

    let refused = 0;
    for (let i = 0; i < 100; i++) {
      const accepted = queue.enqueue(
        async () => {
          ran.push(`settlement-${i}`);
        },
        {
          durable: true,
          label: `settlement-${i}`,
          onAbandoned: () => settledByFallback.push(`settlement-${i}`),
        },
      );
      if (!accepted) refused++;
    }

    // TEETH: before the fix this was 100 — the bound applied to droppable work
    // only, so the queue grew without limit.
    expect(queue.stats().durableQueued, "the durable backlog is unbounded").toBeLessThanOrEqual(2);
    expect(refused, "the caller was not told its settlement was not taken").toBe(98);

    // NOT DROPPED: every refused settlement was settled by its fallback, at the
    // moment of refusal.
    expect(settledByFallback.length).toBe(98);

    blocker.open();
    await queue.shutdown();

    // And the ones the queue DID take ran, exactly once each: all hundred
    // settlements happened, none of them twice.
    const queued = ran.filter((r) => r.startsWith("settlement"));
    expect(queued.length).toBe(2);
    expect(queued.some((id) => settledByFallback.includes(id))).toBe(false);
    expect(new Set([...settledByFallback, ...queued]).size).toBe(100);
  });

  it("a refused settlement with no fallback is counted and named, never silently lost", async () => {
    queue = new LearningQueue({ maxQueueSize: 1 });
    const blocker = gate();
    queue.enqueue(async () => {
      await blocker.wait;
    });

    expect(queue.enqueue(async () => {}, { durable: true, label: "kept" })).toBe(true);
    expect(queue.enqueue(async () => {}, { durable: true, label: "refused-without-a-fallback" })).toBe(false);

    const stats = queue.stats();
    expect(stats.durableRefused).toBe(1);
    expect(stats.durableRefusedWithoutFallback).toBe(1);

    blocker.open();
    await queue.shutdown();
  });

  it("GUARD: observations stay droppable and the total bound still holds", async () => {
    queue = new LearningQueue({ maxQueueSize: 2 });
    const blocker = gate();
    const ran: string[] = [];
    queue.enqueue(async () => {
      await blocker.wait;
      ran.push("blocker");
    });

    for (let i = 1; i <= 6; i++) {
      queue.enqueue(async () => {
        ran.push(`observation-${i}`);
      });
    }
    // The oldest droppable item goes, and the queue never exceeds its bound.
    expect(queue.stats().queued).toBe(2);

    // Let the queue drain on its own: shutdown discards trailing observations
    // by design, so waiting for them is the only honest way to see WHICH two
    // survived the bound.
    blocker.open();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual(["blocker", "observation-5", "observation-6"]);
  });

  it("GUARD: a durable item is still preferred over an observation at the bound", async () => {
    queue = new LearningQueue({ maxQueueSize: 2 });
    const blocker = gate();
    const ran: string[] = [];
    queue.enqueue(async () => {
      await blocker.wait;
      ran.push("blocker");
    });

    queue.enqueue(async () => { ran.push("settlement"); }, { durable: true, label: "settlement" });
    for (let i = 1; i <= 4; i++) {
      queue.enqueue(async () => { ran.push(`observation-${i}`); });
    }

    blocker.open();
    await queue.shutdown();
    // Round 11 #7's guarantee, unchanged: the settlement is never the item that
    // goes, and the observations that survived are the newest ones.
    expect(ran).toContain("settlement");
    expect(ran.filter((r) => r.startsWith("observation")).length).toBeLessThan(4);
  });
});

describe("the shutdown drain is bounded from the inside (r12 #8)", () => {
  it("PROOF: shutdown returns even while draining work keeps enqueueing more durable work", async () => {
    queue = new LearningQueue();
    let spawned = 0;
    const abandoned: string[] = [];

    // A durable item that schedules another durable item — a settlement that
    // schedules a follow-up, which the shutdown doc calls out by name.
    const spawn = (): void => {
      const n = ++spawned;
      queue.enqueue(
        async () => {
          spawn();
          await new Promise((r) => setTimeout(r, 1));
        },
        { durable: true, label: `follow-up-${n}`, onAbandoned: () => abandoned.push(`follow-up-${n}`) },
      );
    };
    spawn();

    await new Promise((r) => setTimeout(r, 10));
    const startedAt = Date.now();
    // TEETH: before the fix processNext never returned, so the 32-pass counter
    // never advanced and this await never resolved — the daemon's 60s force
    // exit was what ended it, with the pending settlements still in memory.
    const report = await queue.shutdown({ deadlineMs: 150 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed, "the drain ran past its own deadline").toBeLessThan(2000);
    expect(report.durableAbandoned, "the drain claims it finished work it never ran").toBeGreaterThan(0);
    // It SAYS what it could not carry, and the fallback ran for each.
    expect(report.abandoned.length).toBe(report.durableAbandoned);
    expect(abandoned.length).toBe(report.durableAbandoned);
    expect(report.abandoned[0]).toMatch(/follow-up-/);
  }, 5000);

  it("PROOF: a single durable item that never settles cannot hold shutdown open for ever", async () => {
    queue = new LearningQueue();
    const abandoned: string[] = [];
    queue.enqueue(async () => new Promise<void>(() => { /* never resolves */ }), {
      durable: true,
      label: "hung-settlement",
    });
    queue.enqueue(async () => {}, {
      durable: true,
      label: "behind-the-hang",
      onAbandoned: () => abandoned.push("behind-the-hang"),
    });

    await new Promise((r) => setTimeout(r, 10));
    const report = await queue.shutdown({ deadlineMs: 120 });

    // The hung item cannot be cancelled, but the work BEHIND it is not held
    // hostage: it is named, and its fallback ran.
    expect(report.abandoned).toContain("behind-the-hang");
    expect(abandoned).toEqual(["behind-the-hang"]);
  }, 5000);

  it("PROOF: the drain stops at its ITEM budget too, and hands the rest to their fallbacks", async () => {
    queue = new LearningQueue();
    const ran: string[] = [];
    const abandoned: string[] = [];
    const blocker = gate();

    queue.enqueue(async () => { await blocker.wait; });
    for (let i = 1; i <= 10; i++) {
      queue.enqueue(async () => { ran.push(`settlement-${i}`); }, {
        durable: true,
        label: `settlement-${i}`,
        onAbandoned: () => abandoned.push(`settlement-${i}`),
      });
    }

    blocker.open();
    // A deadline alone cannot bound work that is individually fast and
    // self-perpetuating; the item budget is the other half, and it is spent
    // INSIDE the processing loop.
    const report = await queue.shutdown({ maxItems: 3 });

    expect(ran).toEqual(["settlement-1", "settlement-2", "settlement-3"]);
    expect(report.durableAbandoned).toBe(7);
    expect(report.abandoned).toEqual([4, 5, 6, 7, 8, 9, 10].map((n) => `settlement-${n}`));
    expect(abandoned.length).toBe(7);
    expect(report.abandonedWithoutFallback).toBe(0);
  }, 5000);

  it("GUARD: an ordinary drain still runs every durable item queued, in order", async () => {
    queue = new LearningQueue();
    const ran: string[] = [];
    const abandoned: string[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      ran.push("blocker");
    });
    queue.enqueue(async () => { ran.push("observation"); });
    queue.enqueue(async () => { ran.push("settlement"); }, {
      durable: true,
      label: "settlement",
      onAbandoned: () => abandoned.push("settlement"),
    });

    await new Promise((r) => setTimeout(r, 5));
    const report = await queue.shutdown();

    expect(ran).toEqual(["blocker", "observation", "settlement"]);
    expect(report.durableAbandoned).toBe(0);
    expect(abandoned, "a fallback ran for work the queue actually did").toEqual([]);
  });
});
