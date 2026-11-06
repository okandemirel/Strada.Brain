/**
 * One request through the REAL bootstrap, with only the edges of the process
 * replaced. Shared by every golden run (src/tests/integration/golden-run*.test.ts).
 *
 * Why it exists (docs/memory/entries/2026-11-04-speed-and-regression-safety-first.md):
 * only a live run could show that a change to the loop — PAOR, the
 * supervisor, goal decomposition — left the old behaviour intact, and a live
 * run is slow, paid and rare. Fifty-odd test files build their own
 * Orchestrator, and a test that builds its own subject cannot see an argument
 * the production construction site never passes
 * (docs/memory/entries/2026-09-18-tested-but-never-wired.md). So nothing here
 * is built by hand: bootstrap() runs every stage and wires every object.
 *
 * Replaced, and nothing else:
 * - The provider and channel factories, and the framework vault targets:
 *   see golden-run-edges.ts. The request enters through the real message
 *   handler bootstrap wires; the answer leaves through the real reporter.
 *   A run whose chain has several seats replaces only the seats' provider
 *   classes, so the real fallback chain and health registry run between them.
 * - The network. Every in-process socket connect is refused (fetch included),
 *   git children may not reach a remote, and the framework sync's git
 *   fallback — which would clone from GitHub when the project has no Strada
 *   packages — is off. A run that needs the network fails here.
 * - The disk outside the test's own folder. Every database path is given
 *   inside it (relative defaults resolve against the checkout), and no vault
 *   indexes a tree outside it: the self vault is off by configuration, and
 *   framework-vault-targets offers no target. A run that leaves a `.strada*`
 *   entry in the working directory names it in `strayEntries`.
 *
 * Kept, with its root moved: workspace leases. Under vitest a
 * WorkspaceLeaseManager refuses the default lease root, which a live daemon
 * shares, so each run gives bootstrap a root in its own folder
 * (WORKSPACE_LEASE_ROOT, read in bootstrap-stages/workspace-lease-setup.ts).
 * A worker writes into its lease, and its files reach the project only when
 * the lease is published. Before this, the background executor ran with no
 * lease ("Workspace isolation disabled" in the log): workers wrote the
 * project directly, and no golden run measured how a lease is taken, merged
 * or published. `logged` holds the run's log lines, so a test can say which
 * of the two happened.
 */

import { vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import winston from "winston";
import TransportStream from "winston-transport";
import { loadConfig, type Config } from "../../config/config.js";
import { ProviderHealthRegistry } from "../../agents/providers/provider-health.js";
import { TaskStorage } from "../../tasks/task-storage.js";
import { TERMINAL_STATUSES, TaskStatus, type Task } from "../../tasks/types.js";
import { createLogger, getLogger, getLogRingBuffer } from "../../utils/logger.js";
import { newRuntimeEntries, runtimeEntriesIn } from "./checkout-runtime-entries.js";
import { edges, loadScript, resetEdges, type Delivered, type ProviderCall, type ScriptedRun, type Step } from "./golden-run-edges.js";
import type { CapturedToolResult } from "./mock-provider.js";

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
 * Where the test runs: the checkout. A run must leave no `.strada*` entry here.
 * A relative default (`.strada-memory/…`, a vault's `<root>/.strada/vault`)
 * lands in the working directory. vitest.worker-setup.ts points process.env's
 * databases away from it, but loadConfig below is handed an environment built
 * by hand. The worker setup checks every test file the same way when the file
 * ends; here it is checked right after each run, by name.
 */
export const GOLDEN_WORKING_DIR = process.cwd();
const workingDir = GOLDEN_WORKING_DIR;
let root: string | undefined;

/**
 * The test file's own folder, the refused network and the quiet logger, made
 * once per file on the first run and undone after the file's last test.
 */
function sandbox(): string {
  if (root) return root;
  root = mkdtempSync(join(tmpdir(), "golden-run-"));
  const made = root;
  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(made, { recursive: true, force: true });
  });
  refuseNetwork();
  quietInfoLogger(made);
  return made;
}

/**
 * Made before bootstrap, whose createLogger then returns it: at info and
 * without the console, so its lines go only to the ring buffer (and a file in
 * the test's folder).
 */
function quietInfoLogger(folder: string): void {
  const logger = createLogger("info", join(folder, "golden-run.log"));
  for (const transport of logger.transports.filter((t) => t instanceof winston.transports.Console)) {
    logger.remove(transport);
  }
}

