/**
 * LearningQueue -- Serial async processor for learning events
 *
 * Processes enqueued async functions one at a time (strictly serial)
 * to prevent SQLite lock contention and ensure ordering.
 *
 * Modeled on EmbeddingQueue's bounded FIFO pattern but with
 * immediate serial processing (no batch window).
 *
 * Two classes of work share this one queue, because ORDER between them is the
 * whole point (round 10 #14: a run's terminal settlement must run behind the
 * tool events it judges):
 *
 *  - OBSERVATIONS (the default) are droppable. They are the unbounded stream the
 *    bound exists for: on overflow the oldest is evicted, and at shutdown the
 *    ones still queued are discarded.
 *  - LIFECYCLE work (`{ durable: true }`) is not. Round 11 #7: putting terminal
 *    settlement on this queue handed the one event that must never be lost to
 *    the one place designed to lose it — under pressure the settlement was
 *    evicted as "oldest", so the run got no terminal credit, its verdict was
 *    never retained, and a late event had nothing to settle against; at shutdown
 *    it was discarded outright. A durable item is never evicted to make room,
 *    and shutdown drains it together with everything queued ahead of it, which
 *    is what preserves the ordering guarantee.
 *
 * - Error isolation: processing errors are caught and logged, never rethrown
 */

import { getLoggerSafe } from "../../utils/logger.js";

const DEFAULT_MAX_QUEUE_SIZE = 1000;
/**
 * Bound on shutdown drain passes. A durable task that enqueues another durable
 * task would otherwise keep shutdown alive forever; after this many passes the
 * remainder is dropped and said so, rather than hanging the daemon.
 */
const MAX_SHUTDOWN_DRAIN_PASSES = 32;

interface QueueItem {
  readonly fn: () => Promise<void>;
  /** See the class doc: lifecycle work, never evicted, drained at shutdown. */
  readonly durable: boolean;
}

export interface LearningQueueEnqueueOptions {
  /**
   * Lifecycle work: a run's terminal settlement and anything else whose loss
   * silently corrupts the record. Never dropped on overflow, drained at
   * shutdown. Default false — observations stay droppable.
   */
  readonly durable?: boolean;
}

export class LearningQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private stopped = false;
  /** Shutdown has finished its drain: nothing more will ever run. */
  private drained = false;
  private readonly maxQueueSize: number;
  private inflightPromise: Promise<void> | null = null;

  constructor(options?: { maxQueueSize?: number }) {
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /**
   * Enqueue an async function for serial execution.
   *
   * At capacity the oldest DROPPABLE item is evicted; a durable item is never
   * the one that goes. Once shutdown's drain has finished nothing is accepted.
   * While it is still running, a durable item joins the drain (an observation
   * does not — shutdown discards those).
   */
  enqueue(fn: () => Promise<void>, options?: LearningQueueEnqueueOptions): void {
    const durable = options?.durable === true;
    if (this.drained) return;
    if (this.stopped && !durable) return;

    if (this.queue.length >= this.maxQueueSize) {
      const oldestDroppable = this.queue.findIndex((item) => !item.durable);
      try {
        getLoggerSafe().warn(
          oldestDroppable >= 0
            ? 'Learning queue overflow: dropping oldest droppable item'
            : 'Learning queue over capacity: every queued item is non-droppable, growing instead of dropping',
          { queueSize: this.queue.length, maxQueueSize: this.maxQueueSize },
        );
      } catch {
        // Logger may not be available in test environments
      }
      // Round 11 #7: evict a droppable item, never the lifecycle work. With
      // nothing droppable left the queue grows past its bound on purpose — a
      // settlement lost is a corrupted record, a settlement delayed is not.
      if (oldestDroppable >= 0) {
        this.queue.splice(oldestDroppable, 1);
      }
    }

    this.queue.push({ fn, durable });

    if (!this.processing) {
      this.inflightPromise = this.processNext();
    }
  }

  /**
   * Process queued items one at a time.
   * Errors are caught and logged -- never rethrown.
   *
   * Once stopped, the queue is truncated after the LAST durable item on every
   * pass: the trailing observations nobody is waiting on are discarded, while
   * the ones a settlement is meant to judge still run before it (round 11 #7).
   */
  private async processNext(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      if (this.stopped) {
        let lastDurable = -1;
        for (let i = this.queue.length - 1; i >= 0; i--) {
          if (this.queue[i]!.durable) {
            lastDurable = i;
            break;
          }
        }
        if (lastDurable < 0) {
          this.queue = [];
          break;
        }
        this.queue = this.queue.slice(0, lastDurable + 1);
      }

      const item = this.queue.shift()!;
      try {
        await item.fn();
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
   * Graceful shutdown: stop accepting observations, await the in-flight item,
   * then DRAIN the lifecycle work still queued (round 11 #7) before discarding
   * the rest.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;

    // The drain. `processNext` keeps running once stopped, through the last
    // durable item — so awaiting the in-flight pass IS the drain. The loop
    // re-enters for durable work enqueued BY a draining item (a settlement that
    // schedules a follow-up) and for the case where nothing was in flight.
    // Bounded, and it says so when it gives up rather than hanging the daemon.
    let passes = 0;
    while (this.inflightPromise !== null || this.queue.some((item) => item.durable)) {
      if (passes++ >= MAX_SHUTDOWN_DRAIN_PASSES) {
        try {
          getLoggerSafe().warn('Learning queue shutdown: giving up on non-droppable work', {
            remaining: this.queue.filter((item) => item.durable).length,
          });
        } catch {
          // Logger may not be available in test environments
        }
        break;
      }
      if (this.inflightPromise !== null) {
        await this.inflightPromise;
        continue;
      }
      this.inflightPromise = this.processNext();
    }

    this.queue = [];
    this.drained = true;
  }
}
