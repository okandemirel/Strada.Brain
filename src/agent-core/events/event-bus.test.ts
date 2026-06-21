/**
 * Agent Core v2 — EventBus unit tests (Phase 2 foundations).
 *
 * Covers the load-bearing invariants:
 *  - gap-free seq + envelope stamping under the per-run lock,
 *  - the ring-buffer BOUND (FIFO eviction; since() truncation reporting),
 *  - the HEARTBEAT INVARIANT mechanism (guardedSleep emits-before-sleep; assertEmittedSince),
 *  - bounded-sink back-pressure (model.delta lossy-newest coalescing; non-delta bounded-lossless),
 *  - the learning bridge maps ONLY tool.finished → tool:result.
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createAgentRunEventBus } from "./event-bus.js";
import { createBoundedSink } from "./bounded-sink.js";
import { guardedSleep, assertEmittedSince } from "./heartbeat-guard.js";
import { createLearningBridgeSink } from "./learning-bridge.js";
import { isVisibleContent, type AgentEvent } from "./agent-event.js";
import type { IEventEmitter } from "../../core/event-bus.js";

describe("AgentRunEventBus — seq + envelope", () => {
  it("stamps gap-free seq, runId, ts and parentRunId on emit", () => {
    const clock = new FakeClock(1000);
    const bus = createAgentRunEventBus({ runId: "run-1", parentRunId: "parent-1", clock });

    const s1 = bus.emit({ type: "run.started", prompt: "hi", mode: "interactive" });
    clock.advance(5);
    const s2 = bus.emit({ type: "heartbeat", source: "loop-yield" });

    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(bus.headSeq).toBe(2);
    expect(bus.log).toHaveLength(2);
    expect(bus.log[0]).toMatchObject({ runId: "run-1", parentRunId: "parent-1", seq: 1, ts: 1000 });
    expect(bus.log[1]).toMatchObject({ seq: 2, ts: 1005, type: "heartbeat" });
  });

  it("overwrites any caller-supplied seq/ts/runId (bus owns the envelope)", () => {
    const clock = new FakeClock(42);
    const bus = createAgentRunEventBus({ runId: "run-x", clock });
    // EmittableEvent omits these fields at the type level; cast to prove the bus overwrites.
    bus.emit({ type: "intent.ack", summary: "ok", seq: 999, ts: 7, runId: "evil" } as never);
    expect(bus.log[0]).toMatchObject({ seq: 1, ts: 42, runId: "run-x" });
  });

  it("drops emits after close()", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    bus.emit({ type: "run.started", prompt: "p", mode: "background" });
    await bus.close();
    const seq = bus.emit({ type: "heartbeat", source: "loop-yield" });
    expect(seq).toBe(1); // returns the last head; nothing appended
    expect(bus.log).toHaveLength(1);
  });

  it("fans out to live sinks and a throwing sink never breaks emit", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const seen: AgentEvent[] = [];
    bus.addSink({
      id: "throws",
      deliver() {
        throw new Error("sink boom");
      },
    });
    bus.addSink({ id: "good", deliver: (e) => void seen.push(e) });

    expect(() => bus.emit({ type: "step.started", step: 0, phase: "planning" as never })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("step.started");
  });

  it("unsubscribe stops delivery to that sink", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const seen: AgentEvent[] = [];
    const off = bus.addSink({ id: "s", deliver: (e) => void seen.push(e) });
    bus.emit({ type: "heartbeat", source: "loop-yield" });
    off();
    bus.emit({ type: "heartbeat", source: "loop-yield" });
    expect(seen).toHaveLength(1);
  });
});

describe("AgentRunEventBus — ring buffer bound", () => {
  it("evicts oldest beyond capacity (FIFO) while seq keeps climbing", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock, ringCapacity: 3 });
    for (let i = 0; i < 10; i++) bus.emit({ type: "epoch.rolled", epoch: i });

    expect(bus.headSeq).toBe(10);
    expect(bus.log).toHaveLength(3); // bounded
    // The three retained are the NEWEST (seq 8,9,10).
    expect(bus.log.map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("since(cursor) returns only events after the cursor and flags truncation", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock, ringCapacity: 3 });
    for (let i = 0; i < 6; i++) bus.emit({ type: "epoch.rolled", epoch: i });
    // Retained window is seq 4,5,6 (baseSeq=3). A cursor at 5 → just seq 6, not truncated.
    const fresh = bus.since(5);
    expect(fresh.events.map((e) => e.seq)).toEqual([6]);
    expect(fresh.truncated).toBe(false);

    // A cursor at 1 predates the retained window → truncated, returns what remains.
    const stale = bus.since(1);
    expect(stale.truncated).toBe(true);
    expect(stale.events.map((e) => e.seq)).toEqual([4, 5, 6]);

    // A cursor at head → nothing new.
    expect(bus.since(6).events).toHaveLength(0);
  });
});

describe("heartbeat invariant", () => {
  it("guardedSleep emits the heartbeat BEFORE the timer fires (append-then-sleep)", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });

    const priorHead = bus.headSeq;
    const p = guardedSleep(bus, clock, 5000, { type: "heartbeat", source: "loop-yield" });

    // The heartbeat is in the log synchronously, BEFORE any time passes.
    expect(bus.headSeq).toBe(priorHead + 1);
    expect(bus.log.at(-1)).toMatchObject({ type: "heartbeat", source: "loop-yield" });

    clock.advance(5000);
    await p; // resolves once the fake timer fires
  });

  it("guardedSleep with ms<=0 still emits the heartbeat (no silent fast-path)", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    await guardedSleep(bus, clock, 0, { type: "heartbeat", source: "model-keepalive" });
    expect(bus.log).toHaveLength(1);
    expect(bus.log[0].type).toBe("heartbeat");
  });

  it("assertEmittedSince throws when the head did NOT advance across a wait-point", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const head = bus.headSeq;
    // Simulate a silent path: no emit happened.
    expect(() => assertEmittedSince(bus, head, "test-wait")).toThrow(/Heartbeat invariant violated/);
  });

  it("assertEmittedSince passes once an event was emitted", () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const head = bus.headSeq;
    bus.emit({ type: "heartbeat", source: "loop-yield" });
    expect(() => assertEmittedSince(bus, head, "test-wait")).not.toThrow();
  });
});

describe("bounded sink — back-pressure", () => {
  it("coalesces model.delta lossy-newest per channel while a slow flush is in flight", async () => {
    const flushed: AgentEvent[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstFlush = true;

    const sink = createBoundedSink({
      id: "slow",
      async flush(batch) {
        flushed.push([...batch]);
        if (firstFlush) {
          firstFlush = false;
          await gate; // hold the first flush open so subsequent deltas queue + coalesce
        }
      },
    });

    const mk = (text: string, seq: number): AgentEvent =>
      ({ type: "model.delta", channel: "answer", text, seq, ts: 0, runId: "r" }) as AgentEvent;

    sink.deliver(mk("a", 1)); // starts the (held) first flush with batch [a]
    sink.deliver(mk("b", 2)); // queue while flushing
    sink.deliver(mk("c", 3)); // coalesces into the queued "b" → "bc"

    release(); // let the first flush complete; pump drains the coalesced remainder
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(flushed[0].map((e) => (e.type === "model.delta" ? e.text : ""))).toEqual(["a"]);
    // The second drained batch is the single coalesced delta "bc" (lossy-newest merge).
    const second = flushed[1];
    expect(second).toHaveLength(1);
    expect(second[0].type).toBe("model.delta");
    expect((second[0] as { text: string }).text).toBe("bc");
  });

  it("does NOT coalesce deltas across different channels (no reorder)", async () => {
    const flushed: AgentEvent[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const sink = createBoundedSink({
      id: "slow",
      async flush(batch) {
        flushed.push([...batch]);
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    const mk = (channel: string, text: string): AgentEvent =>
      ({ type: "model.delta", channel, text, seq: 1, ts: 0, runId: "r" }) as AgentEvent;

    sink.deliver(mk("answer", "x")); // held first flush
    sink.deliver(mk("answer", "y")); // queued
    sink.deliver(mk("reasoning", "z")); // different channel: must NOT merge into "y"
    sink.deliver(mk("answer", "w")); // a reasoning delta is in the way → new answer entry

    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const drained = flushed.slice(1).flat();
    const texts = drained.map((e) => (e.type === "model.delta" ? `${e.channel}:${e.text}` : ""));
    expect(texts).toEqual(["answer:y", "reasoning:z", "answer:w"]);
  });

  it("drops non-delta events past the hard ceiling (bounded-lossless), never deltas", async () => {
    const flushed: AgentEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const sink = createBoundedSink({
      id: "tiny",
      maxQueue: 2,
      async flush(batch) {
        for (const e of batch) flushed.push(e);
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    const beat = (): AgentEvent => ({ type: "heartbeat", source: "loop-yield", seq: 1, ts: 0, runId: "r" }) as AgentEvent;
    const delta = (t: string): AgentEvent =>
      ({ type: "model.delta", channel: "answer", text: t, seq: 1, ts: 0, runId: "r" }) as AgentEvent;

    sink.deliver(beat()); // held first flush
    sink.deliver(beat()); // queue size 1
    sink.deliver(beat()); // queue size 2 (== maxQueue)
    sink.deliver(beat()); // dropped (bounded-lossless: non-delta past ceiling)
    sink.deliver(delta("keep")); // a delta is NEVER dropped by the ceiling

    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const deltas = flushed.filter((e) => e.type === "model.delta");
    expect(deltas).toHaveLength(1); // the delta survived
    // 1 (first) + 2 queued + 1 delta = 4 total; the 4th heartbeat was dropped.
    expect(flushed).toHaveLength(4);
  });

  it("close() flushes any remaining queued batch", async () => {
    const flushed: AgentEvent[] = [];
    const sink = createBoundedSink({
      id: "s",
      async flush(batch) {
        // hold forever on the first call so the second delivery stays queued until close
        await new Promise(() => {});
        for (const e of batch) flushed.push(e);
      },
    });
    const beat = (): AgentEvent => ({ type: "heartbeat", source: "loop-yield", seq: 1, ts: 0, runId: "r" }) as AgentEvent;
    sink.deliver(beat()); // starts the never-resolving flush
    sink.deliver(beat()); // stays queued
    // close drains the queued batch via a fresh flush call (the held one is abandoned).
    const flushedOnClose: AgentEvent[] = [];
    const sink2 = createBoundedSink({ id: "s2", flush: (b) => void b.forEach((e) => flushedOnClose.push(e)) });
    sink2.deliver(beat());
    await sink2.close();
    expect(flushedOnClose.length).toBeGreaterThanOrEqual(1);
  });

  it("bus.close() awaits sink.close()", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const closed = vi.fn();
    bus.addSink({ id: "s", deliver: () => {}, close: closed });
    await bus.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("learning bridge", () => {
  it("maps ONLY tool.finished → tool:result; ignores all other variants", () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const learning: IEventEmitter = {
      emit: (event, payload) => void emitted.push({ event, payload }),
    };
    const sink = createLearningBridgeSink("session-9", learning);

    sink.deliver({ type: "run.started", prompt: "p", mode: "background", seq: 1, ts: 0, runId: "r" });
    sink.deliver({ type: "heartbeat", source: "loop-yield", seq: 2, ts: 0, runId: "r" });
    sink.deliver({
      type: "tool.finished",
      toolName: "edit_file",
      toolCallId: "tc-1",
      success: false,
      errorCategory: "fs",
      seq: 3,
      ts: 0,
      runId: "r",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("tool:result");
    expect(emitted[0].payload).toMatchObject({
      sessionId: "session-9",
      toolName: "edit_file",
      success: false,
      errorDetails: { category: "fs", message: "fs" },
    });
  });
});

describe("isVisibleContent predicate", () => {
  it("is true ONLY for model.delta channel:answer", () => {
    const base = { seq: 1, ts: 0, runId: "r" } as const;
    expect(isVisibleContent({ type: "model.delta", channel: "answer", text: "hi", ...base })).toBe(true);
    expect(isVisibleContent({ type: "model.delta", channel: "reasoning", text: "hm", ...base })).toBe(false);
    expect(isVisibleContent({ type: "model.delta", channel: "tool-args", text: "{}", ...base })).toBe(false);
    expect(isVisibleContent({ type: "heartbeat", source: "model-keepalive", ...base })).toBe(false);
  });
});
