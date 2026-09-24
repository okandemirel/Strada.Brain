// ---------------------------------------------------------------------------
// Non-throwing execFile wrapper — returns exit code + stdout/stderr
// without raising on non-zero exit. Used by skill gating to check binaries.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";

export interface ExecFileResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the timeout killed the process (exitCode is then 124). */
  timedOut?: boolean;
}

/** Exit code reported for a process the timeout killed (as `timeout(1)` does). */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Run a command and return its result without throwing on non-zero exit.
 * Resolves even when the process exits with a non-zero code.
 * Rejects only on spawn-level failures (e.g. ENOENT for the command itself).
 */
export function execFileNoThrow(
  command: string,
  args: string[],
  timeoutMs = 5000,
  extraEnv?: Record<string, string>,
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    execFile(command, args, { timeout: timeoutMs, encoding: "utf-8", env }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // The command binary itself was not found
        resolve({ exitCode: 127, stdout: "", stderr: error.message });
        return;
      }
      // Node puts the numeric exit code in `error.code` (a string there means
      // an OS-level error); there is no `exitCode` property, so every failure
      // used to read as exit 1. A killed process has no exit code at all.
      const code: unknown = (error as { code?: unknown } | null)?.code;
      // Killed with no code of its own: the timeout did it (a maxBuffer
      // overflow also kills, but carries a string code).
      const timedOut = (error as { killed?: boolean } | null)?.killed === true && typeof code !== "string";
      resolve({
        exitCode: !error ? 0 : typeof code === "number" ? code : timedOut ? TIMEOUT_EXIT_CODE : 1,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        timedOut,
      });
    });
  });
}
