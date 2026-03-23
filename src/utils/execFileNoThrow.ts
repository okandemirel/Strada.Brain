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
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // The command binary itself was not found
        resolve({ exitCode: 127, stdout: "", stderr: error.message });
        return;
      }
      resolve({
        exitCode: error ? (error as { code?: number }).code ?? 1 : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
  });
}
