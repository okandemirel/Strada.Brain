import { describe, it, expect } from "vitest";
import { AsyncLock } from "./async-lock.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("AsyncLock — concurrency", () => {
  it("QUEUES a second concurrent caller instead of rejecting it", async () => {
    // Regression: the guard was an instance-level boolean, set for the whole
    // duration of the holder's callback. A second, unrelated caller arriving
    // during that window saw `held === true` and was rejected with a bogus
    // "re-entrancy detected" error — a lock that fails under contention is
    // the opposite of a lock.
    const lock = new AsyncLock();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push("a:start");
      await tick(40);
      order.push("a:end");
    });
    // The second caller must arrive AFTER the first has actually acquired the
    // lock and is inside its callback. Calling back-to-back does not reproduce
    // the failure: `run` yields on `await prev` before marking itself held, so
    // an immediately-adjacent caller slips past the old boolean check.
    await tick(10);
    const b = lock.run(async () => {
      order.push("b:start");
      await tick(1);
      order.push("b:end");
    });

    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("serializes many concurrent callers without interleaving", async () => {
    const lock = new AsyncLock();
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        lock.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await tick(2);
          active--;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });

  it("accepts a caller that arrives mid-hold, repeatedly", async () => {
    // Staggered arrivals are the realistic shape (a watcher event landing
    // while a sync() is running) and the one the old flag rejected.
    const lock = new AsyncLock();
    const done: number[] = [];
    const held = lock.run(async () => { await tick(60); done.push(0); });

    const late: Promise<void>[] = [];
    for (let i = 1; i <= 3; i++) {
      await tick(10);
      late.push(lock.run(async () => { done.push(i); }));
    }

    await expect(Promise.all([held, ...late])).resolves.toBeDefined();
    expect(done).toEqual([0, 1, 2, 3]);
  });

  it("preserves FIFO order across concurrent callers", async () => {
    const lock = new AsyncLock();
    const seen: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        lock.run(async () => {
          seen.push(i);
          await tick(1);
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("AsyncLock — re-entrancy", () => {
  it("still throws when the SAME call chain re-acquires", async () => {
    // The guard must survive the concurrency fix: real re-entrancy deadlocks,
    // so it has to fail loudly rather than hang.
    const lock = new AsyncLock();
    await expect(
      lock.run(async () => {
        await lock.run(async () => undefined);
      }),
    ).rejects.toThrow(/re-entrancy detected/i);
  });

  it("throws on re-entrancy even after an await inside the holder", async () => {
    const lock = new AsyncLock();
    await expect(
      lock.run(async () => {
        await tick(5); // AsyncLocalStorage must survive the await boundary
        await lock.run(async () => undefined);
      }),
    ).rejects.toThrow(/re-entrancy detected/i);
  });

  it("releases the lock after a re-entrancy rejection so later callers still work", async () => {
    const lock = new AsyncLock();
    await expect(
      lock.run(async () => {
        await lock.run(async () => undefined);
      }),
    ).rejects.toThrow();

    await expect(lock.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("AsyncLock — error handling", () => {
  it("releases the lock when the callback throws", async () => {
    const lock = new AsyncLock();
    await expect(lock.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(lock.run(async () => "next")).resolves.toBe("next");
  });

  it("a throwing holder does not block a queued caller", async () => {
    const lock = new AsyncLock();
    const failing = lock.run(async () => {
      await tick(5);
      throw new Error("boom");
    });
    const queued = lock.run(async () => "survived");

    await expect(failing).rejects.toThrow("boom");
    await expect(queued).resolves.toBe("survived");
  });

  it("returns the callback's value", async () => {
    const lock = new AsyncLock();
    await expect(lock.run(async () => 42)).resolves.toBe(42);
  });
});
