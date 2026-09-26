/**
 * Per-agent memories embed with the root memory's embedder.
 *
 * AgentManager opened every agent's AgentDB memory with no embedding provider,
 * so agent memories only ever held hash-fallback vectors. They now get the
 * same embedder config bootstrap gives the root memory, and the hash rows they
 * already hold are re-embedded in the background: in small paced batches,
 * never blocking agent start, resuming across restarts.
 *
 * Real AgentDBMemory on a temp dir; only the Orchestrator (and the task
 * plumbing AgentManager imports) is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager, type AgentManagerOptions } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import type { AgentConfig } from "./agent-types.js";
import { TypedEventBus } from "../../core/event-bus.js";
import type { LearningEventMap } from "../../core/event-bus.js";
import type { IncomingMessage } from "../../channels/channel-messages.interface.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { Orchestrator } from "../orchestrator.js";
import type { AgentDBMemory } from "../../memory/unified/agentdb-memory.js";
import type { MemoryEmbeddingConfig } from "../../memory/unified/unified-memory.interface.js";
import type { Vector } from "../../types/index.js";

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return { ...actual, getLogger: () => logger, getLoggerSafe: () => logger };
});

vi.mock("../orchestrator.js", () => ({
  Orchestrator: vi.fn().mockImplementation(function () {
    return {
      handleMessage: vi.fn().mockResolvedValue("mock response"),
      cleanupSessions: vi.fn(),
      dispose: vi.fn(),
      setTaskManager: vi.fn(),
      setWorkspaceBus: vi.fn(),
      setMonitorLifecycle: vi.fn(),
    };
  }),
}));
vi.mock("../../tasks/message-router.js", () => ({
  MessageRouter: vi.fn().mockImplementation(function () {
    return { route: vi.fn().mockResolvedValue(undefined) };
  }),
}));
vi.mock("../../tasks/command-handler.js", () => ({
  CommandHandler: vi.fn().mockImplementation(function () { return {}; }),
}));
vi.mock("../../tasks/task-manager.js", () => ({
  TaskManager: vi.fn().mockImplementation(function () { return { submit: vi.fn() }; }),
}));

const CONFIG_DIMS = 16;
const PROVIDER_DIMS = 8;
const PROVIDER_ID = "fake:model:8d";
const ROWS = 10;

/** Deterministic "neural" vector: signed components, so never hash-shaped. */
function fakeVector(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 100_003;
  const v = Array.from({ length: PROVIDER_DIMS }, (_, i) => Math.sin(seed * (i + 1) + i));
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / norm);
}

function rowText(i: number): string {
  return `agent note ${i} about zebra${i} migration`;
}

interface FakeProvider {
  config: MemoryEmbeddingConfig;
  single: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  batchCalls: Array<{ texts: string[]; at: number }>;
}

