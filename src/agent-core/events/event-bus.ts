/**
 * Agent Core v2 — AgentRunEventBus: one typed stream, many sinks (ARCHITECTURE §5.1, §1.2, §10.2).
 *
 * Run-scoped (NOT the process-wide TypedEventBus). Owns:
 *  - gap-free `seq` under a per-run lock,
 *  - an in-memory bounded RING BUFFER (the observability sink; powers same-process portal
 *    rehydration from a `seq` cursor while the run is live),
 *  - bounded LIVE sinks (best-effort, never block emit; model.delta coalesces lossy-newest).
 *
 * NO DURABLE REPLAY. The entire NDJSON/SQLite/WAL/replayTo subsystem is CUT. Durable
 * cross-restart replay is a separate post-migration feature. The ring buffer is the
 * in-migration substitute (same-process only).
 *
 * emit() = APPEND THEN SINK (§5): stamp seq+ts → push to ring → fan out to live sinks. The
 * append step is what lets the watchdog and the UI observe the SAME ordered stream.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet (Phase 2 foundation).
 */

import type { Clock } from "../control/clock.js";
import type { AgentEvent, EmittableEvent, Seq } from "./agent-event.js";

/** A live sink: best-effort, fire-and-forget. MUST NOT throw and MUST NOT block. */
export interface LiveSink {
  readonly id: string;
  /** Called for EVERY event (post-stamp). Coalescing/queueing is the sink's own concern. */
  deliver(event: AgentEvent): void;
  /** Drain + release. Awaited at run teardown (bounded). */
  close?(): void | Promise<void>;
}

export interface RingBufferSnapshot {
  readonly events: readonly AgentEvent[];
  /** The seq AFTER which `events` begins (so a reconnecting cursor knows what it missed). */
  readonly fromSeqExclusive: Seq;
  /** True if older events were evicted (the cursor predates the retained window). */
  readonly truncated: boolean;
}

export interface AgentRunEventBus {
  readonly runId: string;
  /** Stamp seq+ts+runId, append to ring, fan out. Returns the assigned seq. NEVER blocks. */
  emit(e: EmittableEvent): Seq;
  /** Register a live sink. Returns an unsubscribe fn. */
  addSink(sink: LiveSink): () => void;
  /** Same-process rehydration: everything strictly after `cursorSeq` still in the ring. */
  since(cursorSeq: Seq): RingBufferSnapshot;
  /** The full retained log (for buildAgentRunResult / persistTerminal). */
  readonly log: readonly AgentEvent[];
  /** Highest assigned seq (0 before first emit). */
  readonly headSeq: Seq;
  /** Drain + close all sinks. Idempotent. */
  close(): Promise<void>;
}

export interface AgentRunEventBusOptions {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly clock: Clock;
  /** Ring capacity (events). Default 2048 — bounded by construction. */
  readonly ringCapacity?: number;
}

const DEFAULT_RING_CAPACITY = 2048;

export function createAgentRunEventBus(opts: AgentRunEventBusOptions): AgentRunEventBus {
  const { runId, parentRunId, clock } = opts;
  const cap = Math.max(1, opts.ringCapacity ?? DEFAULT_RING_CAPACITY);

  // Ring buffer — bounded, FIFO eviction. `headSeq` is total emitted; `baseSeq` is the seq
  // AFTER which the retained window begins (i.e. fromSeqExclusive), so `since()` can report
  // truncation when a cursor predates what is still retained.
  const ring: AgentEvent[] = [];
  let headSeq: Seq = 0;
  let baseSeq: Seq = 0; // seq of ring[0] - 1 (i.e. fromSeqExclusive of the retained window)

  const sinks = new Map<string, LiveSink>();
  let closed = false;

  // ── The per-run lock. JS is single-threaded, so the "lock" is the synchronous, atomic
  //    stamp+append below: nothing can interleave between reading headSeq and writing the
  //    event into the ring. emit() does NOT await before assigning seq → gap-free, total-
  //    ordered even with concurrent emitters (gateway + tool executor + reflection). ──
  function emit(e: EmittableEvent): Seq {
    if (closed) return headSeq; // post-close emits are dropped (run is over)
    headSeq += 1;
    const seq = headSeq;
    const stamped = { ...e, runId, parentRunId, seq, ts: clock.now() } as AgentEvent;

    // APPEND (durability/ordering) ...
    ring.push(stamped);
    if (ring.length > cap) {
      ring.shift();
      baseSeq += 1;
    }

    // ... THEN SINK (best-effort fan-out; a throwing/slow sink can never break the loop).
    for (const sink of sinks.values()) {
      try {
        sink.deliver(stamped);
      } catch {
        // log-and-continue: a sink failure is never the agent loop's problem.
      }
    }
    return seq;
  }

  function since(cursorSeq: Seq): RingBufferSnapshot {
    const truncated = cursorSeq < baseSeq;
    const start = ring.findIndex((ev) => ev.seq > cursorSeq);
    const events = start === -1 ? [] : ring.slice(start);
    return { events, fromSeqExclusive: cursorSeq, truncated };
  }

  function addSink(sink: LiveSink): () => void {
    sinks.set(sink.id, sink);
    return () => {
      sinks.delete(sink.id);
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...sinks.values()].map((s) => s.close?.()));
    sinks.clear();
  }

  return {
    runId,
    emit,
    addSink,
    since,
    get log() {
      return ring as readonly AgentEvent[];
    },
    get headSeq() {
      return headSeq;
    },
    close,
  };
}
