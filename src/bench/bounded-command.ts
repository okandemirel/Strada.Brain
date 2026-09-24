/**
 * Run a bench candidate command under a time budget that binds its whole
 * process TREE, not just the shell that started it (CMP-9).
 *
 * `spawnSync(sh, ["-c", cmd], { timeout })` sent SIGTERM to `sh` alone: an
 * agent the shell had started was re-parented and kept running (and spending)
 * inside a checkout the harness was deleting. And because `spawnSync` waits
 * for EOF on the stdio pipes, a candidate that EXITED but left a background
 * child holding stdout blocked until the budget and was recorded as a timeout.
 *
 * Here the command runs in its own process group (POSIX) and a timeout kills
 * the group — SIGTERM, then SIGKILL after a grace period (Windows:
 * `taskkill /T /F`). The run is over when the command EXITS; pipes still held
 * open by a straggler get a short drain and are then closed, and the
 * stragglers are retired with the group.
 */

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface BoundedCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Between SIGTERM and SIGKILL of the group. */
  readonly graceMs?: number;
  /** How long output may keep arriving after the command itself exited. */
  readonly drainMs?: number;
  /** Output kept per stream; the rest is dropped (the old spawnSync maxBuffer). */
  readonly maxOutputBytes?: number;
}

export interface BoundedCommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | null;
}

const IS_WINDOWS = process.platform === "win32";

/** Signal every process of the command's tree; a tree that is already gone is fine. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch { /* taskkill unavailable: the direct child below still goes */ }
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export function runBoundedCommand(opts: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const graceMs = opts.graceMs ?? 5_000;
  const drainMs = opts.drainMs ?? 1_000;
  const maxBytes = opts.maxOutputBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the whole tree can be signalled at once.
      detached: !IS_WINDOWS,
      windowsHide: true,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    };
    let child: ChildProcess;
    try {
      child = spawn(opts.command, [...opts.args], spawnOptions);
    } catch (err) {
      resolve({ status: null, signal: null, stdout: "", stderr: "", timedOut: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < maxBytes) errOut.push(chunk);
      errBytes += chunk.length;
    });

    let timedOut = false;
    let settled = false;
    let spawnError: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const budget = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
      killTimer.unref();
    }, opts.timeoutMs);
    budget.unref();

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      if (killTimer !== undefined) clearTimeout(killTimer);
      // Whatever the command left behind is retired with it: it would keep
      // writing into a checkout the harness is about to remove.
      if (!IS_WINDOWS) killTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        status,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        timedOut,
        error: spawnError,
      });
    };

    child.on("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    // Done when the command EXITS: a background child still holding the pipes
    // gets `drainMs` for its output, and does not turn a finished run into a
    // timeout.
    child.on("exit", (status, signal) => {
      let closed = false;
      child.once("close", () => {
        closed = true;
        finish(status, signal);
      });
      const drain = setTimeout(() => {
        if (!closed) finish(status, signal);
      }, drainMs);
      drain.unref();
    });
  });
}
