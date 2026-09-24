import { Worker } from "node:worker_threads";

/**
 * Line-by-line regex matching on a worker thread, under a hard time limit.
 *
 * grep_search runs a regex the MODEL wrote. A pattern with nested or
 * overlapping quantifiers backtracks exponentially, and V8 cannot be
 * interrupted from JavaScript while a match runs: on the main thread one such
 * pattern against one long uniform line (GUIDs and serialized hex are all
 * over Unity assets) froze the whole process — every channel, session and the
 * dashboard — for minutes to hours. On a worker the main loop stays free, and
 * a match that overruns its budget is ended by terminating the worker.
 *
 * The worker is plain JavaScript evaluated from a string, so it runs the same
 * from src (tsx, vitest) and from the built dist without a separate file to
 * resolve or copy.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.source, workerData.flags);
parentPort.on("message", (msg) => {
  const lines = msg.text.split("\\n");
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < msg.limit; i++) {
    if (regex.test(lines[i])) {
      hits.push([i, lines[i]]);
      regex.lastIndex = 0;
    }
  }
  parentPort.postMessage({ id: msg.id, hits, lineCount: lines.length });
});
`;

/** A match that did not finish within its budget; the worker was terminated. */
export class RegexTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`regex matching did not finish within ${timeoutMs}ms`);
    this.name = "RegexTimeoutError";
  }
}

export interface LineMatchResult {
  /** [zero-based line index, line text] for each matching line, in order. */
  readonly hits: ReadonlyArray<readonly [number, string]>;
  /** Number of lines the text split into. */
  readonly lineCount: number;
}

interface WorkerReply extends LineMatchResult {
  readonly id: number;
}

export class WorkerLineMatcher {
  private worker: Worker | undefined;
  private ready: Promise<Worker> | undefined;
  private nextId = 0;

  /**
   * @param source    regex source (already validated by the caller)
   * @param flags     regex flags
   * @param timeoutMs budget for ONE match() call, counted from when the
   *                  worker is running (thread start-up is not charged)
   */
  constructor(
    private readonly source: string,
    private readonly flags: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Test each line of `text` (split on "\n") from its start, stopping after
   * `limit` hits. Rejects with RegexTimeoutError when the budget runs out.
   */
  async match(text: string, limit: number): Promise<LineMatchResult> {
    const worker = await this.start();
    const id = ++this.nextId;
    return new Promise<LineMatchResult>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onFailure);
        worker.off("exit", onFailure);
      };
      const onMessage = (reply: WorkerReply): void => {
        if (reply.id !== id) return;
        settle();
        resolve({ hits: reply.hits, lineCount: reply.lineCount });
      };
      const onFailure = (cause: unknown): void => {
        settle();
        this.forget(worker);
        reject(cause instanceof Error ? cause : new Error(`regex worker exited (code ${String(cause)})`));
      };
      const timer = setTimeout(() => {
        settle();
        void this.close();
        reject(new RegexTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      worker.on("message", onMessage);
      worker.once("error", onFailure);
      worker.once("exit", onFailure);
      worker.postMessage({ id, text, limit });
    });
  }

  /** Stop the worker, if one is running. Safe to call more than once. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }

  private forget(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = undefined;
      this.ready = undefined;
    }
  }

  private start(): Promise<Worker> {
    if (this.ready) return this.ready;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: this.source, flags: this.flags },
      // Plain JS: none of the parent's loader flags (tsx, vitest) are needed.
      execArgv: [],
    });
    this.worker = worker;
    this.ready = new Promise<Worker>((resolve, reject) => {
      const settle = (): void => {
        worker.off("online", onOnline);
        worker.off("error", onFailure);
        worker.off("exit", onFailure);
      };
      const onOnline = (): void => {
        settle();
        resolve(worker);
      };
      const onFailure = (cause: unknown): void => {
        settle();
        this.forget(worker);
        reject(cause instanceof Error ? cause : new Error(`regex worker exited (code ${String(cause)})`));
      };
      worker.once("online", onOnline);
      worker.once("error", onFailure);
      worker.once("exit", onFailure);
    });
    return this.ready;
  }
}