/** A line the run logged. */
export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Every line one run logs, from boot to shutdown, and no other run's. The
 * ring buffer is the process's: it mixes in the earlier runs of the same file
 * and keeps only the last 500 lines.
 */
class RunLog extends TransportStream {
  readonly lines: LoggedLine[] = [];

  override log(info: { level: string; message: unknown }, callback: () => void): void {
    const { level, message, timestamp: _timestamp, service: _service, ...meta } = info as Record<string, unknown>;
    this.lines.push({ level: String(level), message: String(message), meta });
    callback();
  }
}

/** The run's warnings that its lease managers could not be built, so it ran without leases. */
export function isolationDisabled(run: GoldenOutcome): string[] {
  return run.logged.map((line) => line.message).filter((message) => message.startsWith("Workspace isolation disabled"));
}

// ─── Where a stalled run stopped ─────────────────────────────────────────────

/**
 * Boot and run share one budget, and shutdown has its own, all inside the
 * test's two minutes. Shared, because under load either may take most of it
 * (bootstrap's lazy imports are compiled on first use). A budget that runs out
 * says which phase it ran out in, what each earlier phase took, and the last
 * lines the run logged: they name the stage it stopped in.
 */
const BUDGET_MS = { bootAndRun: 108_000, shutdown: 10_000 } as const;
export const GOLDEN_RUN_TIMEOUT_MS = 120_000;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

class RunClock {
  private readonly start = Date.now();
  private readonly phases: string[] = [];

  constructor(private readonly run: ScriptedRun) {}

  bootAndRunLeft(): number {
    return Math.max(0, this.start + BUDGET_MS.bootAndRun - Date.now());
  }

  progress(): string {
    const lastLines = getLogRingBuffer()
      .slice(-6)
      .map((entry) => `[${entry.level}] ${entry.message}`);
    const phases = this.phases.length > 0 ? this.phases.join(", ") : "no phase finished";
    const load = loadavg()[0]?.toFixed(0) ?? "?";
    return (
      `${seconds(Date.now() - this.start)} in (${phases}; load ${load}). ` +
      `Steps served: [${this.run.served.join(", ")}]; connections refused: [${connectAttempts.join(", ")}]; ` +
      `last log lines: ${lastLines.join(" | ") || "(none)"}`
    );
  }

