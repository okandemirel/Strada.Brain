/**
 * A delegated run feeds learning and uses learned instincts, as a chat turn does.
 *
 * DelegationManager built the delegate's Orchestrator from the shared run
 * dependencies, and the learning bus and the instinct retriever were not among
 * them: bootstrap handed those two to the root (and AgentManager to each
 * per-agent orchestrator) from a separate list. emitToolResult returns early
 * without a bus, so no delegated tool call produced an observation, a credit
 * or an error pattern, and the run's setup asked no retriever, so no learned
 * instinct reached a delegate's prompt.
 *
 * The first block drives the real DelegationManager -> real Orchestrator ->
 * real V2 runner. Only the provider is scripted. The learning side is the real
 * TypedEventBus and the real LearningPipeline over a real LearningStorage,
 * subscribed the way bootstrap's learning init subscribes it. The same run is
 * also counted in the root's dashboard counters, which a delegate was never
 * given (no tool call or token of a delegate reached /api/metrics). A parent run
 * that delegates through the real DelegationTool records the delegate's task
 * metric as its own subtask in a real MetricsStorage; a delegation outside a run
 * has no parent to record under and writes no row. The second block
 * is a textual tripwire over bootstrap's shared deps object, which is built
 * inside bootstrap() and cannot be run by a unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DelegationManager } from "./delegation-manager.js";
import { DelegationLog } from "./delegation-log.js";
import { TierRouter } from "./tier-router.js";
import { AgentBudgetTracker } from "../agent-budget-tracker.js";
import type { SharedOrchestratorDeps } from "../agent-manager.js";
import type { AgentId } from "../agent-types.js";
import type { DelegationConfig, ModelTier } from "./delegation-types.js";
import { DaemonStorage } from "../../../daemon/daemon-storage.js";
import { ToolRegistry } from "../../../core/tool-registry.js";
import { TypedEventBus, type LearningEventMap, type ToolResultEvent } from "../../../core/event-bus.js";
import { LearningStorage } from "../../../learning/storage/learning-storage.js";
import { LearningPipeline } from "../../../learning/pipeline/learning-pipeline.js";
import type { InstinctRetriever } from "../../instinct-retriever.js";
import type { ITool } from "../../tools/tool.interface.js";
import { MetricsCollector } from "../../../dashboard/metrics.js";
import { MetricsStorage } from "../../../metrics/metrics-storage.js";
import { MetricsRecorder } from "../../../metrics/metrics-recorder.js";
import { Orchestrator } from "../../orchestrator.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import { selectAgentRunner, type RunnerHostOrchestrator } from "../../../agent-core/runner/index.js";
import { createDelegationTools } from "./delegation-tool.js";

vi.mock("../../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

vi.mock("../../context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

/**
 * The delegate's model: read the station once, then answer. A parent run (the
 * one model offered a delegate_ tool; a delegate never is) delegates once, then
 * answers with what came back.
 */
const script = vi.hoisted(() => ({ systemPrompts: [] as string[], toolRan: false, parentDelegated: false }));

const provider = vi.hoisted(() => ({
  name: "deepseek",
  capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: async (systemPrompt: string, _messages: unknown, tools?: Array<{ name: string }>) => {
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
    if (tools?.some((tool) => tool.name === "delegate_code_review")) {
      if (script.parentDelegated) return { text: "The reviewer read 12 knots.", toolCalls: [], stopReason: "end_turn", usage };
      script.parentDelegated = true;
      return {
        text: "",
        toolCalls: [{ id: "tc-parent", name: "delegate_code_review", input: { task: "Check the north anemometer reading" } }],
        stopReason: "tool_use",
        usage,
      };
    }
    script.systemPrompts.push(systemPrompt);
    return script.toolRan
      ? { text: "The north anemometer reads 12 knots.", toolCalls: [], stopReason: "end_turn", usage }
      : {
        text: "",
        toolCalls: [{ id: "tc-1", name: "anemometer_read", input: { station: "north" } }],
        stopReason: "tool_use",
        usage,
      };
  },
}));

vi.mock("../../providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/provider-registry.js")>();
  return { ...actual, createProvider: vi.fn(() => provider) };
});

