/**
 * Golden run: one small task through the real loop, end to end.
 *
 * Why it exists (docs/memory/entries/2026-11-04-speed-and-regression-safety-first.md):
 * until this test, only a live run could show that a change to the loop —
 * PAOR, the supervisor, goal decomposition — left the old behaviour intact,
 * and a live run is slow, paid and rare. Fifty-odd test files build their own
 * Orchestrator, and a test that builds its own subject cannot see an argument
 * the production construction site never passes
 * (docs/memory/entries/2026-09-18-tested-but-never-wired.md). So nothing here
 * is built by hand: the REAL bootstrap() runs every stage and wires every
 * object, and only the edges of the process are replaced.
 *
 * Replaced, and nothing else:
 * - The provider factory. provider-registry's createProvider and
 *   buildProviderChain hand out one MockAIProvider walking SCRIPT, so the
 *   preflight, the chain and the ProviderManager all run for real on top of
 *   it. Every call must be the step the script expects next; a call that is
 *   not is recorded with what it actually was, and the run fails on it.
 * - The channel factory. bootstrap-channels' initializeChannel hands out a
 *   MockChannelAdapter: the request enters through the real message handler
 *   bootstrap wires, and the answer leaves through the real progress reporter.
 * - The network. Every in-process socket connect is refused (fetch included),
 *   git children may not reach a remote, and the framework sync's git
 *   fallback — which would clone from GitHub when the project has no Strada
 *   packages — is off. A run that needs the network fails here.
 * - The disk outside the test's own folder. Every database path is given
 *   inside it (relative defaults resolve against the checkout), and no vault
 *   indexes a tree outside it: the self vault is off by configuration, and
 *   framework-vault-targets offers no target. Those vaults index this
 *   repository (into <checkout>/.strada/vault) and any Strada checkout beside
 *   it, in the background, on the CPU the run needs — and no step reads them.
 *   The run fails if it leaves a `.strada*` entry in the working directory.
 *
 * The chain it pins, in order: the message router hands the request to a
 * background task; the supervisor admits it and the goal decomposer splits it
 * into two dependent nodes; the execute-node bridge hands each node to the
 * background executor, which runs a worker loop on the orchestrator (plan,
 * act with file_write, report); the second node's prompt carries the first
 * node's result; each node is verified; the answer reaches the chat, the files
 * reach the project and the task is recorded as completed.
 *
 * When a deliberate change alters the calls the loop makes, the failure names
 * the step it expected and the call it got. Update SCRIPT in the same commit
 * and say in the message what changed in the loop and why.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import winston from "winston";
import type {
  ConversationMessage,
  ToolDefinition,
} from "../../agents/providers/provider-core.interface.js";
import type { MockAIProvider, MockResponse } from "../helpers/mock-provider.js";
import type { MockChannelAdapter } from "../helpers/mock-channel.js";

const edges = vi.hoisted(() => ({
  provider: undefined as MockAIProvider | undefined,
  channel: undefined as MockChannelAdapter | undefined,
}));

vi.mock("../../agents/providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/providers/provider-registry.js")>();
  const scripted = (): MockAIProvider => {
    if (!edges.provider) throw new Error("golden run: a provider was built before the script was loaded");
    return edges.provider;
  };
  return { ...actual, createProvider: scripted, buildProviderChain: scripted };
});

vi.mock("../../core/bootstrap-channels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/bootstrap-channels.js")>();
  const { MockChannelAdapter } = await import("../helpers/mock-channel.js");
  return {
    ...actual,
    initializeChannel: async () => {
      edges.channel = new MockChannelAdapter({ channelType: "cli", name: "golden-run" });
      return edges.channel;
    },
  };
});

vi.mock("../../vault/framework-vault-targets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../vault/framework-vault-targets.js")>();
  return { ...actual, frameworkVaultTargets: () => [] };
});

import { bootstrap } from "../../core/bootstrap.js";
import { loadConfig, type Config } from "../../config/config.js";
import { MockAIProvider as ScriptedProvider } from "../helpers/mock-provider.js";
import { TaskStorage } from "../../tasks/task-storage.js";
import { TERMINAL_STATUSES, TaskStatus, type Task } from "../../tasks/types.js";
import { createLogger, getLogRingBuffer } from "../../utils/logger.js";

// ─── The task ────────────────────────────────────────────────────────────────

const CHAT_ID = "cli-local";
/** 120+ characters: the classifier rates it complex, so the supervisor admits it. */
const REQUEST =
  "Create two plain text files in the project: notes/alpha.txt containing the word ALPHA, " +
  "and notes/beta.txt containing the word BETA. Nothing else.";
