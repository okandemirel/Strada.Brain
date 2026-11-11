/**
 * What each root dependency would change in a delegated run, measured.
 *
 * DelegationManager builds a delegate's Orchestrator without eleven options the
 * root gets (DELEGATE_EXEMPT in agent-manager-run-deps.test.ts). This file
 * drives the real DelegationManager -> real Orchestrator -> real V2 runner with
 * a scripted provider, once with the delegated construction as it is and once
 * per option with that option added, and pins what the run does with it:
 * provider calls, what the model is sent, extra embedding or LLM calls, and
 * what the run writes and under which identity. DELEGATE_EXEMPT's reasons
 * cite these cases.
 *
 * The option is added through the shared deps object, which the delegated site
 * spreads first, so measuring it needs no source change. Real classes are used
 * where they run in a test (AgentDB memory, user profiles, DM policy, soul
 * loader, goal decomposer); the RAG pipeline, the embedder and the supervisor
 * are recording fakes. What this cannot measure is whether a real model's
 * answer gets better with the added context: the provider is scripted.
 *
 * DELEGATE_DEPS_MEASURE_OUT=<file> writes every case's numbers there as JSON.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { TypedEventBus, type LearningEventMap } from "../../../core/event-bus.js";
import type { ITool } from "../../tools/tool.interface.js";
import { estimateTextTokens } from "../../../common/token-estimator.js";
import { AgentDBMemory } from "../../../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../../../memory/unified/agentdb-adapter.js";
import { MemoryTier } from "../../../memory/unified/unified-memory.interface.js";
import { RateLimiter } from "../../../security/rate-limiter.js";
import { DMPolicy } from "../../../security/dm-policy.js";
import { SoulLoader } from "../../soul/soul-loader.js";
import { GoalDecomposer } from "../../../goals/goal-decomposer.js";
import type { ChatId } from "../../../types/index.js";

vi.mock("../../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

/** Every provider call a run makes, as the provider received it, and the script's knobs. */
const rec = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; messages: string; tools: number; billedTokens: number }>,
  /** Tool turns the delegate takes before it answers. */
  toolTurns: 1,
  /** The shared estimator, set in beforeEach: a hoisted block runs before the imports. */
  estimate: (text: string) => Math.ceil(text.length / 4),
}));

