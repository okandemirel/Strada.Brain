/**
 * A tool is handed the calling run's cancel signal and budget/clock scope, so the sub-agents a
 * delegate or swarm call starts are cancelled with the run and spend inside its budget. Drives
 * the real tool context executeToolCalls builds.
 */

import { Orchestrator } from "./orchestrator.js";
import { createBudget } from "../agent-core/control/budget.js";
import type { ParentRunScope } from "../agent-core/runner/agent-runner.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

interface ToolCallsHost {
  executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<unknown[]>;
}

describe("the tool context carries the calling run's scope", () => {
  it("hands the run's signal and parent-run scope to the tool", async () => {
    const seen: Array<{ signal?: AbortSignal; parentRun?: ParentRunScope }> = [];
    const probe = {
      name: "probe_context",
      description: "Records the tool context it was called with",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async (_input: unknown, context: { signal?: AbortSignal; parentRun?: ParentRunScope }) => {
        seen.push({ signal: context.signal, parentRun: context.parentRun });
        return { content: "ok" };
      }),
    };
    const orch = new Orchestrator({
      providerManager: {
        getProvider: () => ({ name: "mock", capabilities: { toolCalling: true }, chat: vi.fn() }),
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as never,
      tools: [probe] as never,
      channel: {
        name: "mock",
        connect: vi.fn(),
        disconnect: vi.fn(),
        onMessage: vi.fn(),
        sendText: vi.fn(),
        sendMarkdown: vi.fn(),
        isHealthy: () => true,
      } as never,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
    });
    const controller = new AbortController();
    const parentRun: ParentRunScope = {
      signal: controller.signal,
      budget: createBudget(1_000, 1),
      clockView: { now: () => 0, remainingTaskMs: () => Number.POSITIVE_INFINITY },
    };

    await (orch as unknown as ToolCallsHost).executeToolCalls(
      "chat-1",
      [{ id: "c1", name: "probe_context", input: {} }],
      { mode: "background", signal: controller.signal, parentRun },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBe(controller.signal);
    expect(seen[0]!.parentRun).toBe(parentRun);
    orch.dispose();
  });
});
