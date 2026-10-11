/**
 * Per-agent orchestrators get the run dependencies the root orchestrator gets.
 *
 * With multi-agent on (what setup writes) every chat turn runs on the
 * orchestrator AgentManager builds for that chat. That construction passed the
 * tool list and nothing the registry knew about it, never wired the unified
 * budget manager, and carried none of the operator's TASK_* limits or the
 * learning, intervention and consensus hooks. Measured on the old construction:
 * a Strada.MCP scene writer read as read-only and parallel-safe, a bridge tool
 * was offered with the editor closed, the USD cap was Infinity with $0.50 of
 * daily headroom left, and an epoch ran 50 iterations with TASK limits of 10.
 *
 * These tests drive the real AgentManager → real Orchestrator construction and
 * read the per-agent orchestrator through the surfaces a run uses. The last
 * block is a textual tripwire over the two construction sites: bootstrap's root
 * orchestrator cannot be run in a unit test, so a dependency added there is
 * caught by comparing the two option lists instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentManager, type AgentManagerOptions, type SharedOrchestratorDeps } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import { TypedEventBus, type LearningEventMap } from "../../core/event-bus.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { ToolRegistry } from "../../core/tool-registry.js";
import { UnifiedBudgetManager } from "../../budget/unified-budget-manager.js";
import { DEFAULT_TASK_CONFIG } from "../../config/config-types.js";
import type { Orchestrator } from "../orchestrator.js";
import type { ITool } from "../tools/tool.interface.js";
import type { IncomingMessage } from "../../channels/channel-messages.interface.js";

vi.mock("../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

vi.mock("../context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

// Per-agent memory is not what this file is about; keep SQLite + HNSW out of it.
vi.mock("../../memory/unified/agentdb-memory.js", () => ({
  AgentDBMemory: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      shutdown: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      close: vi.fn().mockResolvedValue(undefined),
      getUserProfileStore: vi.fn().mockReturnValue(null),
      getStats: vi.fn(() => ({ totalEntries: 0 })),
    };
  }),
}));

/** A Strada.MCP-shaped tool: the adapter carries no metadata of its own, only the registry does. */
function mcpTool(name: string): ITool {
  return {
    name,
    description: `${name} (Strada.MCP)`,
    inputSchema: { type: "object", properties: { scenePath: { type: "string" } } },
    execute: vi.fn(async () => ({ content: "ok" })),
  } as unknown as ITool;
}

/** The private gates a tool call passes through, read on the live per-agent instance. */
interface ToolGates {
  isWriteOperation(name: string): boolean;
  isParallelSafeToolCall(tc: { id: string; name: string; input: Record<string, unknown> }): boolean;
}

