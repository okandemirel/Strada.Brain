/**
 * ROUND 11 #7 — A RUN'S TERMINAL SETTLEMENT IS NOT DROPPABLE WORK.
 *
 * Round 10 #14 put terminal settlement on the learning queue so it would run
 * BEHIND the tool events it judges. That queue was built for observations: it is
 * a bounded FIFO that drops its OLDEST item on overflow, and its shutdown
 * discards everything still queued. So the ordering fix handed the one event
 * that must never be lost to the one place designed to lose it:
 *
 *  - under queue pressure the settlement is evicted as "oldest", the run never
 *    receives terminal credit, and the verdict is never retained — so a late
 *    event for that run has nothing to settle against either;
 *  - at shutdown a queued settlement is discarded outright.
 *
 * A lifecycle settlement is now DURABLE: never evicted to make room, and drained
 * at shutdown together with the observations queued ahead of it (which is what
 * keeps the ordering guarantee #14 bought). Observations stay droppable — they
 * are the unbounded stream, and the bound exists for them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStorage } from "../storage/learning-storage.js";
import { LearningPipeline } from "./learning-pipeline.js";
import { LearningQueue } from "./learning-queue.js";
import type { Instinct } from "../types.js";
import type { ToolResultEvent } from "../../core/event-bus.js";
import type { TimestampMs } from "../../types/index.js";

const CHAT = "chat-pressure";

function seedShaped(id: string): Instinct {
  return {
    id: id as Instinct["id"],
    name: "Seed-shaped",
    type: "error_fix",
    status: "active",
    confidence: 0.5,
    triggerPattern: "Any tool",
    action: "Do the thing",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: Date.now() as TimestampMs,
    updatedAt: Date.now() as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
  };
}

function toolEvent(over: { taskRunId?: string; ids?: string[] }): ToolResultEvent {
  return {
    sessionId: CHAT,
    ...(over.taskRunId ? { taskRunId: over.taskRunId } : {}),
    toolName: "shell",
    input: {},
    output: "ok",
    success: true,
    appliedInstinctIds: over.ids ?? [],
    timestamp: Date.now(),
  } as ToolResultEvent;
}

/**
 * The production wiring (bootstrap.ts): observations droppable, settlement not,
 * and — round 12 #7/#8 — the queue's answer returned and the pipeline's
 * label/fallback forwarded, so work the queue cannot carry is not swallowed.
 */
function wire(pipeline: LearningPipeline, queue: LearningQueue): void {
  pipeline.setSettlementBarrier((task, options) =>
    queue.enqueue(async () => {
      await task();
    }, { durable: true, ...options }),
  );
}

describe("LearningQueue: lifecycle work is non-droppable (r11 #7)", () => {
  let queue: LearningQueue;

  afterEach(async () => {
    if (queue) await queue.shutdown();
  });

  it("PROOF: a durable item is not evicted when the queue overflows", async () => {
    queue = new LearningQueue({ maxQueueSize: 3 });
    const order: string[] = [];

    // Block the processor so everything else piles up behind it.
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("blocker");
    });

    queue.enqueue(async () => { order.push("settlement"); }, { durable: true });
    for (let i = 1; i <= 5; i++) {
      queue.enqueue(async () => { order.push(`observation-${i}`); });
    }

    await new Promise((r) => setTimeout(r, 200));

    // TEETH: FIFO eviction dropped the oldest queued item, which was the
    // settlement — it was enqueued first and every later observation pushed it
    // closer to the front.
    expect(order, "the settlement was evicted as the oldest queued item").toContain("settlement");
    // The bound still holds: later observations went instead.
    expect(order.filter((o) => o.startsWith("observation")).length).toBeLessThan(5);
  });

  it("PROOF: shutdown drains a queued durable item instead of discarding it", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("blocker");
    });
    queue.enqueue(async () => { order.push("observation"); });
    queue.enqueue(async () => { order.push("settlement"); }, { durable: true });

    await new Promise((r) => setTimeout(r, 5));
    await queue.shutdown();

    // TEETH: shutdown() set stopped=true, awaited the in-flight blocker and
    // threw the rest away, settlement included.
    expect(order).toContain("settlement");
    // Ordering survives the drain: the observation the settlement judges ran first.
    expect(order).toEqual(["blocker", "observation", "settlement"]);
  });

  it("GUARD: observations are still droppable and still bounded", async () => {
    queue = new LearningQueue({ maxQueueSize: 2 });
    const order: string[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("blocker");
    });
    for (let i = 1; i <= 4; i++) {
      queue.enqueue(async () => { order.push(`observation-${i}`); });
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(["blocker", "observation-3", "observation-4"]);
  });

  it("the production wiring marks terminal settlement durable, and forwards the queue's answer", () => {
    // The guarantee above is worth nothing if the one line in bootstrap.ts that
    // requests it goes away. There is no seam to drive that file through, so the
    // line itself is pinned: it is the whole of the fix at the call site.
    const bootstrap = readFileSync(new URL("../../core/bootstrap.ts", import.meta.url), "utf8");
    const barrier = bootstrap.slice(bootstrap.indexOf("pipeline.setSettlementBarrier("));
    const wiring = barrier.slice(0, 400);
    expect(wiring).toContain("durable: true");
    // Round 12 #7/#8: the barrier RETURNS what the queue answered and forwards
    // the pipeline's label/fallback. Without both, a refused or abandoned
    // settlement is swallowed exactly as it was before.
    expect(wiring).toContain("...options");
    expect(wiring.replace(/\s+/g, " ")).toMatch(/=>\s*learningQueue\.enqueue\(/);
  });

  it("GUARD: shutdown still discards trailing observations once nothing durable is left", async () => {
    queue = new LearningQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("blocker");
    });
    queue.enqueue(async () => { order.push("discarded-1"); });
    queue.enqueue(async () => { order.push("discarded-2"); });

    await new Promise((r) => setTimeout(r, 5));
    await queue.shutdown();
    expect(order).toEqual(["blocker"]);
  });
});

