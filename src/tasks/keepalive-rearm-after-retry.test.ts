/**
 * N-1 (keep-alive half) — a mission whose keep-alive retry already SUCCEEDED must not be re-armed.
 *
 * Found by the CLI release smoke: a task blocked on a provider outage armed its keep-alive, the
 * retry fired 30 s later and completed — and 90 s after boot the "orphaned by restart" re-arm
 * picked the still-blocked original row up again ("keep-alive re-armed after restart. Auto-retry
 * 2/10 in ~60s") and would have resubmitted the finished mission a second time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "./types.js";
import { TaskStatus } from "./types.js";
import type { AgentRunResult } from "../agent-core/runner/index.js";

vi.mock("../utils/logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLoggerSafe: () => log, getLogger: () => log };
});

// The executor always runs through the AgentRunner seam; this run is the outage the smoke hit.
vi.mock("../agent-core/runner/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-core/runner/index.js")>();
  const blocked = {
    status: "blocked",
    reason: "blocked:provider_unavailable",
    finalText: "",
    finalSummary: "The AI provider has been unreliable for this task.",
    provider: "kimi",
    catalogVersion: "kimi:default",
    assignmentVersion: 0,
    touchedFiles: [],
    toolTrace: [],
    verificationResults: [],
    reviewFindings: [],
    artifacts: [],
  } as unknown as AgentRunResult;
  return { ...actual, selectAgentRunner: () => ({ run: async () => blocked }) };
});

const { BackgroundExecutor } = await import("./background-executor.js");
const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");

type Row = Task & { result?: string };

function mission(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id: id as Task["id"],
    chatId: "cli-local",
    channelType: "cli",
    title: "provider fallback",
    status: TaskStatus.pending,
    prompt: "Run the provider fallback check and reply.",
    progress: [],
    createdAt: 1,
    updatedAt: 1,
    origin: "user",
    ...overrides,
  } as Row;
}

/** A task store with real retry lineage (parentId), whose retries complete. */
function taskStore(rows: Row[]) {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  let seq = 0;
  const set = (id: string, patch: Partial<Row>): void => {
    const row = byId.get(id);
    if (row) Object.assign(row, patch, { updatedAt: Date.now() });
  };
  const rootOf = (id: string): string => {
    let row = byId.get(id);
    while (row?.parentId && byId.has(String(row.parentId))) row = byId.get(String(row.parentId));
    return String(row?.id ?? id);
  };
  const inLineage = (rootId: string, row: Row): boolean => rootOf(String(row.id)) === rootId;
  return {
    byId,
    updateStatus: vi.fn((id: string, status: TaskStatus) => set(id, { status })),
    complete: vi.fn((id: string, result: string) => set(id, { status: TaskStatus.completed, result })),
    fail: vi.fn((id: string, error: string) => set(id, { status: TaskStatus.failed, result: error })),
    block: vi.fn((id: string, result: string) => set(id, { status: TaskStatus.blocked, result })),
    appendTaskNotice: vi.fn(),
    getStatus: (id: string) => byId.get(id) ?? null,
    listTasks: (chatId: string) => [...byId.values()].filter((r) => r.chatId === chatId),
    listRecoverableTasks: () => [...byId.values()].filter((r) => r.status === TaskStatus.blocked),
    findLineageRootId: (id: string) => rootOf(id),
    findLatestLineageTask: (rootId: string) =>
      [...byId.values()].filter((r) => inLineage(rootId, r)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    // The keep-alive's retry: a continuation in the same lineage, which then succeeds.
    retryTask: vi.fn((id: string) => {
      const parent = byId.get(id);
      if (!parent) return null;
      seq += 1;
      const child = mission(`task_retry_${seq}`, {
        parentId: parent.id,
        prompt: parent.prompt,
        status: TaskStatus.completed,
        result: "provider fallback ok",
        createdAt: Date.now() + seq,
      });
      byId.set(String(child.id), child);
      return child;
    }),
  };
}

describe("mission keep-alive re-arm after a successful retry", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    ProviderHealthRegistry.resetInstance();
  });

  it("does not re-arm a task this process blocked once its keep-alive retry has completed", async () => {
    const original = mission("task_original");
    const store = taskStore([original]);
    const executor = new BackgroundExecutor({ orchestrator: {} as never });
    executor.setTaskManager(store as never); // arms the 90 s boot re-arm sweep

    executor.enqueue(original, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    // The outage parks the mission with its keep-alive, as the smoke saw.
    expect(original.status).toBe(TaskStatus.blocked);
    expect(original.result).toMatch(/Auto-retry 1\/10 in ~30s/);

    // The keep-alive fires and its retry completes.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(store.retryTask).toHaveBeenCalledTimes(1);

    // The boot sweep (90 s) and any retry it would arm (≤ 60 s later).
    await vi.advanceTimersByTimeAsync(200_000);
    expect(store.retryTask).toHaveBeenCalledTimes(1);
    expect(store.block).not.toHaveBeenCalledWith("task_original", expect.stringContaining("re-armed after restart"));
    await executor.shutdown();
  });

  it("after a real restart, skips a blocked task whose retry in the lineage completed", async () => {
    // The previous process blocked the original and its retry completed; the row still says blocked.
    const original = mission("task_original", {
      status: TaskStatus.blocked,
      result: "Transient failure — The AI provider has been unreliable for this task. Auto-retry 1/10 in ~30s.",
    });
    const retry = mission("task_retry", {
      parentId: original.id,
      status: TaskStatus.completed,
      result: "provider fallback ok",
      createdAt: 2,
    });
    const other = mission("task_other", {
      chatId: "cli-other",
      prompt: "An unrelated mission that is still waiting.",
      status: TaskStatus.blocked,
      result: "Transient failure — All providers are in cooldown. Auto-retry 2/10 in ~60s.",
    });
    const store = taskStore([original, retry, other]);
    const executor = new BackgroundExecutor({ orchestrator: {} as never });
    executor.setTaskManager(store as never);

    await vi.advanceTimersByTimeAsync(91_000 + 45_000);

    expect(store.block).not.toHaveBeenCalledWith("task_original", expect.anything());
    // The sweep itself still works: a genuinely orphaned mission is re-armed.
    expect(store.block).toHaveBeenCalledWith("task_other", expect.stringContaining("re-armed after restart"));
    await executor.shutdown();
  });
});
