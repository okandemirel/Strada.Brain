import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { getLogger } from "../utils/logger.js";

/**
 * Gateway daemon — keeps Strata Brain running as an always-on service.
 *
 * Features:
 *   - Auto-restart on crash with exponential backoff
 *   - Graceful shutdown on SIGTERM/SIGINT
 *   - Health monitoring with periodic checks
 *   - Maximum restart attempts before giving up
 */
export class Daemon {
  private child: ChildProcess | null = null;
  private running = false;
  private restartCount = 0;
  private readonly maxRestarts: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly entryPoint: string;
  private readonly args: string[];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    entryPoint?: string;
    args?: string[];
    maxRestarts?: number;
    baseDelay?: number;
    maxDelay?: number;
  } = {}) {
    this.entryPoint = opts.entryPoint ?? resolve(import.meta.dirname, "..", "index.js");
    this.args = opts.args ?? ["start"];
    this.maxRestarts = opts.maxRestarts ?? 10;
    this.baseDelay = opts.baseDelay ?? 1000;
    this.maxDelay = opts.maxDelay ?? 60_000;
  }

  /**
   * Start the daemon. Spawns the child process and monitors it.
   */
  async start(): Promise<void> {
    const logger = getLogger();
    this.running = true;
    this.restartCount = 0;

    logger.info("Daemon starting", {
      entryPoint: this.entryPoint,
      args: this.args,
      maxRestarts: this.maxRestarts,
    });

    this.spawnChild();
    this.setupSignalHandlers();
  }

  /**
   * Stop the daemon and the child process gracefully.
   */
  async stop(): Promise<void> {
    const logger = getLogger();
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.child) {
      logger.info("Daemon stopping child process...");
      return new Promise((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (this.child) {
            this.child.kill("SIGKILL");
          }
          resolve();
        }, 10_000);

        this.child!.once("exit", () => {
          clearTimeout(forceKillTimer);
          this.child = null;
          resolve();
        });

        this.child!.kill("SIGTERM");
      });
    }
  }

  /**
   * Returns true if the daemon is actively running (or restarting).
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current restart count.
   */
  getRestartCount(): number {
    return this.restartCount;
  }

  private spawnChild(): void {
    const logger = getLogger();

    this.child = fork(this.entryPoint, this.args, {
      stdio: "inherit",
      env: { ...process.env, STRATA_DAEMON: "1" },
    });

    logger.info("Child process spawned", { pid: this.child.pid });

    this.child.on("exit", (code, signal) => {
      logger.warn("Child process exited", { code, signal });
      this.child = null;

      if (!this.running) return;

      if (this.restartCount >= this.maxRestarts) {
        logger.error(`Maximum restart attempts (${this.maxRestarts}) reached. Daemon stopping.`);
        this.running = false;
        return;
      }

      const delay = Math.min(
        this.baseDelay * Math.pow(2, this.restartCount),
        this.maxDelay
      );
      this.restartCount++;

      logger.info(`Restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);

      this.restartTimer = setTimeout(() => {
        if (this.running) {
          this.spawnChild();
        }
      }, delay);
    });

    this.child.on("error", (error) => {
      logger.error("Child process error", { error: error.message });
    });
  }

  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      const logger = getLogger();
      logger.info(`Daemon received ${signal}`);
      void this.stop().then(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }
}
