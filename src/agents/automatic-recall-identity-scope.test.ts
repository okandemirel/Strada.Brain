/**
 * Item 3.9 (audit 05.cap / 13F4 / D66) — automatic semantic recall must carry an
 * identity scope.
 *
 * Both automatic recall paths (the per-turn context build and the in-run
 * MemoryRefresher) called `retrieve` with the chat id at best and no user or
 * project identity, so a memory belonging to one person surfaced in another
 * person's turn. These tests drive the real shared filter
 * (`matchesRetrievalFilters`), so they measure what the backends actually
 * return, not just the shape of the options object.
 */

import { describe, it, expect, vi } from "vitest";
import { buildContextLayers, type ContextBuilderDeps } from "./orchestrator-context-builder.js";
import { MemoryRefresher } from "./memory-refresher.js";
import { SessionManager, type SessionManagerDeps } from "./orchestrator-session-manager.js";
import {
  matchesRetrievalFilters,
  toRetrievalFilters,
  type FilterableEntry,
} from "../memory/retrieval-filters.js";
import type { IMemoryManager, RetrievalResult } from "../memory/memory.interface.js";
import type { ReRetrievalConfig } from "../config/config.js";

const PROJECT = "/projects/pixelflow";
const CHAT = "chat-1";

const ALICE_NOTE = "alice ships from the staging branch";
const BOB_NOTE = "bob keeps his build under /Users/bob";
const PROJECT_NOTE = "this repo builds with pnpm";
const SHARED_NOTE = "the daemon restarts with pkill tsx";
const BOB_PROJECT_NOTE = "bob's private note about this repo";
const OTHER_PROJECT_NOTE = "the other repo builds with gradle";

type TestEntry = FilterableEntry & { id: string; content: string };

function entry(over: Partial<TestEntry> & { content: string }): TestEntry {
  return {
    id: `mem-${over.content.slice(0, 8)}`,
    type: "note",
    tags: [],
    importance: "medium",
    archived: false,
    createdAt: Date.now(),
    chatId: CHAT,
    metadata: {},
    ...over,
  } as TestEntry;
}

/** The two-user fixture: one private memory each, one project fact, one shared note. */
function fixture(): TestEntry[] {
  return [
    entry({ content: ALICE_NOTE, userId: "alice" }),
    entry({ content: BOB_NOTE, userId: "bob" }),
    entry({ content: PROJECT_NOTE, type: "project", projectId: PROJECT, chatId: undefined }),
    entry({ content: SHARED_NOTE, shared: true, chatId: undefined }),
    // Project-typed but owned: the chat bypass project knowledge gets must not
    // become a hole in the user comparison.
    entry({
      content: BOB_PROJECT_NOTE,
      type: "project",
      projectId: PROJECT,
      userId: "bob",
      chatId: undefined,
    }),
    entry({
      content: OTHER_PROJECT_NOTE,
      type: "project",
      projectId: "/projects/elsewhere",
      chatId: undefined,
    }),
  ];
}

/**
 * A memory manager that answers `retrieve` through the production filter, so a
 * scope the caller fails to pass really does widen the result set.
 */
function scopedMemory(): { manager: IMemoryManager; retrieve: ReturnType<typeof vi.fn> } {
  const entries = fixture();
  const retrieve = vi.fn(async (options: object) => {
    const filters = toRetrievalFilters(options as never);
    const value: RetrievalResult[] = entries
      .filter((e) => matchesRetrievalFilters(e, filters))
      .map((e) => ({ entry: e as never, score: 0.9 as never, matchType: "semantic" as never }));
    return { kind: "ok" as const, value };
  });
  return { manager: { retrieve } as unknown as IMemoryManager, retrieve };
}

function contextDeps(manager: IMemoryManager): ContextBuilderDeps {
  return {
    systemPrompt: "base",
    defaultLanguage: "en",
    projectPath: PROJECT,
    memoryManager: manager,
    taskClassifier: { classify: () => ({ type: "general", confidence: 1 }) },
    toolDefinitions: [],
    toolMetadataByName: new Map(),
    getTaskExecutionContext: () => ({ chatId: CHAT }),
  } as unknown as ContextBuilderDeps;
}

function refreshConfig(): ReRetrievalConfig {
  return {
    enabled: true,
    interval: 5,
    topicShiftEnabled: true,
    topicShiftThreshold: 0.4,
    maxReRetrievals: 10,
    timeoutMs: 5000,
    memoryLimit: 5,
    ragTopK: 6,
  };
}