describe("AgentManager per-agent orchestrators carry the root orchestrator's run dependencies", () => {
  let db: Database.Database;
  let tmpDir: string;
  let daemonStorage: DaemonStorage;
  let eventBus: TypedEventBus<LearningEventMap>;
  let manager: AgentManager | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "agent-mgr-run-deps-"));
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    eventBus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await eventBus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The shared deps object bootstrap builds; markers so identity can be checked. */
  function sharedDeps(overrides: Partial<SharedOrchestratorDeps> = {}): SharedOrchestratorDeps {
    return {
      trajectoryReplayRetriever: { tag: "trajectory-replay" } as never,
      learningPipeline: { tag: "learning-pipeline" } as never,
      errorLearningHooks: { tag: "error-learning-hooks" } as never,
      interventionEngine: { tag: "intervention-engine" } as never,
      modelIntelligence: { tag: "model-intelligence" } as never,
      consensusManager: { tag: "consensus-manager" } as never,
      confidenceEstimator: { tag: "confidence-estimator" } as never,
      runtimeArtifactManager: undefined,
      autonomousDefaultEnabled: false,
      autonomousDefaultHours: 24,
      interactionConfig: undefined,
      // TASK_BACKGROUND_EPOCH_MAX_ITERATIONS=10, TASK_BACKGROUND_AUTO_CONTINUE=false,
      // TASK_INTERACTIVE_TOKEN_BUDGET=50000.
      taskConfig: {
        ...DEFAULT_TASK_CONFIG,
        backgroundEpochMaxIterations: 10,
        backgroundAutoContinue: false,
        backgroundMaxEpochs: 1,
        interactiveTokenBudget: 50_000,
      },
      supervisorComplexityThreshold: "moderate",
      conformanceEnabled: true,
      conformanceFrameworkPathsOnly: true,
      loopFingerprintThreshold: undefined,
      loopFingerprintWindow: undefined,
      loopDensityThreshold: undefined,
      loopDensityWindow: undefined,
      loopMaxRecoveryEpisodes: undefined,
      loopStaleAnalysisThreshold: undefined,
      loopHardCapReplan: undefined,
      loopHardCapBlock: undefined,
      progressAssessmentEnabled: true,
      onSkillCreated: undefined,
      getSkillEntries: undefined,
      agentCoreFlagSet: undefined,
      capabilityRegistry: undefined,
      capabilityAdapters: undefined,
      ...overrides,
    };
  }

  function buildManager(toolRegistry: ToolRegistry, shared: SharedOrchestratorDeps): AgentManager {
    const registry = new AgentRegistry(db);
    registry.initialize();
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    const provider = {
      name: "kimi",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true, thinkingSupported: false },
      chat: vi.fn(),
    };
    const options = {
      config: { enabled: true, defaultBudgetUsd: 5, maxConcurrent: 4, idleTimeoutMs: 60_000, maxMemoryEntries: 1000 },
      registry,
      budgetTracker,
      eventBus,
      providerManager: {
        getProvider: () => provider,
        getProviderByName: () => provider,
        getPrimaryProviderByName: () => provider,
        getActiveInfo: () => ({ providerName: "kimi", model: "kimi-model", isDefault: true }),
        listAvailable: () => [{ name: "kimi", label: "Kimi", defaultModel: "kimi-model" }],
        isAvailable: () => true,
        shutdown: vi.fn(),
      } as never,
      toolRegistry,
      channel: { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: join(tmpDir, "project"),
      readOnly: false,
      requireConfirmation: true,
      stradaDeps: { coreInstalled: true } as never,
      memoryConfig: { dimensions: 8, dbBasePath: tmpDir },
      instinctRetriever: { tag: "instinct-retriever" } as never,
      sharedOrchestratorDeps: shared,
    } satisfies AgentManagerOptions;
    return new AgentManager(options);
  }

  /** Route one chat message the way production does (background submitter) and return the orchestrator it ran on. */
  async function chatTurnOrchestrator(m: AgentManager, chatId = "cli-local"): Promise<Orchestrator> {
    let captured: Orchestrator | undefined;
    m.setBackgroundTaskSubmitter((_msg, _agent, orchestrator) => {
      captured = orchestrator;
    });
    const msg: IncomingMessage = { channelType: "cli", chatId, userId: "cli-user", text: "open the main scene", timestamp: new Date() };
    await m.routeMessage(msg);
    expect(captured).toBeDefined();
    return captured!;
  }

  function registryWithUnityWriter(): ToolRegistry {
    const toolRegistry = new ToolRegistry();
    // As registerStradaMcpTools registers them: the declaration lives in the
    // registry, and the editor is closed.
    toolRegistry.register(mcpTool("unity_open_scene"), {
      readOnly: false,
      requiresBridge: true,
      available: false,
      availabilityReason: "Unity bridge disconnected",
    });
    toolRegistry.register(mcpTool("unity_set_transform"), { readOnly: false, requiresBridge: true });
    return toolRegistry;
  }

  it("classifies a registry-declared Unity writer as a write that runs serially, and hides it while the bridge is down", async () => {
    const toolRegistry = registryWithUnityWriter();
    manager = buildManager(toolRegistry, sharedDeps());
    const orchestrator = await chatTurnOrchestrator(manager);
    const gates = orchestrator as unknown as ToolGates;

    for (const name of ["unity_open_scene", "unity_set_transform"]) {
      expect(gates.isWriteOperation(name), `${name} is a write`).toBe(true);
      expect(gates.isParallelSafeToolCall({ id: "t1", name, input: {} }), `${name} runs serially`).toBe(false);
    }
    expect(orchestrator.toolOfferedNow("unity_open_scene")).toEqual({
      offered: false,
      reason: "Unity bridge disconnected",
    });

    // The registry's map is read live: the editor coming back offers the tool again.
    const live = toolRegistry.getMetadataMap() as Map<string, { available?: boolean }>;
    live.set("unity_open_scene", { ...live.get("unity_open_scene"), available: true });
    expect(orchestrator.toolOfferedNow("unity_open_scene")).toEqual({ offered: true });
  });

  it("bounds the run by the live USD headroom and the operator's TASK_* limits", async () => {
    const unified = new UnifiedBudgetManager(daemonStorage, { emit: () => {} }, {});
    unified.updateConfig({ dailyLimitUsd: 10 });
    unified.recordCost(9.5, "daemon", { model: "kimi-model" });

    manager = buildManager(registryWithUnityWriter(), sharedDeps());
    manager.setUnifiedBudgetManager(unified);
    const orchestrator = await chatTurnOrchestrator(manager);

    const { port, seed } = orchestrator.createAgentCorePort();
    expect(seed.costCapUsd).toBeCloseTo(0.5, 6);
    expect(seed.outputTokenCap).toBe(50_000);
    expect(port.getBackgroundEpochIterationLimit()).toBe(10);
    expect(port.canAutoContinueBackgroundEpoch(1)).toBe(false);
  });

  it("wires a budget manager set after an agent is already live", async () => {
    manager = buildManager(registryWithUnityWriter(), sharedDeps());
    const orchestrator = await chatTurnOrchestrator(manager);
    expect(orchestrator.createAgentCorePort().seed.costCapUsd).toBe(Number.POSITIVE_INFINITY);

    const unified = new UnifiedBudgetManager(daemonStorage, { emit: () => {} }, {});
    unified.updateConfig({ dailyLimitUsd: 10 });
    unified.recordCost(9.5, "daemon", { model: "kimi-model" });
    manager.setUnifiedBudgetManager(unified);

    expect(orchestrator.createAgentCorePort().seed.costCapUsd).toBeCloseTo(0.5, 6);
  });

  it("hands the run the learning, intervention, trajectory and consensus hooks the root run has", async () => {
    const shared = sharedDeps();
    manager = buildManager(registryWithUnityWriter(), shared);
    const orchestrator = await chatTurnOrchestrator(manager);
    const held = orchestrator as unknown as Record<string, unknown>;

    for (const key of [
      "learningPipeline",
      "errorLearningHooks",
      "interventionEngine",
      "trajectoryReplayRetriever",
      "consensusManager",
      "confidenceEstimator",
      "modelIntelligence",
    ] as const) {
      expect(held[key], key).toBe(shared[key]);
    }
    expect(held["supervisorComplexityThreshold"]).toBe("moderate");
    expect(held["conformanceFrameworkPathsOnly"]).toBe(true);
  });
});

