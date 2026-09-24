/**
 * Agent Core v2 — bounded LiveSink with back-pressure (ARCHITECTURE §5.1, §10.2).
 *
 * The "small async/back-pressure engine" that turns any `(AgentEvent[]) => void` flush into a
 * bounded, non-blocking sink. The TypedEventBus drain pattern does NOT transfer (that bus is
 * process-immortal and unbounded); this is net-new.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet (Phase 2 foundation).
 */

import type { AgentEvent } from "./agent-event.js";
import type { LiveSink } from "./event-bus.js";
import { getLoggerSafe } from "../../utils/logger.js";

export interface BoundedSinkOptions {
  readonly id: string;
  /** Flush a drained batch. MUST NOT throw. May be async; back-pressure is handled here. */
  flush(batch: readonly AgentEvent[]): void | Promise<void>;
  /** Max queued events before non-delta drops (lossless-bounded). Default 512. */
  readonly maxQueue?: number;
}

const DEFAULT_MAX_QUEUE = 512;

/**
 * A LiveSink that never blocks emit():
 *  - model.delta coalesces LOSSY-NEWEST under back-pressure (a slow WS client gets merged
 *    deltas per channel, never a memory blowup),
 *  - non-delta variants are BOUNDED-LOSSLESS (dropped only if the hard ceiling is hit, which
 *    is the back-pressure safety valve, never the steady state).
 */
export function createBoundedSink(opts: BoundedSinkOptions): LiveSink {
  const maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
  let queue: AgentEvent[] = [];
  let flushing = false;
  let closed = false;
  let flushFailureLogged = false;

  /**
   * The "MUST NOT throw" contract, enforced here: deliver() starts pump() without awaiting it,
   * so a throwing flush became one unhandled rejection per event, and a persistently failing
   * consumer (a busy database behind the progress path) could trip the process's rejection-storm
   * shutdown. The failed batch is dropped; later batches still flow. Logged once per sink.
   */
  async function safeFlush(batch: readonly AgentEvent[]): Promise<void> {
    try {
      await opts.flush(batch);
    } catch (error) {
      if (flushFailureLogged) return;
      flushFailureLogged = true;
      getLoggerSafe().warn("[agent-core] event sink flush failed; dropping the batch", {
        sink: opts.id,
        events: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function coalesce(ev: AgentEvent): void {
    if (ev.type === "model.delta") {
      // merge into the trailing delta of the SAME channel if it's still queued (lossy-newest)
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (!q || q.type !== "model.delta") continue;
        if (q.channel === ev.channel) {
          queue[i] = { ...q, text: q.text + ev.text };
          return;
        }
        break; // a different-channel delta is in the way → don't reorder past it
      }
    }
    if (queue.length >= maxQueue && ev.type !== "model.delta") return; // bounded-lossless drop
    queue.push(ev);
  }

  async function pump(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0 && !closed) {
        const batch = queue;
        queue = [];
        await safeFlush(batch); // a slow flush queues new events; emit() never waits on this
      }
    } finally {
      flushing = false;
      if (queue.length > 0 && !closed) void pump();
    }
  }

  return {
    id: opts.id,
    deliver(ev) {
      if (!closed) {
        coalesce(ev);
        void pump();
      }
    },
    async close() {
      closed = true;
      if (queue.length) {
        const b = queue;
        queue = [];
        await safeFlush(b);
      }
    },
  };
}
