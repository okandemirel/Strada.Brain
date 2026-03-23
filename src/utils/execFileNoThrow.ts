// ---------------------------------------------------------------------------
// Non-throwing execFile wrapper — returns exit code + stdout/stderr
// without raising on non-zero exit. Used by skill gating to check binaries.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";

export interface ExecFileResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
      resolve({
        // `error.exitCode` holds the numeric process exit code; `.code` is a
        // string like "ENOENT" for OS-level errors, not the exit code.
        exitCode: error ? ((error as NodeJS.ErrnoException & { exitCode?: number }).exitCode ?? 1) : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
  });
}
