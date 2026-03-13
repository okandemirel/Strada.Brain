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

import { spawn, type ChildProcess } from "node:child_process";
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

/** Maximum captured output size per stream (10KB) */
const MAX_OUTPUT_BYTES = 10 * 1024;

export interface DeploymentExecutorLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
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

  constructor(
    config: DeploymentConfig,
    projectRoot: string,
    logger: DeploymentExecutorLogger,
    db: DeploymentDatabase,
  ) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
    this.logger = logger;
    this.db = db;
    this.initSchema();
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
      return {
        success: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "Deployment already in progress",
        durationMs: 0,
      };
    }

    const scriptPath = this.config.scriptPath;
    if (!scriptPath) {
      return {
        success: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "No deployment script configured (DEPLOY_SCRIPT_PATH)",
        durationMs: 0,
      };
    }

    // Validate and resolve script path
    const resolvedScript = this.validateScript(scriptPath);

    this.deploymentInProgress = true;
    this.activeProposalId = proposal.id;

    // Update log to executing
    this.updateLogStatus(proposal.id, "executing");

    const startTime = Date.now();

    try {
      const result = await this.runScript(resolvedScript, proposal);
      const durationMs = Date.now() - startTime;
      const deployResult: DeployResult = { ...result, durationMs };

      if (deployResult.success) {
        // Run post-verify if configured
        if (this.config.postScriptPath) {
          const postResult = await this.runPostVerify(proposal);
          if (!postResult.success) {
            this.updateLogEntry(proposal.id, "post_verify_failed", postResult.stderr, durationMs);
            this.logger.error("Post-verify script failed", { proposalId: proposal.id });
            return { ...deployResult, success: false };
          }
        }
        this.updateLogEntry(proposal.id, "completed", deployResult.stdout, durationMs);
        this.logger.info("Deployment completed successfully", { proposalId: proposal.id, durationMs });
      } else {
        this.updateLogEntry(proposal.id, "failed", deployResult.stderr, durationMs, deployResult.stderr);
        this.logger.error("Deployment failed", {
          proposalId: proposal.id,
          exitCode: deployResult.exitCode,
          signal: deployResult.signal,
        });
      }

      return deployResult;
    } finally {
      this.deploymentInProgress = false;
      this.activeProcess = null;
      this.activeProposalId = null;
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

  /** Get aggregate deployment statistics */
  getStats(circuitBreakerState: CircuitState = "CLOSED"): DeploymentStats {
    const total = this.db.prepare("SELECT COUNT(*) as cnt FROM deployment_log").get() as { cnt: number } | undefined;
    const successful = this.db.prepare("SELECT COUNT(*) as cnt FROM deployment_log WHERE status = ?").get("completed") as { cnt: number } | undefined;
    const failed = this.db.prepare("SELECT COUNT(*) as cnt FROM deployment_log WHERE status IN (?, ?, ?)").get("failed", "post_verify_failed", "cancelled") as { cnt: number } | undefined;
    const lastRow = this.db.prepare("SELECT * FROM deployment_log ORDER BY proposed_at DESC LIMIT 1").get();

    return {
      totalDeployments: total?.cnt ?? 0,
      successful: successful?.cnt ?? 0,
      failed: failed?.cnt ?? 0,
      lastDeployment: lastRow ? this.rowToEntry(lastRow as Record<string, unknown>) : undefined,
      circuitBreakerState,
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

  private validateScript(scriptPath: string): string {
    return validateScriptPath(scriptPath, this.projectRoot);
  }

  /**
   * Run a script via spawn() with timeout and output capture.
   * SECURITY: Uses spawn with array args (no shell) to prevent injection.
   */
  private runScript(
    resolvedScript: string,
    proposal: { id: string; approvedBy?: string },
  ): Promise<Omit<DeployResult, "durationMs">> {
    return new Promise((resolve) => {
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

      const child = spawn(resolvedScript, [], {
        env: safeEnv,
        cwd: this.projectRoot,
        timeout: this.config.executionTimeoutMs,
        killSignal: "SIGTERM",
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeProcess = child;

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
        }
      });

      child.on("error", (err) => {
        resolve({
          success: false,
          exitCode: null,
          signal: null,
          stdout,
          stderr: err.message,
        });
      });

      child.on("close", (code, signal) => {
        resolve({
          success: code === 0 && signal === null,
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      });
    });
  }

  private async runPostVerify(
    proposal: { id: string; approvedBy?: string },
  ): Promise<{ success: boolean; stderr: string }> {
    const postPath = this.config.postScriptPath;
    if (!postPath) return { success: true, stderr: "" };

    const resolved = this.validateScript(postPath);
    const result = await this.runScript(resolved, proposal);
    return { success: result.success, stderr: result.stderr };
  }

  private updateLogStatus(id: string, status: DeploymentStatus): void {
    if (status === "approved") {
      this.db
        .prepare("UPDATE deployment_log SET status = ?, approved_at = ? WHERE id = ?")
        .run(status, Date.now(), id);
    } else {
      this.db.prepare("UPDATE deployment_log SET status = ? WHERE id = ?").run(status, id);
    }
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
