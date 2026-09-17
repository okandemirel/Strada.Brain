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
 * ROUND 12 #7 / #8 — NON-DROPPABLE IS NOT THE SAME AS UNBOUNDED. Round 11 #7 paid
 * for "never dropped" by removing the bound and the exit:
 *
 *  - the queue grew without limit whenever nothing droppable was left to evict,
 *    so a blocked processor and a stream of settlements let a queue configured
 *    for two hold a hundred pending items, with nowhere for the work to go;
 *  - the shutdown pass counter could not bound its own drain, because
 *    {@link LearningQueue.processNext} loops while the queue is non-empty and a
 *    durable item that enqueues another one never let it return. `shutdown()`
 *    never resolved, and the daemon's force-exit took the pending settlements
 *    with it.
 *
 * Both are closed WITHOUT dropping durable work. The durable backlog has its own
 * bound; past it a durable item is REFUSED (`enqueue` returns false) instead of
 * queued, and the drain runs under a deadline and an item budget. In both cases
 * the item's {@link LearningQueueEnqueueOptions.onAbandoned} fallback runs
 * synchronously, so the work happens here and now — for a terminal settlement
 * that means it is written out of order rather than carried in memory or lost at
 * exit. What could not be carried and has no fallback is counted and NAMED, in
 * the warning and in {@link LearningQueue.shutdown}'s report.
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
/**
 * Wall-clock bound on the whole shutdown drain (round 12 #8). Well inside the
 * daemon's 60-second force-exit, so the drain ends on its own terms — reporting
 * what it could not carry — instead of being killed with the work in memory.
 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;
/**
 * Item budget for the shutdown drain (round 12 #8): the other half of the
 * deadline, for work that is individually fast but self-perpetuating.
 */
const DEFAULT_SHUTDOWN_DRAIN_ITEMS = 256;

interface QueueItem {
  readonly fn: () => Promise<void>;
  /** See the class doc: lifecycle work, never evicted, drained at shutdown. */
  readonly durable: boolean;
  /** What this work IS, for the overflow warning and the shutdown report. */
  readonly label?: string;
  /** See {@link LearningQueueEnqueueOptions.onAbandoned}. */
  readonly onAbandoned?: () => void;
}

export interface LearningQueueEnqueueOptions {
  /**
   * Lifecycle work: a run's terminal settlement and anything else whose loss
   * silently corrupts the record. Never dropped on overflow, drained at
   * shutdown. Default false — observations stay droppable.
   */
  readonly durable?: boolean;
  /**
   * What this work is, in words. It is what the overflow warning and the
   * shutdown report name, so "3 durable items abandoned" can be read as
   * "3 terminal settlements did not run".
   */
  readonly label?: string;
  /**
   * LAST RESORT for durable work the queue cannot carry (round 12 #7/#8): called
   * synchronously, at most once, when the item is refused at the durable bound
   * or when the shutdown drain's budget runs out before it. It must do the work
   * itself, cheaply and synchronously — for a terminal settlement, settle now
   * and out of order. A settlement delayed is not a settlement lost; a
   * settlement dropped is, and this is what stops the drop.
   */
  readonly onAbandoned?: () => void;
}

/** What a shutdown drain did, and what it could not do (round 12 #8). */
export interface LearningQueueShutdownReport {
  /** Durable items the drain could not run before its budget ran out. */
  readonly durableAbandoned: number;
  /** Their labels, so the log names the work rather than counting it. */
  readonly abandoned: readonly string[];
  /** How many of those had no fallback, and are therefore genuinely lost. */
  readonly abandonedWithoutFallback: number;
}

