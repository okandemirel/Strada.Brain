/**
 * Code context (ragPipeline) in a delegated run: cost and benefit, measured.
 *
 * A delegated orchestrator is built without the root's ragPipeline. With RAG
 * on, the delegate still has the same index on demand: code_search is one of
 * the parent tools it inherits (tool-registry registers it whenever a pipeline
 * exists). Passing ragPipeline would add the retrieved code to the system
 * prompt of EVERY worker call instead. This file runs the same tasks in both
 * arms through the real DelegationManager -> real Orchestrator -> real V2
 * runner, with real read-only tools (file_read, grep_search, glob_search,
 * list_directory, code_search) and a real RAGPipeline over a small invented
 * C# project:
 *
 *   tools  — what a delegate gets today: the tools, code_search included.
 *   rag    — the same, plus ragPipeline handed to the delegated construction
 *            through the shared deps the delegated site spreads (no source
 *            change is needed to measure it).
 *
 * Per run it records the provider calls, the input and output tokens the
 * provider REPORTED, the wall time, the RAG searches, and whether the answer
 * names every fact the task asks for (a fixed check, not a judgement).
 *
 * Every case runs in the gates, with a scripted model and a vocabulary
 * embedder (no Ollama in CI; the hash fallback scores these prompts at the
 * orchestrator's 0.2 floor, so nothing would be injected):
 * they pin that the harness measures what it says (the rag arm's context
 * reaches the worker call, the tools arm's does not, the cap stops a run).
 *
 * RAG_LIVE_MEASURE=1 turns the matrix case into the real measurement: a real model (OpenCode,
 * OPENCODE_API_KEY or the anonymous free tier) with Ollama's nomic-embed-text:
 *   RAG_LIVE_MEASURE=1 RAG_LIVE_MODEL=glm-5.3-flash-free \
 *   RAG_MEASURE_OUT=/tmp/rag-measure.json \
 *   npx vitest run src/agents/multi/delegation/delegation-rag-measure.test.ts
 * RAG_LIVE_TASKS=<id,id> limits the run to those tasks.
 * Hard caps (stated to the owner before the run): 300,000 input tokens per
 * run, 2,000,000 input + 100,000 output tokens over all runs. A run that would
 * pass a cap is stopped and reported as "cap".
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { FileReadTool } from "../../tools/file-read.js";
import { GlobSearchTool, GrepSearchTool, ListDirectoryTool } from "../../tools/search.js";
import { CodeSearchTool } from "../../tools/code-search.js";
import { RAGPipeline } from "../../../rag/rag-pipeline.js";
import { FileVectorStore } from "../../../rag/vector-store.js";
import { OllamaEmbeddingProvider } from "../../../rag/embeddings/ollama-embeddings.js";
import { ProviderHealthRegistry } from "../../providers/provider-health.js";
import type { IEmbeddingProvider, IRAGPipeline } from "../../../rag/rag.interface.js";

vi.mock("../../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

const LIVE = process.env["RAG_LIVE_MEASURE"] === "1";
const LIVE_MODEL = process.env["RAG_LIVE_MODEL"] ?? "glm-5.3-flash-free";
/** RAG_LIVE_TASKS=hive-limit,honey-ratio runs only those (a smoke run, or a resumed one). */
const LIVE_TASKS = (process.env["RAG_LIVE_TASKS"] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const RUN_INPUT_CAP = 300_000;
const TOTAL_INPUT_CAP = 2_000_000;
const TOTAL_OUTPUT_CAP = 100_000;

/** The meter every provider call passes through, live or scripted. */
const meter = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; tools: number; inputTokens: number; outputTokens: number }>,
  /** Calls the provider refused or failed (a 429, a timeout): attempted, never answered. */
  failures: [] as string[],
  runInput: 0,
  totalInput: 0,
  totalOutput: 0,
  capHit: false,
  /** Whether this case talks to the real provider (only the matrix case, and only under RAG_LIVE_MEASURE=1). */
  live: false,
  caps: { run: 0, totalIn: 0, totalOut: 0 },
  /** The scripted model's behaviour, set per test. */
  script: undefined as
    | undefined
    | ((system: string, transcript: string, tools: number, call: number) => {
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }),
}));