  /** Waits for `work` at most `limitMs`, and records how long the phase took. */
  async within<T>(phase: string, limitMs: number, work: Promise<T>): Promise<T> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`golden run: the budget ran out during ${phase}. ${this.progress()}`)),
        limitMs,
      );
    });
    try {
      const result = await Promise.race([work, limit]);
      this.phases.push(`${phase} ${seconds(Date.now() - started)}`);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function makeConfig(project: string, memoryDir: string, chain: readonly string[]): Config {
  const loaded = loadConfig({
    UNITY_PROJECT_PATH: project,
    PROVIDER_CHAIN: chain.join(","),
    ...Object.fromEntries(chain.map((seat) => [`${seat.toUpperCase()}_API_KEY`, `golden-run-not-a-${seat}-key`])),
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

export const GOLDEN_CHAT_ID = "cli-local";

export interface GoldenRequest {
  /** The run's folder under the file's sandbox: its project and memory live there. */
  readonly name: string;
  readonly request: string;
  readonly script: readonly Step[];
  /** PROVIDER_CHAIN's seats, in order; each needs its scriptedSeat edge. One deepseek seat when unset. */
  readonly chain?: readonly string[];
  /**
   * Whether the run is over, read every 50 ms once the request is handed off:
   * the chat's tasks, oldest first (a retry submits a new one), and the texts
   * the chat received. An unscripted provider call ends the wait at once: the
   * run has left the script.
   */
  readonly settled: (tasks: readonly Task[], delivered: readonly string[]) => boolean;
}

export interface GoldenOutcome {
  /** The chat's newest task as the task store recorded it: the one a retry submitted, if any. */
  readonly task: Task | undefined;
  /** Every task the chat's request produced, oldest first. */
  readonly tasks: readonly Task[];
  /** Every message the chat received, in order. */
  readonly delivered: readonly Delivered[];
  readonly served: readonly string[];
  /** The call each served step answered, in the order of `served`. */
  readonly calls: readonly ProviderCall[];
  readonly violations: readonly string[];
  /** What each tool reported back to the worker, in order. */
  readonly toolResults: readonly CapturedToolResult[];
  readonly project: string;
  /** Where the run's workspace leases were made: a folder beside the project. */
  readonly leaseRoot: string;
  /** Where bootstrap keeps provider health: what the next boot restores. */
  readonly providerHealthFile: string;
  /** Every line the run logged, from boot to shutdown, in order. */
  readonly logged: readonly LoggedLine[];
  /** `.strada*` entries the run left in the working directory. */
  readonly strayEntries: readonly string[];
}

/**
 * The usual end of a run: the newest task is terminal and, when it completed,
 * the result it recorded reached the chat. Whatever that result is: a run
 * that completes with the wrong answer settles at once, and its assertions
 * say what differs.
 */
export function settledWhenAnswered(tasks: readonly Task[], delivered: readonly string[]): boolean {
  const task = tasks.at(-1);
  if (task === undefined || !TERMINAL_STATUSES.has(task.status)) return false;
  return task.status !== TaskStatus.completed || (task.result !== undefined && delivered.includes(task.result));
}

export async function runGolden(request: GoldenRequest): Promise<GoldenOutcome> {
  const folder = join(sandbox(), request.name);
  const project = join(folder, "project");
  const memoryDir = join(folder, "memory");
  const leaseRoot = join(folder, "leases");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# A tiny project with no Unity in it\n");
  // Read when bootstrap builds its lease managers; undone with the file's other stubs.
  vi.stubEnv("WORKSPACE_LEASE_ROOT", leaseRoot);
  const runLog = new RunLog();
  getLogger().add(runLog);
  const entriesBefore = runtimeEntriesIn(workingDir);
  // Provider health is a process singleton: a failure one run recorded must
  // not cool the provider down for the next run in the same file.
  ProviderHealthRegistry.resetInstance();
  const chain = request.chain ?? ["deepseek"];
  const run = loadScript(request.script, chain);
  resetEdges(run);
  const clock = new RunClock(run);
  const toChat = (): Delivered[] => edges.delivered.filter((m) => m.chatId === GOLDEN_CHAT_ID);

  const { bootstrap } = await import("../../core/bootstrap.js");
  const booting = bootstrap({ channelType: "cli", config: makeConfig(project, memoryDir, chain), daemonMode: false });
  const app = await clock.within("bootstrap", clock.bootAndRunLeft(), booting).catch((error: unknown) => {
    // A boot that finishes after its limit is still shut down.
    void booting.then((late) => late.shutdown()).catch(() => undefined);
    getLogger().remove(runLog);
    throw error;
  });
  let tasks: Task[] = [];
  try {
    const channel = edges.channel;
    if (!channel) throw new Error("golden run: bootstrap did not build its channel through initializeChannel");
    const store = new TaskStorage(join(memoryDir, "tasks.db"));
    store.initialize();
    try {
      // Awaits the real message handler, so it shares the budget too.
      await clock.within(
        "the hand-off",
        clock.bootAndRunLeft(),
        channel.simulateIncomingMessage(GOLDEN_CHAT_ID, request.request),
      );
      await vi.waitFor(
        () => {
          if (run.violations.length > 0) return;
          tasks = store.listByChatId(GOLDEN_CHAT_ID).reverse();
          if (!request.settled(tasks, toChat().map((m) => m.text))) {
            const statuses = tasks.map((t) => t.status).join(" → ") || "not created";
            throw new Error(`golden run: the chat's tasks are ${statuses}. ${clock.progress()}`);
          }
        },
        { timeout: clock.bootAndRunLeft(), interval: 50 },
      );
      // As they stand when the wait ended, which a violation ends early.
      tasks = store.listByChatId(GOLDEN_CHAT_ID).reverse();
    } finally {
      store.close();
    }
  } finally {
    try {
      await clock.within("shutdown", BUDGET_MS.shutdown, app.shutdown());
    } finally {
      getLogger().remove(runLog);
    }
  }

  return {
    task: tasks.at(-1),
    tasks,
    delivered: toChat(),
    served: run.served,
    calls: run.calls,
    violations: run.violations,
    toolResults: run.provider.getToolResults(),
    project,
    leaseRoot,
    providerHealthFile: join(memoryDir, "provider-health.json"),
    logged: runLog.lines,
    strayEntries: newRuntimeEntries(workingDir, entriesBefore),
  };
}
