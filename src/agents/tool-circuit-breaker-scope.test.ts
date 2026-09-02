/**
 * The breaker's scope is the run, and its refusal names what it measured.
 *
 * audited 2026-09-02: every supervisor DAG node runs on the one Orchestrator
 * with the one chatId (bootstrap.ts createSupervisorExecuteNodeBridge), so
 * `toolConsecutiveErrors` keyed by chatId alone was one counter for the whole
 * tree: node A's twelve misses refused file_write to every later node, and
 * node B's first success erased node A's evidence. The bridge already stamps a
 * per-node taskRunId into the task execution context; the breaker keys on it.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function failingTool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "ENOENT", isError: true }),
  };
}

function orchestratorWith(tool: ReturnType<typeof failingTool>) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [tool] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/breaker-scope-test",
    readOnly: false,
    requireConfirmation: false,
  });
}

const call = (orch: Orchestrator, name: string, path: string) =>
  (
    orch as unknown as {
      executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<Array<{ content: string }>>;
    }
  ).executeToolCalls("chat1", [{ id: `t-${path}`, name, input: { path } }], { mode: "background" });

const inRun = <T>(orch: Orchestrator, taskRunId: string, run: () => Promise<T>) =>
  orch.withTaskExecutionContext({ chatId: "chat1", taskRunId }, run);

describe("breaker scope", () => {
  it("one node's misses do not disable the tool for a sibling node on the same chatId", async () => {
    const tool = failingTool("file_read");
    const orch = orchestratorWith(tool);

    await inRun(orch, "supervisor:chat1:node-a", async () => {
      for (let i = 0; i < 12; i++) await call(orch, "file_read", `a${i}.cs`);
    });
    expect(tool.execute).toHaveBeenCalledTimes(12);

    tool.execute.mockResolvedValue({ content: "ok" });
    const [siblingResult] = await inRun(orch, "supervisor:chat1:node-b", () =>
      call(orch, "file_read", "b0.cs"),
    );

    expect(tool.execute, "node B was refused for node A's failures").toHaveBeenCalledTimes(13);
    expect(siblingResult?.content).toBe("ok");
  });

  it("the refusal names the count, the target, the run scope and the retry window", async () => {
    const tool = failingTool("file_read");
    const orch = orchestratorWith(tool);

    const results = await inRun(orch, "run:x", async () => {
      const out: string[] = [];
      for (let i = 0; i < 4; i++) {
        const [r] = await call(orch, "file_read", "same.cs");
        out.push(r?.content ?? "");
      }
      return out;
    });

    const refusal = results[3] ?? "";
    expect(refusal).toContain("failed 3 consecutive times on 'same.cs'");
    expect(refusal).toContain("in this run");
    expect(refusal).toMatch(/one retry is admitted after \d+s/);
  });

  it("outside a run the scope named is the conversation", async () => {
    const tool = failingTool("file_read");
    const orch = orchestratorWith(tool);
    let refusal = "";
    for (let i = 0; i < 4; i++) {
      const [r] = await call(orch, "file_read", "same.cs");
      refusal = r?.content ?? "";
    }
    expect(refusal).toContain("in this conversation");
  });
});
