/**
 * An interactive goal tree is settled when the run that decomposed it ends.
 *
 * audited 2026-09-02: runProactiveGoalDecomposition upserted every interactive
 * tree as 'executing' and nothing on the interactive path ever wrote a
 * terminal status — updateTreeStatus was called only from task-manager and
 * background-executor, both keyed to a task. So every substantive message
 * left a permanently 'executing' row: pruneOldTrees (completed/failed/blocked
 * only) could never reclaim it, and getInterruptedTrees reported finished
 * conversation turns as interrupted work after any unclean shutdown. Measured
 * in the live goals.db: 803 'executing' rows, 791 of them with no owning task.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeClock } from "../agent-core/control/clock.js";
import { createControlPlane } from "../agent-core/control/control-plane.js";
import { V2AgentRunner, type V2RunnerDeps } from "../agent-core/runner/v2-agent-runner.js";
import type { AgentRunRequest, IOStrategy } from "../agent-core/runner/agent-runner.js";
import type { ProviderResponse } from "./providers/provider-core.interface.js";
import { GoalStorage } from "../goals/goal-storage.js";
import { generateGoalNodeId } from "../goals/types.js";
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));
vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (p: { projectPath: string }) => ({
    content: `root=${p.projectPath}`,
    contentHashes: [p.projectPath],
    summary: `root=${p.projectPath}`,
    fingerprint: `root ${p.projectPath}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const { Orchestrator } = await import("./orchestrator.js");

function tree(sessionId: string): GoalTree {
  const rootId = generateGoalNodeId();
  const childId = generateGoalNodeId();
  const now = Date.now();
  const root: GoalNode = {
    id: rootId, parentId: null, task: "Build the board module", dependsOn: [], depth: 0,
    status: "pending", createdAt: now, updatedAt: now,
  };
  const child: GoalNode = {
    id: childId, parentId: rootId, task: "Wire the input", dependsOn: [rootId], depth: 1,
    status: "pending", createdAt: now, updatedAt: now,
  };
  return {
    rootId, sessionId, taskDescription: "Build the board module",
    nodes: new Map<GoalNodeId, GoalNode>([[rootId, root], [childId, child]]), createdAt: now,
  };
}

function resp(over: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: "ok", toolCalls: [], stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ...over,
  } as ProviderResponse;
}

async function drive<T>(clock: FakeClock, runPromise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = runPromise.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  for (let i = 0; i < 5000 && !settled; i++) {
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5000);
  }
  return wrapped;
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function harness(chat: ReturnType<typeof vi.fn>) {
  const dbDir = join(tmpdir(), `goal-settle-${randomBytes(4).toString("hex")}`);
  const storage = new GoalStorage(join(dbDir, "goals.db"));
  storage.initialize();
  cleanups.push(() => { try { storage.close(); } catch { /* closed */ } rmSync(dbDir, { recursive: true, force: true }); });

  const decomposed: GoalTree[] = [];
  const clock = new FakeClock(0);
  const provider = {
    name: "mock",
    capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
    chat,
  };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: vi.fn(() => provider),
      getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
      shutdown: vi.fn(),
    },
    tools: [],
    channel: {
      name: "mock", connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(),
      sendText: vi.fn().mockResolvedValue(undefined), sendMarkdown: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
    },
    projectPath: "/tmp/goal-settle-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: clock,
    goalDecomposer: {
      shouldDecompose: () => true,
      decomposeProactive: async (scope: string) => { const t = tree(scope); decomposed.push(t); return t; },
    },
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  orch.setGoalStorage(storage);

  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const controlPlane = createControlPlane({ clock, seed, createHealthCore });
  const runner = new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  const io = { mode: "worker", onEvent: vi.fn(), deliverFinal: vi.fn(), externalSignal: new AbortController().signal } as unknown as IOStrategy;
  const request: AgentRunRequest = {
    prompt: "Build the board module with its config, DI installer, systems and the input wiring for the first playable level.",
    chatId: "chat-1",
    channelType: "web",
  };
  return { clock, storage, decomposed, run: () => drive(clock, runner.run(request, io)) };
}

describe("an interactive run that decomposed a goal tree", () => {
  it("settles the tree as completed when the run ends cleanly, so prune can reclaim it", async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce(resp({ text: "here is the plan" }))
      .mockResolvedValue(resp({ text: "done" }));
    const h = harness(chat);

    await h.run();

    expect(h.decomposed, "the run did not decompose a tree; the premise is broken").toHaveLength(1);
    expect(h.storage.getInterruptedTrees(), "the tree is still 'executing' after the run ended").toHaveLength(0);
    expect(h.storage.pruneOldTrees(0), "prune could not reclaim the finished tree").toBe(1);
  });
});
