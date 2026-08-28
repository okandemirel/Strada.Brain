import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
      // Its own process group, so a timeout can reach what the command
      // started. `bash -c "find / | head"` forks: signalling bash alone leaves
      // find running, holding the stdout pipe this process is reading.
      detached: true,
    });

    /** Signal the command and everything it spawned, not just the shell. */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone, or never started: nothing to signal.
      }
    };

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

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cap = (s: string) => (s.length > maxOutput ? s.slice(-maxOutput) : s);

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abandonTimer) clearTimeout(abandonTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), 5000);
      // 'close' waits for the stdio pipes, and a process we failed to kill
      // holds them open. A timeout that can itself hang is not a timeout:
      // measured, one `find /Users` ran 45 minutes past a 30-second limit and
      // took the whole run with it. Answer regardless.
      abandonTimer = setTimeout(() => {
        finish({
          stdout: cap(stdout),
          stderr: cap(stderr),
          exitCode: 124,
          timedOut: true,
          durationMs: Date.now() - start,
        });
      }, 8000);
    }, opts.timeoutMs);

    child.on("close", (code) => {
      finish({
        stdout: cap(stdout),
        stderr: cap(stderr),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      // Node reports a MISSING CWD as "spawn <cmd> ENOENT" — indistinguishable
      // from a missing binary, and the agent then chases the wrong cause
      // (observed live: "spawn git ENOENT" while git was on PATH and the real
      // problem was a vanished lease directory). Name the actual culprit.
      let message = err.message;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          if (!existsSync(opts.cwd)) {
            message = `working directory does not exist: ${opts.cwd} (the workspace may have been released) — original: ${err.message}`;
          }
        } catch {
          // Diagnosis is best-effort; the original message still lands.
        }
      }
      finish({
        stdout: "",
        stderr: message,
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}
