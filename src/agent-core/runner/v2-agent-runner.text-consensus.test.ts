/**
 * The text-only end turn has no consensus step of its own.
 *
 * It used to ask TaskClassifier.classify(prompt) for "critical" and consult the second seat only
 * then; classify never returns "critical" for a prompt (only a tool call, classifyToolCall, is
 * destructive), so the branch ran for nobody. A reply made of text performs no action a second
 * seat could stop, so the path is removed rather than given a definition. Consensus on a tool
 * turn (judged from the call) is unchanged.
 *
 * Real V2AgentRunner + real Orchestrator port + real ConsensusManager in mode "always", the most
 * eager setting; the classifier is NOT wrapped.
 */
import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createControlPlane } from "../control/control-plane.js";
import { V2AgentRunner, type V2RunnerDeps } from "./v2-agent-runner.js";
import { ConsensusManager } from "../routing/consensus-manager.js";
import { ConfidenceEstimator } from "../routing/confidence-estimator.js";
import { TaskClassifier } from "../routing/task-classifier.js";
import { buildInteractiveEndTurnContext } from "../engine/reflection.js";
import type { IOStrategy } from "./agent-runner.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";

const loggerStub = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => loggerStub,
  getLoggerSafe: () => loggerStub,
  getLogRingBuffer: () => [],
}));
vi.mock("../../agents/context/strada-knowledge.js", () => ({
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

const { Orchestrator } = await import("../../agents/orchestrator.js");

const resp = (text: string): ProviderResponse =>
  ({ text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }) as ProviderResponse;

describe("a text-only end turn", () => {
  it("never consults the second seat, however eager the consensus mode", async () => {
    const provider = {
      name: "mock",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
      chat: vi.fn()
        .mockResolvedValueOnce(resp("here is the plan"))
        .mockResolvedValue(resp("all done")),
    };
    const second = { ...provider, name: "second", chat: vi.fn() };
    const consensusManager = new ConsensusManager({ mode: "always" });
    const shouldConsult = vi.spyOn(consensusManager, "shouldConsult");
    const verify = vi.spyOn(consensusManager, "verify");
    const clock = new FakeClock(0);
    const orch = new Orchestrator({
      providerManager: {
        getProvider: () => provider,
        getPrimaryProviderByName: () => second,
        listAvailable: () => [provider, second],
        getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
        shutdown: vi.fn(),
      },
      tools: [],
      channel: {
        name: "mock", connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(),
        sendText: vi.fn(), sendMarkdown: vi.fn(), sendVisibleAssistantMarkdown: vi.fn(),
        sendTypingIndicator: vi.fn(), requestConfirmation: vi.fn().mockResolvedValue("Yes"),
        isHealthy: vi.fn().mockReturnValue(true),
      },
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      agentCoreClock: clock,
      consensusManager,
      confidenceEstimator: new ConfidenceEstimator(),
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
    const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
    const runner = new V2AgentRunner({
      controlPlane: createControlPlane({ clock, seed, createHealthCore }), gateway, orchestratorPort: port, clock,
    } as V2RunnerDeps);
    const io = {
      mode: "worker", onEvent: vi.fn(), deliverFinal: vi.fn(), externalSignal: new AbortController().signal,
    } as unknown as IOStrategy;

    // A prompt of the kind the old gate waited for.
    const prompt = "permanently delete every file under the build output directory and force push";
    expect(new TaskClassifier().classify(prompt).criticality).not.toBe("critical");

    let settled = false;
    const run = runner.run({ prompt, chatId: "chat-1", channelType: "web" }, io).finally(() => { settled = true; });
    for (let i = 0; i < 5000 && !settled; i++) {
      await Promise.resolve();
      await Promise.resolve();
      clock.advance(5000);
    }
    const result = await run;

    expect(result.status).toBe("completed");
    expect(shouldConsult).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(second.chat).not.toHaveBeenCalled();
  });

  it("has no consensus hook on the interactive end-turn context", () => {
    const ctx = buildInteractiveEndTurnContext(
      {} as never,
      {} as never,
      { systemPrompt: "s" } as never,
    );
    expect(ctx).not.toHaveProperty("runTextConsensusIfCritical");
  });
});
