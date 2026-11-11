/**
 * Loop recovery's delegate runs inside the run that called it.
 *
 * When a run loops, the intervention pipeline delegates a review
 * (delegate_code_review / delegate_analysis) through the orchestrator's
 * executeToolCalls. That call carried no run scope: the delegate was not
 * cancelled with the run, took no slice of its budget, was not bounded by its
 * clock, and — with no parent metric id — recorded no task metric. Every other
 * tool a run calls gets the scope through the tool turn; the recovery delegate
 * is called from the reflection/end-turn dispatch, which was not given it.
 *
 * Real path: a parent Orchestrator under the real V2 runner, the real
 * DelegationTool, the real DelegationManager and the delegate's own real
 * Orchestrator + V2 runner, over a real MetricsStorage. Only the provider is
 * scripted: the parent answers without ever using a tool, which is what makes
 * its loop recovery delegate a review.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DelegationManager } from "./multi/delegation/delegation-manager.js";
import { DelegationLog } from "./multi/delegation/delegation-log.js";
import { TierRouter } from "./multi/delegation/tier-router.js";
import { AgentBudgetTracker } from "./multi/agent-budget-tracker.js";
import type { SharedOrchestratorDeps } from "./multi/agent-manager.js";
import type { AgentId } from "./multi/agent-types.js";
import type { DelegationConfig, ModelTier } from "./multi/delegation/delegation-types.js";
import { createDelegationTools } from "./multi/delegation/delegation-tool.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { TypedEventBus, type LearningEventMap } from "../core/event-bus.js";
import type { ITool } from "./tools/tool.interface.js";
import { MetricsStorage } from "../metrics/metrics-storage.js";
import { MetricsRecorder } from "../metrics/metrics-recorder.js";
import { Orchestrator } from "./orchestrator.js";
import { ProviderManager } from "./providers/provider-manager.js";
import { selectAgentRunner, type RunnerHostOrchestrator } from "../agent-core/runner/index.js";

vi.mock("../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

/**
 * The parent's model asks once for a tool the parent was not given, then only
 * answers in text: its end-turn gates refuse the unverified answer turn after
 * turn, and loop recovery delegates a review. The delegate is told it is a
 * code-review sub-agent: it reads the station once, then answers. `hold`, when
 * set, keeps the delegate's first call pending until it is released or its
 * signal aborts.
 */
const script = vi.hoisted(() => ({
  parentCalls: 0,
  delegateCalls: 0,
  delegateToolRan: false,
  hold: undefined as { started: () => void; released: Promise<void> } | undefined,
}));

const provider = vi.hoisted(() => ({
  name: "deepseek",
  capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: async (
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools?: Array<{ name: string }>,
    options?: { signal?: AbortSignal },
  ) => {
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
    const brief = JSON.stringify(messages);
    const isDelegate = brief.includes("specialized sub-agent for code review") && !tools?.some((t) => t.name.startsWith("delegate_"));
    if (!isDelegate) {
      script.parentCalls++;
      return script.parentCalls === 1
        ? { text: "", toolCalls: [{ id: "tc-p", name: "anemometer_read", input: { station: "north" } }], stopReason: "tool_use", usage }
        : { text: "The north anemometer reads 12 knots.", toolCalls: [], stopReason: "end_turn", usage };
    }
    script.delegateCalls++;
    if (script.delegateCalls === 1 && script.hold) {
      script.hold.started();
      // As a real provider does: the request is dropped when the call's signal aborts.
      const signal = options?.signal;
      await new Promise<void>((resolve, reject) => {
        void script.hold!.released.then(resolve);
        if (signal?.aborted) reject(new Error("Request aborted"));
        signal?.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
      });
    }
    return script.delegateToolRan
      ? { text: "The north anemometer reads 12 knots.", toolCalls: [], stopReason: "end_turn", usage }
      : { text: "", toolCalls: [{ id: "tc-1", name: "anemometer_read", input: { station: "north" } }], stopReason: "tool_use", usage };
  },
}));

vi.mock("./providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/provider-registry.js")>();
  return { ...actual, createProvider: vi.fn(() => provider) };
});

vi.mock("./providers/provider-manager.js", () => ({
  ProviderManager: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.getProvider = () => provider;
    this.getProviderByName = () => provider;
    this.getPrimaryProviderByName = () => provider;
    this.getActiveInfo = () => ({ providerName: "deepseek", model: "deepseek-chat", isDefault: true });
    this.listAvailable = () => [{ name: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat" }];
    this.isAvailable = () => true;
    this.shutdown = vi.fn();
  }),
}));

const TIERS: Record<ModelTier, string> = {
  local: "ollama:llama3.3",
  cheap: "deepseek:deepseek-chat",
  standard: "deepseek:deepseek-chat",
  premium: "deepseek:deepseek-chat",
};

const CONFIG: DelegationConfig = {
  enabled: true,
  maxDepth: 2,
  maxConcurrentPerParent: 3,
  tiers: TIERS,
  types: [{ name: "code_review", tier: "cheap", timeoutMs: 60_000, maxIterations: 10 }],
  verbosity: "quiet",
};

