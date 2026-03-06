/**
 * LearningQueue -- Serial async processor for learning events
 *
 * Processes enqueued async functions one at a time (strictly serial)
 * to prevent SQLite lock contention and ensure ordering.
 *
 * Modeled on EmbeddingQueue's bounded FIFO pattern but with
 * immediate serial processing (no batch window).
 *
 * - Bounded: maxQueueSize with FIFO eviction (oldest dropped on overflow)
 * - Error isolation: processing errors are caught and logged, never rethrown
 * - Graceful shutdown: awaits the current in-flight item, discards remaining
 */

const DEFAULT_MAX_QUEUE_SIZE = 1000;

export class LearningQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private stopped = false;
  private readonly maxQueueSize: number;
  private inflightPromise: Promise<void> | null = null;

  constructor(options?: { maxQueueSize?: number }) {
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /**
   * Enqueue an async function for serial execution.
   * If stopped, silently ignores. If at capacity, drops oldest (FIFO eviction).
   */
  enqueue(fn: () => Promise<void>): void {
    if (this.stopped) return;

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // Drop oldest to prevent unbounded growth
    }

    this.queue.push(fn);

    if (!this.processing) {
      this.inflightPromise = this.processNext();
    }
  }

  /**
   * Process queued items one at a time.
   * Errors are caught and logged -- never rethrown.
   * Loop exits when queue is empty OR stopped flag is set.
   * When stopped, only the current in-flight item completes.
   */
  private async processNext(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const fn = this.queue.shift()!;
      try {
        await fn();
      } catch (error: unknown) {
        // Log-and-continue: learning failure must never crash the agent
        try {
          const { getLogger } = await import("../../utils/logger.js");
          getLogger().debug("LearningQueue: event processing failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Logger may not be available in test environments -- silently ignore
        }
      }
    }

    this.processing = false;
    this.inflightPromise = null;
  }

  /**
   * Graceful shutdown: set stopped flag, await the currently in-flight item,
   * then discard remaining queued items.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;

    // Wait for the currently processing item to complete
    if (this.inflightPromise) {
      await this.inflightPromise;
    }

    this.queue = [];
  }
}