const NODE_ALPHA = "Create notes/alpha.txt containing the word ALPHA";
const NODE_BETA = "Create notes/beta.txt containing the word BETA";
const ALPHA_DONE = "Wrote notes/alpha.txt.";
const BETA_DONE = "Wrote notes/beta.txt.";
/** What the user is told: the supervisor joins the nodes' reports. */
const ANSWER = `${ALPHA_DONE}\n\n${BETA_DONE}`;

// ─── The script ──────────────────────────────────────────────────────────────

interface ProviderCall {
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ToolDefinition[];
}

interface Step {
  /** What the loop is doing when it makes this call. */
  readonly step: string;
  /** Undefined when the call is this step; otherwise what is wrong with it. */
  readonly check: (call: ProviderCall) => string | undefined;
  readonly reply: Partial<MockResponse>;
}

function textOf(message: ConversationMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? block.content : ""))
    .join("\n");
}

function toolResultIds(message: ConversationMessage | undefined): string[] {
  if (!message || typeof message.content === "string") return [];
  return message.content.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : []));
}

const offers = (call: ProviderCall, tool: string): boolean => call.tools.some((t) => t.name === tool);

function describeCall(call: ProviderCall): string {
  const first = textOf(call.messages[0]).slice(0, 160).replace(/\s+/g, " ");
  const last = call.messages.at(-1);
  const lastResults = toolResultIds(last);
  return (
    `first message "${first}…"; ${call.messages.length} message(s), last from ${last?.role ?? "nobody"}` +
    `${lastResults.length > 0 ? ` carrying tool results [${lastResults.join(", ")}]` : ""}; ` +
    `${call.tools.length} tool(s) offered${offers(call, "file_write") ? " including file_write" : ""}`
  );
}

const requires = (problems: Array<string | false>): string | undefined =>
  problems.filter((p): p is string => typeof p === "string").join("; ") || undefined;

const say = (text: string): Partial<MockResponse> => ({ text, toolCalls: [], stopReason: "end_turn" });

/** One supervisor node run by a worker: a plan turn, an action turn, a report turn. */
function workerSteps(node: "alpha" | "beta", task: string, done: string, carries?: string): Step[] {
  const isThisNode = (call: ProviderCall): string | false => {
    const prompt = textOf(call.messages[0]);
    if (!prompt.startsWith(task)) return `the worker's task is not "${task}"`;
    if (carries && !(prompt.includes("## Completed dependencies") && prompt.includes(carries))) {
      return `the prompt does not carry the dependency's result "${carries}"`;
    }
    return false;
  };
  const callId = `call_${node}`;
  return [
    {
      step: `${node}: plan`,
      check: (call) =>
        requires([isThisNode(call), offers(call, "file_write") && "a planning turn offers file_write"]),
      reply: say(`Plan: write notes/${node}.txt with file_write, then report.`),
    },
    {
      step: `${node}: act`,
      check: (call) =>
        requires([
          isThisNode(call),
          !offers(call, "file_write") && "file_write is not offered",
          toolResultIds(call.messages.at(-1)).length > 0 && "a tool already ran",
        ]),
      reply: {
        text: "",
        toolCalls: [
          { id: callId, name: "file_write", input: { path: `notes/${node}.txt`, content: `${node.toUpperCase()}\n` } },
        ],
        stopReason: "tool_use",
      },
    },
    {
      step: `${node}: report`,
      check: (call) =>
        requires([
          isThisNode(call),
          !toolResultIds(call.messages.at(-1)).includes(callId) && `the last message carries no result for ${callId}`,
        ]),
      reply: say(done),
    },
  ];
}