// =============================================================================
// Tripwire: a root dependency cannot be dropped at the per-agent site unnoticed
// =============================================================================

/** Top-level keys and spreads of the object literal passed to `new Orchestrator({`. */
function orchestratorOptionKeys(source: string, anchor: string): { keys: Set<string>; spreads: string[] } {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`construction site not found: ${anchor}`);
  // Comments first: they hold apostrophes and braces the walk below would misread.
  const body = source
    .slice(at + anchor.length - 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  const keys = new Set<string>();
  const spreads: string[] = [];
  let depth = 0;
  let segment = "";
  const flush = () => {
    const entry = segment.trim();
    segment = "";
    if (!entry) return;
    if (entry.startsWith("...")) spreads.push(entry.slice(3).trim());
    else {
      const key = /^([A-Za-z_$][\w$]*)/.exec(entry)?.[1];
      if (key) keys.add(key);
    }
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = body.indexOf(ch, i + 1);
      segment += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) {
        flush();
        return { keys, spreads };
      }
    } else if (ch === "," && depth === 1) {
      flush();
      continue;
    }
    if (depth >= 1) segment += ch;
  }
  throw new Error(`unterminated construction at ${anchor}`);
}

/**
 * Root-orchestrator options the per-agent orchestrator deliberately does not
 * take, and why. Anything the root gets that is neither here nor at the
 * per-agent site is a dependency some chat turn silently runs without.
 */
const ROOT_ONLY: Record<string, string> = {
  taskExecutionStore: "the root memory's execution store; agent memories are isolated from it",
  sessionSummarizer: "summarizes into the root memory's execution store",
  memoryDbPath: "the root's session files; an agent's belong with its own memory",
  interruptedGoalTrees: "the last process's goal trees resume once, on the root, not once per agent",
  crashRecoveryContext: "crash recovery is reported once, by the root",
};

describe("per-agent Orchestrator construction (tripwire over the construction sites)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const anchor = "const orchestrator = new Orchestrator({";
  const root = orchestratorOptionKeys(read("../../core/bootstrap.ts"), anchor);
  const perAgent = orchestratorOptionKeys(read("./agent-manager.ts"), anchor);

  it("spreads the one shared deps object at both sites", () => {
    expect(root.spreads).toContain("sharedOrchestratorDeps");
    expect(perAgent.spreads).toContain("this.opts.sharedOrchestratorDeps");
  });

  it("gives the per-agent orchestrator every option the root gets, or names why not", () => {
    const dropped = [...root.keys].filter((key) => !perAgent.keys.has(key) && !(key in ROOT_ONLY));
    expect(dropped, "root options a chat turn would run without: share them or list them in ROOT_ONLY").toEqual([]);
  });

  it("lists in ROOT_ONLY only options the root really has and the agent really lacks", () => {
    for (const key of Object.keys(ROOT_ONLY)) {
      expect(root.keys.has(key), `${key} is a root option`).toBe(true);
      expect(perAgent.keys.has(key), `${key} is not passed per agent`).toBe(false);
    }
  });

  it("hands bootstrap's shared deps to the multi-agent stage", () => {
    const bootstrap = read("../../core/bootstrap.ts");
    const call = bootstrap.slice(bootstrap.indexOf("await initializeMultiAgentDelegationStage({"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/\bsharedOrchestratorDeps\b/);
  });
});