class CapReached extends Error {}

/** Wrap a provider so every call is counted and the caps are enforced before the next call. */
function metered<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function" || !["chat", "chatStream", "chatStreamStructured"].includes(String(prop))) {
        return value;
      }
      return async (system: string, messages: unknown[], tools: unknown[], ...rest: unknown[]) => {
        if (
          meter.runInput >= meter.caps.run
          || meter.totalInput >= meter.caps.totalIn
          || meter.totalOutput >= meter.caps.totalOut
        ) {
          meter.capHit = true;
          throw new CapReached("measurement token cap reached");
        }
        let response: { usage?: { inputTokens?: number; outputTokens?: number } };
        try {
          response = await (value as (...a: unknown[]) => Promise<typeof response>)
            .apply(obj, [system, messages, tools, ...rest]);
        } catch (err) {
          meter.failures.push((err instanceof Error ? err.message : String(err)).slice(0, 200));
          throw err;
        }
        const inputTokens = response.usage?.inputTokens ?? 0;
        const outputTokens = response.usage?.outputTokens ?? 0;
        meter.calls.push({ system, tools: Array.isArray(tools) ? tools.length : 0, inputTokens, outputTokens });
        meter.runInput += inputTokens;
        meter.totalInput += inputTokens;
        meter.totalOutput += outputTokens;
        return response;
      };
    },
  });
}

const scripted = vi.hoisted(() => ({
  name: "opencode",
  capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: async (systemPrompt: string, messages: unknown[], tools: unknown[]) => {
    const transcript = JSON.stringify(messages);
    const inputTokens = Math.ceil((systemPrompt.length + transcript.length) / 4);
    const usage = { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20 };
    if (!Array.isArray(tools) || tools.length === 0 || !meter.script) {
      return { text: "OK", toolCalls: [], stopReason: "end_turn", usage };
    }
    const step = meter.script(systemPrompt, transcript, tools.length, meter.calls.length);
    return { ...step, stopReason: step.toolCalls.length > 0 ? "tool_use" : "end_turn", usage };
  },
}));

vi.mock("../../providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/provider-registry.js")>();
  return {
    ...actual,
    // The delegated site's own createProvider call (its config, its key) — live, or the scripted model.
    createProvider: vi.fn((config: Parameters<typeof actual.createProvider>[0]) =>
      metered(meter.live ? actual.createProvider(config) : scripted)),
  };
});

vi.mock("../../providers/provider-manager.js", () => ({
  ProviderManager: vi.fn().mockImplementation(function (this: Record<string, unknown>, provider: unknown) {
    this.getProvider = () => provider;
    this.getProviderByName = () => provider;
    this.getPrimaryProviderByName = () => provider;
    this.getActiveInfo = () => ({ providerName: "opencode", model: "measure", isDefault: true });
    this.listAvailable = () => [{ name: "opencode", label: "OpenCode", defaultModel: "measure" }];
    this.isAvailable = () => true;
    this.shutdown = vi.fn();
  }),
}));

const MODEL_SPEC = `opencode:${LIVE ? LIVE_MODEL : "measure"}`;
const TIERS: Record<ModelTier, string> = { local: MODEL_SPEC, cheap: MODEL_SPEC, standard: MODEL_SPEC, premium: MODEL_SPEC };

const CONFIG: DelegationConfig = {
  enabled: true,
  maxDepth: 2,
  maxConcurrentPerParent: 3,
  tiers: TIERS,
  types: [{ name: "code_review", tier: "cheap", timeoutMs: LIVE ? 600_000 : 60_000, maxIterations: 12 }],
  verbosity: "quiet",
};

// ---------------------------------------------------------------------------
// The invented project: an orchard with bee hives. Three facts are planted,
// each next to a decoy a careless reader would report instead.
// ---------------------------------------------------------------------------

