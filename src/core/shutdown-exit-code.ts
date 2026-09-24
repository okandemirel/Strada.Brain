/**
 * The process exit code a shutdown ends with.
 *
 * A fatal error (an uncaught exception, an unhandled-rejection storm) used to
 * exit 0 whenever cleanup succeeded, so a unit run with `Restart=on-failure`
 * was not restarted after a crash — the service stayed down until a person
 * noticed (audit 14F5 / D74, 2026-09-13). An ordinary signal shutdown stays
 * clean; a failed cleanup was already 1.
 */
/**
 * How long a graceful shutdown may run before the runtime forces its own exit.
 * `strada kill` / `strada restart` derive their SIGKILL deadline from this, so
 * the CLI never cuts short a shutdown the runtime still allows (COR-5).
 */
export const SHUTDOWN_TIMEOUT_MS = 60_000;

export const FATAL_SHUTDOWN_SIGNALS: ReadonlySet<string> = new Set(["uncaughtException", "unhandled-rejection-storm"]);

export function shutdownExitCode(signal: string, cleanupOk: boolean): number {
  if (!cleanupOk) return 1;
  return FATAL_SHUTDOWN_SIGNALS.has(signal) ? 1 : 0;
}
