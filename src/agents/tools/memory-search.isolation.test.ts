/**
 * memory_search against the real AgentDB backend, two users on one memory.
 *
 * The tool used to ignore the caller's chat and user, and the AgentDB adapter
 * dropped `types` on its text path, so Bob could read Alice's DM through
 * memory_search, with or without a type filter. The mocked-manager tests in
 * memory-search.test.ts only checked what the tool sent, never what came back.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "../../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../../memory/unified/agentdb-adapter.js";
import { MemoryTier } from "../../memory/unified/unified-memory.interface.js";
import type { ChatId, DurationMs } from "../../types/index.js";
import { createToolContext } from "../../test-helpers.js";
import { MemorySearchTool } from "./memory-search.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const DIMS = 8;

/** Deterministic bag-of-words vector, so the HNSW path runs without a provider. */
async function hashEmbedding(text: string): Promise<number[]> {
  const v = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS]! += 1;
  }
  return v.some((x) => x !== 0) ? v : v.map(() => 1);
}

let dir: string;
const open: AgentDBMemory[] = [];

afterEach(async () => {
  for (const memory of open.splice(0)) await memory.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-search-isolation-"));
});

const ALICE = { userId: "alice", chatId: "alice-dm" };
const BOB = { userId: "bob", chatId: "bob-dm" };

async function twoUserMemory(withVectors: boolean): Promise<MemorySearchTool> {
  const memory = new AgentDBMemory({
    dbPath: join(dir, withVectors ? "vec" : "text"),
    dimensions: DIMS,
    maxEntriesPerTier: { [MemoryTier.Working]: 50, [MemoryTier.Ephemeral]: 50, [MemoryTier.Persistent]: 50 },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 60_000 as DurationMs,
    ...(withVectors ? { embeddingProvider: hashEmbedding } : {}),
  });
  open.push(memory);
  expect((await memory.initialize()).kind).toBe("ok");
  const adapter = new AgentDBAdapter(memory);

  const stored = await Promise.all([
    adapter.storeConversation(
      ALICE.chatId as ChatId,
      "Alice said her bank pin hint is the lighthouse and she is quitting the studio",
    ),
    adapter.storeNote("Alice private note: lighthouse pin hint, quitting the studio soon", {
      chatId: ALICE.chatId as ChatId,
      userId: ALICE.userId,
    }),
    adapter.storeConversation(
      BOB.chatId as ChatId,
      "Bob said his locker code hint is the windmill and he wants a raise",
    ),
    adapter.storeNote("Bob private note: windmill locker code hint, asking for a raise", {
      chatId: BOB.chatId as ChatId,
      userId: BOB.userId,
    }),
  ]);
  for (const r of stored) expect(r.kind).toBe("ok");

  return new MemorySearchTool(adapter);
}

describe.each([
  ["text index", false],
  ["vector index", true],
])("memory_search isolates users on a real AgentDB (%s)", (_label, withVectors) => {
  it("does not return Alice's conversation or note to Bob, with or without a type filter", async () => {
    const tool = await twoUserMemory(withVectors);
    const bob = createToolContext(BOB);

    for (const input of [
      { query: "lighthouse pin hint quitting studio", limit: 10 },
      { query: "lighthouse pin hint quitting studio", limit: 10, type: "note" },
      { query: "lighthouse pin hint quitting studio", limit: 10, type: "conversation" },
    ]) {
      const result = await tool.execute(input, bob);
      expect(result.isError).toBeUndefined();
      expect(result.content).not.toContain("lighthouse");
      expect(result.content).not.toContain("alice-dm");
    }
  });

  it("does not return Bob's conversation or note to Alice", async () => {
    const tool = await twoUserMemory(withVectors);
    const alice = createToolContext(ALICE);

    for (const input of [
      { query: "windmill locker code hint raise", limit: 10 },
      { query: "windmill locker code hint raise", limit: 10, type: "note" },
    ]) {
      const result = await tool.execute(input, alice);
      expect(result.isError).toBeUndefined();
      expect(result.content).not.toContain("windmill");
      expect(result.content).not.toContain("bob-dm");
    }
  });

  it("still returns each user's own entries, and the type filter keeps only that type", async () => {
    const tool = await twoUserMemory(withVectors);
    const bob = createToolContext(BOB);

    const all = await tool.execute({ query: "windmill locker code hint raise", limit: 10 }, bob);
    expect(all.content).toContain("[CONVERSATION]");
    expect(all.content).toContain("[NOTE]");

    const notes = await tool.execute({ query: "windmill locker code hint raise", limit: 10, type: "note" }, bob);
    expect(notes.content).toContain("[NOTE]");
    expect(notes.content).not.toContain("[CONVERSATION]");
  });
});
