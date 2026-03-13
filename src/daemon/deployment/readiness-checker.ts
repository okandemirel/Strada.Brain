/**
 * ReadinessChecker
 *
 * Asynchronously checks deployment readiness by running the test command
 * and verifying git state. Results are cached to avoid re-running tests
 * within the same heartbeat cycle.
 *
 * SECURITY: Uses spawn() (not exec) for all child processes.
 * Script path validation prevents directory traversal.
 *
 * Requirements: DEPLOY-01 (readiness detection)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { DeploymentConfig, ReadinessResult } from "./deployment-types.js";
import { validateScriptPath as validatePath } from "./validate-script-path.js";

export interface ReadinessCheckerLogger {
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export class ReadinessChecker {
  private readonly config: DeploymentConfig;
  private readonly projectRoot: string;
  private readonly logger: ReadinessCheckerLogger;
  private cachedResult: ReadinessResult | null = null;

  constructor(
    config: DeploymentConfig,
    projectRoot: string,
    logger: ReadinessCheckerLogger,
  ) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
    this.logger = logger;
  }

  /**
   * Check deployment readiness. Returns cached result unless forceRefresh is true.
   *
   * Checks:
   * 1. Test command exits 0
   * 2. Git working directory is clean (if requireCleanGit)
   * 3. Current branch matches targetBranch
   */
  async checkReadiness(forceRefresh = false): Promise<ReadinessResult> {
    if (this.cachedResult && !forceRefresh) {
      return { ...this.cachedResult, cached: true };
    }

    const timestamp = Date.now();

    // Run test command
    const testPassed = await this.runTestCommand();

    // Check git state
    let gitClean = true;
    let branchMatch = true;

    if (this.config.requireCleanGit) {
      gitClean = await this.checkGitClean();
    }

    branchMatch = await this.checkBranch();

    // Build result
    const ready = testPassed && gitClean && branchMatch;
    const reasons: string[] = [];
    if (!testPassed) reasons.push("test command failed");
    if (!gitClean) reasons.push("git working directory has uncommitted changes");
    if (!branchMatch) reasons.push(`current branch does not match target branch "${this.config.targetBranch}"`);

    const result: ReadinessResult = {
      ready,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      testPassed,
      gitClean,
      branchMatch,
      timestamp,
      cached: false,
    };

    this.cachedResult = result;
    this.logger.debug("Readiness check complete", { ready, testPassed, gitClean, branchMatch });
    return result;
  }

  /** Clear cached readiness result */
  invalidateCache(): void {
    this.cachedResult = null;
  }

  /**
   * Validate a script path against the project root.
   * Prevents directory traversal by ensuring the resolved path starts with projectRoot.
   * Checks file exists and is executable.
   */
  validateScriptPath(scriptPath: string): string {
    return validatePath(scriptPath, this.projectRoot);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private runTestCommand(): Promise<boolean> {
    return new Promise((resolve) => {
      const { testCommand } = this.config;
      this.logger.debug(`Running test command: ${testCommand}`);

      // Use shell mode for commands like "npm test" that need shell resolution.
      // The command is from admin config (not user input), so shell injection
      // risk is controlled.
      const child = spawn(testCommand, {
        shell: true,
        cwd: this.projectRoot,
        timeout: this.config.testTimeoutMs,
        killSignal: "SIGTERM",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString().slice(0, 2048);
      });

      child.on("error", (err) => {
        this.logger.warn(`Test command error: ${err.message}`);
        resolve(false);
      });

      child.on("close", (code, signal) => {
        if (signal) {
          this.logger.warn(`Test command killed by signal: ${signal}`);
          resolve(false);
          return;
        }
        if (code !== 0) {
          this.logger.warn(`Test command failed with exit code ${code}: ${stderr.slice(0, 200)}`);
        }
        resolve(code === 0);
      });
    });
  }

  private checkGitClean(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("git", ["status", "--porcelain"], {
        cwd: this.projectRoot,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Cap output to prevent unbounded memory growth on large dirty repos
      const MAX_GIT_OUTPUT = 64 * 1024; // 64KB is plenty for dirty-check
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_GIT_OUTPUT) {
          stdout += chunk.toString().slice(0, MAX_GIT_OUTPUT - stdout.length);
        }
      });

      child.on("error", (err) => {
        this.logger.warn(`Git status error: ${err.message}`);
        resolve(false);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().length === 0);
      });
    });
  }

  private checkBranch(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.projectRoot,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 1024) {
          stdout += chunk.toString().slice(0, 1024 - stdout.length);
        }
      });

      child.on("error", (err) => {
        this.logger.warn(`Git branch check error: ${err.message}`);
        resolve(false);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        const currentBranch = stdout.trim();
        resolve(currentBranch === this.config.targetBranch);
      });
    });
  }
}
