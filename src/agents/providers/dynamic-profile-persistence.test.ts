import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDynamicProfilePersistence } from "./dynamic-profile-persistence.js";
import { DynamicBehavioralProfileStore } from "./dynamic-behavioral-profiles.js";
import type { PhaseOutcome } from "../../agent-core/routing/routing-types.js";
import { BehavioralDimension } from "./provider-behavioral-profiles.js";

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "strada-dynprof-"));
  tempDirs.push(dir);
  return join(dir, "dynamic-profiles.db");
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function outcome(ts: number): PhaseOutcome {
  return {
    provider: "claude", model: "claude-opus-4-8", role: "executor", phase: "executing",
    source: "supervisor-strategy", status: "approved", reason: "ok",
    task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
    timestamp: ts,
  };
}

describe("SqliteDynamicProfilePersistence", () => {
  it("persists accumulators across store instances (survives restart)", async () => {
    const path = tempDbPath();
    const persistA = new SqliteDynamicProfilePersistence(path);
    const storeA = new DynamicBehavioralProfileStore(persistA);
    for (let i = 0; i < 15; i++) storeA.ingest(outcome(1000 + i));
    await storeA.flush();
    const blendedA = storeA.getBlendedProfile("claude", "claude-opus-4-8")!;
    persistA.close();

    // New process simulation: fresh persistence + store on the same file.
    const persistB = new SqliteDynamicProfilePersistence(path);
    const storeB = new DynamicBehavioralProfileStore(persistB);
    await storeB.initialize();
    const blendedB = storeB.getBlendedProfile("claude", "claude-opus-4-8")!;
    persistB.close();

    expect(blendedB.scores[BehavioralDimension.toolCallReliability]).toBeCloseTo(
      blendedA.scores[BehavioralDimension.toolCallReliability], 6,
    );
  });

  it("a full-state save replaces prior rows (no stale accumulation)", async () => {
    const path = tempDbPath();
    const persist = new SqliteDynamicProfilePersistence(path);
    persist.save([
      { key: "claude", dimension: "toolCallReliability", ema: 0.9, samples: 5, updatedAt: 1 },
      { key: "groq", dimension: "fastExecution", ema: 0.8, samples: 3, updatedAt: 1 },
    ]);
    persist.save([
      { key: "claude", dimension: "toolCallReliability", ema: 0.5, samples: 9, updatedAt: 2 },
    ]);
    const rows = persist.load();
    persist.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("claude");
    expect(rows[0]!.ema).toBeCloseTo(0.5, 6);
    expect(rows[0]!.samples).toBe(9);
  });

  it("loads empty on a fresh database", () => {
    const path = tempDbPath();
    const persist = new SqliteDynamicProfilePersistence(path);
    expect(persist.load()).toEqual([]);
    persist.close();
  });

  // audited 2026-09-02: the table had no count column, so every restart showed
  // "obs 0" beside a confidence and drift computed from the restored samples.
  it("carries observationCount across a restart through SQLite", async () => {
    const path = tempDbPath();
    const persistA = new SqliteDynamicProfilePersistence(path);
    const storeA = new DynamicBehavioralProfileStore(persistA);
    for (let i = 0; i < 40; i++) storeA.ingest(outcome(1000 + i));
    await storeA.flush();
    persistA.close();

    const persistB = new SqliteDynamicProfilePersistence(path);
    const storeB = new DynamicBehavioralProfileStore(persistB);
    await storeB.initialize();
    persistB.close();
    expect(storeB.getSnapshot("claude", "claude-opus-4-8")!.observationCount).toBe(40);
  });

  it("upgrades a database created before the observations column existed", () => {
    const path = tempDbPath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE dynamic_behavioral_profiles (
        key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        ema REAL NOT NULL,
        samples REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, dimension)
      );
      INSERT INTO dynamic_behavioral_profiles VALUES ('claude', 'toolCallReliability', 0.9, 5, 1);
    `);
    legacy.close();

    const persist = new SqliteDynamicProfilePersistence(path);
    const rows = persist.load();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observations).toBe(0);
    persist.save([{ key: "claude", dimension: "toolCallReliability", ema: 0.9, samples: 5, updatedAt: 1, observations: 7 }]);
    expect(persist.load()[0]!.observations).toBe(7);
    persist.close();
  });
});
