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
  /**
   * Characters of EARLIER stdout/stderr discarded by the capture cap; 0 when
   * the text is complete. When non-zero the text opens with a marker saying so.
   */
  stdoutDropped: number;
  stderrDropped: number;
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
    let stdoutDropped = 0;
    let stderrDropped = 0;
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

    // Past the cap only the TAIL is kept — the summary a build or test run
    // prints last is usually the most useful part. What was wrong (audited
    // 2026-09-02): the head was thrown away silently. shell_exec printed the
    // remainder under `--- stdout ---` and git_diff returned it verbatim, so a
    // 60KB `dotnet test` lost its failing-test list and first compile errors,
    // and a >16KB `git diff --stat --patch` always lost its --stat header, with
    // nothing in the result saying anything was missing. Now the discarded
    // count is measured and the retained text opens with a marker naming it.
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > maxOutput * 2) {
        stdoutDropped += stdout.length - maxOutput;
        stdout = stdout.slice(-maxOutput);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > maxOutput * 2) {
        stderrDropped += stderr.length - maxOutput;
        stderr = stderr.slice(-maxOutput);
      }
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    /** Apply the final cap and, if anything was ever dropped, say so up front. */
    const cap = (s: string, dropped: number, stream: "stdout" | "stderr"): { text: string; dropped: number } => {
      if (s.length > maxOutput) {
        dropped += s.length - maxOutput;
        s = s.slice(-maxOutput);
      }
      if (dropped > 0) {
        s = `[… ${dropped} earlier characters of ${stream} dropped by the ${maxOutput}-character capture limit; what follows is the TAIL of the output …]\n${s}`;
      }
      return { text: s, dropped };
    };
    const capped = (): Pick<RunResult, "stdout" | "stderr" | "stdoutDropped" | "stderrDropped"> => {
      const out = cap(stdout, stdoutDropped, "stdout");
      const err = cap(stderr, stderrDropped, "stderr");
      return { stdout: out.text, stderr: err.text, stdoutDropped: out.dropped, stderrDropped: err.dropped };
    };

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
          ...capped(),
          exitCode: 124,
          timedOut: true,
          durationMs: Date.now() - start,
        });
      }, 8000);
    }, opts.timeoutMs);

    child.on("close", (code) => {
      finish({
        ...capped(),
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
        stdoutDropped: 0,
        stderrDropped: 0,
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}
