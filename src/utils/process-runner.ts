import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";

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
   * Characters of stdout/stderr discarded by the capture cap; 0 when the text
   * is complete. When non-zero the text keeps its first and last halves and a
   * marker between them says how much of the middle is missing.
   */
  stdoutDropped: number;
  stderrDropped: number;
}

/**
 * How a timeout reaches the command AND everything it started.
 *
 * POSIX: the child leads its own process group (spawned `detached`), so one
 * negative-pid signal covers the tree, and SIGTERM escalates to SIGKILL.
 * Windows has no process groups: `process.kill(-pid)` either throws or
 * terminates only `cmd.exe`, the real command (dotnet test, Unity, ping)
 * keeps the inherited pipes and runs on as an orphan. `taskkill /T /F` walks
 * the tree by parent pid instead. It is named by absolute path so the lookup
 * never consults the current directory.
 */
export type TreeKillPlan =
  | { kind: "group"; pid: number; signal: NodeJS.Signals }
  | { kind: "taskkill"; command: string; args: string[] };

export function planTreeKill(
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals,
  env: Record<string, string | undefined> = process.env,
): TreeKillPlan {
  if (platform === "win32") {
    const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? env["windir"];
    const command = systemRoot ? winPath.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
    return { kind: "taskkill", command, args: ["/pid", String(pid), "/T", "/F"] };
  }
  return { kind: "group", pid: -pid, signal };
}

/**
 * Bounded capture of one stream that keeps BOTH ends. The first half of the
 * budget fills with the opening output and stays; the rest is a rolling tail.
 *
 * Why both (audited 2026-09-02, then again for TLS-10): a tail-only capture
 * silently lost a 60KB `dotnet test`'s first compile errors and a large
 * `git diff --stat --patch`'s --stat header; adding a leading marker made the
 * loss visible but not recoverable, and a consumer that then cut the result
 * from the head (the tool-result cap) handed the model neither end. Keeping
 * the head and the tail means any later head- or tail-cut still sees one of
 * the two ends of the real output.
 */
function createStreamCapture(maxOutput: number): {
  push: (chunk: string) => void;
  finish: (stream: "stdout" | "stderr") => { text: string; dropped: number };
} {
  const headCap = Math.ceil(maxOutput / 2);
  const tailCap = maxOutput - headCap;
  let head = "";
  let tail = "";
  let dropped = 0;
  // Neither cut may split a surrogate pair: half an emoji or CJK extension
  // character is a lone surrogate the model reads as garbage (review TLS-14).
  const lastChars = (text: string): string => {
    const kept = tailCap > 0 ? text.slice(-tailCap) : "";
    return /^[\uDC00-\uDFFF]/.test(kept) ? kept.slice(1) : kept;
  };
  return {
    push(chunk) {
      if (head.length < headCap) {
        let room = headCap - head.length;
        if (room < chunk.length && /[\uD800-\uDBFF]/.test(chunk[room - 1] ?? "")) room -= 1;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (!chunk) return;
      tail += chunk;
      // Trim in batches, not per chunk: slicing a 16K string on every 64K
      // read would be quadratic on a chatty command.
      if (tail.length > tailCap * 2) {
        const kept = lastChars(tail);
        dropped += tail.length - kept.length;
        tail = kept;
      }
    },
    finish(stream) {
      let kept = tail;
      let total = dropped;
      if (kept.length > tailCap) {
        const last = lastChars(kept);
        total += kept.length - last.length;
        kept = last;
      }
      if (total === 0) return { text: head + kept, dropped: 0 };
      const marker =
        `\n[… ${total} characters of ${stream} omitted from the MIDDLE by the ${maxOutput}-character capture limit; ` +
        `the first ${head.length} and the last ${kept.length} are kept …]\n`;
      return { text: head + marker + kept, dropped: total };
    },
  };
}

/**
 * Spawn a child process, capture stdout/stderr, enforce timeout.
 * Shared by shell-exec, git-tools, and dotnet-tools.
 */
export function runProcess(opts: RunOptions): Promise<RunResult> {
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    const start = Date.now();
    const stdout = createStreamCapture(maxOutput);
    const stderr = createStreamCapture(maxOutput);
    let timedOut = false;

    const platform = process.platform;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
      // POSIX: its own process group, so a timeout can reach what the command
      // started. `bash -c "find / | head"` forks: signalling bash alone leaves
      // find running, holding the stdout pipe this process is reading.
      // Windows: no groups to join, and `detached` there means a new console
      // (visible windows for every grandchild) — taskkill /T covers the tree.
      detached: platform !== "win32",
      windowsHide: true,
    });

    /** Signal the command and everything it spawned, not just the shell. */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid === undefined) {
          child.kill(signal);
          return;
        }
        const plan = planTreeKill(platform, child.pid, signal);
        if (plan.kind === "group") {
          process.kill(plan.pid, plan.signal);
          return;
        }
        execFile(plan.command, plan.args, { windowsHide: true, timeout: 10_000 }, (err) => {
          // taskkill failing to START is not "already gone": fall back to the
          // direct child so at least the shell dies. A non-zero exit (128: no
          // such process) means the tree already exited.
          if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
            try {
              child.kill(signal);
            } catch {
              // Already gone.
            }
          }
        });
      } catch {
        // Already gone, or never started: nothing to signal.
      }
    };

    // Past the cap the head and the tail are kept and the middle is counted
    // and marked (see createStreamCapture). Decoded by the stream, not per
    // chunk: a multi-byte character split across two reads would otherwise
    // become two U+FFFD in compiler output and file names.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => stdout.push(data));
    child.stderr.on("data", (data: string) => stderr.push(data));

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const capped = (): Pick<RunResult, "stdout" | "stderr" | "stdoutDropped" | "stderrDropped"> => {
      const out = stdout.finish("stdout");
      const err = stderr.finish("stderr");
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
        // 124 for EVERY timeout, as documented. A POSIX kill leaves code null,
        // but taskkill /F makes the Windows process exit with 1, which read
        // as an ordinary failure; a command that exits by itself on SIGTERM
        // did the same everywhere.
        exitCode: timedOut ? 124 : code ?? 1,
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
