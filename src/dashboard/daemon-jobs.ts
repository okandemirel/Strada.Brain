/**
 * Long daemon operations as jobs (COR-13 follow-up).
 *
 * `strada daemon memory:consolidate` and `deploy:check` run work that can take
 * longer than a shell can wait on one HTTP answer: Node's fetch gives up after
 * 300 s without response headers, and the CLI then could only say "it may
 * still be running". Their routes now start a job and answer 202 { jobId } at
 * once; GET /api/daemon/jobs/:id reports it until it is done.
 *
 * In memory, per dashboard run: at most one running job per kind (a second
 * start is told which job is already running), finished jobs are kept for an
 * hour, and the table is bounded.
 */

import { randomUUID } from "node:crypto";

export const DAEMON_JOB_KINDS = ["memory:consolidate", "deploy:check"] as const;
export type DaemonJobKind = (typeof DAEMON_JOB_KINDS)[number];
export type DaemonJobState = "running" | "done" | "failed";

/** What GET /api/daemon/jobs/:id answers. */
export interface DaemonJobView {
  readonly id: string;
  readonly kind: DaemonJobKind;
  readonly state: DaemonJobState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly result?: unknown;
  readonly error?: string;
}

export type DaemonJobStart =
  | { readonly started: true; readonly job: DaemonJobView }
  /** One of this kind is still running: that one, not a second. */
  | { readonly started: false; readonly running: DaemonJobView };

export interface DaemonJobRegistryOptions {
  /** Jobs kept at once; the oldest finished ones make room. */
  readonly maxJobs?: number;
  /** How long a finished job stays readable. */
  readonly retainMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_MAX_JOBS = 50;
export const DEFAULT_JOB_RETAIN_MS = 60 * 60_000;

interface JobRecord {
  id: string;
  kind: DaemonJobKind;
  state: DaemonJobState;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

function view(job: JobRecord): DaemonJobView {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.state === "done" ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

export class DaemonJobRegistry {
  /** Insertion order is start order: the first finished entry is the oldest. */
  private readonly jobs = new Map<string, JobRecord>();
  private readonly maxJobs: number;
  private readonly retainMs: number;
  private readonly now: () => number;

  constructor(options: DaemonJobRegistryOptions = {}) {
    this.maxJobs = Math.max(1, options.maxJobs ?? DEFAULT_MAX_JOBS);
    this.retainMs = options.retainMs ?? DEFAULT_JOB_RETAIN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Start `run` as the `kind` job, unless one is already running. `run` is
   * called before this returns, so the work has begun when the 202 goes out;
   * its outcome (or its error message) is kept on the job. Never rejects.
   */
  start(kind: DaemonJobKind, run: () => Promise<unknown>): DaemonJobStart {
    this.prune();
    for (const job of this.jobs.values()) {
      if (job.kind === kind && job.state === "running") return { started: false, running: view(job) };
    }
    this.makeRoom();

    const job: JobRecord = { id: randomUUID(), kind, state: "running", startedAt: this.now() };
    this.jobs.set(job.id, job);
    let pending: Promise<unknown>;
    try {
      pending = run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (result) => {
        job.state = "done";
        job.result = result;
        job.finishedAt = this.now();
      },
      (error: unknown) => {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = this.now();
      },
    );
    return { started: true, job: view(job) };
  }

  /** The job, or undefined when it never existed here or has expired. */
  get(id: string): DaemonJobView | undefined {
    this.prune();
    const job = this.jobs.get(id);
    return job ? view(job) : undefined;
  }

  /** Forget finished jobs older than the retention window. */
  private prune(): void {
    const cutoff = this.now() - this.retainMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && job.finishedAt <= cutoff) this.jobs.delete(id);
    }
  }

  /**
   * Drop the oldest finished jobs until one more fits. Running jobs are never
   * dropped (there is at most one per kind).
   */
  private makeRoom(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < this.maxJobs) return;
      if (job.state !== "running") this.jobs.delete(id);
    }
  }
}
