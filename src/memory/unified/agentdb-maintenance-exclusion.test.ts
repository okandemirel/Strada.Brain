/**
 * MEM-10: AgentDB's SQLite init opened memory.db, checkpointed and possibly
 * REINDEXed it, and only then (inside configureSqlitePragmas) asked whether a
 * restore held the maintenance exclusion. Any failure after the open also
 * replaced the handle with an in-memory fallback without closing it, so
 * memory.db stayed attached for the life of the process.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { acquireMaintenanceExclusion, attachedDatabaseUser } from "../../core/database-backup.js";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

let dir: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdb-exclusion-"));
  home = join(dir, "strada-home");
  mkdirSync(home, { recursive: true });
  previousHome = process.env["STRADA_HOME"];
  process.env["STRADA_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["STRADA_HOME"];
  else process.env["STRADA_HOME"] = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

function memoryAt(dbPath: string): AgentDBMemory {
  return new AgentDBMemory({
    dbPath,
    dimensions: 8,
    maxEntriesPerTier: { [MemoryTier.Working]: 5, [MemoryTier.Ephemeral]: 5, [MemoryTier.Persistent]: 5 },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 60_000,
  });
}

describe("AgentDB SQLite init and the maintenance exclusion (MEM-10)", () => {
  it("does not open (or create) memory.db while a restore holds the exclusion", async () => {
    const dbPath = join(dir, "agentdb");
    const held = acquireMaintenanceExclusion(home, "restore");
    const memory = memoryAt(dbPath);
    try {
      const result = await memory.initialize();
      expect(result.kind).toBe("err");
      expect(existsSync(join(dbPath, "memory.db"))).toBe(false);
    } finally {
      held.release();
      await memory.shutdown();
    }
  });

  it("closes the file handle before falling back to an in-memory database", async () => {
    const dbPath = join(dir, "agentdb");
    mkdirSync(dbPath, { recursive: true });
    const file = join(dbPath, "memory.db");
    // A memory.db whose schema step fails after the open: indexes cannot be
    // created on a view named `memories`.
    const seed = new Database(file);
    seed.exec("CREATE VIEW memories AS SELECT 1 AS id");
    seed.close();

    const memory = memoryAt(dbPath);
    try {
      await memory.initialize();
      expect(attachedDatabaseUser(file)).toBeUndefined();
    } finally {
      await memory.shutdown();
    }
  });
});
