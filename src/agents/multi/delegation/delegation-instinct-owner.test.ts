/**
 * A delegated run is given its caller's own learning, and nobody else's.
 *
 * DelegationManager starts every delegate as userId "sub-agent", and the run's
 * setup asked the instinct retriever for request.userId. "sub-agent" owns no
 * user-scoped instinct, so the delegate got project and global learning only,
 * while the root run on the same task would also have got the user's own.
 *
 * The decision (board #60): instincts are retrieved for the CALLER's person.
 * Only instinct retrieval: profile, memory recall and DM policy stay keyed by
 * "sub-agent", which is a separate access decision. A delegation with no caller
 * run behind it keeps the old candidate set, shared learning only.
 *
 * Driven end to end: a real root Orchestrator run (the V2 runner) for "alice"
 * calls a real DelegationTool, the real DelegationManager starts the delegate,
 * and the delegate's setup asks a real InstinctRetriever over a real
 * PatternMatcher and LearningStorage. Only the provider is scripted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DelegationManager } from "./delegation-manager.js";
import { DelegationLog } from "./delegation-log.js";
import { DelegationTool } from "./delegation-tool.js";
import { TierRouter } from "./tier-router.js";
import { AgentBudgetTracker } from "../agent-budget-tracker.js";
import type { SharedOrchestratorDeps } from "../agent-manager.js";
import type { AgentId } from "../agent-types.js";
import type { DelegationConfig, ModelTier } from "./delegation-types.js";
import { DaemonStorage } from "../../../daemon/daemon-storage.js";
import { ToolRegistry } from "../../../core/tool-registry.js";
import { TypedEventBus, type LearningEventMap } from "../../../core/event-bus.js";
import { LearningStorage } from "../../../learning/storage/learning-storage.js";
import { PatternMatcher } from "../../../learning/matching/pattern-matcher.js";
import { LearningPipeline } from "../../../learning/pipeline/learning-pipeline.js";
import { ErrorLearningHooks } from "../../../learning/hooks/error-learning-hooks.js";
import { ConfidenceScorer } from "../../../learning/scoring/confidence-scorer.js";
import { InstinctRetriever } from "../../instinct-retriever.js";
import { Orchestrator } from "../../orchestrator.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import { SessionManager } from "../../orchestrator-session-manager.js";
import { selectAgentRunner, type RunnerHostOrchestrator } from "../../../agent-core/runner/runner-factory.js";
import type { ITool } from "../../tools/tool.interface.js";
import type { ToolContext } from "../../tools/tool-core.interface.js";
import type { Instinct, InstinctId } from "../../../learning/types.js";
import type { TimestampMs } from "../../../types/index.js";

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

const ROOT_TASK = "Survey the harbour weather stations";
/** What every seeded instinct is triggered by; both delegated tasks say it. */
const TRIGGER = "calibrate the anemometer against the reference mast";
const DELEGATED_TASK = `${TRIGGER} at the north station`;
const NESTED_TASK = `${TRIGGER} at the south station`;

/**
 * Each call is recorded with the run it belongs to (its first user turn). The
 * root run delegates once; a delegated run reads the anemometer once; every
 * run answers after its first tool call.
 */
const script = vi.hoisted(() => ({
  calls: [] as Array<{ systemPrompt: string; firstTurn: string }>,
}));

const provider = vi.hoisted(() => {
  const text = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("")
        : "";
  return {
    name: "deepseek",
    capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
    chat: async (
      systemPrompt: string,
      messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>,
    ) => {
      const firstTurn = text(messages.find((m) => m.role === "user")?.content);
      script.calls.push({ systemPrompt, firstTurn });
      const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
      const calledATool = messages.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
      if (calledATool) return { text: "Done.", toolCalls: [], stopReason: "end_turn", usage };
      const isRoot = firstTurn.startsWith("Survey the harbour weather stations");
      return {
        text: "",
        toolCalls: isRoot
          ? [{ id: "tc-root", name: "delegate_station_check", input: { task: "calibrate the anemometer against the reference mast at the north station" } }]
          : [{ id: "tc-read", name: "anemometer_read", input: { station: "north" } }],
        stopReason: "tool_use",
        usage,
      };
    },
  };
});

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
  maxDepth: 3,
  maxConcurrentPerParent: 3,
  tiers: TIERS,
  types: [{ name: "station_check", tier: "cheap", timeoutMs: 60_000, maxIterations: 10 }],
  verbosity: "quiet",
};

const ALICE_RULE = "Alice wants every anemometer calibration logged in knots.";
const BOB_RULE = "Bob wants every anemometer calibration logged in metres per second.";
const PROJECT_RULE = "Anemometer calibration needs the reference mast reading first.";
/** Learning filed under the delegate's own id: the caller's person is not "sub-agent". */
const SUB_AGENT_RULE = "Sub-agents log every anemometer calibration in furlongs per fortnight.";
/** A failed read, and the private recovery rules two people taught for it. */
const READ_ERROR = "Assets/Station.cs(1,1): CS0006 — Metadata file 'Harbour.Mast.dll' could not be found";
const ALICE_FIX = "Alice: rebuild the mast library before reading again.";
const BOB_FIX = "Bob: restart the station logger before reading again.";