const PLANTED: Record<string, string> = {
  "Assets/Scripts/Hives/HiveRules.cs": `namespace Orchard.Hives
{
    public static class HiveRules
    {
        // How many hives one plot may hold at once.
        public const int MaxHivesPerPlot = 5;
        // How many hives may be founded over a whole season, across all plots.
        public const int MaxHivesPerSeason = 12;
    }
}
`,
  "Assets/Scripts/Hives/PlotPlanner.cs": `using System.Collections.Generic;

namespace Orchard.Hives
{
    public sealed class PlotPlanner
    {
        private readonly Dictionary<int, int> _hivesByPlot = new Dictionary<int, int>();
        private int _foundedThisSeason;

        public bool TryPlaceHive(int plotId)
        {
            _hivesByPlot.TryGetValue(plotId, out var count);
            if (count >= HiveRules.MaxHivesPerPlot) return false;
            _hivesByPlot[plotId] = count + 1;
            return true;
        }

        public bool CanFoundHive()
        {
            return _foundedThisSeason < HiveRules.MaxHivesPerSeason;
        }

        public void FoundHive() { _foundedThisSeason++; }
    }
}
`,
  "Assets/Scripts/Production/HoneyPress.cs": `namespace Orchard.Production
{
    public sealed class HoneyPress
    {
        // Units of nectar that make one jar of honey.
        public const float NectarPerJar = 3.5f;
        // Units of wax left over per jar, sold separately.
        public const float WaxPerJar = 0.25f;

        public int Render(float nectar)
        {
            return (int)(nectar / NectarPerJar);
        }

        public float Wax(int jars) { return jars * WaxPerJar; }
    }
}
`,
  "Assets/Scripts/Weather/FrostWatcher.cs": `namespace Orchard.Weather
{
    public sealed class FrostWatcher
    {
        private readonly BloomState _bloom;
        public FrostWatcher(BloomState bloom) { _bloom = bloom; }

        public void OnFrost()
        {
            _bloom.pollenYieldMultiplier = 0.5f;
        }

        public void OnThaw()
        {
            _bloom.pollenYieldMultiplier = 1f;
        }
    }
}
`,
  "Assets/Scripts/Weather/BloomState.cs": `namespace Orchard.Weather
{
    public sealed class BloomState
    {
        public float pollenYieldMultiplier = 1f;
        public float petalDropRate = 0.1f;
    }
}
`,
};

/** Filler: plausible systems with no planted fact, so the project is not three files. */
function fillerFiles(): Record<string, string> {
  const areas = ["Irrigation", "Market", "Workers", "Seasons", "Storage", "Pests", "Soil", "Ledger"];
  const files: Record<string, string> = {};
  areas.forEach((area, a) => {
    for (let i = 0; i < 3; i++) {
      const name = `${area}System${i}`;
      files[`Assets/Scripts/${area}/${name}.cs`] = `namespace Orchard.${area}
{
    public sealed class ${name}
    {
        public const int Capacity = ${(a + 2) * (i + 3)};
        private float _level;

        public void Tick(float dt)
        {
            _level += dt * ${(a + 1) * 0.5 + i};
            if (_level > Capacity) _level = Capacity;
        }

        public float Level => _level;

        public bool IsSaturated() { return _level >= Capacity; }
    }
}
`;
    }
  });
  return files;
}

interface MeasureTask {
  readonly id: string;
  readonly prompt: string;
  /** What the answer must name, all of it. */
  readonly expect: readonly RegExp[];
  /** For the scripted model: the grep it runs, and the text that proves it found the fact. */
  readonly grep: string;
  readonly evidence: string;
  /** The planted file the scripted model opens when the context already points at it. */
  readonly file: string;
  readonly answer: string;
}

const TASKS: readonly MeasureTask[] = [
  {
    id: "hive-limit",
    prompt: "In this Unity project, what is the maximum number of hives a single plot may hold, and which method enforces that limit? Reply with the number and the method name.",
    expect: [/\b5\b/, /TryPlaceHive/],
    grep: "MaxHivesPerPlot",
    evidence: "MaxHivesPerPlot = 5",
    file: "Assets/Scripts/Hives/HiveRules.cs",
    answer: "A plot holds at most 5 hives; PlotPlanner.TryPlaceHive enforces it.",
  },
  {
    id: "honey-ratio",
    prompt: "In this Unity project, which method turns nectar into jars of honey, and how many units of nectar make one jar? Reply with the method name and the number.",
    expect: [/Render/, /3\.5/],
    grep: "NectarPerJar",
    evidence: "NectarPerJar = 3.5f",
    file: "Assets/Scripts/Production/HoneyPress.cs",
    answer: "HoneyPress.Render divides nectar by NectarPerJar, 3.5 units per jar.",
  },
  {
    id: "frost-pollen",
    prompt: "In this Unity project, when frost hits, which class and method lower the pollen yield, and which field holds the multiplier? Reply with the class, the method and the field.",
    expect: [/FrostWatcher/, /OnFrost/, /pollenYieldMultiplier/],
    grep: "pollenYieldMultiplier",
    evidence: "pollenYieldMultiplier = 0.5f",
    file: "Assets/Scripts/Weather/FrostWatcher.cs",
    answer: "FrostWatcher.OnFrost sets BloomState.pollenYieldMultiplier to 0.5.",
  },
];

