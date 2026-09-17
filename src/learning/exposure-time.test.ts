/**
 * ROUND 12 #9 — `exposedAt` MUST BE WHEN THE RUN WAS SHOWN THE GUIDANCE, NOT WHEN
 * THE QUEUE GOT ROUND TO THE EVENT.
 *
 * Round 11 #8 split the two facts the ledger needs — when a run was SHOWN a rule
 * and when its credit SETTLED — so that "N run(s) applied it AFTER it was
 * retired" means a leak and not a queue hop. It then filled the exposure column
 * with `Date.now()` at the moment the tool event was PROCESSED. Tool events ride
 * the same serial queue as the settlement (round 10 #14), so processing time is
 * exactly the clock that fix was written to stop trusting: expose guidance, queue
 * its tool event, retire the guidance, then let the event be processed, and the
 * ledger reports the retired rule as still being applied. The late-credit path
 * stamped `Date.now()` for the same reason.
 *
 * The exposure now comes from where the guidance is put in front of the model —
 * {@link LearningPipeline.noteGuidanceShown}, which is also what the error
 * recovery hooks' `shownGuidance` (97f7d92d) reports — and, when nobody recorded
 * it, from the tool event's OWN timestamp, which is an in-run fact. Never from
 * the processing clock.
 *
 * Both directions are tested: a genuine post-retirement exposure is still a leak.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { PatternMatcher } from "./matching/pattern-matcher.js";
import { ConfidenceScorer } from "./scoring/confidence-scorer.js";
import { ErrorLearningHooks, type ErrorContext } from "./hooks/error-learning-hooks.js";
import { buildInstinctLedger, retireGuidance } from "./ledger.js";
import type { Instinct } from "./types.js";
import type { ToolResultEvent } from "../core/event-bus.js";
import type { TimestampMs } from "../types/index.js";

/** A fixed past clock, so "before the retirement" is not a race against the test. */
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const CHAT = "chat-exposure";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

function seeded(id: string, over: Partial<Instinct> = {}): Instinct {
  const i: Instinct = {
    id: id as Instinct["id"],
    name: "using-directive rule",
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern: "CS0246",
    action: "Add a using directive for the missing namespace",
    contextConditions: [],
    stats: { timesSuggested: 3, timesApplied: 3, timesFailed: 0, successRate: 1, averageExecutionMs: 10 },
    createdAt: T0 as TimestampMs,
    updatedAt: T0 as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
  storage.createInstinct(i);
  return i;
}

function toolEvent(over: { taskRunId?: string; ids: string[]; timestamp: number }): ToolResultEvent {
  return {
    sessionId: CHAT,
    ...(over.taskRunId ? { taskRunId: over.taskRunId } : {}),
    toolName: "dotnet_build",
    input: {},
    output: "ok",
    success: true,
    appliedInstinctIds: over.ids,
    timestamp: over.timestamp,
  } as ToolResultEvent;
}

function creditRow(instinctId: string) {
  const rows = storage.getInstinctCredits({ instinctId });
  expect(rows, "no credit row was written at all").toHaveLength(1);
  return rows[0]!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exposure-time-"));
  storage = new LearningStorage(join(dir, "learning.db"));
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
  rmSync(dir, { recursive: true, force: true });
});