vi.mock("../../providers/provider-manager.js", () => ({
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

const INSTINCT_ID = "inst-anemometer-calibration";
const INSIGHT = "Calibrate an anemometer against the reference mast before trusting its reading.";

describe("a delegated run feeds learning and uses learned instincts", () => {
  let tmpDir: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;
  let learningStorage: LearningStorage;
  let bus: TypedEventBus<LearningEventMap>;

  beforeEach(() => {
    script.systemPrompts = [];
    script.toolRan = false;
    script.parentDelegated = false;
    tmpDir = mkdtempSync(join(tmpdir(), "delegation-learning-"));
    mkdirSync(join(tmpDir, "weather-station"), { recursive: true });
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    learningStorage = new LearningStorage(join(tmpDir, "learning.db"));
    learningStorage.initialize();
    bus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    await bus.shutdown();
    learningStorage.close();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A read-only tool the delegate is handed with the parent's tools. */
  function anemometerTool(): ITool {
    return {
      name: "anemometer_read",
      description: "Read a weather station's anemometer.",
      inputSchema: { type: "object", properties: { station: { type: "string" } } },
      execute: vi.fn(async () => {
        script.toolRan = true;
        return { content: "north: 12 knots" };
      }),
    } as unknown as ITool;
  }

  /** The retriever's surface a run asks, recording what it was asked. */
  function recordingRetriever() {
    return {
      getInsightsForTask: vi.fn(async () => ({ insights: [INSIGHT], matchedInstinctIds: [INSTINCT_ID] })),
      getMatchedInstincts: vi.fn(async () => []),
      recordOutcome: vi.fn(async () => undefined),
    };
  }

  /** Bootstrap's shared deps with the learning side real and every other hook off. */
  function sharedDeps(
    retriever: ReturnType<typeof recordingRetriever>,
    metrics?: MetricsCollector,
    metricsRecorder?: MetricsRecorder,
  ): SharedOrchestratorDeps {
    return {
      eventEmitter: bus,
      instinctRetriever: retriever as unknown as InstinctRetriever,
      metrics,
      metricsRecorder,
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

  it("turns a delegated tool call into a learning observation tagged with the instinct the run retrieved", async () => {
    // As bootstrap's learning init subscribes the pipeline (serially there, awaited here).
    const pipeline = new LearningPipeline(learningStorage, {}, undefined, undefined, bus);
    const results: ToolResultEvent[] = [];
    const handled: Promise<void>[] = [];
    bus.on("tool:result", (event) => {
      results.push(event);
      handled.push(pipeline.handleToolResult(event));
    });
    const retriever = recordingRetriever();
    const manager = buildManager(sharedDeps(retriever));

    await manager.delegate({
      type: "code_review",
      task: "Check the north anemometer reading",
      parentAgentId: "parent-001" as AgentId,
      depth: 0,
      mode: "sync",
    });
    await Promise.all(handled);

    expect(script.toolRan, "the delegate never ran its tool").toBe(true);
    // The delegated tool call reached the bus, scoped to the delegate's run,
    // carrying the instinct its setup retrieved (what run credit is keyed on).
    const delegated = results.filter((event) => event.toolName === "anemometer_read");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ success: true, appliedInstinctIds: [INSTINCT_ID] });
    expect(delegated[0]!.sessionId).toMatch(/^delegation-/);
    // The real pipeline stored it as an observation.
    const observations = learningStorage
      .getDatabase()!
      .prepare("SELECT session_id, tool_name, type FROM observations")
      .all() as Array<{ session_id: string; tool_name: string; type: string }>;
    expect(observations).toEqual([{ session_id: delegated[0]!.sessionId, tool_name: "anemometer_read", type: "success" }]);
  });

  it("counts the delegated tool call and its tokens in the dashboard counters the root reports", async () => {
    const metrics = new MetricsCollector();
    const manager = buildManager(sharedDeps(recordingRetriever(), metrics));

    await manager.delegate({
      type: "code_review",
      task: "Check the north anemometer reading",
      parentAgentId: "parent-001" as AgentId,
      depth: 0,
      mode: "sync",
    });

    expect(script.toolRan, "the delegate never ran its tool").toBe(true);
    const snapshot = metrics.getSnapshot();
    expect(snapshot.toolCallCounts).toEqual({ anemometer_read: 1 });
    expect(snapshot.totalTokens.input).toBeGreaterThan(0);
  });

  /** A metrics store as bootstrap's knowledge stage opens one, and the recorder over it. */
  function metricsStore(): { storage: MetricsStorage; recorder: MetricsRecorder } {
    const storage = new MetricsStorage(join(tmpDir, "metrics.db"));
    storage.initialize();
    return { storage, recorder: new MetricsRecorder(storage) };
  }

  /** A root-shaped orchestrator over the same shared deps, running one turn that delegates. */
  async function runParentThatDelegates(manager: DelegationManager, shared: SharedOrchestratorDeps): Promise<void> {
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
        { prompt: "Have a reviewer check the north anemometer.", chatId: "parent-chat", channelType: "cli", userId: "user-1", maxEpochs: 1 },
        { mode: "background", onEvent: () => {}, deliverFinal: () => {} },
      );
    } finally {
      await parent.dispose();
    }
  }

  it("records the delegated run's task metric as a subtask of the run that delegated it", async () => {
    const { storage, recorder } = metricsStore();
    const shared = sharedDeps(recordingRetriever(), undefined, recorder);
    try {
      await runParentThatDelegates(buildManager(shared), shared);

      expect(script.parentDelegated, "the parent never called the delegate tool").toBe(true);
      expect(script.toolRan, "the delegate never ran its tool").toBe(true);
      const rows = storage.getTaskMetrics({});
      const parent = rows.filter((row) => row.sessionId === "parent-chat");
      expect(parent).toEqual([expect.objectContaining({ taskType: "background", parentTaskId: undefined })]);
      // The run's loop recovery also delegates a review, inside the same run: its row is a
      // subtask of the same parent too.
      const delegated = rows.filter((row) => row.sessionId.startsWith("delegation-"));
      expect(delegated).toEqual([
        expect.objectContaining({ taskType: "subtask", parentTaskId: parent[0]!.id }),
        expect.objectContaining({ taskType: "subtask", parentTaskId: parent[0]!.id }),
      ]);
      expect(delegated.filter((row) => row.taskDescription.includes("Task: Check the north anemometer reading"))).toHaveLength(1);
      expect(rows).toHaveLength(3);
      // The parent task is counted once; its subtasks are counted apart.
      expect(storage.getAggregation({}).totalTasks).toBe(1);
      expect(storage.getAggregation({ taskType: "subtask" }).totalTasks).toBe(2);
    } finally {
      storage.close();
    }
  });

  it("writes no task metric for a delegation that no run asked for, rather than a 'background' row", async () => {
    const { storage, recorder } = metricsStore();
    try {
      const manager = buildManager(sharedDeps(recordingRetriever(), undefined, recorder));

      await manager.delegate({
        type: "code_review",
        task: "Check the north anemometer reading",
        parentAgentId: "parent-001" as AgentId,
        depth: 0,
        mode: "sync",
      });

      expect(script.toolRan, "the delegate never ran its tool").toBe(true);
      expect(storage.getTaskMetrics({})).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("asks the shared instinct retriever for the delegated task and puts its insight in the delegate's prompt", async () => {
    const retriever = recordingRetriever();
    const manager = buildManager(sharedDeps(retriever));

    await manager.delegate({
      type: "code_review",
      task: "Check the north anemometer reading",
      parentAgentId: "parent-001" as AgentId,
      depth: 0,
      mode: "sync",
    });

    expect(retriever.getInsightsForTask).toHaveBeenCalled();
    expect(String(retriever.getInsightsForTask.mock.calls[0]?.[0])).toContain("Check the north anemometer reading");
    expect(script.systemPrompts.length).toBeGreaterThan(0);
    expect(script.systemPrompts.every((prompt) => prompt.includes(INSIGHT)), "every delegate call carries the learned insight").toBe(true);
  });
});

// =============================================================================
// Tripwire: bootstrap's shared deps carry the learning bus, the retriever and the counters
// =============================================================================

/**
 * Textual, because the object is built inside bootstrap(), which a unit test
 * cannot run. The type makes every key required, so dropping one is a compile
 * error; what the type cannot see is a key set to the wrong value, or a second
 * copy passed at the root that the delegates would not get.
 */
describe("bootstrap's shared orchestrator deps (tripwire)", () => {
  const bootstrap = readFileSync(fileURLToPath(new URL("../../../core/bootstrap.ts", import.meta.url)), "utf8");
  const sharedStart = bootstrap.indexOf("const sharedOrchestratorDeps: SharedOrchestratorDeps = {");
  const rootStart = bootstrap.indexOf("const orchestrator = new Orchestrator({");
  const shared = bootstrap.slice(sharedStart, rootStart);
  const root = bootstrap.slice(rootStart, bootstrap.indexOf("// Wire FrameworkPromptGenerator", rootStart));

  it("hands every orchestrator the learning bus and the instinct retriever", () => {
    expect(sharedStart).toBeGreaterThan(-1);
    expect(shared).toMatch(/\beventEmitter: learningResult\.eventBus,/);
    expect(shared).toMatch(/\binstinctRetriever,/);
  });

  it("hands every orchestrator the dashboard counters and the task-metric recorder", () => {
    expect(shared).toMatch(/^\s+metrics,$/m);
    expect(shared).toMatch(/^\s+metricsRecorder,$/m);
  });

  it("gives the root no second copy that a delegate would not get", () => {
    expect(rootStart).toBeGreaterThan(sharedStart);
    expect(root).toContain("...sharedOrchestratorDeps,");
    expect(root).not.toMatch(/\beventEmitter:/);
    expect(root).not.toMatch(/\binstinctRetriever\b/);
    expect(root).not.toMatch(/^\s+metrics[,:]/m);
    expect(root).not.toMatch(/^\s+metricsRecorder[,:]/m);
  });
});
