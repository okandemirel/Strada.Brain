/**
 * Round 10 #13 and #14 — WHOSE RUN IS THIS CREDIT?
 *
 * #13: the per-run credit ledger, the repair tracker and the teardown were all
 * keyed by `event.sessionId`, and production puts the CHAT id there. Two
 * supervisor wave nodes run on one Orchestrator with one chatId, so sibling runs
 * shared one ledger: the first to finish settled both runs' instincts from ITS
 * verdict and then deleted the ledger, leaving the second run with nothing to
 * debit. A failure in one run could also be "repaired" by a success in its
 * sibling, minting an error_fix instinct that was never observed to fix anything.
 *
 * #14: settlement could run BEFORE the tool events it is meant to judge. Tool
 * results reach the pipeline through an asynchronous serial queue
 * (bootstrap.ts), while the engine's teardown called the settlement directly —
 * so a queued event landing after teardown recreated pending credit that
 * nobody's verdict owned, and the next run's teardown on the same chat credited
 * it as a success.
 *
 * The run identity now travels with the tool event, the credit key, the repair
 * key, the ledger row and the teardown; settlement is ordered behind its own
 * events through the same queue; and a run's terminal verdict is retained, so a
 * late event is settled on the verdict of the run it belonged to — once.
 *
 * Guard direction: a run without a run identity (older callers, v1 revert paths)
 * behaves exactly as before, and a repair within ONE run still links.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStorage } from "../storage/learning-storage.js";
import { LearningPipeline } from "./learning-pipeline.js";
import { LearningQueue } from "./learning-queue.js";
import type { Instinct } from "../types.js";
import type { ToolResultEvent } from "../../core/event-bus.js";
import type { TimestampMs } from "../../types/index.js";

const CHAT = "chat-shared";
// Long enough to be a meaningful trigger (isMeaningfulTrigger needs >= 12 letters-ish).
const ERROR_OUTPUT =
  "error CS0103: the name BoardController does not exist in the current context";

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

function toolEvent(over: {
  sessionId?: string;
  taskRunId?: string;
  toolName?: string;
  ids?: string[];
  success?: boolean;
  input?: Record<string, unknown>;
}): ToolResultEvent {
  return {
    sessionId: over.sessionId ?? CHAT,
    ...(over.taskRunId ? { taskRunId: over.taskRunId } : {}),
    toolName: over.toolName ?? "shell",
    input: over.input ?? {},
    output: over.success === false ? ERROR_OUTPUT : "ok",
    success: over.success ?? true,
    ...(over.success === false
      ? { errorDetails: { category: "build", message: ERROR_OUTPUT } }
      : {}),
    appliedInstinctIds: over.ids ?? [],
    timestamp: Date.now(),
  } as ToolResultEvent;
}

describe("run-scoped instinct credit (round 10 #13, #14)", () => {
  let storage: LearningStorage;
  let pipeline: LearningPipeline;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "run-credit-"));
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

  // ─── #13 ────────────────────────────────────────────────────────────────────

  it("two runs in one chat settle independently, each on its own verdict", async () => {
    const i1 = seedShaped("instinct_run1");
    const i2 = seedShaped("instinct_run2");
    storage.createInstinct(i1);
    storage.createInstinct(i2);

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", ids: [String(i1.id)] }));
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-2", ids: [String(i2.id)] }));

    // The sibling that finishes first must settle ONLY its own instinct.
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-1");
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-2");

    const after1 = storage.getInstinct(i1.id)!;
    const after2 = storage.getInstinct(i2.id)!;

    expect(after1.stats.timesApplied, "run-1's instinct did not get run-1's success").toBe(1);
    expect(after1.stats.timesFailed).toBe(0);
    expect(after2.stats.timesFailed, "run-2's failure never reached run-2's instinct").toBe(1);
    expect(after2.stats.timesApplied, "run-2's instinct was credited with run-1's success").toBe(0);
  });

  it("the first sibling's teardown does not delete the other's pending credit", async () => {
    const i2 = seedShaped("instinct_survivor");
    storage.createInstinct(i2);

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-2", ids: [String(i2.id)] }));
    // run-1 tears down first, having used nothing.
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-1");

    expect(storage.getInstinct(i2.id)!.stats.timesApplied, "settled by a sibling's teardown").toBe(0);

    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-2");
    expect(storage.getInstinct(i2.id)!.stats.timesFailed).toBe(1);
  });

  it("the credit ledger row names the run that settled it", async () => {
    const i1 = seedShaped("instinct_ledger");
    storage.createInstinct(i1);

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-7", ids: [String(i1.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-7");

    const rows = storage.getInstinctCredits({ instinctId: String(i1.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(CHAT);
    expect(rows[0].taskRunId, "the ledger cannot tell two sibling runs apart").toBe("run-7");
    expect(rows[0].source).toBe("terminal");
  });

  it("a failure in one run is not repaired by a success in its sibling", async () => {
    const before = storage.getInstincts({ type: "error_fix" }).length;

    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-1", toolName: "file_edit", success: false, input: { file_path: "/src/Board.cs" } }),
    );
    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-2", toolName: "file_edit", success: true, input: { file_path: "/src/Board.cs" } }),
    );

    const after = storage.getInstincts({ type: "error_fix" }).length;
    expect(after, "a sibling run's success was booked as the repair of this run's failure").toBe(before);
  });

  it("GUARD: a repair inside ONE run still links", async () => {
    const before = storage.getInstincts({ type: "error_fix" }).length;

    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-1", toolName: "file_edit", success: false, input: { file_path: "/src/Board.cs" } }),
    );
    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-1", toolName: "file_edit", success: true, input: { file_path: "/src/Board.cs" } }),
    );

    const after = storage.getInstincts({ type: "error_fix" }).length;
    expect(after, "the run repaired its own failure and learned nothing from it").toBeGreaterThan(before);
  });

  it("GUARD: without a run identity the chat is still the scope (unchanged behaviour)", async () => {
    const i = seedShaped("instinct_legacy_key");
    storage.createInstinct(i);

    await pipeline.handleToolResult(toolEvent({ ids: [String(i.id)] }));
    await pipeline.handleToolResult(toolEvent({ ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true });
    await pipeline.handleToolResult(toolEvent({ ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true });

    expect(storage.getInstinct(i.id)!.stats.timesApplied).toBe(2);
  });

  // ─── #14 ────────────────────────────────────────────────────────────────────

  it("terminal settlement waits behind the tool events it is meant to judge", async () => {
    const i = seedShaped("instinct_ordering");
    storage.createInstinct(i);

    const queue = new LearningQueue();
    pipeline.setSettlementBarrier((task) => {
      queue.enqueue(async () => {
        await task();
      });
    });

    // The production shape: the tool result goes onto the serial queue, and the
    // engine's teardown fires without awaiting it.
    queue.enqueue(async () => {
      await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", ids: [String(i.id)] }));
    });
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-1");

    // Drain: a marker enqueued last resolves only after everything before it —
    // shutdown() would DISCARD the queued settlement instead of running it.
    await new Promise<void>((resolve) => {
      queue.enqueue(async () => {
        resolve();
      });
    });
    await queue.shutdown();

    const after = storage.getInstinct(i.id)!;
    expect(after.stats.timesFailed, "the run's own failing verdict never judged its event").toBe(1);
    expect(after.stats.timesApplied).toBe(0);

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0].taskRunId).toBe("run-1");
    expect(rows[0].success).toBe(false);
  });

  it("teardown does not evict a repair the run's own queued events were about to link", async () => {
    const before = storage.getInstincts({ type: "error_fix" }).length;

    const queue = new LearningQueue();
    pipeline.setSettlementBarrier((task) => {
      queue.enqueue(async () => {
        await task();
      });
    });

    // Both halves of one repair are already on the queue when the run tears down.
    // Settled directly, the teardown evicts the pending failure BETWEEN them and
    // the repair the run actually performed is never learned (#14).
    queue.enqueue(async () => {
      await pipeline.handleToolResult(
        toolEvent({ taskRunId: "run-1", toolName: "file_edit", success: false, input: { file_path: "/src/Board.cs" } }),
      );
    });
    queue.enqueue(async () => {
      await pipeline.handleToolResult(
        toolEvent({ taskRunId: "run-1", toolName: "file_edit", success: true, input: { file_path: "/src/Board.cs" } }),
      );
    });
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-1");

    await new Promise<void>((resolve) => {
      queue.enqueue(async () => {
        resolve();
      });
    });
    await queue.shutdown();

    const after = storage.getInstincts({ type: "error_fix" }).length;
    expect(after, "the teardown evicted the run's own pending failure before its repair arrived")
      .toBeGreaterThan(before);
  });

  it("an event that lands after teardown is settled on its own run's verdict, once", async () => {
    const i = seedShaped("instinct_late");
    storage.createInstinct(i);

    // run-1 ends failed. Its event arrives afterwards.
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-1");
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", ids: [String(i.id)] }));

    const afterLate = storage.getInstinct(i.id)!;
    expect(afterLate.stats.timesFailed, "the late event was credited to nobody's verdict").toBe(1);
    expect(afterLate.stats.timesApplied).toBe(0);

    // A later, successful run on the SAME chat must not adopt run-1's evidence.
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-2", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-2");

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    const run1 = rows.filter((r) => r.taskRunId === "run-1");
    const run2 = rows.filter((r) => r.taskRunId === "run-2");

    expect(run1, "run-1 settled more than once").toHaveLength(1);
    expect(run1[0].success, "run-1's terminal verdict was overwritten by a later run").toBe(false);
    expect(run2).toHaveLength(1);
    expect(run2[0].success).toBe(true);
  });

  it("a second late event for a settled run does not settle it twice", async () => {
    const i = seedShaped("instinct_twice");
    storage.createInstinct(i);

    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-1");
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", toolName: "shell", ids: [String(i.id)] }));
    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", toolName: "file_read", ids: [String(i.id)] }));

    expect(storage.getInstinct(i.id)!.stats.timesFailed).toBe(1);
    expect(storage.getInstinctCredits({ instinctId: String(i.id) })).toHaveLength(1);
  });

  it("GUARD: a run whose events all arrive in time is unaffected by the retention", async () => {
    const i = seedShaped("instinct_intime");
    storage.createInstinct(i);

    await pipeline.handleToolResult(toolEvent({ taskRunId: "run-1", ids: [String(i.id)] }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-1");

    const after = storage.getInstinct(i.id)!;
    expect(after.stats.timesApplied).toBe(1);
    expect(after.stats.timesFailed).toBe(0);
    expect(storage.getInstinctCredits({ instinctId: String(i.id) })).toHaveLength(1);
  });
});
