/**
 * LRN-14: the append-only learning tables have a retention path, and the
 * periodic pass runs it.
 *
 * pruneInstinctCredits had no caller, and the intervention log (a row per
 * warned tool call), processed trajectories with their verdicts, and the
 * cross-session dedup markers had no retention at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.ts";
import { LearningPipeline } from "./pipeline/learning-pipeline.ts";
import { DEFAULT_LEARNING_CONFIG, type Instinct } from "./types.ts";
import type { TimestampMs } from "../types/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let storage: LearningStorage;

function count(table: string, where = "1=1"): number {
  return (storage.getDatabase()!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function trajectory(id: string, daysAgo: number, processed: boolean): void {
  const db = storage.getDatabase()!;
  db.prepare(
    `INSERT INTO trajectories (id, session_id, task_description, steps, outcome, applied_instinct_ids, created_at, processed)
     VALUES (?, 's1', 'build the scene', '[]', '{"success":true}', '[]', ?, ?)`,
  ).run(id, Date.now() - daysAgo * DAY, processed ? 1 : 0);
  db.prepare(
    `INSERT INTO verdicts (id, trajectory_id, judge_type, score, dimensions, created_at)
     VALUES (?, ?, 'automated', 0.9, '{}', ?)`,
  ).run(`verdict_${id}`, id, Date.now() - daysAgo * DAY);
}

function rule(id: string): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id,
    name: id,
    type: "tool_usage",
    status: "active",
    confidence: 0.7,
    triggerPattern: `trigger ${id}`,
    action: "verify the scene",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
  } as unknown as Instinct;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "history-retention-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("learning history retention (LRN-14)", () => {
  it("the periodic pass deletes rows older than each table's window and keeps the rest", async () => {
    const pipeline = new LearningPipeline(storage);
    const history = DEFAULT_LEARNING_CONFIG.historyRetentionDays;
    const ledger = DEFAULT_LEARNING_CONFIG.exposureRetentionDays;
    storage.createInstinct(rule("rule_history"));

    for (const [id, daysAgo] of [["old", history + 5], ["new", 1]] as const) {
      storage.logIntervention({
        id: `iv_${id}`,
        instinctId: "rule_history",
        toolName: "dotnet_build",
        tier: "warn",
        actionTaken: "warned",
        createdAt: Date.now() - daysAgo * DAY,
      });
    }
    for (const [id, daysAgo] of [["old", ledger + 5], ["new", 1]] as const) {
      storage.recordInstinctCredit({
        instinctId: "rule_history",
        sessionId: `s_${id}`,
        success: true,
        verdictScore: 0.9,
        source: "terminal",
        confidenceBefore: 0.7,
        confidenceAfter: 0.72,
        statusAt: "active",
        timestamp: Date.now() - daysAgo * DAY,
      });
    }
    trajectory("traj_old", history + 5, true);
    trajectory("traj_new", 1, true);
    storage.incrementCrossSessionHitCount("rule_history", "boot-old");
    storage.incrementCrossSessionHitCount("rule_history", "boot-new");
    storage
      .getDatabase()!
      .prepare("UPDATE instinct_scopes SET created_at = ? WHERE project_path = 'boot-old'")
      .run(Date.now() - (history + 5) * DAY);

    await (pipeline as unknown as { runPeriodicExtraction(): Promise<void> }).runPeriodicExtraction();

    expect(count("intervention_log")).toBe(1);
    expect(count("instinct_credit_log")).toBe(1);
    expect(count("trajectories", "id = 'traj_old'")).toBe(0);
    expect(count("trajectories", "id = 'traj_new'")).toBe(1);
    expect(count("verdicts", "trajectory_id = 'traj_old'")).toBe(0);
    expect(count("verdicts", "trajectory_id = 'traj_new'")).toBe(1);
    expect(count("instinct_scopes", "scope_type = 'session_hit'")).toBe(1);
    pipeline.stop();
  });

  it("a trajectory not yet learned from is kept whatever its age", () => {
    trajectory("traj_unprocessed", 1_000, false);

    expect(storage.pruneProcessedTrajectories(Date.now())).toBe(0);
    expect(count("trajectories", "id = 'traj_unprocessed'")).toBe(1);
  });
});
