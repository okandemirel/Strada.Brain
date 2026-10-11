/**
 * DeploymentExecutor
 *
 * Executes deployment scripts via spawn() with timeout, cancellation,
 * and output capture. Stores deployment history in SQLite.
 *
 * SECURITY: Uses spawn() (not exec) to prevent shell injection.
 * Script paths are validated against the project root.
 * Output is capped at 10KB per stream.
 *
 * Requirements: DEPLOY-02 (execution after human approval)
 */

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DeploymentConfig,
  DeployResult,
  DeploymentLogEntry,
  DeploymentStats,
  DeploymentStatus,
} from "./deployment-types.js";
import type { CircuitState } from "../daemon-types.js";
import { validateScriptPath } from "./validate-script-path.js";
import { runBoundedProcess } from "./bounded-process.js";

/** Maximum captured output size per stream (10KB) */
const MAX_OUTPUT_BYTES = 10 * 1024;

export interface DeploymentExecutorLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Every status a deploy that did not go out ends in. A rollback runs only
 * after a failed deploy or a failed post-verify, so its two statuses are
 * failures too: counting them as neither made a rolled-back failure vanish
 * from `Failed:`.
 */
const FAILED_STATUSES: readonly DeploymentStatus[] = [
  "failed",
  "post_verify_failed",
  "cancelled",
  "rollback_completed",
  "rollback_failed",
];

export interface DeploymentExecutorOptions {
  /**
   * The deploy circuit breaker's state. The breaker belongs to DeployTrigger;
   * without this getStats() reported CLOSED while the trigger had disabled
   * itself after repeated failures.
   */
  readonly circuitState?: () => CircuitState;
}

/** Minimal database interface for deployment log */
export interface DeploymentDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export class DeploymentExecutor {
  private readonly config: DeploymentConfig;
  private readonly projectRoot: string;
  private readonly logger: DeploymentExecutorLogger;
  private readonly db: DeploymentDatabase;
  private activeProcess: ChildProcess | null = null;
  private activeProposalId: string | null = null;
  private deploymentInProgress = false;
  private readonly circuitState?: () => CircuitState;