describe("automatic recall carries the identity scope (item 3.9)", () => {
  it("the per-turn context build recalls the current user's memory, not the other user's", async () => {
    const { manager } = scopedMemory();
    const forAlice = await buildContextLayers(
      contextDeps(manager),
      "goal-scope",
      "exec-scope",
      "how do we ship",
      null,
      undefined,
      { userId: "alice", projectId: PROJECT },
    );
    expect(forAlice.context).toContain(ALICE_NOTE);
    expect(forAlice.context).not.toContain(BOB_NOTE);

    const forBob = await buildContextLayers(
      contextDeps(manager),
      "goal-scope",
      "exec-scope",
      "how do we ship",
      null,
      undefined,
      { userId: "bob", projectId: PROJECT },
    );
    expect(forBob.context).toContain(BOB_NOTE);
    expect(forBob.context).not.toContain(ALICE_NOTE);
  });

  it("the per-turn context build names the identity scope in the retrieve call", async () => {
    const { manager, retrieve } = scopedMemory();
    await buildContextLayers(
      contextDeps(manager),
      "goal-scope",
      "exec-scope",
      "how do we ship",
      null,
      undefined,
      { userId: "alice", projectId: PROJECT },
    );
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: "alice", chatId: CHAT, projectId: PROJECT } }),
    );
  });

  it("project knowledge and an explicitly shared note still reach the prompt", async () => {
    const { manager } = scopedMemory();
    const built = await buildContextLayers(
      contextDeps(manager),
      "goal-scope",
      "exec-scope",
      "how do we build",
      null,
      undefined,
      { userId: "alice", projectId: PROJECT },
    );
    // Project knowledge stays its own type — it is returned because the scope
    // names its project, not because it was folded into alice's memory.
    expect(built.context).toContain(PROJECT_NOTE);
    expect(built.context).toContain(SHARED_NOTE);
  });

  it("project knowledge crossing chats is still not a way past the user or the project", async () => {
    const { manager } = scopedMemory();
    const built = await buildContextLayers(
      contextDeps(manager),
      "goal-scope",
      "exec-scope",
      "how do we build",
      null,
      undefined,
      { userId: "alice", projectId: PROJECT },
    );
    // Project-typed, this project — but bob's.
    expect(built.context).not.toContain(BOB_PROJECT_NOTE);
    // Project-typed, unowned — but another project's.
    expect(built.context).not.toContain(OTHER_PROJECT_NOTE);
  });

  it("the in-run refresher recalls the current user's memory, not the other user's", async () => {
    const config = refreshConfig();

    const alice = scopedMemory();
    const forAlice = await new MemoryRefresher(config, {
      chatId: CHAT,
      userId: "alice",
      projectId: PROJECT,
      memoryManager: alice.manager,
    }).refresh("how do we ship", "session-1");
    expect(forAlice.newMemoryContext).toContain(ALICE_NOTE);
    expect(forAlice.newMemoryContext).not.toContain(BOB_NOTE);
    expect(alice.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: "alice", chatId: CHAT, projectId: PROJECT } }),
    );

    const bob = scopedMemory();
    const forBob = await new MemoryRefresher(config, {
      chatId: CHAT,
      userId: "bob",
      projectId: PROJECT,
      memoryManager: bob.manager,
    }).refresh("how do we ship", "session-1");
    expect(forBob.newMemoryContext).toContain(BOB_NOTE);
    expect(forBob.newMemoryContext).not.toContain(ALICE_NOTE);
  });

  it("the session manager hands the run's identity to the refresher it builds", async () => {
    const { manager, retrieve } = scopedMemory();
    const sm = new SessionManager({
      channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
      interactionPolicy: { get: vi.fn() },
      activeGoalTrees: new Map(),
      pendingResumeTrees: new Map(),
      instinctRetriever: null,
      eventEmitter: null,
      memoryManager: manager,
      reRetrievalConfig: refreshConfig(),
    } as unknown as SessionManagerDeps);

    const refresher = sm.createMemoryRefresher([], CHAT, { userId: "alice", projectId: PROJECT });
    expect(refresher).not.toBeNull();
    const result = await refresher!.refresh("how do we ship", "session-1");
    expect(result.newMemoryContext).toContain(ALICE_NOTE);
    expect(result.newMemoryContext).not.toContain(BOB_NOTE);
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { userId: "alice", chatId: CHAT, projectId: PROJECT } }),
    );
  });

  it("a refresher with no identity still recalls the chat's shared memory", async () => {
    const config = refreshConfig();
    const { manager, retrieve } = scopedMemory();
    const result = await new MemoryRefresher(config, {
      chatId: CHAT,
      memoryManager: manager,
    }).refresh("how do we restart", "session-1");
    expect(result.newMemoryContext).toContain(SHARED_NOTE);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ scope: { chatId: CHAT } }));
  });
});