describe("every run settles exactly once, under pressure and at shutdown (r11 #7)", () => {
  let storage: LearningStorage;
  let pipeline: LearningPipeline;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lifecycle-settlement-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
  });

  afterEach(() => {
    pipeline.stop();
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("PROOF: a run under queue pressure still gets its terminal credit, exactly once", async () => {
    const i = seedShaped("instinct_pressure");
    storage.createInstinct(i);

    const queue = new LearningQueue({ maxQueueSize: 3 });
    wire(pipeline, queue);

    // Block the processor, register this run's applied instinct, then let the
    // engine tear the run down and bury the settlement under later events.
    queue.enqueue(async () => { await new Promise((r) => setTimeout(r, 40)); });
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-1");
    for (let n = 0; n < 6; n++) {
      queue.enqueue(async () => { await Promise.resolve(); });
    }

    await new Promise((r) => setTimeout(r, 250));
    await queue.shutdown();

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows, "the run's settlement was dropped on overflow — no terminal credit").toHaveLength(1);
    expect(rows[0]!.taskRunId).toBe("run-1");
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.source).toBe("terminal");
    expect(storage.getInstinct(i.id)!.stats.timesFailed).toBe(1);
  });

  it("PROOF: a settlement still queued when the daemon shuts down is drained, not discarded", async () => {
    const i = seedShaped("instinct_shutdown");
    storage.createInstinct(i);

    const queue = new LearningQueue();
    wire(pipeline, queue);

    queue.enqueue(async () => { await new Promise((r) => setTimeout(r, 40)); });
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-2", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-2");

    await new Promise((r) => setTimeout(r, 5));
    await queue.shutdown();

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows, "shutdown discarded the queued settlement").toHaveLength(1);
    expect(rows[0]!.success).toBe(true);
    expect(storage.getInstinct(i.id)!.stats.timesApplied).toBe(1);
  });

  it("r12 #7: a settlement the queue REFUSES at its durable bound is still recorded, exactly once", async () => {
    const first = seedShaped("instinct_bound_first");
    const refused = seedShaped("instinct_bound_refused");
    storage.createInstinct(first);
    storage.createInstinct(refused);

    // One durable slot, and a blocked processor so it cannot free up.
    const queue = new LearningQueue({ maxQueueSize: 4, maxDurableQueueSize: 1 });
    wire(pipeline, queue);
    queue.enqueue(async () => { await new Promise((r) => setTimeout(r, 60)); });

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-bound-1", ids: [String(first.id)] }));
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-bound-2", ids: [String(refused.id)] }));

    // run-bound-1 takes the only durable slot; run-bound-2's settlement is
    // refused — and must not be swallowed by the refusal.
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-bound-1");
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-bound-2");

    // TEETH: the refused run has ALREADY settled, here, before the queue drains.
    const early = storage.getInstinctCredits({ instinctId: String(refused.id) });
    expect(early, "the refused settlement was dropped: no terminal credit").toHaveLength(1);
    expect(early[0]!.taskRunId).toBe("run-bound-2");
    expect(early[0]!.success).toBe(false);
    expect(storage.getInstinctCredits({ instinctId: String(first.id) }), "the queued settlement ran early").toHaveLength(0);

    await new Promise((r) => setTimeout(r, 120));
    await queue.shutdown();

    // And the queued one still settles normally — no double credit either way.
    expect(storage.getInstinctCredits({ instinctId: String(first.id) })).toHaveLength(1);
    expect(storage.getInstinctCredits({ instinctId: String(refused.id) })).toHaveLength(1);
    expect(storage.getInstinct(refused.id)!.stats.timesFailed).toBe(1);
    expect(storage.getInstinct(first.id)!.stats.timesApplied).toBe(1);
  });

  it("r12 #7: a barrier that refuses and runs no fallback still does not cost the run its settlement", async () => {
    const i = seedShaped("instinct_refusing_barrier");
    storage.createInstinct(i);

    // Not the learning queue: any barrier may answer "I did not take this".
    // The pipeline's contract is that the run settles regardless — the queue's
    // own fallback is a belt, this is the braces.
    let refusals = 0;
    pipeline.setSettlementBarrier(() => {
      refusals++;
      return false;
    });

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-refuse", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-refuse");

    expect(refusals).toBe(1);
    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows, "a refused settlement was swallowed by the barrier").toHaveLength(1);
    expect(rows[0]!.taskRunId).toBe("run-refuse");
    expect(rows[0]!.source).toBe("terminal");
  });

  it("GUARD: a barrier that takes the work (returning nothing) settles once, not twice", async () => {
    const i = seedShaped("instinct_legacy_barrier");
    storage.createInstinct(i);

    // The pre-round-12 barrier shape: a block body, no return value. It must
    // keep meaning "taken", or every settlement would run twice.
    const taken: Array<() => Promise<void> | void> = [];
    pipeline.setSettlementBarrier((task) => {
      taken.push(task);
    });

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-legacy", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-legacy");

    expect(storage.getInstinctCredits({ instinctId: String(i.id) }), "the barrier was bypassed").toHaveLength(0);
    await taken[0]!();
    expect(storage.getInstinctCredits({ instinctId: String(i.id) })).toHaveLength(1);
  });

  it("r12 #8: a settlement the shutdown drain cannot reach is settled by its fallback, not lost", async () => {
    const i = seedShaped("instinct_drain_budget");
    storage.createInstinct(i);

    const queue = new LearningQueue();
    wire(pipeline, queue);

    // An item that never finishes: the drain cannot get past it, and the daemon
    // used to force-exit with the settlement behind it still in memory.
    queue.enqueue(async () => new Promise<void>(() => { /* never resolves */ }));
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-drain", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-drain");

    await new Promise((r) => setTimeout(r, 5));
    const report = await queue.shutdown({ deadlineMs: 120 });

    expect(report.durableAbandoned).toBe(1);
    expect(report.abandoned[0]).toContain("run-drain");
    expect(report.abandonedWithoutFallback).toBe(0);
    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows, "the shutdown lost the pending settlement").toHaveLength(1);
    expect(rows[0]!.taskRunId).toBe("run-drain");
    expect(rows[0]!.success).toBe(true);
  }, 5000);

  it("a late event after a pressured settlement is judged by that run's retained verdict", async () => {
    const early = seedShaped("instinct_early");
    const late = seedShaped("instinct_late");
    storage.createInstinct(early);
    storage.createInstinct(late);

    const queue = new LearningQueue({ maxQueueSize: 3 });
    wire(pipeline, queue);

    queue.enqueue(async () => { await new Promise((r) => setTimeout(r, 40)); });
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-3", ids: [String(early.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-3");
    for (let n = 0; n < 6; n++) {
      queue.enqueue(async () => { await Promise.resolve(); });
    }
    await new Promise((r) => setTimeout(r, 250));

    // The straggler: it belongs to run-3, which has already settled. Without a
    // retained verdict (dropped settlement) it had nothing to settle against.
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-3", ids: [String(late.id)] }));
    await queue.shutdown();

    expect(storage.getInstinct(late.id)!.stats.timesFailed, "the late event was not judged by run-3's verdict").toBe(1);
    const rows = storage.getInstinctCredits({ instinctId: String(late.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskRunId).toBe("run-3");
  });

  it("r11 #8: the credit row records WHEN the run was shown the rule, not only when it settled", async () => {
    const i = seedShaped("instinct_exposure_time");
    storage.createInstinct(i);

    const queue = new LearningQueue();
    wire(pipeline, queue);

    // The exposure happens now; the settlement rides the queue behind a blocker
    // and lands measurably later. The ledger needs both times to tell a delayed
    // settlement apart from a run that applied a retired rule.
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-5", ids: [String(i.id)] }));
    queue.enqueue(async () => { await new Promise((r) => setTimeout(r, 40)); });
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-5");
    await queue.shutdown();

    const row = storage.getInstinctCredits({ instinctId: String(i.id) })[0]!;
    expect(row.exposedAt, "the exposure time was not recorded").toBeDefined();
    expect(row.exposedAt!).toBeLessThan(row.timestamp);
  });

  it("GUARD: the settlement still runs behind its own run's queued tool events", async () => {
    const i = seedShaped("instinct_order_guard");
    storage.createInstinct(i);

    const queue = new LearningQueue();
    wire(pipeline, queue);

    queue.enqueue(async () => {
      await pipeline.handleToolResult(toolEvent({ taskRunId: "run-4", ids: [String(i.id)] }));
    });
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-4");

    await queue.shutdown();

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.source).toBe("terminal");
  });
});