function verifyStep(node: "alpha" | "beta", done: string): Step {
  return {
    step: `${node}: verify`,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Review this supervisor worker result") && "this is not the node verifier",
        !prompt.includes(`Worker output:\n${done}`) && `the verifier is not shown "${done}"`,
      ]);
    },
    reply: say('{"verdict":"approve"}'),
  };
}

const SCRIPT: readonly Step[] = [
  {
    step: "decompose the request",
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Decompose this task into sub-goals") && "this is not the goal decomposer",
        !prompt.includes(REQUEST) && "the decomposer is not given the request",
      ]);
    },
    reply: say(
      JSON.stringify({
        nodes: [
          { id: "s1", task: NODE_ALPHA, dependsOn: [], needsFurtherDecomposition: false },
          { id: "s2", task: NODE_BETA, dependsOn: ["s1"], needsFurtherDecomposition: false },
        ],
      }),
    ),
  },
  ...workerSteps("alpha", NODE_ALPHA, ALPHA_DONE),
  ...workerSteps("beta", NODE_BETA, BETA_DONE, ALPHA_DONE),
  verifyStep("alpha", ALPHA_DONE),
  verifyStep("beta", BETA_DONE),
];

/** The steps served so far, and every call that was not the step the script expected. */
const served: string[] = [];
const violations: string[] = [];

function loadScript(): MockAIProvider {
  const provider = new ScriptedProvider({ name: "deepseek", streaming: false });
  provider.registerResponseHandler("golden-script", ({ messages, tools }) => {
    const call: ProviderCall = { messages, tools };
    const index = served.length + violations.length;
    const step = SCRIPT[served.length];
    const problem = step ? step.check(call) : "the script has ended";
    if (step && !problem) {
      served.push(step.step);
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        ...step.reply,
      };
    }
    violations.push(
      `call ${index} should be step ${served.length} "${step?.step ?? "(none)"}", but ${problem}. ` +
        `The call: ${describeCall(call)}`,
    );
    throw new Error(`golden run: unscripted provider call (${violations.at(-1)})`);
  });
  return provider;
}

// ─── The edges of the process ────────────────────────────────────────────────

/** Every connection the process tried to open. Each one is refused. */
const connectAttempts: string[] = [];

function refuseNetwork(): void {
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const [first, second] = args;
    const target = typeof first === "object" && first !== null
      ? (first as { path?: string; host?: string; port?: number })
      : { host: typeof second === "string" ? second : "localhost", port: Number(first) };
    connectAttempts.push(target.path ?? `${target.host ?? "localhost"}:${target.port ?? "?"}`);
    const refused = Object.assign(new Error("connect ECONNREFUSED (golden run: no network)"), { code: "ECONNREFUSED" });
    // Delivered in the I/O phase, as a real refusal is: a client that retries
    // from its error handler cannot then starve the event loop.
    setImmediate(() => this.destroy(refused));
    return this;
  });
  // A git child process is outside this process's sockets: no remote for it.
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
}

/**
 * Every path under the working directory's `.strada*` entries. A relative
 * default (`.strada-memory/…`, a vault's `<root>/.strada/vault`) lands in the
 * working directory, and a test runs in the checkout: the run must leave
 * nothing there. vitest.worker-setup.ts points process.env's databases away
 * from it, but loadConfig below is handed an environment built by hand.
 */
