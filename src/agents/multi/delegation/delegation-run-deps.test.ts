/**
 * A delegated sub-agent's orchestrator gets the run dependencies a chat turn's gets.
 *
 * DelegationManager built its Orchestrator from the tool list, the provider
 * and the lease path, and nothing else the root or a per-agent orchestrator
 * is given. Measured on that construction: a Strada.MCP scene writer read as
 * read-only and parallel-safe, a bridge tool was offered with the editor
 * closed, the USD cap was Infinity with $0.50 of daily headroom left, the
 * TASK_* limits were the defaults, and no learning, intervention or consensus
 * hook was wired. Its projectPath and its tool calls' sourceProjectPath were
 * both the lease, which no vault is registered against: vault_graph_explore
 * fell back to every vault (Strada.Brain's own included) and the prompt told
 * the delegate its project was not indexed.
 *
 * These tests drive the real DelegationManager -> real Orchestrator
 * construction. Only the runner is faked: it hands over the orchestrator the
 * delegation built, and the tests read it through the surfaces a run uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DelegationManager, type DelegationManagerOptions } from "./delegation-manager.js";
import { DelegationLog } from "./delegation-log.js";
import { TierRouter } from "./tier-router.js";
import { AgentBudgetTracker } from "../agent-budget-tracker.js";
import type { SharedOrchestratorDeps } from "../agent-manager.js";
import type { AgentId } from "../agent-types.js";
import type { DelegationConfig, ModelTier } from "./delegation-types.js";
import { DaemonStorage } from "../../../daemon/daemon-storage.js";
import { ToolRegistry } from "../../../core/tool-registry.js";
import { UnifiedBudgetManager } from "../../../budget/unified-budget-manager.js";
import { DEFAULT_TASK_CONFIG } from "../../../config/config-types.js";
import { VaultRegistry } from "../../../vault/vault-registry.js";
import type { IVault } from "../../../vault/vault.interface.js";
import { VaultGraphExploreTool } from "../../tools/vault-graph-explore-tool.js";
import type { ToolContext } from "../../tools/tool-core.interface.js";
import type { ITool } from "../../tools/tool.interface.js";
import type { Orchestrator } from "../../orchestrator.js";
import type { IEventBus, LearningEventMap } from "../../../core/event-bus.js";

vi.mock("../../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

// No HTTP client for the tier's provider: the runner below never calls it.
vi.mock("../../providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/provider-registry.js")>();
  return {
    ...actual,
    createProvider: vi.fn((config: { name: string }) => ({
      name: config.name,
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
      chat: vi.fn(),
    })),
  };
});

vi.mock("../../providers/provider-manager.js", () => ({
  ProviderManager: vi.fn().mockImplementation(function (this: Record<string, unknown>, provider: unknown) {
    this.getProvider = () => provider;
    this.getProviderByName = () => provider;
    this.getPrimaryProviderByName = () => provider;
    this.getActiveInfo = () => ({ providerName: "deepseek", model: "deepseek-chat", isDefault: true });
    this.listAvailable = () => [{ name: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat" }];
    this.isAvailable = () => true;
    this.shutdown = vi.fn();
  }),
}));

/** What the fake runner does with the orchestrator the delegation built, while the run is open. */
let duringRun: ((orchestrator: Orchestrator, request: { workspaceLease?: unknown }) => Promise<void>) | undefined;

vi.mock("../../../agent-core/runner/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agent-core/runner/index.js")>();
  return {
    ...actual,
    selectAgentRunner: vi.fn((orchestrator: Orchestrator) => ({
      run: async (request: { workspaceLease?: unknown }) => {
        await duringRun?.(orchestrator, request);
        return {
          status: "completed", finalText: "done", finalSummary: "done", provider: "deepseek",
          catalogVersion: "deepseek:deepseek-chat", assignmentVersion: 0, touchedFiles: [], toolTrace: [],
          verificationResults: [], reviewFindings: [], artifacts: [],
        };
      },
    })),
  };
});

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

const PARENT = "parent-001" as AgentId;