  constructor(
    config: DeploymentConfig,
    projectRoot: string,
    logger: DeploymentExecutorLogger,
    db: DeploymentDatabase,
    options: DeploymentExecutorOptions = {},
  ) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
    this.logger = logger;
    this.db = db;
    this.circuitState = options.circuitState;
    this.initSchema();
    this.endInterruptedDeployments();
  }

  /**
   * Execute the deployment script for an approved proposal.
   * Validates script path, captures output, updates deployment_log.
   */
  async execute(proposal: {
    id: string;
    approvedBy?: string;
    agentId?: string;
  }): Promise<DeployResult> {
    if (this.deploymentInProgress) {
      return this.refuseApproved(proposal, "Deployment already in progress");
    }

    const scriptPath = this.config.scriptPath;
    if (!scriptPath) {
      return this.refuseApproved(proposal, "No deployment script configured (DEPLOY_SCRIPT_PATH)");
    }

    this.deploymentInProgress = true;
    this.activeProposalId = proposal.id;
    const startTime = Date.now();

    try {
      this.markExecuting(proposal);
      // Validated once the row says 'executing', so a script that cannot run
      // ends this approved proposal as 'failed' (below) rather than leaving it
      // 'proposed'.
      const resolvedScript = this.validateScript(scriptPath);
      const result = await this.runScript(resolvedScript, proposal);
      const durationMs = Date.now() - startTime;
      const deployResult: DeployResult = { ...result, durationMs };

      if (deployResult.success) {
        // Run post-verify if configured
        if (this.config.postScriptPath) {
          const postResult = await this.runPostVerify(proposal);
          if (!postResult.success) {
            const failure = { output: postResult.stderr, error: `Post-verify failed: ${postResult.stderr || "the script exited non-zero"}` };
            this.updateLogEntry(proposal.id, "post_verify_failed", failure.output, durationMs, failure.error);
            this.logger.error("Post-verify script failed", { proposalId: proposal.id });
            // The new version is live and failed its health check: this is
            // the case a rollback exists for. It returned before reaching it.
            await this.runRollback(proposal, durationMs, failure);
            return { ...deployResult, success: false };
          }
        }
        this.updateLogEntry(proposal.id, "completed", deployResult.stdout, durationMs);
        this.logger.info("Deployment completed successfully", { proposalId: proposal.id, durationMs });
      } else {
        const failure = {
          output: deployResult.stderr,
          error: deployResult.stderr || `Deployment script ended with ${deployResult.signal ?? `exit code ${deployResult.exitCode}`}`,
        };
        this.updateLogEntry(proposal.id, "failed", failure.output, durationMs, failure.error);
        this.logger.error("Deployment failed", {
          proposalId: proposal.id,
          exitCode: deployResult.exitCode,
          signal: deployResult.signal,
        });

        // Automatic rollback if configured
        await this.runRollback(proposal, durationMs, failure);
      }

      return deployResult;
    } catch (err) {
      // Whatever threw after the approval still ends the row: it stayed
      // 'executing' for good, never pruned and counted as neither a success
      // nor a failure.
      const message = err instanceof Error ? err.message : String(err);
      try {
        this.updateLogEntry(proposal.id, "failed", undefined, Date.now() - startTime, message);
      } catch (logErr) {
        this.logger.error("Could not record the failed deployment", {
          proposalId: proposal.id,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
      throw err;
    } finally {
      this.deploymentInProgress = false;
      this.activeProcess = null;
      this.activeProposalId = null;
    }
  }

  /**
   * An approved proposal this executor will not run still ends, as 'failed'
   * with the reason: left 'proposed' it read as never decided and counted as
   * no failure, while the trigger recorded one on its breaker. The row of the
   * deploy that is running (the same approval delivered twice) is left alone.
   */
  private refuseApproved(proposal: { id: string; approvedBy?: string }, reason: string): DeployResult {
    if (proposal.id !== this.activeProposalId) {
      this.markExecuting(proposal);
      this.updateLogEntry(proposal.id, "failed", undefined, 0, reason);
    }
    return { success: false, exitCode: null, signal: null, stdout: "", stderr: reason, durationMs: 0 };
  }

  /**
   * Run the configured rollback script, if any, and record its outcome. The
   * rollback is the second half of `failure`, not its replacement: the row
   * keeps the deploy's error and output, and the rollback's is added to them.
   * It used to overwrite both, erasing why the deploy failed.
   */
  private async runRollback(
    proposal: { id: string; approvedBy?: string },
    durationMs: number,
    failure: { output: string; error: string },
  ): Promise<void> {
    if (!this.config.rollbackScriptPath) return;
    const withRollback = (rollbackOutput: string): string =>
      rollbackOutput ? `${failure.output}${failure.output ? "\n" : ""}--- rollback ---\n${rollbackOutput}` : failure.output;
    try {
      const rollbackPath = this.validateScript(this.config.rollbackScriptPath);
      this.logger.info("Running rollback script", { proposalId: proposal.id, rollbackPath });
      const rollbackResult = await this.runScript(rollbackPath, proposal);
      if (rollbackResult.success) {
        this.logger.info("Rollback completed", { proposalId: proposal.id });
        this.updateLogEntry(proposal.id, "rollback_completed", withRollback(rollbackResult.stdout), durationMs, failure.error);
      } else {
        this.logger.error("Rollback failed", {
          proposalId: proposal.id,
          stderr: rollbackResult.stderr,
        });
        this.updateLogEntry(
          proposal.id,
          "rollback_failed",
          withRollback(rollbackResult.stderr),
          durationMs,
          `${failure.error}\nRollback failed: ${rollbackResult.stderr || "the script exited non-zero"}`,
        );
      }
    } catch (rollbackErr) {
      const message = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      this.logger.error("Rollback script error", { proposalId: proposal.id, error: message });
      this.updateLogEntry(proposal.id, "rollback_failed", failure.output, durationMs, `${failure.error}\nRollback could not run: ${message}`);
    }
  }

  /** Cancel an in-progress deployment by sending SIGTERM */
  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      if (this.activeProposalId) {
        this.updateLogStatus(this.activeProposalId, "cancelled");
      }
      this.logger.warn("Deployment cancelled");
    }
  }

  /** Check if a deployment is currently in progress */
  isInProgress(): boolean {
    return this.deploymentInProgress;
  }

  /** Create a "proposed" entry in the deployment log and return the ID */
  logProposal(agentId?: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO deployment_log (id, proposed_at, agent_id, status) VALUES (?, ?, ?, ?)",
      )
      .run(id, now, agentId ?? null, "proposed");
    return id;
  }

  /** Get deployment history ordered by most recent */
  getHistory(limit = 20): DeploymentLogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM deployment_log ORDER BY proposed_at DESC LIMIT ?")
      .all(limit);
    return rows.map(this.rowToEntry);
  }

  /**
   * Get aggregate deployment statistics. The circuit breaker state is the
   * deploy breaker's (see DeploymentExecutorOptions) unless one is passed.
   */
  getStats(circuitBreakerState?: CircuitState): DeploymentStats {
    const total = this.db.prepare("SELECT COUNT(*) as cnt FROM deployment_log").get() as { cnt: number } | undefined;
    const successful = this.db.prepare("SELECT COUNT(*) as cnt FROM deployment_log WHERE status = ?").get("completed") as { cnt: number } | undefined;
    const failed = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM deployment_log WHERE status IN (${FAILED_STATUSES.map(() => "?").join(", ")})`)
      .get(...FAILED_STATUSES) as { cnt: number } | undefined;
    const lastRow = this.db.prepare("SELECT * FROM deployment_log ORDER BY proposed_at DESC LIMIT 1").get();

    return {
      totalDeployments: total?.cnt ?? 0,
      successful: successful?.cnt ?? 0,
      failed: failed?.cnt ?? 0,
      lastDeployment: lastRow ? this.rowToEntry(lastRow as Record<string, unknown>) : undefined,
      circuitBreakerState: circuitBreakerState ?? this.circuitState?.() ?? "CLOSED",
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_log (
        id TEXT PRIMARY KEY,
        proposed_at INTEGER NOT NULL,
        approved_at INTEGER,
        approved_by TEXT,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        script_output TEXT,
        duration INTEGER,
        error TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_deployment_log_status ON deployment_log(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_deployment_log_proposed ON deployment_log(proposed_at DESC)");
  }

  /**
   * A row still 'executing' when an executor is built belongs to a runtime
   * that stopped mid-deploy (the runtime builds one executor, and one runtime
   * holds an install): nothing will finish it, and it stayed out of both
   * counts for good.
   */
  private endInterruptedDeployments(): void {
    const ended = this.db
      .prepare("UPDATE deployment_log SET status = ?, error = ? WHERE status = ?")
      .run("failed", "Strada stopped while this deployment ran; whether the script finished is unknown", "executing")
      .changes;
    if (ended > 0) this.logger.warn("Ended deployments a stopped runtime left executing", { count: ended });
  }

  private validateScript(scriptPath: string): string {
    return validateScriptPath(scriptPath, this.projectRoot);
  }

  /**
   * Run a script via spawn() with timeout and output capture.
   * SECURITY: Uses spawn with array args (no shell) to prevent injection.
   */
  private async runScript(
    resolvedScript: string,
    proposal: { id: string; approvedBy?: string },
  ): Promise<Omit<DeployResult, "durationMs">> {
    // SECURITY: Only pass a minimal allowlist of environment variables.
    // Never spread process.env — it contains API keys, tokens, and secrets.
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      SHELL: process.env.SHELL ?? "/bin/sh",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: process.env.TERM ?? "xterm-256color",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      DEPLOY_TRIGGER: "auto",
      DEPLOY_PROPOSAL_ID: proposal.id,
      DEPLOY_APPROVED_BY: proposal.approvedBy ?? "",
    };

    // Bounded: completion follows the script's exit (a background process it
    // leaves holding stdout no longer hangs the deploy forever) and a timeout
    // terminates the whole process tree, not just the script.
    const run = await runBoundedProcess({
      command: resolvedScript,
      cwd: this.projectRoot,
      env: safeEnv,
      timeoutMs: this.config.executionTimeoutMs,
      maxOutputChars: MAX_OUTPUT_BYTES,
      onSpawn: (child) => {
        this.activeProcess = child;
      },
    });
    let stderr = run.stderr;
    if (run.error) stderr = run.error.message;
    else if (run.timedOut) stderr = `${stderr}${stderr ? "\n" : ""}Script timed out after ${this.config.executionTimeoutMs}ms`;
    return {
      success: run.error === undefined && !run.timedOut && run.exitCode === 0 && run.signal === null,
      exitCode: run.exitCode,
      signal: run.signal,
      stdout: run.stdout,
      stderr,
    };
  }

  private async runPostVerify(
    proposal: { id: string; approvedBy?: string },
  ): Promise<{ success: boolean; stderr: string }> {
    const postPath = this.config.postScriptPath;
    if (!postPath) return { success: true, stderr: "" };

    let resolved: string;
    try {
      resolved = this.validateScript(postPath);
    } catch (err) {
      // An unrunnable post-verify script leaves a live release nobody
      // verified: that fails verification, so the rollback runs. Thrown, it
      // skipped both and escaped execute().
      return { success: false, stderr: err instanceof Error ? err.message : String(err) };
    }
    const result = await this.runScript(resolved, proposal);
    return { success: result.success, stderr: result.stderr };
  }

  private updateLogStatus(id: string, status: DeploymentStatus): void {
    this.db.prepare("UPDATE deployment_log SET status = ? WHERE id = ?").run(status, id);
  }

  /**
   * The approved proposal starts running. execute() is called on the approval
   * decision, so this is also when (and by whom) it was approved: nothing else
   * wrote approved_by/approved_at, and deploy:history's "Approved By" was
   * always "-".
   */
  private markExecuting(proposal: { id: string; approvedBy?: string }): void {
    this.db
      .prepare("UPDATE deployment_log SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?")
      .run("executing", Date.now(), proposal.approvedBy ?? null, proposal.id);
  }

  private updateLogEntry(
    id: string,
    status: DeploymentStatus,
    output?: string,
    duration?: number,
    error?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE deployment_log SET status = ?, script_output = ?, duration = ?, error = ? WHERE id = ?",
      )
      .run(status, output?.slice(0, MAX_OUTPUT_BYTES) ?? null, duration ?? null, error ?? null, id);
  }

  private rowToEntry(row: Record<string, unknown>): DeploymentLogEntry {
    return {
      id: row.id as string,
      proposedAt: row.proposed_at as number,
      approvedAt: (row.approved_at as number | null) ?? undefined,
      approvedBy: (row.approved_by as string | null) ?? undefined,
      agentId: (row.agent_id as string | null) ?? undefined,
      status: row.status as DeploymentStatus,
      scriptOutput: (row.script_output as string | null) ?? undefined,
      duration: (row.duration as number | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
    };
  }
}