/** Gate-mode embedder: one dimension per domain word, so a task's question lands on its file. */
const VOCAB = ["hive", "plot", "nectar", "honey", "jar", "press", "render", "frost", "pollen", "bloom", "yield", "wax", "season"];
const vocabEmbedder: IEmbeddingProvider = {
  name: "vocab",
  dimensions: VOCAB.length + 1,
  embed: async (texts: string[]) => ({
    embeddings: texts.map((text) => {
      const lower = text.toLowerCase();
      return [...VOCAB.map((word) => lower.split(word).length - 1), 0.1];
    }),
    usage: { totalTokens: 0 },
  }),
};

type Arm = "tools" | "rag";

interface RunRow {
  readonly arm: Arm;
  readonly task: string;
  /** cap: stopped at a token cap; provider: a provider call failed and no right answer came back. */
  readonly status: "ok" | "wrong" | "cap" | "provider" | "error";
  readonly correct: boolean;
  readonly providerCalls: number;
  readonly providerFailures: number;
  readonly workerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallMs: number;
  readonly ragSearches: number;
  readonly codeSearchCalls: number;
  /** Characters of retrieved code in the first worker call's system prompt. */
  readonly firstSystemChars: number;
  readonly toolsUsed: readonly string[];
  readonly answer: string;
  readonly error?: string;
}

const rows: RunRow[] = [];