/** A Strada.MCP-shaped tool: the adapter carries no metadata of its own, only the registry does. */
function mcpTool(name: string): ITool {
  return {
    name,
    description: `${name} (Strada.MCP)`,
    inputSchema: { type: "object", properties: { scenePath: { type: "string" } } },
    execute: vi.fn(async () => ({ content: "ok" })),
  } as unknown as ITool;
}

interface FakeVault {
  id: string;
  kind: string;
  rootPath: string;
  query: ReturnType<typeof vi.fn>;
  readCanvas: ReturnType<typeof vi.fn>;
  listFiles: () => Array<{ path: string }>;
  dispose: () => Promise<void>;
}

function fakeVault(id: string, kind: string, rootPath: string): FakeVault {
  return {
    id,
    kind,
    rootPath,
    query: vi.fn().mockResolvedValue({ hits: [], budgetUsed: 0, truncated: false }),
    readCanvas: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    listFiles: () => [{ path: "Assets/Scripts/MatchResolver.cs" }, { path: "Assets/Scripts/Board.cs" }],
    dispose: async () => undefined,
  };
}

/** The private gates a tool call passes through, read on the live delegate. */
interface DelegateInternals {
  isWriteOperation(name: string): boolean;
  isParallelSafeToolCall(tc: { id: string; name: string; input: Record<string, unknown> }): boolean;
  executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<Array<{ content: string; isError?: boolean }>>;
  systemPrompt: string;
}

