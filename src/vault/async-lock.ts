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
 * be a deadlock; the `held` flag detects that synchronously and throws a
 * useful error instead of hanging. The cost is a boolean read/write and it
 * only fires for the misuse case. Inner call sites that already hold the
 * lock must call the `*Internal` helpers that assume it is held.
 */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held) {
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
      this.held = true;
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}