describe("ragPipeline in a delegated run (measured)", () => {
  let tmpDir: string;
  let projectDir: string;
  let db: Database.Database;
  let daemonStorage: DaemonStorage;
  let bus: TypedEventBus<LearningEventMap>;
  let rag: RAGPipeline;
  let ragSearches = 0;

  beforeEach(async () => {
    meter.calls = [];
    meter.runInput = 0;
    meter.totalInput = 0;
    meter.totalOutput = 0;
    meter.capHit = false;
    meter.caps = { run: RUN_INPUT_CAP, totalIn: TOTAL_INPUT_CAP, totalOut: TOTAL_OUTPUT_CAP };
    meter.script = undefined;
    meter.live = false;
    tmpDir = mkdtempSync(join(tmpdir(), "delegation-rag-measure-"));
    projectDir = join(tmpDir, "orchard");
    for (const [rel, body] of Object.entries({ ...PLANTED, ...fillerFiles() })) {
      mkdirSync(join(projectDir, rel, ".."), { recursive: true });
      writeFileSync(join(projectDir, rel), body);
    }
    db = new Database(":memory:");
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    daemonStorage.migrateBudgetSource();
    bus = new TypedEventBus<LearningEventMap>();
    const embedder: IEmbeddingProvider = LIVE ? new OllamaEmbeddingProvider() : vocabEmbedder;
    rag = new RAGPipeline(embedder, new FileVectorStore(join(tmpDir, "vectors"), embedder.dimensions), {
      useHNSW: false,
      // config.rag.contextMaxTokens' default (RAG_CONTEXT_MAX_TOKENS).
      contextMaxTokens: 4000,
    });
    await rag.initialize();
    await rag.indexProject(projectDir);
  }, 120_000);

  afterEach(async () => {
    await rag.shutdown();
    await bus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    const out = process.env["RAG_MEASURE_OUT"];
    if (out) writeFileSync(out, `${JSON.stringify({ live: LIVE, model: LIVE ? LIVE_MODEL : "scripted", rows }, null, 2)}\n`);
  });

  /** Bootstrap's shared deps with every optional hook off. */
  function sharedDeps(): SharedOrchestratorDeps {
    return {
      eventEmitter: bus,
      instinctRetriever: undefined,
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

  /** The pipeline, with its searches counted; behaviour is the pipeline's own. */
  function countedRag(): IRAGPipeline {
    return new Proxy(rag, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (prop === "search" && typeof value === "function") {
          return (...args: unknown[]) => {
            ragSearches++;
            return (value as (...a: unknown[]) => unknown).apply(obj, args);
          };
        }
        return typeof value === "function" ? value.bind(obj) : value;
      },
    }) as IRAGPipeline;
  }

  async function runArm(arm: Arm, task: MeasureTask): Promise<RunRow> {
    meter.calls = [];
    meter.failures = [];
    meter.runInput = 0;
    meter.capHit = false;
    ragSearches = 0;
    // A refused call benches the provider for the next run too; each arm starts on a clean registry.
    ProviderHealthRegistry.resetInstance();
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    const toolsUsed: string[] = [];
    const toolRegistry = new ToolRegistry();
    // RAG on: code_search is a parent tool, so BOTH arms inherit it. It gets the
    // uncounted pipeline: ragSearches counts the context injection only.
    for (const tool of [new FileReadTool(), new GrepSearchTool(), new GlobSearchTool(), new ListDirectoryTool(), new CodeSearchTool(rag)]) {
      const execute = tool.execute.bind(tool);
      tool.execute = ((...args: Parameters<typeof execute>) => {
        toolsUsed.push(tool.name);
        return execute(...args);
      }) as typeof tool.execute;
      toolRegistry.register(tool, { readOnly: true });
    }
    const manager = new DelegationManager({
      config: CONFIG,
      tierRouter: new TierRouter(TIERS),
      delegationLog: new DelegationLog(db),
      eventBus: bus,
      budgetTracker,
      channel: { name: "cli", sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: projectDir,
      readOnly: true,
      stradaDeps: { coreInstalled: false, corePath: null, modulesInstalled: false, modulesPath: null, warnings: [] } as never,
      parentTools: toolRegistry.getAllTools(),
      toolMetadataByName: toolRegistry.getMetadataMap(),
      sharedOrchestratorDeps: {
        ...sharedDeps(),
        ...(arm === "rag" ? { ragPipeline: countedRag() } : {}),
      } as SharedOrchestratorDeps,
      // The anonymous free tier accepts any bearer; a real key is used when one is set.
      apiKeys: { opencode: process.env["OPENCODE_API_KEY"] || "public" },
    });
    const started = Date.now();
    let answer = "";
    let error: string | undefined;
    try {
      const result = await manager.delegate({
        type: "code_review",
        task: task.prompt,
        parentAgentId: "parent-001" as AgentId,
        depth: 0,
        mode: "sync",
      });
      answer = result.content;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const wallMs = Date.now() - started;
    const worker = meter.calls.filter((call) => call.tools > 0);
    const correct = error === undefined && task.expect.every((re) => re.test(answer));
    const marker = "re-retrieval:rag:start";
    const firstSystem = worker[0]?.system ?? "";
    const row: RunRow = {
      arm,
      task: task.id,
      status: meter.capHit
        ? "cap"
        : correct ? "ok" : meter.failures.length > 0 ? "provider" : error !== undefined ? "error" : "wrong",
      correct,
      providerCalls: meter.calls.length,
      providerFailures: meter.failures.length,
      workerCalls: worker.length,
      inputTokens: meter.calls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: meter.calls.reduce((sum, call) => sum + call.outputTokens, 0),
      wallMs,
      ragSearches,
      codeSearchCalls: toolsUsed.filter((name) => name === "code_search").length,
      firstSystemChars: firstSystem.includes(marker) ? firstSystem.length - firstSystem.indexOf(marker) : 0,
      toolsUsed,
      answer: answer.slice(0, 400),
      ...(error !== undefined || meter.failures.length > 0
        ? { error: (error ?? meter.failures[0] ?? "").slice(0, 300) }
        : {}),
    };
    rows.push(row);
    return row;
  }

  /**
   * The scripted model: answers once a tool showed it the fact; opens the file
   * when the code context already shows it (the runner does not accept an
   * answer from a delegate that used no tool); greps for it otherwise.
   */
  function scriptFor(task: MeasureTask) {
    meter.script = (system, transcript) => {
      if (transcript.includes(task.evidence)) return { text: task.answer, toolCalls: [] };
      const call = system.includes(task.evidence)
        ? { name: "file_read", input: { path: task.file } }
        : { name: "grep_search", input: { pattern: task.grep, file_pattern: "**/*.cs" } };
      return { text: "", toolCalls: [{ id: `tc-${meter.calls.length}`, ...call }] };
    };
  }

  it("the tools arm finds the fact with its tools; no code context is in its prompt", async () => {
    const task = TASKS[0]!;
    scriptFor(task);
    const row = await runArm("tools", task);
    expect(row.status).toBe("ok");
    expect(row.ragSearches).toBe(0);
    expect(row.firstSystemChars).toBe(0);
    expect(row.toolsUsed).toContain("grep_search");
    expect(row.workerCalls).toBeGreaterThanOrEqual(2);
  });

  it("the rag arm searches once and the retrieved code rides on the worker call", async () => {
    const task = TASKS[0]!;
    scriptFor(task);
    const row = await runArm("rag", task);
    expect(row.ragSearches).toBe(1);
    expect(row.firstSystemChars).toBeGreaterThan(0);
    expect(row.toolsUsed).toEqual(["file_read"]);
    expect(row.status).toBe("ok");
  });

  it("a run that reaches the token cap is stopped and reported as cap, not as an answer", async () => {
    const task = TASKS[1]!;
    // A model that never stops searching.
    meter.script = () => ({
      text: "",
      toolCalls: [{ id: `tc-${meter.calls.length}`, name: "list_directory", input: { path: "." } }],
    });
    meter.caps = { run: 1, totalIn: TOTAL_INPUT_CAP, totalOut: TOTAL_OUTPUT_CAP };
    const row = await runArm("tools", task);
    expect(row.status).toBe("cap");
    expect(row.correct).toBe(false);
    expect(row.providerCalls).toBe(1);
  });

  it("a refused provider (a 429) is reported as provider, never as a wrong answer", async () => {
    meter.script = () => {
      throw new Error("Free usage limit reached");
    };
    const row = await runArm("tools", TASKS[2]!);
    expect(row.status).toBe("provider");
    expect(row.providerFailures).toBeGreaterThan(0);
    expect(row.providerCalls).toBe(0);
  }, 60_000);

  // The measurement itself. In the gates it runs the matrix against the scripted
  // model and pins that every row is right and only the rag arm carries context.
  // Under RAG_LIVE_MEASURE=1 it is the real model's run: a wrong answer or a
  // refused call is then a measured outcome written to the rows, not a failure.
  it("every task in both arms, within the caps", async () => {
    meter.live = LIVE;
    const matrix: RunRow[] = [];
    run: for (const task of TASKS.filter((t) => !LIVE || LIVE_TASKS.length === 0 || LIVE_TASKS.includes(t.id))) {
      for (const arm of ["tools", "rag"] as const) {
        scriptFor(task);
        const row = await runArm(arm, task);
        matrix.push(row);
        if (LIVE) console.log(JSON.stringify(row));
        // A refused provider (the free tier's 429) ends the measurement: retrying burns
        // quota and a half-measured pair says nothing. The rows say where it stopped.
        if (row.status === "provider" || row.status === "error") break run;
        if (meter.totalInput >= TOTAL_INPUT_CAP || meter.totalOutput >= TOTAL_OUTPUT_CAP) break run;
      }
    }
    expect(matrix.length).toBeGreaterThan(0);
    if (!LIVE) {
      expect(matrix.map((row) => `${row.arm}:${row.task}:${row.status}`)).toEqual(
        TASKS.flatMap((task) => [`tools:${task.id}:ok`, `rag:${task.id}:ok`]),
      );
      expect(matrix.filter((row) => row.arm === "rag").every((row) => row.ragSearches === 1 && row.firstSystemChars > 0)).toBe(true);
      expect(matrix.filter((row) => row.arm === "tools").every((row) => row.ragSearches === 0 && row.firstSystemChars === 0)).toBe(true);
    }
  }, LIVE ? 3_600_000 : 60_000);
});
