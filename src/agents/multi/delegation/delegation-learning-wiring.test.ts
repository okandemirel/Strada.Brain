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
 * subscribed the way bootstrap's learning init subscribes it. The second block
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

/** The delegate's model: read the station once, then answer. */
const script = vi.hoisted(() => ({ systemPrompts: [] as string[], toolRan: false }));

const provider = vi.hoisted(() => ({
  name: "deepseek",
  capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: async (systemPrompt: string) => {
    script.systemPrompts.push(systemPrompt);
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
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
  function sharedDeps(retriever: ReturnType<typeof recordingRetriever>): SharedOrchestratorDeps {
    return {
      eventEmitter: bus,
      instinctRetriever: retriever as unknown as InstinctRetriever,
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
// Tripwire: bootstrap's shared deps carry the learning bus and the retriever
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

  it("gives the root no second copy that a delegate would not get", () => {
    expect(rootStart).toBeGreaterThan(sharedStart);
    expect(root).toContain("...sharedOrchestratorDeps,");
    expect(root).not.toMatch(/\beventEmitter:/);
    expect(root).not.toMatch(/\binstinctRetriever\b/);
  });
});