function stradaEntriesIn(dir: string): Set<string> {
  const entries = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(".strada")) continue;
    entries.add(name);
    const top = join(dir, name);
    if (!statSync(top).isDirectory()) continue;
    for (const nested of readdirSync(top, { recursive: true })) entries.add(join(name, String(nested)));
  }
  return entries;
}

const workingDir = process.cwd();
const root = mkdtempSync(join(tmpdir(), "golden-run-"));
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// ─── Where a stalled run stopped ─────────────────────────────────────────────

/**
 * Boot and run share one budget, and shutdown has its own, all inside the
 * test's two minutes. Shared, because under load either may take most of it
 * (bootstrap's lazy imports are compiled on first use). A budget that runs out
 * says which phase it ran out in, what each earlier phase took, and the last
 * lines the run logged: they name the stage it stopped in.
 */
const BUDGET_MS = { bootAndRun: 108_000, shutdown: 10_000 } as const;
const TEST_TIMEOUT_MS = 120_000;
const clock = { start: 0, phases: [] as string[] };

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const bootAndRunLeft = (): number => Math.max(0, clock.start + BUDGET_MS.bootAndRun - Date.now());

/**
 * Made before bootstrap, whose createLogger then returns it: at info and
 * without the console, so its lines go only to the ring buffer (and a file in
 * the test's folder).
 */
function quietInfoLogger(): void {
  const logger = createLogger("info", join(root, "golden-run.log"));
  for (const transport of logger.transports.filter((t) => t instanceof winston.transports.Console)) {
    logger.remove(transport);
  }
}

function progress(): string {
  const lastLines = getLogRingBuffer()
    .slice(-6)
    .map((entry) => `[${entry.level}] ${entry.message}`);
  const phases = clock.phases.length > 0 ? clock.phases.join(", ") : "no phase finished";
  const load = loadavg()[0]?.toFixed(0) ?? "?";
  return (
    `${seconds(Date.now() - clock.start)} in (${phases}; load ${load}). ` +
    `Steps served: [${served.join(", ")}]; connections refused: [${connectAttempts.join(", ")}]; ` +
    `last log lines: ${lastLines.join(" | ") || "(none)"}`
  );
}

