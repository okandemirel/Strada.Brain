import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT = 16_384;

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  maxOutput?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Spawn a child process, capture stdout/stderr, enforce timeout.
 * Shared by shell-exec, git-tools, and dotnet-tools.
 */
export function runProcess(opts: RunOptions): Promise<RunResult> {
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > maxOutput * 2) {
        stdout = stdout.slice(-maxOutput);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > maxOutput * 2) {
        stderr = stderr.slice(-maxOutput);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const cap = (s: string) => (s.length > maxOutput ? s.slice(-maxOutput) : s);
      resolve({
        stdout: cap(stdout),
        stderr: cap(stderr),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}