export class LearningQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private stopped = false;
  /** Shutdown has finished its drain: nothing more will ever run. */
  private drained = false;
  private readonly maxQueueSize: number;
  private readonly maxDurableQueueSize: number;
  private inflightPromise: Promise<void> | null = null;
  /** Durable items refused at the bound (round 12 #7), and the subset with no fallback. */
  private durableRefused = 0;
  private durableRefusedWithoutFallback = 0;
  /**
   * The shutdown drain's budget (round 12 #8). Read by {@link processNext} on
   * every iteration — including a pass that was ALREADY RUNNING when shutdown
   * was called, which is the case the pass counter could never bound.
   */
  private drainBudget: { deadlineAt: number; itemsLeft: number } | null = null;

  constructor(options?: {
    maxQueueSize?: number;
    /**
     * Bound on the DURABLE backlog (round 12 #7). Defaults to `maxQueueSize`, so
     * the queue holds no more items than its bound in total whatever the mix.
     */
    maxDurableQueueSize?: number;
  }) {
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxDurableQueueSize = options?.maxDurableQueueSize ?? this.maxQueueSize;
  }

  /** What the queue is holding right now, and what it has refused. */
  stats(): {
    queued: number;
    durableQueued: number;
    durableRefused: number;
    durableRefusedWithoutFallback: number;
  } {
    return {
      queued: this.queue.length,
      durableQueued: this.countDurable(),
      durableRefused: this.durableRefused,
      durableRefusedWithoutFallback: this.durableRefusedWithoutFallback,
    };
  }

  private countDurable(): number {
    let n = 0;
    for (const item of this.queue) if (item.durable) n++;
    return n;
  }

  /**
   * Enqueue an async function for serial execution.
   *
   * Returns whether the queue TOOK the work. At capacity the oldest DROPPABLE
   * item is evicted; a durable item is never the one that goes, but past the
   * durable bound an incoming durable item is refused rather than held in memory
   * for ever (round 12 #7) — its `onAbandoned` runs instead, synchronously.
   * Once shutdown's drain has finished nothing is accepted. While it is still
   * running, a durable item joins the drain (an observation does not — shutdown
   * discards those).
   */
  enqueue(fn: () => Promise<void>, options?: LearningQueueEnqueueOptions): boolean {
    const durable = options?.durable === true;
    if (this.drained) return this.refuse(options, 'Learning queue is shut down');
    if (this.stopped && !durable) return false;

    if (durable) {
      // ROUND 12 #7: the durable backlog has a bound of its own. Refusing is not
      // dropping: the caller is told, and the fallback does the work now.
      if (this.countDurable() >= this.maxDurableQueueSize) {
        return this.refuse(options, 'Learning queue durable backlog is full');
      }
    } else if (this.queue.length >= this.maxQueueSize) {
      const oldestDroppable = this.queue.findIndex((item) => !item.durable);
      try {
        getLoggerSafe().warn(
          oldestDroppable >= 0
            ? 'Learning queue overflow: dropping oldest droppable item'
            : 'Learning queue overflow: every queued item is non-droppable, dropping this observation instead of growing',
          { queueSize: this.queue.length, maxQueueSize: this.maxQueueSize },
        );
      } catch {
        // Logger may not be available in test environments
      }
      // Round 11 #7: evict a droppable item, never the lifecycle work. Round 12
      // #7: with nothing droppable left, the incoming OBSERVATION is what goes —
      // observations are the droppable class, and the bound has to hold
      // somewhere.
      if (oldestDroppable >= 0) {
        this.queue.splice(oldestDroppable, 1);
      } else {
        return false;
      }
    }

    this.queue.push({
      fn,
      durable,
      ...(options?.label === undefined ? {} : { label: options.label }),
      ...(options?.onAbandoned === undefined ? {} : { onAbandoned: options.onAbandoned }),
    });

    if (!this.processing) {
      this.inflightPromise = this.processNext();
    }
    return true;
  }

  /**
   * Refuse one item: say so, run its fallback, and count the ones that had none
   * (round 12 #7). Always returns false — the queue did not take the work.
   */
  private refuse(options: LearningQueueEnqueueOptions | undefined, why: string): boolean {
    const durable = options?.durable === true;
    if (!durable) return false;
    this.durableRefused++;
    const label = options?.label ?? 'durable learning work';
    if (options?.onAbandoned) {
      this.runFallback(options.onAbandoned, label);
    } else {
      this.durableRefusedWithoutFallback++;
    }
    try {
      getLoggerSafe().warn(`${why}: refusing durable work`, {
        work: label,
        handledByFallback: options?.onAbandoned !== undefined,
        durableQueued: this.countDurable(),
        maxDurableQueueSize: this.maxDurableQueueSize,
      });
    } catch {
      // Logger may not be available in test environments
    }
    return false;
  }

  /** A fallback must never take its caller down with it. */
  private runFallback(onAbandoned: () => void, label: string): void {
    try {
      onAbandoned();
    } catch (error: unknown) {
      try {
        getLoggerSafe().warn('Learning queue: fallback for abandoned durable work failed', {
          work: label,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Logger may not be available in test environments
      }
    }
  }

  /**
   * Process queued items one at a time.
   * Errors are caught and logged -- never rethrown.
   *
   * Once stopped, the queue is truncated after the LAST durable item on every
   * pass: the trailing observations nobody is waiting on are discarded, while
   * the ones a settlement is meant to judge still run before it (round 11 #7).
   *
   * Round 12 #8: once stopped, the loop also obeys {@link drainBudget} — a
   * deadline and an item count. Without it a durable item that enqueues another
   * durable item kept this loop running for ever, so shutdown's pass counter
   * never got a turn and shutdown never returned.
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

        // The budget is checked BEFORE taking the next item, so what is left
        // stays on the queue for shutdown to name and hand to its fallback.
        const budget = this.drainBudget;
        if (budget && (budget.itemsLeft <= 0 || Date.now() >= budget.deadlineAt)) break;
        if (budget) budget.itemsLeft--;
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
   *
   * Bounded in three ways, because round 12 #8 showed one was not enough: the
   * pass counter, a wall-clock deadline, and an item budget — the last two
   * enforced INSIDE {@link processNext}, and the deadline also raced against the
   * in-flight item, which cannot be cancelled but must not hold the exit open.
   * Whatever durable work is left is handed to its fallback and NAMED in the
   * returned report.
   */
  async shutdown(options?: { deadlineMs?: number; maxItems?: number }): Promise<LearningQueueShutdownReport> {
    // Already drained: nothing is queued and nothing more will be accepted, so a
    // second call must not sit out another deadline waiting on an item that is
    // still hung from the first (round 12 #8).
    if (this.drained) return { durableAbandoned: 0, abandoned: [], abandonedWithoutFallback: 0 };
    this.stopped = true;
    const deadlineAt = Date.now() + Math.max(0, options?.deadlineMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
    this.drainBudget = {
      deadlineAt,
      itemsLeft: Math.max(0, options?.maxItems ?? DEFAULT_SHUTDOWN_DRAIN_ITEMS),
    };

    // The drain. `processNext` keeps running once stopped, through the last
    // durable item — so awaiting the in-flight pass IS the drain. The loop
    // re-enters for durable work enqueued BY a draining item (a settlement that
    // schedules a follow-up) and for the case where nothing was in flight.
    let passes = 0;
    let gaveUp = false;
    while (this.inflightPromise !== null || this.queue.some((item) => item.durable)) {
      // Three bounds, because round 12 #8 showed one was not enough: passes,
      // the wall clock, and the item budget processNext is spending.
      if (
        passes++ >= MAX_SHUTDOWN_DRAIN_PASSES ||
        Date.now() >= deadlineAt ||
        (this.drainBudget !== null && this.drainBudget.itemsLeft <= 0 && this.inflightPromise === null)
      ) {
        gaveUp = true;
        break;
      }
      if (this.inflightPromise !== null) {
        // The item in flight cannot be cancelled. Waiting on it is bounded by
        // the same deadline, so one hung settlement cannot hold the exit open
        // (and the work BEHIND it is not held hostage either).
        const finished = await this.raceDeadline(this.inflightPromise, deadlineAt);
        if (!finished) {
          gaveUp = true;
          break;
        }
        continue;
      }
      this.inflightPromise = this.processNext();
    }

    this.drainBudget = null;
    const remaining = this.queue.filter((item) => item.durable);
    this.queue = [];
    this.drained = true;

    const abandoned = remaining.map((item) => item.label ?? 'durable learning work');
    let abandonedWithoutFallback = 0;
    for (const item of remaining) {
      if (item.onAbandoned) {
        this.runFallback(item.onAbandoned, item.label ?? 'durable learning work');
      } else {
        abandonedWithoutFallback++;
      }
    }

    if (gaveUp || abandoned.length > 0) {
      try {
        getLoggerSafe().warn('Learning queue shutdown: non-droppable work did not run in the drain', {
          abandoned,
          abandonedWithoutFallback,
          passes,
        });
      } catch {
        // Logger may not be available in test environments
      }
    }

    return { durableAbandoned: abandoned.length, abandoned, abandonedWithoutFallback };
  }

  /**
   * Await `promise`, but never past `deadlineAt`. Answers whether it finished.
   * The timer is cleared either way, so a pending drain never keeps the process
   * alive by itself.
   */
  private async raceDeadline(promise: Promise<void>, deadlineAt: number): Promise<boolean> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    try {
      return (await Promise.race([promise.then(() => true), expired])) !== false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