describe("the exposure time comes from the prompt, not from the queue (r12 #9)", () => {
  it("PROOF: a run shown a rule before its retirement is not reported as applying it afterwards", async () => {
    const i = seeded("instinct_shown_before");

    // The guidance goes into the prompt at T0 — that is the exposure.
    pipeline.noteGuidanceShown({ sessionId: CHAT, taskRunId: "run-9a", instinctIds: [String(i.id)], shownAt: T0 });
    const event = toolEvent({ taskRunId: "run-9a", ids: [String(i.id)], timestamp: T0 + 30 * 60_000 });

    // The rule is retired while the run is still finishing...
    retireGuidance(storage, String(i.id), { reason: "trigger too wide", actor: "okan", now: T0 + HOUR });
    // ...and only then does the queue reach the run's tool event and settlement.
    await pipeline.handleToolResult(event);
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-9a");

    const row = creditRow(String(i.id));
    // TEETH: before the fix this was Date.now() at processing time — hours or
    // days after the retirement, whatever the run had actually seen.
    expect(row.exposedAt, "the exposure was stamped at processing time").toBe(T0);

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirement, "a queue hop was reported as a post-retirement application").toBe(0);
    expect(entry.effect.runsSettledAfterRetirementExposedBefore).toBe(1);
  });

  it("PROOF: with nobody recording the exposure, the EVENT's own time is used, never the processing clock", async () => {
    const i = seeded("instinct_event_time");

    // No noteGuidanceShown: the production carriers that put guidance in the
    // prompt outside this module have not been wired yet. The tool result still
    // happened inside the run, at a time the run itself recorded.
    const event = toolEvent({ taskRunId: "run-9b", ids: [String(i.id)], timestamp: T0 + 30 * 60_000 });
    retireGuidance(storage, String(i.id), { reason: "trigger too wide", actor: "okan", now: T0 + HOUR });
    await pipeline.handleToolResult(event);
    pipeline.clearRunInstinctCredits(CHAT, { success: false }, "run-9b");

    const row = creditRow(String(i.id));
    expect(row.exposedAt).toBe(T0 + 30 * 60_000);
    expect(row.timestamp, "the settlement time should still be now").toBeGreaterThan(T0 + HOUR);

    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirement).toBe(0);
  });

  it("GUARD: a run genuinely shown the rule AFTER its retirement is still reported as a leak", async () => {
    const i = seeded("instinct_real_leak");

    retireGuidance(storage, String(i.id), { reason: "trigger too wide", actor: "okan", now: T0 + HOUR });
    // Shown to a run an hour AFTER it was retired: something is still handing it
    // out, which is the one thing this measure exists to catch.
    pipeline.noteGuidanceShown({ sessionId: CHAT, taskRunId: "run-9c", instinctIds: [String(i.id)], shownAt: T0 + 2 * HOUR });
    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-9c", ids: [String(i.id)], timestamp: T0 + 2 * HOUR + 60_000 }),
    );
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-9c");

    expect(creditRow(String(i.id)).exposedAt).toBe(T0 + 2 * HOUR);
    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirement, "a real post-retirement exposure stopped being counted").toBe(1);
  });

  it("PROOF: a late event for an already-settled run is dated by the event, not by when it was processed", async () => {
    const i = seeded("instinct_late_event");

    // The run settles first (#14), then a straggler event for it arrives.
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-9d");
    retireGuidance(storage, String(i.id), { reason: "trigger too wide", actor: "okan", now: T0 + HOUR });
    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-9d", ids: [String(i.id)], timestamp: T0 + 30 * 60_000 }),
    );

    const row = creditRow(String(i.id));
    // TEETH: settleLateCredit stamped Date.now(), so every straggler read as a
    // fresh post-retirement application.
    expect(row.exposedAt, "the late credit was stamped at processing time").toBe(T0 + 30 * 60_000);
    const entry = buildInstinctLedger(storage, String(i.id), { now: T0 + 4 * HOUR })!;
    expect(entry.effect.runsAfterRetirement).toBe(0);
  });

  it("the exposure the run was shown is the EARLIEST one, and a later event does not move it", async () => {
    const i = seeded("instinct_earliest");

    pipeline.noteGuidanceShown({ sessionId: CHAT, taskRunId: "run-9e", instinctIds: [String(i.id)], shownAt: T0 });
    // A mid-run re-retrieval reports the same rule again, later.
    pipeline.noteGuidanceShown({ sessionId: CHAT, taskRunId: "run-9e", instinctIds: [String(i.id)], shownAt: T0 + HOUR });
    await pipeline.handleToolResult(
      toolEvent({ taskRunId: "run-9e", ids: [String(i.id)], timestamp: T0 + 2 * HOUR }),
    );
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, "run-9e");

    expect(creditRow(String(i.id)).exposedAt).toBe(T0);
  });

  it("a settled run's exposures are forgotten, so the next run on the chat cannot inherit them", async () => {
    const i = seeded("instinct_not_inherited");

    pipeline.noteGuidanceShown({ sessionId: CHAT, instinctIds: [String(i.id)], shownAt: T0 });
    await pipeline.handleToolResult(toolEvent({ ids: [String(i.id)], timestamp: T0 + 60_000 }));
    pipeline.clearRunInstinctCredits(CHAT, { success: true });
    expect(creditRow(String(i.id)).exposedAt).toBe(T0);

    // A SECOND run on the same chat, shown nothing: its exposure must be its own
    // event's time. Inheriting T0 would date a fresh exposure to the last run.
    const second = seeded("instinct_second_run");
    await pipeline.handleToolResult(
      toolEvent({ ids: [String(i.id), String(second.id)], timestamp: T0 + 3 * HOUR }),
    );
    pipeline.clearRunInstinctCredits(CHAT, { success: true });

    const rows = storage.getInstinctCredits({ instinctId: String(i.id) });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.exposedAt).sort()).toEqual([T0, T0 + 3 * HOUR]);
  });
});

describe("the error-recovery hooks' 'when it was shown' is the same fact (r12 #9 + 97f7d92d)", () => {
  it("guidance shown by the recovery hooks dates the tool event's credit too", async () => {
    const i = seeded("instinct_recovery_shown");
    const hooks = new ErrorLearningHooks(pipeline, new PatternMatcher(storage), new ConfidenceScorer(), storage);
    hooks.enable();

    const context: ErrorContext = {
      toolName: "dotnet_build",
      errorOutput: "error CS0246: The type or namespace name could not be found",
      analysis: { hasErrors: true, errorCount: 1, summary: "1 error", recoveryInjection: "" },
      sessionId: CHAT,
      timestamp: new Date(),
    };

    const before = Date.now();
    const shown = hooks.onBeforeErrorAnalysis(context);
    const after = Date.now();
    expect(shown.recoveryInjection.length, "fixture did not actually show the guidance").toBeGreaterThan(0);

    // The event is processed measurably later — the queue hop the whole finding
    // is about.
    await new Promise((r) => setTimeout(r, 25));
    await pipeline.handleToolResult(
      toolEvent({ ids: [String(i.id)], timestamp: Date.now() }),
    );
    pipeline.clearRunInstinctCredits(CHAT, { success: true });

    const row = creditRow(String(i.id));
    // TEETH: the exposure is the moment the hook put the guidance in the prompt,
    // not the moment the event was processed 25ms+ later.
    expect(row.exposedAt!).toBeGreaterThanOrEqual(before);
    expect(row.exposedAt!).toBeLessThanOrEqual(after);
  });
});
