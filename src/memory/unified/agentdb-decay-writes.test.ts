/**
 * What a decay pass writes to memory.db (review of memory-rag#3).
 *
 * Decay is on by default and runs every MEMORY_AUTO_TIERING_INTERVAL_MS
 * (5 minutes). Each pass moves almost every score a little — the Persistent
 * lambda of 0.01/day needs about a year to reach the 0.01 floor — and every
 * moved entry was persisted by rewriting its whole memories row, embedding
 * blob included (6 KB at 1536 dims): about 65 MB per pass at 10k entries.
 *
 * These run the real AgentDBMemory on a temp dir and count the bytes SQLite
 * appends to the WAL during one pass, with automatic checkpoints off.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory, _setNowFn, _resetNowFn } from "./agentdb-memory.js";
import { decaySweep, type AgentDBTieringContext } from "./agentdb-tiering.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UnifiedMemoryConfig } from "./unified-memory.interface.js";
import type { MemoryId, NormalizedScore, TimestampMs } from "../../types/index.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const DAY = 86_400_000;
const DIMS = 1536;
const ROWS = 200;

let dir: string;
const open: AgentDBMemory[] = [];

async function memoryAt(dbPath: string): Promise<AgentDBMemory> {
  const config: Partial<UnifiedMemoryConfig> = {
    dbPath,
    dimensions: DIMS,
    maxEntriesPerTier: {
      [MemoryTier.Working]: 1000,
      [MemoryTier.Ephemeral]: 1000,
      [MemoryTier.Persistent]: 10_000,
    },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 86_400_000 as never,
  };
  const memory = new AgentDBMemory(config);
  open.push(memory);
  expect((await memory.initialize()).kind).toBe("ok");
  // The production defaults (config-schema.ts).
  memory.setDecayConfig({
    enabled: true,
    lambdas: { working: 0.1, ephemeral: 0.05, persistent: 0.01 },
    exemptDomains: [],
    timeoutMs: 30_000,
  });
  return memory;
}

function tieringCtx(memory: AgentDBMemory): AgentDBTieringContext {
  return (memory as unknown as { getTieringCtx(): AgentDBTieringContext }).getTieringCtx();
}

/** Bytes SQLite appends to memory.db-wal while `run` executes. */
function walBytes(memory: AgentDBMemory, run: () => void): number {
  const db = memory.getConsolidationInternals().sqliteDb!;
  db.pragma("wal_autocheckpoint = 0");
  db.pragma("wal_checkpoint(TRUNCATE)");
  run();
  return statSync(join(dir, "memory.db-wal")).size;
}

/** The store as a crash right now would leave it, reopened. */
async function reopenSnapshot(memory: AgentDBMemory): Promise<AgentDBMemory> {
  const copy = join(dir, "after-crash");
  mkdirSync(copy);
  const db = memory.getConsolidationInternals().sqliteDb!;
  db.exec(`VACUUM INTO '${join(copy, "memory.db").replace(/'/g, "''")}'`);
  return memoryAt(copy);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdb-decay-writes-"));
});

afterEach(async () => {
  _resetNowFn();
  for (const memory of open.splice(0)) await memory.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("decay pass write volume", () => {
  async function storedNotes(t0: number): Promise<AgentDBMemory> {
    _setNowFn(() => t0 as TimestampMs);
    const memory = await memoryAt(dir);
    for (let i = 0; i < ROWS; i++) {
      await memory.storeNote(`persistent note ${i} about the build pipeline`, [], MemoryTier.Persistent);
    }
    const entries = memory.getConsolidationInternals().entries;
    expect(entries.size).toBe(ROWS);
    expect([...entries.values()][0]!.embedding).toHaveLength(DIMS);
    return memory;
  }

  it("a pass that moves every score writes the scores, not the rows", async () => {
    const t0 = Date.now();
    const memory = await storedNotes(t0);
    const entries = memory.getConsolidationInternals().entries;
    const before = new Map([...entries.values()].map((e) => [e.id as string, e.importanceScore]));

    // 30 days unaccessed: every Persistent score drops by about a quarter.
    _setNowFn(() => (t0 + 30 * DAY) as TimestampMs);
    const written = walBytes(memory, () => decaySweep(tieringCtx(memory)));
    for (const e of entries.values()) {
      expect(e.importanceScore).toBeCloseTo(before.get(e.id as string)! * Math.exp(-0.3), 6);
    }
    // Each row carries a 6144-byte embedding, and rewriting a row rewrites its
    // pages: the whole-row upsert cost about 8.3 KB per decayed entry.
    expect(written / ROWS, `decay pass wrote ${written} B for ${ROWS} rows`).toBeLessThan(600);
  });

  it("a 5-minute pass writes nothing while no score has moved by the epsilon, and still decays in memory", async () => {
    const t0 = Date.now();
    const memory = await storedNotes(t0);
    const entries = memory.getConsolidationInternals().entries;
    const ctx = tieringCtx(memory);
    _setNowFn(() => (t0 + 30 * DAY) as TimestampMs);
    decaySweep(ctx);

    // The next pass moves each score by about 2e-6.
    _setNowFn(() => (t0 + 30 * DAY + 5 * 60_000) as TimestampMs);
    const scores = [...entries.values()].map((e) => e.importanceScore);
    const written = walBytes(memory, () => decaySweep(ctx));
    expect(written, `5-minute pass wrote ${written} B for ${ROWS} rows`).toBe(0);
    [...entries.values()].forEach((e, i) => {
      expect(e.importanceScore).toBeLessThan(scores[i]!);
      expect(e.decayedAt).toBe(t0 + 30 * DAY + 5 * 60_000);
    });
  });

  it("a crash after a pass reloads the decayed score", async () => {
    const t0 = Date.now();
    _setNowFn(() => t0 as TimestampMs);
    const memory = await memoryAt(dir);
    const note = await memory.storeNote("a persistent note about release signing", [], MemoryTier.Persistent);
    const entry = memory.getConsolidationInternals().entries.get(note.id as string)!;
    const stored = entry.importanceScore;

    _setNowFn(() => (t0 + 30 * DAY) as TimestampMs);
    decaySweep(tieringCtx(memory));
    expect(entry.importanceScore).toBeCloseTo(stored * Math.exp(-0.3), 6);

    const reopened = await reopenSnapshot(memory);
    const loaded = reopened.getConsolidationInternals().entries.get(note.id as string)!;
    expect(loaded.importanceScore).toBeCloseTo(entry.importanceScore, 6);
    expect(loaded.decayedAt).toBe(t0 + 30 * DAY);

    // Reloaded, the next pass decays only the time since, not the 30 days again.
    _setNowFn(() => (t0 + 31 * DAY) as TimestampMs);
    decaySweep(tieringCtx(reopened));
    expect(loaded.importanceScore).toBeCloseTo(stored * Math.exp(-0.31), 6);
  });

  it("a whole-row write after a pass outranks the score the pass persisted", async () => {
    const t0 = Date.now();
    _setNowFn(() => t0 as TimestampMs);
    const memory = await memoryAt(dir);
    const note = await memory.storeNote("a persistent note about the CI cache", [], MemoryTier.Persistent);

    _setNowFn(() => (t0 + 30 * DAY) as TimestampMs);
    decaySweep(tieringCtx(memory));
    expect((await memory.updateImportance(note.id as MemoryId, 0.9 as NormalizedScore)).kind).toBe("ok");

    const reopened = await reopenSnapshot(memory);
    expect(reopened.getConsolidationInternals().entries.get(note.id as string)!.importanceScore).toBe(0.9);
  });
});
