/**
 * The conversation contract between the orchestrator's helpers and the V2 engine, driven through
 * the REAL port (real setupRun / dispatch* / tool turn / synthesizeFinal) with a scripted provider.
 *
 *  - Delivery (ORC-1): only an interactive run posts to the chat from inside the run. Background,
 *    worker and supervisor-node answers are returned as finalText and delivered by the task
 *    system, and the answer is recorded in the run's transcript exactly once.
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../agent-core/control/clock.js";
import { createControlPlane } from "../agent-core/control/control-plane.js";
import { V2AgentRunner, type V2RunnerDeps } from "../agent-core/runner/v2-agent-runner.js";
import type { AgentRunRequest, IOStrategy, RunnerMode } from "../agent-core/runner/agent-runner.js";
import type { ConversationMessage, ProviderResponse } from "./providers/provider-core.interface.js";
import type { Session } from "./orchestrator-session-manager.js";

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

function resp(over: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ...over,
  } as ProviderResponse;
}

async function drive<T>(clock: FakeClock, runPromise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = runPromise.then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      throw e;
    },
  );
  for (let i = 0; i < 5000 && !settled; i++) {
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5000);
  }
  return wrapped;
}

function mkTool(name: string) {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object", properties: {} },
    isWrite: false,
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

function harness() {
  const clock = new FakeClock(0);
  const chat = vi.fn();
  // Every request body the provider was sent, snapshotted at call time.
  const sent: ConversationMessage[][] = [];
  chat.mockImplementation(() => resp());
  const provider = {
    name: "mock",
    capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
    chat: vi.fn(async (_system: string, messages: ConversationMessage[], ...rest: unknown[]) => {
      sent.push(structuredClone(messages));
      return chat(_system, messages, ...rest) as ProviderResponse;
    }),
  };
  const channel = {
    name: "mock",
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
  };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: vi.fn(() => provider),
      getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
      shutdown: vi.fn(),
    },
    tools: [mkTool("file_read")],
    channel,
    projectPath: "/tmp/conversation-contract-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: clock,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const controlPlane = createControlPlane({ clock, seed, createHealthCore });
  const runner = new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  const run = (mode: RunnerMode, request: Partial<AgentRunRequest> = {}) =>
    drive(
      clock,
      runner.run(
        { prompt: "do the thing", chatId: "chat-1", channelType: "web", ...request },
        {
          mode,
          onEvent: vi.fn(),
          deliverFinal: vi.fn(),
          externalSignal: new AbortController().signal,
        } as unknown as IOStrategy,
      ),
    );
  const runSession = (): Session => (port.debugRunContext!() as { session: Session }).session;
  return { chat, sent, channel, orch, run, runSession };
}

/** A one-letter shape of a transcript, for readable failure messages. */
function shape(messages: readonly ConversationMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "assistant") {
        const calls = m.tool_calls?.length ? `(tc:${m.tool_calls.map((c) => c.id).join(",")})` : "";
        return `a${calls}:${String(m.content).slice(0, 20)}`;
      }
      if (typeof m.content === "string") return `u:${m.content.slice(0, 20)}`;
      return `u[${m.content.map((b) => (b.type === "tool_result" ? `tr:${b.tool_use_id}` : b.type)).join(",")}]`;
    })
    .join(" | ");
}

describe("background, worker and node runs do not post to the chat (ORC-1)", () => {
  it.each(["worker", "background", "supervisor-node"] as const)(
    "%s: the answer is returned, never sent, and recorded once",
    async (mode) => {
      const h = harness();
      h.chat
        .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
        .mockResolvedValueOnce(resp({ text: "the real worker answer", stopReason: "end_turn" }));

      const result = await h.run(mode);

      expect(result.finalText).toContain("the real worker answer");
      expect(h.channel.sendMarkdown).not.toHaveBeenCalled();
      expect(h.channel.sendText).not.toHaveBeenCalled();
      const answers = h.runSession().messages.filter(
        (m) => m.role === "assistant" && String(m.content).includes("the real worker answer"),
      );
      expect(answers, shape(h.runSession().messages)).toHaveLength(1);
    },
  );

  it("a background loop-recovery stop is still recorded (the handler appends nothing there)", async () => {
    const h = harness();
    h.chat.mockResolvedValue(resp({ text: "", stopReason: "end_turn" }));
    const result = await h.run("worker");
    expect(h.channel.sendMarkdown).not.toHaveBeenCalled();
    expect(result.finalText.length).toBeGreaterThan(0);
  });

  it("interactive still renders the answer to the chat, once", async () => {
    const h = harness();
    h.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(resp({ text: "final visible answer", stopReason: "end_turn" }));
    await h.run("interactive");
    const sent = h.channel.sendMarkdown.mock.calls.filter((c) => String(c[1]).includes("final visible answer"));
    expect(sent).toHaveLength(1);
  });
});
