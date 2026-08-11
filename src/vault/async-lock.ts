/**
 * Tiny FIFO async lock — serializes async sections per holder instance.
 *
 * Used by the vault implementations to prevent concurrent
 * sync()/reindexFile() interleaving from desynchronizing the embedding /
 * edge / SQLite indexes (two overlapping reindexes of the same path would
 * otherwise leave orphaned HNSW vectors or dangling chunk→vector rows).
 *
 * Re-entrancy guard (always on): the lock is NOT re-entrant. If the same
 * call chain tries to acquire it while already holding it the result would
 * be a deadlock, so that is detected and turned into a useful error instead
 * of a hang. Inner call sites that already hold the lock must call the
 * `*Internal` helpers that assume it is held.
 *
 * The guard tracks the holding ASYNC CONTEXT, not a shared boolean. A plain
 * instance-level `held` flag cannot tell "this call chain already holds the
 * lock" (real re-entrancy, must throw) from "a different caller wants the
 * lock while someone else holds it" (ordinary contention, must QUEUE) — it
 * sees `true` for both. That made every second concurrent caller fail with a
 * bogus "re-entrancy detected" error instead of waiting its turn, which is
 * the opposite of what a lock is for. AsyncLocalStorage propagates through
 * `await`, so only the chain that actually entered `run` sees the marker.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  /** Set only within the async context of the callback that holds the lock. */
  private readonly holding = new AsyncLocalStorage<true>();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.holding.getStore()) {
      throw new Error(
        'AsyncLock re-entrancy detected: call chain tried to acquire the lock ' +
          'while already holding it — this would deadlock. Refactor the inner call site to ' +
          'use the internal (`*Internal`) helper that assumes the lock is already held.',
      );
    }
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return await this.holding.run(true, fn);
    } finally {
      release();
    }
  }
}
