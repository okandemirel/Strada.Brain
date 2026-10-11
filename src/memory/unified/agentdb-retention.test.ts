/**
 * Retention under the default memory config (audit memory-rag#3).
 *
 * Defaults: MEMORY_AUTO_TIERING=false, MEMORY_TIER_WORKING_MAX=100,
 * MEMORY_DECAY_ENABLED=true. Every completed turn stores a conversation
 * summary in the Working tier, and only the auto-tiering sweep ever moved a
 * Working entry out. So the Working cap hard-deleted the oldest conversation
 * memory once there were 100 of them across all chats, and decay — which ran
 * only inside that sweep — never ran while the stats said it was enabled.
 *
 * These run the real AgentDBMemory/AgentDBAdapter (and the real
 * initializeMemory) on a temp dir and read the result back after a restart.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as winston from "winston";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory, _setNowFn, _resetNowFn } from "./agentdb-memory.js";
import { AgentDBAdapter } from "./agentdb-adapter.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UnifiedMemoryConfig } from "./unified-memory.interface.js";
import { initializeMemory } from "../../core/bootstrap-memory.js";
import type { Config } from "../../config/config.js";
import type { ChatId, TimestampMs } from "../../types/index.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const CHAT = "chat-1" as ChatId;

let dir: string;
const open: AgentDBMemory[] = [];

function memoryAt(dbPath: string, limits: { working: number; persistent: number }): AgentDBMemory {
  // The bootstrap config shape (bootstrap-memory.ts), with small caps.
  const config: Partial<UnifiedMemoryConfig> = {
    dbPath,
    dimensions: 8,
    maxEntriesPerTier: {
      [MemoryTier.Working]: limits.working,
      [MemoryTier.Ephemeral]: 1000,
      [MemoryTier.Persistent]: limits.persistent,
    },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 86_400_000 as never,
  };
  const memory = new AgentDBMemory(config);
  open.push(memory);
  return memory;
}

function conversations(memory: AgentDBMemory): Array<{ content: string; tier: MemoryTier }> {
  return [...memory.getConsolidationInternals().entries.values()]
    .filter((e) => e.type === "conversation")
    .map((e) => ({ content: e.content, tier: e.tier }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdb-retention-"));
});

afterEach(async () => {
  _resetNowFn();
  for (const memory of open.splice(0)) await memory.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("Working tier overflow (memory-rag#3)", () => {
  it("keeps every conversation past the Working cap: the overflow moves to Persistent, across a restart", async () => {
    const memory = memoryAt(dir, { working: 10, persistent: 10_000 });
    expect((await memory.initialize()).kind).toBe("ok");
    const adapter = new AgentDBAdapter(memory);

    for (let i = 0; i < 15; i++) {
      expect((await adapter.storeConversation(CHAT, `turn ${i} summary`)).kind).toBe("ok");
    }

    const stored = conversations(memory);
    expect(stored.map((c) => c.content).sort()).toEqual(
      Array.from({ length: 15 }, (_, i) => `turn ${i} summary`).sort(),
    );
    expect(stored.filter((c) => c.tier === MemoryTier.Working)).toHaveLength(10);
    // The oldest go first: all rows tie on importance and access.
    expect(stored.filter((c) => c.tier === MemoryTier.Persistent).map((c) => c.content).sort()).toEqual(
      ["turn 0 summary", "turn 1 summary", "turn 2 summary", "turn 3 summary", "turn 4 summary"],
    );

    await memory.shutdown();
    const reopened = memoryAt(dir, { working: 10, persistent: 10_000 });
    expect((await reopened.initialize()).kind).toBe("ok");
    expect(conversations(reopened)).toHaveLength(15);
  });

  it("deletes only past the Persistent cap, lowest-scoring first", async () => {
    const memory = memoryAt(dir, { working: 10, persistent: 10 });
    expect((await memory.initialize()).kind).toBe("ok");
    const adapter = new AgentDBAdapter(memory);
    const note = await memory.storeNote("critical: the release key lives in the vault", [], MemoryTier.Persistent);

    for (let i = 0; i < 25; i++) {
      expect((await adapter.storeConversation(CHAT, `turn ${i} summary`)).kind).toBe("ok");
    }

    const entries = memory.getConsolidationInternals().entries;
    const byTier = (tier: MemoryTier) => [...entries.values()].filter((e) => e.tier === tier);
    expect(byTier(MemoryTier.Working)).toHaveLength(10);
    expect(byTier(MemoryTier.Persistent)).toHaveLength(10);
    // A note outranks the conversation summaries that overflowed into its tier.
    expect(entries.has(note.id as string)).toBe(true);
  });
});

describe("decay with auto-tiering off (memory-rag#3)", () => {
  function config(dbPath: string): Config {
    // The defaults that matter here: auto-tiering off, decay on.
    return {
      memory: {
        enabled: true,
        dbPath,
        backend: "agentdb",
        unified: {
          dimensions: 8,
          autoTiering: false,
          autoTieringIntervalMs: 20,
          promotionThreshold: 5,
          demotionTimeoutDays: 7,
          tierLimits: { working: 100, ephemeral: 1000, persistent: 10000 },
          ephemeralTtlHours: 24,
        },
        decay: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.05, persistent: 0.01 },
          exemptDomains: ["instinct", "analysis-cache"],
          timeoutMs: 30000,
        },
      },
    } as unknown as Config;
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;

  it("decays a stale entry although the auto-tiering sweep never runs", async () => {
    const manager = await initializeMemory(config(dir), logger);
    expect(manager).toBeInstanceOf(AgentDBAdapter);
    const memory = (manager as AgentDBAdapter).getAgentDBMemory();
    open.push(memory);

    const tenDaysAgo = Date.now() - 10 * 86_400_000;
    _setNowFn(() => tenDaysAgo as TimestampMs);
    const stored = await (manager as AgentDBAdapter).storeConversation(CHAT, "an old conversation");
    _resetNowFn();
    expect(stored.kind).toBe("ok");
    const id = stored.kind === "ok" ? (stored.value as string) : "";
    const entry = memory.getConsolidationInternals().entries.get(id)!;
    const before = entry.importanceScore;

    await vi.waitFor(() => {
      expect(entry.importanceScore).toBeLessThan(before);
    }, { timeout: 2000, interval: 20 });

    // exp(-0.1 * 10 days) of the stored score, not compounded per pass.
    expect(entry.importanceScore).toBeCloseTo(before * Math.exp(-1), 2);
    // Decay is not tiering: a 10-day-stale Working entry stays in Working.
    expect(entry.tier).toBe(MemoryTier.Working);
    expect(memory.getDecayStats().enabled).toBe(true);
  });
});
