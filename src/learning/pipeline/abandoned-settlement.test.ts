/**
 * ROUND 13 #22 — A SETTLEMENT THAT REPORTED "HANDLED" AND WROTE NOTHING.
 *
 * Two classes of work share the learning queue. Tool events are DROPPABLE
 * (evicted on overflow, discarded when shutdown's drain runs out of budget) and
 * the run's terminal settlement is DURABLE (never evicted; abandoned only with a
 * synchronous `onAbandoned` fallback that settles it here and now).
 *
 * That split assumed the two were independent. They are not: the fact the
 * settlement settles — WHICH GUIDANCE THIS RUN WAS CARRYING — arrives only with
 * the tool event. Drop the event and the fallback runs, finds no pending credit,
 * writes ZERO credit rows, and the shutdown report says the settlement was
 * handled by its fallback. A false green about the one measurement that says
 * whether learning works.
 *
 * The fix is ordering: the credit-bearing half of a tool event is registered
 * synchronously, at emit time, before the droppable work is enqueued.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPipeline } from "./learning-pipeline.js";
import { LearningQueue } from "./learning-queue.js";
import { LearningStorage } from "../storage/learning-storage.js";
import { TypedEventBus, type LearningEventMap } from "../../core/event-bus.js";

let dir: string;
let storage: LearningStorage;
let bus: TypedEventBus<LearningEventMap>;
let queue: LearningQueue;
let pipeline: LearningPipeline;

const SESSION = "session-abandoned";
const RUN = "run-abandoned";
const RULE = "cs0006-build-dependency";

/** A gate the test opens by hand, so "the processor is blocked" is deterministic. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let the serial queue empty, without shutting it down. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 200 && queue.stats().queued > 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abandoned-settlement-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  storage.createInstinct({
    id: RULE,
    name: RULE,
    type: "error_fix" as const,
    status: "active" as const,
    confidence: 0.8,
    triggerPattern: "error CS0006",
    action: "Build the dependency project first",
    contextConditions: [],
    stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1 },
    bayesianAlpha: 4,
    bayesianBeta: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  bus = new TypedEventBus<LearningEventMap>();
  // Wired exactly as bootstrap wires it: the pipeline is built first (so its own
  // listeners are registered first), then the queueing subscriber, then the
  // settlement barrier.
  pipeline = new LearningPipeline(storage, {}, undefined, undefined, bus);
  queue = new LearningQueue({ maxQueueSize: 2 });
  bus.on("tool:result", (event) => {
    queue.enqueue(async () => {
      await pipeline.handleToolResult(event);
    });
  });
  pipeline.setSettlementBarrier((task, options) =>
    queue.enqueue(async () => {
      await task();
    }, { durable: true, ...options }),
  );
});

afterEach(async () => {
  pipeline.stop();
  await queue.shutdown();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a run whose tool event the queue could not carry", () => {
  it("still settles the credit the event reported when shutdown's budget runs out", async () => {
    // The processor is blocked and STAYS blocked: shutdown's deadline expires
    // with the tool event still queued, which is how the event is discarded.
    const blocker = gate();
    queue.enqueue(async () => {
      await blocker.wait;
    });

    bus.emit("tool:result", {
      sessionId: SESSION,
      taskRunId: RUN,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [RULE],
      timestamp: Date.now(),
    });

    // The run ends. Its settlement goes on the same queue, behind the event.
    pipeline.clearRunInstinctCredits(SESSION, { success: true, verdictScore: 1 }, RUN);

    const report = await queue.shutdown({ deadlineMs: 1 });
    // The settlement was abandoned to its synchronous fallback, and the report
    // says it was handled there.
    expect(report.durableAbandoned).toBe(1);
    expect(report.abandonedWithoutFallback).toBe(0);
    blocker.open();

    // THE TEETH: the fallback said it handled the settlement, so this is the row
    // it wrote. Before the fix it was empty — the event carrying "this run was
    // shown RULE" was discarded, the pending map was empty, and the settlement
    // wrote nothing while reporting that it had handled it.
    const credits = storage.getInstinctCredits({ instinctId: RULE });
    expect(credits).toHaveLength(1);
    expect(credits[0]!.source).toBe("terminal");
    expect(credits[0]!.success).toBe(true);
    expect(credits[0]!.taskRunId).toBe(RUN);
  });

  it("still settles it when the event is evicted to make room", async () => {
    const blocker = gate();
    queue.enqueue(async () => {
      await blocker.wait;
    });

    bus.emit("tool:result", {
      sessionId: SESSION,
      taskRunId: RUN,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [RULE],
      timestamp: Date.now(),
    });
    // Two more observations past the bound of two: the OLDEST droppable item is
    // evicted, and that is the tool event.
    queue.enqueue(async () => {});
    queue.enqueue(async () => {});

    pipeline.clearRunInstinctCredits(SESSION, { success: true, verdictScore: 1 }, RUN);
    blocker.open();
    await settleQueue();

    const credits = storage.getInstinctCredits({ instinctId: RULE });
    expect(credits).toHaveLength(1);
    expect(credits[0]!.source).toBe("terminal");
  });

  it("does not double-credit when the event is carried after all", async () => {
    bus.emit("tool:result", {
      sessionId: SESSION,
      taskRunId: RUN,
      toolName: "dotnet_build",
      input: { file_path: "/fixture/App.csproj" },
      output: "Build succeeded",
      success: true,
      appliedInstinctIds: [RULE],
      timestamp: Date.now(),
    });
    // The queue drains normally, so handleToolResult registers the same credit a
    // second time. Once per run, not once per registration.
    await settleQueue();
    pipeline.clearRunInstinctCredits(SESSION, { success: true, verdictScore: 1 }, RUN);
    await settleQueue();

    expect(storage.getInstinctCredits({ instinctId: RULE })).toHaveLength(1);
  });
});