describe("a delegated run retrieves instincts for its caller's person (#60)", () => {
  let tmpDir: string;
  let projectPath: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;
  let learningStorage: LearningStorage;
  let bus: TypedEventBus<LearningEventMap>;
  /** What each anemometer_read call was handed, in call order. */
  let readContexts: ToolContext[];
  /** Set by a test: the delegate's tool starts one more delegation with its own context. */
  let nestFrom: ((context: ToolContext) => Promise<void>) | undefined;
  /** Set by a test: the delegate's read fails with READ_ERROR. */
  let failRead: boolean;

  beforeEach(() => {
    script.calls = [];
    readContexts = [];
    nestFrom = undefined;
    failRead = false;
    tmpDir = mkdtempSync(join(tmpdir(), "delegation-instinct-owner-"));
    projectPath = join(tmpDir, "harbour-stations");
    mkdirSync(projectPath, { recursive: true });
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    learningStorage = new LearningStorage(join(tmpDir, "learning.db"));
    learningStorage.initialize();
    bus = new TypedEventBus<LearningEventMap>();
    seed("inst-alice", ALICE_RULE, "user", "alice");
    seed("inst-bob", BOB_RULE, "user", "bob");
    seed("inst-project", PROJECT_RULE, "project");
    seed("inst-sub-agent", SUB_AGENT_RULE, "user", "sub-agent");
  });

  afterEach(async () => {
    await bus.shutdown();
    learningStorage.close();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One stored instinct (by default triggered by both delegated tasks), scoped as given. */
  function seed(
    id: string,
    action: string,
    scopeType: "user" | "project",
    userId?: string,
    kind: { type: "user_teaching" | "error_fix"; trigger: string } = { type: "user_teaching", trigger: TRIGGER },
  ): void {
    const now = Date.now() as TimestampMs;
    learningStorage.createInstinct({
      id: id as InstinctId,
      name: id,
      type: kind.type,
      status: "active",
      confidence: 0.9,
      triggerPattern: kind.trigger,
      action,
      contextConditions: [],
      stats: { timesSuggested: 6, timesApplied: 6, timesFailed: 0, successRate: 1, averageExecutionMs: 0 },
      bayesianAlpha: 4,
      bayesianBeta: 1,
      createdAt: now,
      updatedAt: now,
      sourceTrajectoryIds: [],
      tags: [],
    } as Instinct);
    learningStorage.addInstinctScopeV2(id, projectPath, scopeType, userId);
  }

  function anemometerTool(): ITool {
    return {
      name: "anemometer_read",
      description: "Read a harbour station's anemometer.",
      inputSchema: { type: "object", properties: { station: { type: "string" } } },
      execute: vi.fn(async (_input: unknown, context: ToolContext) => {
        readContexts.push(context);
        const nest = nestFrom;
        nestFrom = undefined;
        if (nest) await nest(context);
        return failRead ? { content: READ_ERROR, isError: true } : { content: "north: 12 knots" };
      }),
    } as unknown as ITool;
  }

  function sharedDeps(options: { errorLearning?: boolean } = {}): SharedOrchestratorDeps {
    const retriever = new InstinctRetriever(new PatternMatcher(learningStorage), {
      scopeContext: { projectPath, scopeFilter: "project+universal", recencyBoost: 1.0, scopeBoost: 1.1 },
      storage: learningStorage,
    });
    return {
      eventEmitter: bus,
      instinctRetriever: retriever,
      trajectoryReplayRetriever: undefined,
      learningPipeline: undefined,
      errorLearningHooks: options.errorLearning
        ? new ErrorLearningHooks(
          new LearningPipeline(learningStorage),
          new PatternMatcher(learningStorage),
          new ConfidenceScorer(),
          learningStorage,
        )
        : undefined,
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

  const channel = { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never;

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
      channel,
      projectPath,
      readOnly: false,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] } as never,
      parentTools: toolRegistry.getAllTools(),
      toolMetadataByName: toolRegistry.getMetadataMap(),
      sharedOrchestratorDeps: shared,
      apiKeys: { deepseek: "test-key" },
    });
  }

  /** A root background run for `userId` whose one tool delegates to the manager. */
  async function runRoot(
    userId: string,
    onManager?: (manager: DelegationManager) => void,
    shared: SharedOrchestratorDeps = sharedDeps(),
  ): Promise<void> {
    const manager = buildManager(shared);
    onManager?.(manager);
    const registry = new ToolRegistry();
    registry.register(new DelegationTool(CONFIG.types[0]!, manager, "root-agent" as AgentId, 0), { readOnly: false });
    const root = new Orchestrator({
      ...shared,
      providerManager: new (ProviderManager as unknown as new () => ProviderManager)(),
      tools: registry.getAllTools(),
      toolMetadataByName: registry.getMetadataMap(),
      channel,
      projectPath,
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] } as never,
    });
    const runner = selectAgentRunner(root as unknown as RunnerHostOrchestrator, "background");
    await runner.run(
      { prompt: ROOT_TASK, chatId: "harbour-chat", channelType: "cli", userId, maxEpochs: 1 },
      { mode: "background", onEvent: () => {}, deliverFinal: () => {} },
    );
  }

  /** The system prompt of the first model call of the run whose first turn names `task`. */
  function promptOfRun(task: string): string {
    const call = script.calls.find((c) => c.firstTurn.includes(`Task: ${task}`));
    expect(call, `no model call belongs to the run for "${task}"`).toBeDefined();
    return call!.systemPrompt;
  }

  it("gives the delegate its caller's own user-scoped instinct and never another user's", async () => {
    await runRoot("alice");

    const delegated = promptOfRun(DELEGATED_TASK);
    expect(delegated, "alice's own learning did not reach her delegate").toContain(ALICE_RULE);
    expect(delegated, "another user's private learning reached the delegate").not.toContain(BOB_RULE);
    expect(delegated, "shared project learning is still given").toContain(PROJECT_RULE);
    expect(delegated, "the delegate was given learning filed under its own id").not.toContain(SUB_AGENT_RULE);
  });

  it("keeps everything else keyed by the sub-agent: only instinct retrieval changes identity", async () => {
    await runRoot("alice");

    expect(readContexts).toHaveLength(1);
    expect(readContexts[0]!.parentRun?.instinctUserId).toBe("alice");
    // Memory recall and the autonomy-pref key stay the delegate's own (#53 decides those).
    expect(readContexts[0]!.recallUserId).toBe("sub-agent");
    expect(readContexts[0]!.userId).toBeUndefined();
  });

  it("hands the delegate's in-run refresher the same owner its setup retrieved for", async () => {
    const built = vi.spyOn(SessionManager.prototype, "createMemoryRefresher");
    try {
      await runRoot("alice");
      // The root run, then its delegate: the delegate's recall stays its own,
      // its instinct re-retrieval is the caller's (memory-refresher-instinct-owner.test.ts).
      const identities = built.mock.calls.map((call) => call[2]);
      expect(identities).toContainEqual(expect.objectContaining({ userId: "sub-agent", instinctOwner: { userId: "alice" } }));
    } finally {
      built.mockRestore();
    }
  });

  it("carries the caller's person through a delegate's own delegation", async () => {
    let manager: DelegationManager | undefined;
    nestFrom = async (context) => {
      await manager!.delegate({
        type: "station_check",
        task: NESTED_TASK,
        parentAgentId: "delegate-agent" as AgentId,
        depth: 1,
        mode: "sync",
        toolContext: context,
      });
    };
    // The manager is the one the root run delegates through.
    await runRoot("bob", (m) => {
      manager = m;
    });

    const nested = promptOfRun(NESTED_TASK);
    expect(nested, "bob's learning did not reach his delegate's delegate").toContain(BOB_RULE);
    expect(nested, "another user's private learning reached the nested delegate").not.toContain(ALICE_RULE);
    expect(nested).not.toContain(SUB_AGENT_RULE);
    expect(readContexts.map((c) => c.parentRun?.instinctUserId)).toEqual(["bob", "bob"]);
  });

  it("a delegation with no calling run gets shared learning only, as before", async () => {
    const manager = buildManager(sharedDeps());
    await manager.delegate({
      type: "station_check",
      task: DELEGATED_TASK,
      parentAgentId: "root-agent" as AgentId,
      depth: 0,
      mode: "sync",
      toolContext: { projectPath, workingDirectory: projectPath, readOnly: false },
    });

    const delegated = promptOfRun(DELEGATED_TASK);
    expect(delegated).toContain(PROJECT_RULE);
    expect(delegated, "a private instinct reached a delegate whose caller is unknown").not.toContain(ALICE_RULE);
    expect(delegated, "a private instinct reached a delegate whose caller is unknown").not.toContain(BOB_RULE);
    expect(delegated, "a private instinct reached a delegate whose caller is unknown").not.toContain(SUB_AGENT_RULE);
  });

  it("chooses the delegate's recovery guidance for its caller's person, never another user's", async () => {
    const errorFix = { type: "error_fix" as const, trigger: READ_ERROR };
    seed("fix-alice", ALICE_FIX, "user", "alice", errorFix);
    seed("fix-bob", BOB_FIX, "user", "bob", errorFix);
    failRead = true;

    await runRoot("alice", undefined, sharedDeps({ errorLearning: true }));

    expect(readContexts, "the delegate never read the anemometer").toHaveLength(1);
    // Recovery guidance is recorded as shown only when it reached the prompt.
    const shown = learningStorage
      .getDatabase()!
      .prepare("SELECT instinct_id FROM instinct_exposure_log")
      .all() as Array<{ instinct_id: string }>;
    const ids = shown.map((row) => row.instinct_id);
    expect(ids, "alice's own recovery rule was not offered to her delegate").toContain("fix-alice");
    expect(ids, "another user's private recovery rule was offered").not.toContain("fix-bob");
  });
});