describe("DelegationManager builds the delegate's orchestrator with a chat turn's run dependencies", () => {
  let tmpDir: string;
  let project: string;
  let lease: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;

  beforeEach(() => {
    duringRun = undefined;
    // The lexical tmpdir form on purpose: on macOS /var/..., its realpath /private/var/...
    tmpDir = mkdtempSync(join(tmpdir(), "delegation-run-deps-"));
    project = join(tmpDir, "SampleGame");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(tmpDir, "strada-brain"), { recursive: true });
    lease = join(tmpDir, "strada-workspaces", "delegation-1");
    mkdirSync(lease, { recursive: true });
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
  });

  afterEach(() => {
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The shared deps object bootstrap builds; markers so identity can be checked. */
  function sharedDeps(): SharedOrchestratorDeps {
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
      // TASK_BACKGROUND_EPOCH_MAX_ITERATIONS=6 (below the type's 10),
      // TASK_INTERACTIVE_TOKEN_BUDGET=50000.
      taskConfig: { ...DEFAULT_TASK_CONFIG, backgroundEpochMaxIterations: 6, interactiveTokenBudget: 50_000 },
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
    };
  }

  function registryWithTools(): ToolRegistry {
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
    toolRegistry.register(new VaultGraphExploreTool() as unknown as ITool, { readOnly: true });
    return toolRegistry;
  }

  /** Every vault a campaign boot registers: the project's, against its resolved root, and Strada.Brain's own. */
  function campaignVaults(): { registry: VaultRegistry; projectVault: FakeVault; selfVault: FakeVault } {
    const projectVault = fakeVault("unity:project", "unity-project", realpathSync(project));
    const selfVault = fakeVault("self:strada-brain", "self", join(tmpDir, "strada-brain"));
    const registry = new VaultRegistry();
    registry.register(projectVault as unknown as IVault);
    registry.register(selfVault as unknown as IVault);
    return { registry, projectVault, selfVault };
  }

  /** A lease at `lease`, cut from the project; its commit publishes nothing and loses nothing. */
  function leaseManager() {
    return {
      acquireLease: vi.fn().mockResolvedValue({
        id: "delegation-1", kind: "temp-copy", sourceRoot: project, leaseRoot: join(tmpDir, "strada-workspaces"),
        path: lease, createdAt: Date.now(),
        commit: vi.fn().mockResolvedValue({
          written: [], conflicts: [], removed: [], failed: [], conflictsQuarantinedUnder: null, quarantined: 0,
        }),
        release: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }

  function buildManager(overrides: Partial<DelegationManagerOptions> = {}): DelegationManager {
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    const toolRegistry = registryWithTools();
    const options = {
      config: CONFIG,
      tierRouter: new TierRouter(TIERS),
      delegationLog: new DelegationLog(db),
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), shutdown: vi.fn() } as unknown as IEventBus<LearningEventMap>,
      budgetTracker,
      channel: { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: project,
      readOnly: false,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] },
      parentTools: toolRegistry.getAllTools(),
      toolMetadataByName: toolRegistry.getMetadataMap(),
      sharedOrchestratorDeps: sharedDeps(),
      apiKeys: { deepseek: "test-key" },
      ...overrides,
    } satisfies DelegationManagerOptions;
    return new DelegationManager(options);
  }

  /** The caller: a chat turn working in the project itself. */
  const callerContext: ToolContext = {
    projectPath: project,
    sourceProjectPath: project,
    workingDirectory: project,
    readOnly: false,
    chatId: "cli-local",
    userId: "cli-user",
  } as ToolContext;

  /** Delegate once and return what `inspect` read off the delegate's orchestrator mid-run. */
  async function delegateAndInspect<T>(
    manager: DelegationManager,
    inspect: (orchestrator: Orchestrator, request: { workspaceLease?: unknown }) => Promise<T> | T,
  ): Promise<T> {
    let seen: { value: T } | undefined;
    duringRun = async (orchestrator, request) => {
      seen ??= { value: await inspect(orchestrator, request) };
    };
    await manager.delegate({
      type: "code_review", task: "Review MatchResolver", parentAgentId: PARENT, depth: 0, mode: "sync", toolContext: callerContext,
    });
    expect(seen, "the delegated run never reached the runner").toBeDefined();
    return seen!.value;
  }

  it("classifies a registry-declared Unity writer as a write that runs serially, and hides it while the bridge is down", async () => {
    const manager = buildManager();

    const seen = await delegateAndInspect(manager, (orchestrator) => {
      const gates = orchestrator as unknown as DelegateInternals;
      return {
        write: ["unity_open_scene", "unity_set_transform"].map((name) => gates.isWriteOperation(name)),
        parallel: ["unity_open_scene", "unity_set_transform"].map((name) =>
          gates.isParallelSafeToolCall({ id: "t1", name, input: {} })),
        offered: orchestrator.toolOfferedNow("unity_open_scene"),
      };
    });

    expect(seen.write, "Unity writers are writes").toEqual([true, true]);
    expect(seen.parallel, "Unity writers run serially").toEqual([false, false]);
    expect(seen.offered).toEqual({ offered: false, reason: "Unity bridge disconnected" });
  });

  it("bounds the delegated run by the operator's TASK_* limits", async () => {
    const manager = buildManager();

    const seen = await delegateAndInspect(manager, (orchestrator) => {
      const { port, seed } = orchestrator.createAgentCorePort();
      return { outputTokenCap: seed.outputTokenCap, epochLimit: port.getBackgroundEpochIterationLimit() };
    });

    expect(seen.outputTokenCap).toBe(50_000);
    // The type's own maxIterations (10) still caps it from above; the operator's 6 is lower.
    expect(seen.epochLimit).toBe(6);
  });

  it("bounds the delegated run by the live USD headroom", async () => {
    const unified = new UnifiedBudgetManager(daemonStorage, { emit: () => {} }, {});
    unified.updateConfig({ dailyLimitUsd: 10 });
    unified.recordCost(9.5, "daemon", { model: "deepseek-chat" });
    const manager = buildManager();
    manager.setUnifiedBudgetManager(unified);

    const costCapUsd = await delegateAndInspect(manager, (orchestrator) =>
      orchestrator.createAgentCorePort().seed.costCapUsd);

    expect(costCapUsd).toBeCloseTo(0.5, 6);
  });

  it("hands the run the learning, intervention, trajectory and consensus hooks the root run has", async () => {
    const shared = sharedDeps();
    const manager = buildManager({ sharedOrchestratorDeps: shared });

    const held = await delegateAndInspect(manager, (orchestrator) => ({ ...(orchestrator as unknown as Record<string, unknown>) }));

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
    expect(held["conformanceFrameworkPathsOnly"]).toBe(true);
  });

  it("resolves the project's vault from a leased delegate, for its tools and its prompt", async () => {
    const { registry, projectVault, selfVault } = campaignVaults();
    const manager = buildManager({ vaultRegistry: registry, workspaceLeaseManager: leaseManager() as never });

    const seen = await delegateAndInspect(manager, async (orchestrator, request) => {
      const delegate = orchestrator as unknown as DelegateInternals;
      const [result] = await delegate.executeToolCalls(
        "delegation-sub",
        [{ id: "c1", name: "vault_graph_explore", input: { query: "MatchResolver" } }],
        { mode: "delegated", workspaceLease: request.workspaceLease },
      );
      return { result, prompt: delegate.systemPrompt };
    });

    expect(seen.result?.isError, seen.result?.content).toBeFalsy();
    // The lease owns no vault: resolving on it fell back to every vault.
    expect(projectVault.query).toHaveBeenCalled();
    expect(selfVault.query).not.toHaveBeenCalled();
    expect(seen.prompt).toContain("This project is indexed in the vault: 2 files");
    expect(seen.prompt).not.toContain("NOT indexed in the vault");
  });

  it("reviews a leased delegate's shell command with the real root shell_exec redirects from", async () => {
    // shell_exec rewrites the real root to the lease (redirectSourceProjectPath);
    // the review has to read the command the same way, or it judges another one.
    const manager = buildManager({ workspaceLeaseManager: leaseManager() as never });

    const reviewed = await delegateAndInspect(manager, async (orchestrator, request) => {
      const host = orchestrator as unknown as {
        reviewShellCommandWithProvider(...args: unknown[]): Promise<unknown>;
        reviewSelfManagedWriteOperation(chatId: string, tool: string, input: unknown, mode: string, opts: unknown): Promise<unknown>;
      };
      const review = vi.spyOn(host, "reviewShellCommandWithProvider").mockResolvedValue({ approved: true });
      await host.reviewSelfManagedWriteOperation(
        "delegation-sub", "shell_exec", { command: `dotnet build ${project}/SampleGame.sln` }, "delegated",
        { workspaceLease: request.workspaceLease },
      );
      return review.mock.calls[0]?.[3] as { projectPath?: string; sourceProjectPath?: string } | undefined;
    });

    expect(reviewed?.projectPath).toBe(lease);
    expect(reviewed?.sourceProjectPath).toBe(project);
  });

  // Each delegated run wrote its trajectory under its temporary lease path,
  // a key no replay read ever matches: rows piled up in learning storage
  // under throwaway project ids (review delegation-wiring P3).
  it("records a leased delegate's trajectory under the project, not the lease", async () => {
    const recordTrajectory = vi.fn();
    const shared = {
      ...sharedDeps(),
      learningPipeline: { recordTrajectory, isTrajectoryLevelCreditEnabled: () => false } as never,
    };
    const manager = buildManager({ sharedOrchestratorDeps: shared, workspaceLeaseManager: leaseManager() as never });

    await delegateAndInspect(manager, (orchestrator) => {
      (orchestrator as unknown as { recordInRunTrajectoryCredit(params: unknown): void }).recordInRunTrajectoryCredit({
        chatId: "delegation-sub",
        sessionId: "delegation-sub",
        taskDescription: "Review MatchResolver",
        success: true,
        stepResults: [{ toolName: "file_read", success: true, summary: "read MatchResolver.cs", timestamp: Date.now() }],
      });
    });

    expect(recordTrajectory).toHaveBeenCalledTimes(1);
    expect(recordTrajectory.mock.calls[0]?.[0]).toMatchObject({ projectId: project });
  });

  it("builds a leased delegate's replay context on the project's world, not the lease's", async () => {
    const manager = buildManager({ workspaceLeaseManager: leaseManager() as never });

    const replay = await delegateAndInspect(manager, (orchestrator) =>
      orchestrator.buildTrajectoryReplayContext({ chatId: "delegation-sub" }));

    expect(replay?.projectWorldSummary).toContain(`root=${project}`);
    expect(replay?.projectWorldSummary).not.toContain(lease);
  });

  it("bootstrap hands the delegation manager the unified budget manager", () => {
    // bootstrap's daemon block cannot run in a unit test; the setter is not
    // type-enforced, so its call is checked where it is made.
    const bootstrap = readFileSync(fileURLToPath(new URL("../../../core/bootstrap.ts", import.meta.url)), "utf8");
    expect(bootstrap).toMatch(/delegationManager\?\.setUnifiedBudgetManager\(unifiedBudgetManager\)/);
  });
});