/** Waits for `work` at most `limitMs`, and records how long the phase took. */
async function within<T>(phase: string, limitMs: number, work: Promise<T>): Promise<T> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`golden run: the budget ran out during ${phase}. ${progress()}`)), limitMs);
  });
  try {
    const result = await Promise.race([work, limit]);
    clock.phases.push(`${phase} ${seconds(Date.now() - started)}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function makeConfig(project: string, memoryDir: string): Config {
  const loaded = loadConfig({
    UNITY_PROJECT_PATH: project,
    PROVIDER_CHAIN: "deepseek",
    DEEPSEEK_API_KEY: "golden-run-not-a-key",
    MEMORY_DB_PATH: memoryDir,
    // Relative by default: it, and the dynamic profiles opened beside it,
    // would land in the checkout (vitest.worker-setup.ts sets it in
    // process.env, which this environment is not).
    MODEL_INTELLIGENCE_DB_PATH: join(memoryDir, "model-intelligence.db"),
    // What a child process logs at. This process's logger is made by the test.
    LOG_LEVEL: "error",
    // Embeddings: semantic memory and RAG call an embedding API.
    MEMORY_ENABLED: "false",
    RAG_ENABLED: "false",
    // Unity project discovery, and the self vault, which indexes this
    // repository into the checkout. Minutes of work no step reads.
    STRADA_VAULT_ENABLED: "false",
    STRADA_VAULT_SELF_ENABLED: "false",
    // Listeners and the update check are not the loop.
    DASHBOARD_ENABLED: "false",
    AUTO_UPDATE_ENABLED: "false",
  });
  return {
    ...loaded,
    strada: {
      ...loaded.strada,
      // Not settable from the environment. The sync itself still runs.
      frameworkSync: { ...loaded.strada.frameworkSync, gitFallbackEnabled: false },
    },
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

describe("golden run: a two-node task through the real bootstrap", () => {
  it("decomposes, hands each node to the executor, runs the worker loop and delivers", async () => {
    const project = join(root, "project");
    const memoryDir = join(root, "memory");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "README.md"), "# A tiny project with no Unity in it\n");
    const entriesBefore = stradaEntriesIn(workingDir);
    refuseNetwork();
    quietInfoLogger();
    edges.provider = loadScript();

    clock.start = Date.now();
    const booting = bootstrap({ channelType: "cli", config: makeConfig(project, memoryDir), daemonMode: false });
    const app = await within("bootstrap", bootAndRunLeft(), booting).catch((error: unknown) => {
      // A boot that finishes after its limit is still shut down.
      void booting.then((late) => late.shutdown()).catch(() => undefined);
      throw error;
    });
    const channel = edges.channel;
    const answers = (): string[] =>
      [...(channel?.sentMessages ?? []), ...(channel?.sentMarkdowns ?? [])]
        .filter((m) => m.chatId === CHAT_ID)
        .map((m) => m.text);
    let task: Task | undefined;
    try {
      expect(channel, "bootstrap did not build its channel through initializeChannel").toBeDefined();
      const tasks = new TaskStorage(join(memoryDir, "tasks.db"));
      tasks.initialize();
      try {
        // Awaits the real message handler, so it shares the budget too.
        await within("the hand-off", bootAndRunLeft(), channel!.simulateIncomingMessage(CHAT_ID, REQUEST));
        // Until the task is settled and, if it completed, its answer is out.
        // An unscripted call ends the wait at once: the run has left the script.
        await vi.waitFor(
          () => {
            if (violations.length > 0) return;
            task = tasks.listByChatId(CHAT_ID)[0];
            const settled = task !== undefined && TERMINAL_STATUSES.has(task.status);
            if (!settled || (task?.status === TaskStatus.completed && !answers().includes(ANSWER))) {
              throw new Error(`golden run: the task is ${task?.status ?? "not created"}. ${progress()}`);
            }
          },
          { timeout: bootAndRunLeft(), interval: 50 },
        );
      } finally {
        tasks.close();
      }
    } finally {
      await within("shutdown", BUDGET_MS.shutdown, app.shutdown());
    }

    // Nothing landed in the checkout the test runs from.
    expect(
      [...stradaEntriesIn(workingDir)].filter((entry) => !entriesBefore.has(entry)),
      `the run wrote into the working directory ${workingDir}: a path resolved against it`,
    ).toEqual([]);

    // Every provider call was the step the script expected, and every step ran.
    expect(violations).toEqual([]);
    expect(served).toEqual(SCRIPT.map((s) => s.step));

    // The tools ran: what file_write reported back to the worker, in order.
    const provider = edges.provider;
    expect(
      provider.getToolResults().map((r) => ({ id: r.toolCallId, name: r.name, isError: r.isError })),
    ).toEqual([
      { id: "call_alpha", name: "file_write", isError: false },
      { id: "call_beta", name: "file_write", isError: false },
    ]);
    expect(provider.getToolResults().map((r) => r.content)).toEqual([
      expect.stringMatching(/^File written: notes\/alpha\.txt\b/),
      expect.stringMatching(/^File written: notes\/beta\.txt\b/),
    ]);

    // The work reached the project.
    expect(readFileSync(join(project, "notes", "alpha.txt"), "utf8")).toBe("ALPHA\n");
    expect(readFileSync(join(project, "notes", "beta.txt"), "utf8")).toBe("BETA\n");
    expect(existsSync(join(project, "README.md"))).toBe(true);

    // The task is recorded as done, and the answer reached the chat.
    expect(task?.status, `task error: ${task?.error ?? "none"}`).toBe(TaskStatus.completed);
    expect(answers()).toContain(ANSWER);
  }, TEST_TIMEOUT_MS);
});