describe("loop recovery's delegate runs inside the calling run", () => {
  let tmpDir: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;
  let bus: TypedEventBus<LearningEventMap>;
  let storage: MetricsStorage;

  beforeEach(() => {
    script.parentCalls = 0;
    script.delegateCalls = 0;
    script.delegateToolRan = false;
    script.hold = undefined;
    tmpDir = mkdtempSync(join(tmpdir(), "loop-recovery-parent-run-"));
    mkdirSync(join(tmpDir, "weather-station"), { recursive: true });
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    bus = new TypedEventBus<LearningEventMap>();
    storage = new MetricsStorage(join(tmpDir, "metrics.db"));
    storage.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    storage.close();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function anemometerTool(): ITool {
    return {
      name: "anemometer_read",
      description: "Read a weather station's anemometer.",
      inputSchema: { type: "object", properties: { station: { type: "string" } } },
      execute: vi.fn(async () => {
        script.delegateToolRan = true;
        return { content: "north: 12 knots" };
      }),
    } as unknown as ITool;
  }

  function sharedDeps(): SharedOrchestratorDeps {
    return {
      eventEmitter: bus,
      instinctRetriever: undefined,
      metrics: undefined,
      metricsRecorder: new MetricsRecorder(storage),
      trajectoryReplayRetriever: undefined,
      learningPipeline: undefined,
      errorLearningHooks: undefined,
      interventionEngine: undefined,
      modelIntelligence: undefined,
      consensusManager: undefined,
      confidenceEstimator: undefined,
      runtimeArtifactManager: undefined,
      autonomousDefaultEnabled: false,
      autonomousDefaultHours: 24,
      interactionConfig: undefined,
      taskConfig: undefined,
      supervisorComplexityThreshold: undefined,
      conformanceEnabled: false,
      conformanceFrameworkPathsOnly: undefined,
      loopFingerprintThreshold: undefined,
      loopFingerprintWindow: undefined,
      loopDensityThreshold: undefined,
      loopDensityWindow: undefined,
      loopMaxRecoveryEpisodes: undefined,
      loopStaleAnalysisThreshold: undefined,
      loopHardCapReplan: undefined,
      loopHardCapBlock: undefined,
      progressAssessmentEnabled: false,
      onSkillCreated: undefined,
      getSkillEntries: undefined,
      agentCoreFlagSet: undefined,
      capabilityRegistry: undefined,
      capabilityAdapters: undefined,
    };
  }

  function buildManager(shared: SharedOrchestratorDeps): DelegationManager {
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(anemometerTool(), { readOnly: true });
    return new DelegationManager({
      config: CONFIG,
      tierRouter: new TierRouter(TIERS),
      delegationLog: new DelegationLog(db),
      eventBus: bus,
      budgetTracker,
      channel: { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: join(tmpDir, "weather-station"),
      readOnly: false,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] } as never,
      parentTools: toolRegistry.getAllTools(),
      toolMetadataByName: toolRegistry.getMetadataMap(),
      sharedOrchestratorDeps: shared,
      apiKeys: { deepseek: "test-key" },
    });
  }

  async function runParent(signal?: AbortSignal): Promise<void> {
    const shared = sharedDeps();
    const manager = buildManager(shared);
    const parent = new Orchestrator({
      ...shared,
      providerManager: new ProviderManager({} as never) as never,
      tools: createDelegationTools(CONFIG.types, manager, "parent-001" as AgentId, 0, CONFIG.maxDepth),
      channel: { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: join(tmpDir, "weather-station"),
      readOnly: false,
      requireConfirmation: false,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] } as never,
    });
    try {
      await selectAgentRunner(parent as unknown as RunnerHostOrchestrator, "background").run(
        { prompt: "Check the north anemometer.", chatId: "parent-chat", channelType: "cli", userId: "user-1", maxEpochs: 1 },
        { mode: "background", onEvent: () => {}, deliverFinal: () => {}, ...(signal ? { externalSignal: signal } : {}) },
      );
    } finally {
      await parent.dispose();
    }
  }

  it("records the recovery delegate's task metric as a subtask of the run that looped", async () => {
    await runParent();

    expect(script.delegateToolRan, "loop recovery never ran its delegate").toBe(true);
    const rows = storage.getTaskMetrics({});
    const parent = rows.filter((row) => row.sessionId === "parent-chat");
    expect(parent).toEqual([expect.objectContaining({ taskType: "background", parentTaskId: undefined })]);
    const delegated = rows.filter((row) => row.sessionId.startsWith("delegation-"));
    expect(delegated).toEqual([
      expect.objectContaining({ taskType: "subtask", parentTaskId: parent[0]!.id, completionStatus: "success" }),
    ]);
    // Loop recovery's brief, not a delegation the model asked for.
    expect(delegated[0]!.taskDescription).toContain("Task: Review the touched files");
  });

  it("stops the recovery delegate when the run is cancelled, before it can act", async () => {
    let release!: () => void;
    let started!: () => void;
    const delegateStarted = new Promise<void>((resolve) => { started = resolve; });
    script.hold = { started, released: new Promise<void>((resolve) => { release = resolve; }) };
    const cancel = new AbortController();
    // Without the run's signal nothing would ever stop the delegate: let it go after a while so
    // the run can still end, and the test sees what the delegate did once it was let go.
    const letGo = setTimeout(() => release(), 1_500);
    try {
      const run = runParent(cancel.signal);
      await delegateStarted;
      cancel.abort();
      await run;
      release();
      // Give a delegate that was not stopped every chance to act on the released call.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      clearTimeout(letGo);
    }

    expect(script.delegateCalls, "the delegate asked its model again after the cancel").toBe(1);
    expect(script.delegateToolRan, "the delegate ran its tool after the run was cancelled").toBe(false);
    const delegated = storage.getTaskMetrics({}).filter((row) => row.sessionId.startsWith("delegation-"));
    expect(delegated.map((row) => row.completionStatus)).not.toContain("success");
  });
});
