/**
 * MEM-17: AgentDBAdapter's updateEntry, resolveError and archiveOldEntries
 * called a `persistEntry` method AgentDBMemory did not have; the adapter
 * tests mocked it, so the break never showed. These run against a real
 * AgentDBMemory on a temp dir and read the result back after a restart.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { AgentDBAdapter } from "./agentdb-adapter.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { MemoryId, TimestampMs } from "../../types/index.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz123456";

let dir: string;
const open: AgentDBMemory[] = [];

function memoryAt(dbPath: string): AgentDBMemory {
  const memory = new AgentDBMemory({
    dbPath,
    dimensions: 8,
    maxEntriesPerTier: { [MemoryTier.Working]: 20, [MemoryTier.Ephemeral]: 20, [MemoryTier.Persistent]: 20 },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 60_000,
  });
  open.push(memory);
  return memory;
}

async function reopen(dbPath: string, memory: AgentDBMemory): Promise<AgentDBMemory> {
  await memory.shutdown();
  const again = memoryAt(dbPath);
  expect((await again.initialize()).kind).toBe("ok");
  return again;
}

async function storedMetadata(memory: AgentDBMemory, id: MemoryId): Promise<Record<string, unknown>> {
  const found = await memory.getById(id);
  if (found.kind !== "ok" || found.value.kind !== "some") throw new Error(`entry ${id as string} not found`);
  return (found.value.value.metadata ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdb-adapter-persist-"));
});

afterEach(async () => {
  for (const memory of open.splice(0)) await memory.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("AgentDBAdapter write-backs against a real AgentDBMemory (MEM-17)", () => {
  it("resolveError persists the resolution (redacted) across a restart", async () => {
    const dbPath = join(dir, "db");
    const memory = memoryAt(dbPath);
    expect((await memory.initialize()).kind).toBe("ok");
    const adapter = new AgentDBAdapter(memory);

    const stored = await adapter.storeError(new Error("build failed"), { category: "build" });
    expect(stored.kind).toBe("ok");
    const id = (stored as { value: MemoryId }).value;

    const resolved = await adapter.resolveError(id, `rotated the leaked token ${GITHUB_TOKEN}`);
    expect(resolved.kind).toBe("ok");

    const reopened = await reopen(dbPath, memory);
    const metadata = await storedMetadata(reopened, id);
    expect(metadata["resolved"]).toBe(true);
    expect(String(metadata["resolution"])).toContain("rotated the leaked token");
    expect(JSON.stringify(metadata)).not.toContain(GITHUB_TOKEN);
  });

  it("updateEntry and archiveOldEntries persist their changes", async () => {
    const dbPath = join(dir, "db");
    const memory = memoryAt(dbPath);
    expect((await memory.initialize()).kind).toBe("ok");
    const adapter = new AgentDBAdapter(memory);

    const note = await adapter.storeNote("prefer SystemBase for ECS systems", { tags: ["ecs"] });
    expect(note.kind).toBe("ok");
    const id = (note as { value: MemoryId }).value;

    const updated = await adapter.updateEntry(id, { tags: ["ecs", "reviewed"], metadata: { reviewer: GITHUB_TOKEN } });
    expect(updated.kind).toBe("ok");
    const archived = await adapter.archiveOldEntries((Date.now() + 60_000) as TimestampMs);
    expect(archived).toEqual({ kind: "ok", value: 1 });

    const reopened = await reopen(dbPath, memory);
    const found = await reopened.getById(id);
    if (found.kind !== "ok" || found.value.kind !== "some") throw new Error("note not found after restart");
    const entry = found.value.value;
    expect(entry.tags).toEqual(["ecs", "reviewed"]);
    expect(entry.archived).toBe(true);
    expect(entry.content).toBe("prefer SystemBase for ECS systems");
    expect(JSON.stringify(entry.metadata)).not.toContain(GITHUB_TOKEN);
  });
});
