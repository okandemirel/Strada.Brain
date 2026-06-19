import { describe, it, expect, afterEach } from "vitest";
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
});