function makeProvider(onBatch?: (callIndex: number) => Promise<void> | void): FakeProvider {
  const batchCalls: Array<{ texts: string[]; at: number }> = [];
  const single = vi.fn(async (text: string) => fakeVector(text));
  const batch = vi.fn(async (texts: string[]) => {
    batchCalls.push({ texts, at: Date.now() });
    await onBatch?.(batchCalls.length);
    return texts.map(fakeVector);
  });
  return {
    config: {
      dimensions: PROVIDER_DIMS,
      embeddingProvider: single,
      embeddingProviderBatch: batch,
      embeddingProviderId: PROVIDER_ID,
    },
    single,
    batch,
    batchCalls,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const agentConfig: AgentConfig = {
  enabled: true,
  defaultBudgetUsd: 5,
  maxConcurrent: 10,
  idleTimeoutMs: 0,
  maxMemoryEntries: 1000,
};

const msg: IncomingMessage = {
  channelType: "web",
  chatId: "chat-1",
  userId: "user-1",
  text: "Hello",
  timestamp: new Date(),
};

/** The AgentDBMemory behind the most recently built agent orchestrator. */
function lastAgentMemory(): AgentDBMemory {
  const opts = vi.mocked(Orchestrator).mock.calls.at(-1)![0] as unknown as {
    memoryManager: { getAgentDBMemory(): AgentDBMemory };
  };
  return opts.memoryManager.getAgentDBMemory();
}

function entriesOf(memory: AgentDBMemory): Array<{ id: string; content: string; embedding: number[]; embeddingProvenance?: string }> {
  return [...(memory as unknown as { entries: Map<string, { id: string; content: string; embedding: number[]; embeddingProvenance?: string }> }).entries.values()];
}

function infoLines(): string[] {
  return logger.info.mock.calls.map((c) => String(c[0]));
}

describe("AgentManager per-agent memory embedder", () => {
  let tmpDir: string;
  let db: Database.Database;
  let registry: AgentRegistry;
  let daemonStorage: DaemonStorage;
  let budgetTracker: AgentBudgetTracker;
  let eventBus: TypedEventBus<LearningEventMap>;
  const managers: AgentManager[] = [];

  function makeManager(memoryConfig: Partial<AgentManagerOptions["memoryConfig"]> = {}): AgentManager {
    const manager = new AgentManager({
      config: agentConfig,
      registry,
      budgetTracker,
      eventBus,
      providerManager: {} as never,
      toolRegistry: { getAllTools: () => [] } as never,
      channel: { sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: "/fake/project",
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
      stradaDeps: { installed: false, version: undefined } as never,
      memoryConfig: { dimensions: CONFIG_DIMS, dbBasePath: tmpDir, ...memoryConfig },
    });
    managers.push(manager);
    return manager;
  }

  /** Previous release: the agent memory has no embedder and stores hash rows. */
  async function seedHashRows(): Promise<void> {
    const manager = makeManager();
    await manager.routeMessage(msg);
    const memory = lastAgentMemory();
    for (let i = 0; i < ROWS; i++) await memory.storeNote(rowText(i), ["seed"]);
    await manager.shutdown();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "agent-mem-embed-"));
    db = new Database(":memory:");
    registry = new AgentRegistry(db);
    registry.initialize();
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    eventBus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    await eventBus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens an agent memory with the root memory's embedder: provider vectors at its size and provenance", async () => {
    const provider = makeProvider();
    const manager = makeManager({ embedding: provider.config });
    await manager.routeMessage(msg);
    const memory = lastAgentMemory();

    const note = await memory.storeNote("the agent remembers the lighthouse", ["t"]);
    const stored = entriesOf(memory).find((e) => e.id === (note.id as string))!;

    expect(provider.single).toHaveBeenCalledWith("the agent remembers the lighthouse");
    expect(stored.embeddingProvenance).toBe(PROVIDER_ID);
    expect(stored.embedding).toHaveLength(PROVIDER_DIMS);
    // A brand-new memory has nothing to re-embed: no pass, no log line.
    await manager.whenMemoryReEmbedIdle();
    expect(provider.batch).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes("Agent memory re-embed"))).toBe(false);
  });

  it("re-embeds old hash rows in bounded, paced batches without blocking agent start; they become vector-searchable", async () => {
    await seedHashRows();

    const gate = deferred();
    const firstBatchStarted = deferred();
    const provider = makeProvider(async (call) => {
      if (call === 1) {
        firstBatchStarted.resolve();
        await gate.promise;
      }
    });
    const manager = makeManager({ embedding: provider.config, reEmbed: { batchSize: 3, pauseMs: 30 } });

    // Agent start returns while the first batch is still held open.
    await expect(manager.routeMessage(msg)).resolves.toBe("mock response");
    const memory = lastAgentMemory();
    await firstBatchStarted.promise;
    expect(memory.countEntriesAwaitingReEmbed()).toBe(ROWS);

    // Not re-embedded yet: out of the vector index, found by text search.
    const target = rowText(7);
    const byVectorBefore = await memory.retrieveByEmbedding(fakeVector(target) as Vector<number>, { limit: ROWS });
    expect(byVectorBefore.map((r) => r.entry.content)).not.toContain(target);
    const byTextBefore = await memory.retrieveSemantic("zebra7", { limit: 3 });
    expect(byTextBefore.map((r) => r.entry.content)).toContain(target);

    gate.resolve();
    await manager.whenMemoryReEmbedIdle();

    // Bounded: never more than batchSize texts per provider call, every row once.
    expect(provider.batchCalls.map((c) => c.texts.length)).toEqual([3, 3, 3, 1]);
    expect(new Set(provider.batchCalls.flatMap((c) => c.texts)).size).toBe(ROWS);
    // Paced: each batch waits pauseMs after the one before it.
    for (let i = 1; i < provider.batchCalls.length; i++) {
      expect(provider.batchCalls[i]!.at - provider.batchCalls[i - 1]!.at).toBeGreaterThanOrEqual(25);
    }

    for (const entry of entriesOf(memory)) {
      expect(entry.embeddingProvenance).toBe(PROVIDER_ID);
      expect(entry.embedding).toHaveLength(PROVIDER_DIMS);
    }
    expect(memory.countEntriesAwaitingReEmbed()).toBe(0);
    // Vector path only (empty query text): the row is now in the index.
    const byVectorAfter = await memory.retrieveByEmbedding(fakeVector(target) as Vector<number>, { limit: 1 });
    expect(byVectorAfter.map((r) => r.entry.content)).toEqual([target]);

    expect(infoLines().filter((l) => l.includes("Agent memory re-embed started"))).toEqual([
      `[AgentManager] Agent memory re-embed started: ${ROWS} rows to re-embed`,
    ]);
    expect(infoLines().filter((l) => l.includes("Agent memory re-embed finished"))).toEqual([
      `[AgentManager] Agent memory re-embed finished: ${ROWS}/${ROWS} rows re-embedded`,
    ]);
  });

  it("a restart resumes with the rows left and never redoes finished ones", async () => {
    await seedHashRows();

    // Boot 1 with the embedder: shut down right after the first batch.
    const firstBatch = deferred();
    const boot1 = makeProvider((call) => { if (call === 1) firstBatch.resolve(); });
    const manager1 = makeManager({ embedding: boot1.config, reEmbed: { batchSize: 3, pauseMs: 30 } });
    await manager1.routeMessage(msg);
    await firstBatch.promise;
    await manager1.shutdown();

    expect(boot1.batchCalls.map((c) => c.texts.length)).toEqual([3]);
    expect(infoLines()).toContain("[AgentManager] Agent memory re-embed stopped: 3/10 rows re-embedded");
    const doneInBoot1 = new Set(boot1.batchCalls[0]!.texts);

    // Boot 2: only the seven rows left go to the provider.
    const boot2 = makeProvider();
    const manager2 = makeManager({ embedding: boot2.config, reEmbed: { batchSize: 3, pauseMs: 0 } });
    await manager2.routeMessage(msg);
    await manager2.whenMemoryReEmbedIdle();
    const sentInBoot2 = boot2.batchCalls.flatMap((c) => c.texts);
    expect(sentInBoot2).toHaveLength(ROWS - 3);
    expect(sentInBoot2.filter((t) => doneInBoot1.has(t))).toEqual([]);
    expect(lastAgentMemory().countEntriesAwaitingReEmbed()).toBe(0);
    await manager2.shutdown();

    // Boot 3: nothing left, so no provider call and no pass.
    logger.info.mockClear();
    const boot3 = makeProvider();
    const manager3 = makeManager({ embedding: boot3.config, reEmbed: { batchSize: 3, pauseMs: 0 } });
    await manager3.routeMessage(msg);
    await manager3.whenMemoryReEmbedIdle();
    expect(boot3.batch).not.toHaveBeenCalled();
    expect(boot3.single).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes("Agent memory re-embed started"))).toBe(false);
  });

  it("without a provider an agent memory keeps hash-fallback vectors at the configured size (unchanged)", async () => {
    const manager = makeManager();
    await manager.routeMessage(msg);
    const memory = lastAgentMemory();

    const note = await memory.storeNote("no embedder configured here", ["t"]);
    const stored = entriesOf(memory).find((e) => e.id === (note.id as string))!;

    expect(stored.embeddingProvenance).toBe("histogram");
    expect(stored.embedding).toHaveLength(CONFIG_DIMS);
    expect(memory.countEntriesAwaitingReEmbed()).toBe(0);
    await manager.whenMemoryReEmbedIdle();
    expect(infoLines().some((l) => l.includes("Agent memory re-embed"))).toBe(false);
  });
});