const provider = vi.hoisted(() => ({
  name: "deepseek",
  capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: async (systemPrompt: string, messages: unknown[], tools: unknown[]) => {
    const transcript = JSON.stringify(messages);
    const inputTokens = rec.estimate(systemPrompt) + rec.estimate(transcript);
    rec.calls.push({ system: systemPrompt, messages: transcript, tools: tools.length, billedTokens: inputTokens + 20 });
    const usage = { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20 };
    if (tools.length === 0) {
      // Tool-less calls are planning/review calls. A decomposition gets a plan.
      return transcript.includes("Decompose this task")
        ? {
          text: JSON.stringify({
            nodes: [
              { id: "read", task: "Read the north anemometer", dependsOn: [] },
              { id: "report", task: "Report the reading", dependsOn: ["read"] },
            ],
          }),
          toolCalls: [],
          stopReason: "end_turn",
          usage,
        }
        : { text: "OK", toolCalls: [], stopReason: "end_turn", usage };
    }
    const done = new Set(transcript.match(/north-\d+: 12 knots/g) ?? []).size;
    return done >= rec.toolTurns
      ? { text: "The north anemometer reads 12 knots.", toolCalls: [], stopReason: "end_turn", usage }
      : {
        text: "",
        toolCalls: [{ id: `tc-${rec.calls.length}`, name: "anemometer_read", input: { station: `north-${done}` } }],
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

const TASK = "Check the north anemometer reading";
/** config-schema's reRetrieval defaults (RE_RETRIEVAL_*), as bootstrap passes config.reRetrieval. */
const RE_RETRIEVAL_DEFAULTS = {
  enabled: true,
  interval: 5,
  topicShiftEnabled: true,
  topicShiftThreshold: 0.4,
  maxReRetrievals: 10,
  timeoutMs: 5000,
  memoryLimit: 3,
  ragTopK: 6,
};

/** What one delegated run did. */
interface RunMeasure {
  readonly providerCalls: number;
  readonly workerCalls: number;
  readonly auxiliaryCalls: number;
  /** System prompt of the first worker call. */
  readonly firstSystemChars: number;
  /** Every call's system prompt + messages, estimated with the shared estimator. */
  readonly inputTokens: number;
  /** Input + output tokens the provider reported, summed over every call. */
  readonly billedTokens: number;
  /** Tokens the delegation's budget was charged with. */
  readonly meteredTokens: number;
  readonly content: string;
  readonly system: string;
}

const report: Record<string, Record<string, unknown>> = {};

/** A real object whose method calls are counted; behaviour is the object's own. */
function counted<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

describe("root dependencies in a delegated run (measured)", () => {
  let tmpDir: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;
  let bus: TypedEventBus<LearningEventMap>;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    rec.calls = [];
    rec.toolTurns = 1;
    rec.estimate = estimateTextTokens;
    tmpDir = mkdtempSync(join(tmpdir(), "delegation-root-deps-"));
    mkdirSync(join(tmpDir, "weather-station"), { recursive: true });
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    bus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await bus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    const out = process.env["DELEGATE_DEPS_MEASURE_OUT"];
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  });

  function anemometerTool(): ITool {
    return {
      name: "anemometer_read",
      description: "Read a weather station's anemometer.",
      inputSchema: { type: "object", properties: { station: { type: "string" } } },
      execute: vi.fn(async (input: { station?: string }) => ({ content: `${input.station ?? "north"}: 12 knots` })),
    } as unknown as ITool;
  }

  /** Bootstrap's shared deps with every optional hook off. */
  function sharedDeps(): SharedOrchestratorDeps {
    return {
      eventEmitter: bus,
      instinctRetriever: undefined,
      metrics: undefined,
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

  /** One delegated run, with `extra` added to what the delegated site spreads. */
  async function delegateWith(extra: Record<string, unknown> = {}, task = TASK): Promise<RunMeasure> {
    rec.calls = [];
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    let meteredTokens = 0;
    const recordCost = budgetTracker.recordCost.bind(budgetTracker);
    budgetTracker.recordCost = ((agentId, costUsd, meta) => {
      meteredTokens += (meta?.tokensIn ?? 0) + (meta?.tokensOut ?? 0);
      return recordCost(agentId, costUsd, meta);
    }) as typeof budgetTracker.recordCost;
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(anemometerTool(), { readOnly: true });
    const manager = new DelegationManager({
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
      sharedOrchestratorDeps: { ...sharedDeps(), ...extra } as SharedOrchestratorDeps,
      apiKeys: { deepseek: "test-key" },
    });
    const result = await manager.delegate({
      type: "code_review",
      task,
      parentAgentId: "parent-001" as AgentId,
      depth: 0,
      mode: "sync",
    });
    const worker = rec.calls.filter((call) => call.tools > 0);
    return {
      providerCalls: rec.calls.length,
      workerCalls: worker.length,
      auxiliaryCalls: rec.calls.length - worker.length,
      firstSystemChars: worker[0]?.system.length ?? 0,
      inputTokens: rec.calls.reduce((sum, call) => sum + estimateTextTokens(call.system) + estimateTextTokens(call.messages), 0),
      billedTokens: rec.calls.reduce((sum, call) => sum + call.billedTokens, 0),
      meteredTokens,
      content: result.content,
      system: worker[0]?.system ?? "",
    };
  }

  /** The run's numbers next to the baseline's, for the report and the assertions. */
  function delta(name: string, base: RunMeasure, run: RunMeasure, extra: Record<string, unknown> = {}) {
    const row = {
      providerCalls: run.providerCalls - base.providerCalls,
      auxiliaryCalls: run.auxiliaryCalls - base.auxiliaryCalls,
      systemCharsPerCall: run.firstSystemChars - base.firstSystemChars,
      systemTokensPerCall: estimateTextTokens(run.system) - estimateTextTokens(base.system),
      inputTokens: run.inputTokens - base.inputTokens,
      billedTokens: run.billedTokens - base.billedTokens,
      meteredTokens: run.meteredTokens - base.meteredTokens,
      sameAnswer: run.content === base.content,
      ...extra,
    };
    report[name] = {
      base: {
        providerCalls: base.providerCalls,
        inputTokens: base.inputTokens,
        firstSystemChars: base.firstSystemChars,
        billedTokens: base.billedTokens,
        meteredTokens: base.meteredTokens,
      },
      ...row,
    };
    return row;
  }

  /** The root's memory: a real AgentDB holding one conversation of the user's. */
  async function rootMemory(embedCalls: string[]) {
    const memory = new AgentDBMemory({
      dbPath: join(tmpDir, "memory"),
      dimensions: 8,
      maxEntriesPerTier: { [MemoryTier.Working]: 50, [MemoryTier.Ephemeral]: 50, [MemoryTier.Persistent]: 50 },
      hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
      quantizationType: "none",
      cacheSize: 10,
      enableAutoTiering: false,
      ephemeralTtlMs: 60_000,
      embeddingProvider: async (text: string) => {
        embedCalls.push(text.slice(0, 40));
        return Array.from({ length: 8 }, (_, i) => ((text.length + i) % 7) / 7);
      },
    });
    expect((await memory.initialize()).kind).toBe("ok");
    cleanups.push(async () => void (await memory.shutdown()));
    const adapter = new AgentDBAdapter(memory);
    await adapter.storeConversation("owner-chat" as ChatId, "The owner asked about the north anemometer calibration last week.", {
      userId: "owner",
      userMessage: "How is the north anemometer calibrated?",
      assistantMessage: "Against the reference mast, every spring.",
    });
    embedCalls.length = 0;
    return adapter;
  }

  it("memoryManager: recall finds nothing of the user's, and every run files the brief as a conversation", async () => {
    const base = await delegateWith();
    const embedCalls: string[] = [];
    const adapter = await rootMemory(embedCalls);
    const calls: string[] = [];
    const stored: Array<{ chatId: string; userId?: string; chars: number }> = [];
    const memoryManager = counted(adapter, calls);
    const storeConversation = adapter.storeConversation.bind(adapter);
    adapter.storeConversation = (async (chatId, summary, options) => {
      stored.push({ chatId: String(chatId), userId: options?.userId, chars: summary.length });
      return storeConversation(chatId, summary, options);
    }) as typeof adapter.storeConversation;
    const statsBefore = adapter.getStats().totalEntries;
    const run = await delegateWith({ memoryManager });
    const row = delta("memoryManager", base, run, {
      memoryCalls: calls,
      memoryEmbedCalls: embedCalls.length,
      stored,
      entriesAdded: adapter.getStats().totalEntries - statsBefore,
    });
    // The user's conversation is scoped to the user: the delegate ("sub-agent") never sees it.
    expect(run.system).not.toContain("reference mast");
    expect(calls).toContain("retrieve");
    // What it does instead: files the delegate's transcript in the user's memory DB.
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((entry) => entry.chatId.startsWith("delegation-") && entry.userId === undefined)).toBe(true);
    expect(row.entriesAdded).toBeGreaterThan(0);
    expect(row.sameAnswer).toBe(true);
  });

  it("ragPipeline: one search per run, its code context rides on every worker call", async () => {
    const base = await delegateWith();
    const searches: Array<{ query: string; queryEmbedding: boolean }> = [];
    const chunk = (i: number) => `// Station${i}.cs\npublic sealed class Station${i} { public float WindKnots; }\n`.repeat(12);
    const results = Array.from({ length: 6 }, (_, i) => ({
      chunk: { id: `c${i}`, filePath: `Assets/Station${i}.cs`, content: chunk(i), contentHash: `h${i}`, kind: "class", startLine: 1, endLine: 24, language: "csharp" },
      vectorScore: 0.8,
      finalScore: 0.8,
    }));
    const ragPipeline = {
      contextMaxTokens: 4000,
      search: vi.fn(async (query: string, options?: { queryEmbedding?: unknown }) => {
        searches.push({ query: query.slice(0, 40), queryEmbedding: options?.queryEmbedding !== undefined });
        return results;
      }),
      formatContext: (found: typeof results) => found.map((r) => `### ${r.chunk.filePath}\n${r.chunk.content}`).join("\n"),
    };
    const run = await delegateWith({ ragPipeline });
    const row = delta("ragPipeline", base, run, {
      searches: searches.length,
      queryEmbeddedBySearch: searches.filter((s) => !s.queryEmbedding).length,
      ragChars: ragPipeline.formatContext(results).length,
      capTokens: 4000,
    });
    expect(searches).toHaveLength(1);
    expect(run.system).toContain("re-retrieval:rag:start");
    expect(row.systemCharsPerCall).toBeGreaterThan(ragPipeline.formatContext(results).length);
    expect(row.inputTokens).toBeGreaterThan(row.systemTokensPerCall * (run.workerCalls - 1));
  });

  it("embeddingProvider: one embedding of the whole brief per run, read by nothing a delegate has", async () => {
    const base = await delegateWith();
    const embedded: number[] = [];
    const embeddingProvider = {
      name: "counting-embedder",
      dimensions: 8,
      embed: vi.fn(async (texts: string[]) => {
        embedded.push(...texts.map((t) => t.length));
        return { embeddings: texts.map(() => Array.from({ length: 8 }, () => 0.1)), usage: { totalTokens: texts.length } };
      }),
    };
    const run = await delegateWith({ embeddingProvider });
    const row = delta("embeddingProvider", base, run, { embedCalls: embedded.length, embeddedChars: embedded });
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toBeGreaterThan(TASK.length);
    expect(row.systemCharsPerCall).toBe(0);
    expect(row.providerCalls).toBe(0);
  });

  it("reRetrievalConfig: with the delegate's instinct retriever it re-asks it mid-run; alone it changes nothing", async () => {
    rec.toolTurns = 7;
    const retrieverCalls: string[] = [];
    const instinctRetriever = {
      getInsightsForTask: vi.fn(async () => {
        retrieverCalls.push("getInsightsForTask");
        return { insights: ["Calibrate against the reference mast."], matchedInstinctIds: ["inst-1"] };
      }),
      getMatchedInstincts: vi.fn(async () => []),
      recordOutcome: vi.fn(async () => undefined),
    };
    const baseAlone = await delegateWith();
    const alone = await delegateWith({ reRetrievalConfig: RE_RETRIEVAL_DEFAULTS });
    const base = await delegateWith({ instinctRetriever });
    const baseRetrieverCalls = retrieverCalls.length;
    retrieverCalls.length = 0;
    const run = await delegateWith({ instinctRetriever, reRetrievalConfig: RE_RETRIEVAL_DEFAULTS });
    const withRetriever = delta("reRetrievalConfig", base, run, {
      toolTurns: rec.toolTurns,
      retrieverCallsBase: baseRetrieverCalls,
      retrieverCalls: retrieverCalls.length,
      aloneInputTokens: alone.inputTokens - baseAlone.inputTokens,
    });
    expect(retrieverCalls.length).toBeGreaterThan(baseRetrieverCalls);
    expect(withRetriever.providerCalls).toBe(0);
    expect(alone.inputTokens - baseAlone.inputTokens).toBe(0);
  });

  it("rateLimiter: the delegate's tokens land in the global daily counter; nothing in the run is refused", async () => {
    const base = await delegateWith();
    const rateLimiter = new RateLimiter({ tokensPerDay: 1_000_000 });
    const run = await delegateWith({ rateLimiter });
    const tokensToday = rateLimiter.getSnapshot().tokensToday;
    const row = delta("rateLimiter", base, run, { limiterTokensToday: tokensToday, billedTokensRun: run.billedTokens });
    expect(tokensToday).toBe(run.billedTokens);
    expect(row.providerCalls).toBe(0);
    expect(row.inputTokens).toBe(0);
    expect(row.sameAnswer).toBe(true);
  });

  it("goalDecomposer: every delegation spends decomposition calls its budget is not charged for", async () => {
    const base = await delegateWith();
    const goalDecomposer = new GoalDecomposer(provider as never, 3, [0], { streamingEnabled: false });
    const run = await delegateWith({ goalDecomposer });
    const row = delta("goalDecomposer", base, run);
    expect(row.auxiliaryCalls).toBeGreaterThan(0);
    expect(row.billedTokens).toBeGreaterThan(0);
    expect(row.meteredTokens).toBeLessThan(row.billedTokens);
  });

  it("supervisorBrain: a delegated run never asks it", async () => {
    const base = await delegateWith();
    const calls: string[] = [];
    const supervisorBrain = new Proxy({}, {
      get: (_target, prop) => (prop === "then" ? undefined : (...args: unknown[]) => {
        calls.push(String(prop));
        return args.length ? false : undefined;
      }),
    });
    const run = await delegateWith({ supervisorBrain, supervisorComplexityThreshold: "simple" });
    const row = delta("supervisorBrain", base, run, { supervisorCalls: calls });
    expect(calls).toEqual([]);
    expect(row.providerCalls).toBe(0);
    expect(row.inputTokens).toBe(0);
  });

  it("userProfileStore: a delegate's brief in another language creates a 'sub-agent' profile that later delegates read", async () => {
    const turkish = "Kuzey istasyonundaki anemometrenin okumasını kontrol et ve bana sonucu bildir lütfen";
    const base = await delegateWith({}, turkish);
    const adapter = await rootMemory([]);
    const store = adapter.getUserProfileStore()!;
    const calls: string[] = [];
    const run = await delegateWith({ userProfileStore: counted(store, calls) }, turkish);
    const profile = store.getProfile("sub-agent");
    const row = delta("userProfileStore", base, run, { profileCalls: calls, subAgentProfile: profile ? { language: profile.language } : null });
    expect(store.getProfile("owner")).toBeNull();
    expect(profile, "the delegate created a profile for the user id 'sub-agent'").not.toBeNull();
    expect(row.providerCalls).toBe(0);
  });

  it("dmPolicy: alone it is asked and changes nothing; with profiles the root's policy keeps one entry per delegation", async () => {
    const base = await delegateWith();
    const dmPolicy = new DMPolicy(null);
    dmPolicy.setSessionPrefs("owner", "owner-chat", { approveAll: true } as never);
    const prefs = (dmPolicy as unknown as { sessionPrefs: Map<string, unknown> }).sessionPrefs;
    const before = prefs.size;
    const aloneCalls: string[] = [];
    const alone = await delegateWith({ dmPolicy: counted(dmPolicy, aloneCalls) });
    const aloneEntries = prefs.size - before;
    const adapter = await rootMemory([]);
    const calls: string[] = [];
    const withProfiles = { dmPolicy: counted(dmPolicy, calls), userProfileStore: adapter.getUserProfileStore()! };
    await delegateWith(withProfiles);
    await delegateWith(withProfiles);
    const row = delta("dmPolicy", base, alone, {
      policyCallsAlone: aloneCalls,
      entriesAddedAlone: aloneEntries,
      policyCallsWithProfiles: calls,
      entriesAddedByTwoDelegationsWithProfiles: prefs.size - before - aloneEntries,
    });
    expect(aloneEntries).toBe(0);
    expect(row.inputTokens).toBe(0);
    expect([...prefs.keys()].filter((key) => key.startsWith("sub-agent:delegation-"))).toHaveLength(2);
    // The user's own per-chat state is keyed by their id and chat: a delegate never reaches it.
    expect(prefs.get("owner:owner-chat")).toMatchObject({ approveAll: true });
    expect(row.providerCalls).toBe(0);
  });

  it("soulLoader: the persona file rides on every worker call", async () => {
    const base = await delegateWith();
    const soulDir = join(tmpDir, "config-root");
    mkdirSync(soulDir, { recursive: true });
    copyFileSync(fileURLToPath(new URL("../../../../soul.md", import.meta.url)), join(soulDir, "soul.md"));
    const soulLoader = new SoulLoader(soulDir, { soulFile: "soul.md" });
    await soulLoader.initialize();
    cleanups.push(() => soulLoader.shutdown());
    const run = await delegateWith({ soulLoader });
    const soulChars = soulLoader.getContent("cli").length;
    const row = delta("soulLoader", base, run, { soulChars });
    expect(run.system).toContain("## Agent Personality");
    expect(row.systemCharsPerCall).toBeGreaterThanOrEqual(soulChars);
    expect(row.providerCalls).toBe(0);
  });

  it("getIdentityState: the daemon's identity section rides on every worker call", async () => {
    const base = await delegateWith();
    const now = Date.now();
    const getIdentityState = () => ({
      agentUuid: "0f9b2c4e-6a71-4d3e-9b8a-5c1d2e3f4a5b",
      agentName: "Strada Brain",
      firstBootTs: now - 30 * 86_400_000,
      bootCount: 42,
      cumulativeUptimeMs: 200 * 3_600_000,
      lastActivityTs: now - 60_000,
      totalMessages: 1200,
      totalTasks: 310,
      projectContext: "",
      cleanShutdown: true,
    });
    const run = await delegateWith({ getIdentityState });
    const row = delta("getIdentityState", base, run);
    expect(run.system).toContain("## Agent Identity");
    expect(row.systemCharsPerCall).toBeGreaterThan(0);
    expect(row.providerCalls).toBe(0);
  });
});
