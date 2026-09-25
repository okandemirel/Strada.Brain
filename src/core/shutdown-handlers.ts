/**
 * Process-level shutdown wiring for the runtime (moved out of index.ts so it
 * can be tested without starting the CLI).
 *
 * Policy (measured against long autonomous builds: a multi-hour GDD-to-game run
 * must not die to one stray rejected promise):
 *  - SIGTERM / SIGINT / SIGHUP: graceful shutdown; the SAME kind of request a
 *    second time forces an exit — that is the operator's "stop now".
 *  - uncaughtException: process state may be corrupt → full graceful shutdown.
 *  - unhandledRejection: log-and-continue, with a storm guard as the runaway
 *    backstop.
 *  - A supervisor's IPC shutdown message (FND-25): the graceful path on
 *    Windows, where every signal from the parent is an immediate
 *    TerminateProcess that skips all of the above.
 */

import { shutdownExitCode } from "./shutdown-exit-code.js";
import { sanitizeSecretsQuiet } from "../security/secret-patterns.js";
import { getLogger } from "../utils/logger.js";

/** The IPC message a supervising parent sends to ask for a graceful shutdown. */
export const SHUTDOWN_IPC_MESSAGE = { type: "strada:shutdown" } as const;

export function isShutdownIpcMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SHUTDOWN_IPC_MESSAGE.type
  );
}

/** The slice of `process` the handlers use; injectable for tests. */
export interface ShutdownProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): void;
}

export interface ShutdownLog {
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ShutdownHandlerOptions {
  shutdown: () => Promise<void>;
  /** Runs after `shutdown` succeeds (lock release); failures are ignored. */
  afterShutdown?: () => Promise<void>;
  proc?: ShutdownProcess;
  /** Where rejections and exceptions are reported; the redacting app logger by default. */
  log?: ShutdownLog;
  /** Console for the operator-facing progress lines. */
  out?: Pick<Console, "log" | "error">;
}

const SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGHUP", "supervisor-shutdown"]);
const REJECTION_WINDOW_MS = 60_000;
const MAX_REJECTIONS_PER_WINDOW = 20;

function describeFailure(reason: unknown): { error: string; stack?: string } {
  if (reason instanceof Error) {
    return {
      error: sanitizeSecretsQuiet(reason.message),
      ...(reason.stack ? { stack: sanitizeSecretsQuiet(reason.stack) } : {}),
    };
  }
  return { error: sanitizeSecretsQuiet(String(reason)) };
}

export function setupShutdownHandlers(options: ShutdownHandlerOptions): void {
  const proc = options.proc ?? process;
  const out = options.out ?? console;
  // The redacting app logger (console + log file) is the ONE place a failure is
  // reported; before it exists, the console — the meta is sanitized either way.
  const log = (): ShutdownLog => {
    if (options.log) return options.log;
    try {
      return getLogger();
    } catch {
      return { error: (message, meta) => out.error(message, meta ?? "") };
    }
  };
  let isShuttingDown = false;

  const handleShutdown = async (reason: string): Promise<void> => {
    if (isShuttingDown) {
      // COR-19: only a repeated stop REQUEST forces the exit. A rejection or
      // exception raised while the graceful path runs (often caused by it) must
      // not cut off task persistence, lease commit and lock release.
      if (SIGNALS.has(reason)) {
        out.log("Force shutdown...");
        proc.exit(1);
      }
      return;
    }
    isShuttingDown = true;

    out.log(`\nReceived ${reason}, shutting down gracefully...`);

    try {
      await options.shutdown();
    } catch (error) {
      out.error("Error during shutdown:", sanitizeSecretsQuiet(error instanceof Error ? error.stack ?? error.message : String(error)));
      proc.exit(1);
      return;
    }
    try {
      await options.afterShutdown?.();
    } catch {
      // Lock cleanup is best-effort; a stale lock self-heals on next start.
    }
    out.log("Shutdown complete.");
    // A crash is a crash however clean the cleanup was: exit 0 here left a
    // `Restart=on-failure` unit down after an uncaught exception (audit 14F5).
    proc.exit(shutdownExitCode(reason, true));
  };

  proc.on("SIGTERM", () => void handleShutdown("SIGTERM"));
  proc.on("SIGINT", () => void handleShutdown("SIGINT"));
  proc.on("SIGHUP", () => void handleShutdown("SIGHUP"));
  proc.on("message", (message: unknown) => {
    if (isShutdownIpcMessage(message)) void handleShutdown("supervisor-shutdown");
  });

  proc.on("uncaughtException", (error: unknown) => {
    log().error(isShuttingDown ? "Uncaught exception during shutdown" : "Uncaught exception", describeFailure(error));
    void handleShutdown("uncaughtException");
  });

  let recentRejections: number[] = [];
  proc.on("unhandledRejection", (reason: unknown) => {
    if (isShuttingDown) {
      log().error("Unhandled rejection during shutdown", describeFailure(reason));
      return;
    }
    const now = Date.now();
    recentRejections = recentRejections.filter((timestamp) => now - timestamp < REJECTION_WINDOW_MS);
    recentRejections.push(now);
    log().error(
      `Unhandled rejection (${recentRejections.length} in the last ${REJECTION_WINDOW_MS / 1000}s)`,
      describeFailure(reason),
    );
    if (recentRejections.length >= MAX_REJECTIONS_PER_WINDOW) {
      out.error("Unhandled-rejection storm detected — shutting down before the log floods.");
      void handleShutdown("unhandled-rejection-storm");
    }
  });
}
