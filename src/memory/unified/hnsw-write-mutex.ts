/**
 * HnswWriteMutex — Promise-based async write queue for HNSW index safety.
 *
 * hnswlib-node is NOT thread-safe for concurrent writes. This mutex serializes
 * all write operations (upsert, upsertBatch, remove, rebuildIndex) through a
 * single Promise chain so that no two writes interleave at await boundaries.
 *
 * Reads (search, searchFiltered) are NOT blocked — they bypass the mutex entirely.
 */
export class HnswWriteMutex {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Execute `fn` while holding the write lock.
   * Operations are serialized in FIFO order.
   * If `fn` throws, the error is propagated to the caller and the queue continues.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: () => void;

    // Chain a new link onto the queue. The previous link must settle
    // (resolve OR reject) before the new link's executor runs.
    const next = new Promise<void>((r) => {
      resolve = r;
    });

    const previous = this.queue;
    this.queue = next;

    // Wait for the previous operation to finish (we don't care if it threw).
    await previous;

    try {
      return await fn();
    } finally {
      // Release the lock so the next queued operation can start.
      resolve();
    }
  }
}
