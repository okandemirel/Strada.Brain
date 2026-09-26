/**
 * Bounded child processes for deployment and readiness scripts.
 *
 * Waiting for `'close'` hung forever when the script left a background
 * process holding its stdout/stderr (`./server &`, a test runner's watcher),
 * and the timeout's kill reached only the direct child. Here completion
 * follows the process's own `'exit'` (plus a short drain for buffered
 * output), a timeout terminates the whole process tree, and a hard deadline
 * resolves even when nothing reports back.
 *
 * SECURITY: spawn() with an argument array and no shell.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** How long output is still collected after the process exits. */
export const EXIT_DRAIN_GRACE_MS = 500;
/** Between the polite and the forced kill of a timed-out tree. */
export const KILL_GRACE_MS = 5_000;

export interface BoundedProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock budget; the whole process tree is terminated when it runs out. */
  readonly timeoutMs: number;
  /** Cap per captured stream, in characters. */
  readonly maxOutputChars: number;
  /**
   * Terminate whatever the process left running once it exits (a test
   * runner's watchers). Off for deploy scripts, whose background processes
   * may be the deployment itself.
   */
  readonly killTreeOnExit?: boolean;
  /** Receives the child right after spawn (e.g. for cancellation). */
  readonly onSpawn?: (child: ChildProcess) => void;
}

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: Error;
}

/** Own process group on POSIX so the tree can be signalled as one. */
const SPAWN_DETACHED = process.platform !== "win32";

/**
 * Signal a child spawned by runBoundedProcess together with its descendants.
 * POSIX: the child leads its own process group, so the negative pid reaches
 * the group. Windows has no process groups: `taskkill /T /F` walks the tree.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const killDirect = (): void => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  if (!SPAWN_DETACHED) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", killDirect);
    } catch {
      killDirect();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    killDirect();
  }
}

/** Stop a pipe from holding the event loop open without closing it under a live writer. */
function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

/**
 * `npm` and `npx` are `.cmd` shims on Windows, which spawn() cannot start
 * without a shell (ENOENT for the bare name, EINVAL for `.cmd` since
 * CVE-2024-27980), and this module never uses one: the readiness check's
 * default `npm test` could not run there at all. Node ships both CLIs'
 * JavaScript next to its executable, so a bare `npm`/`npx` runs that with
 * this Node instead. Everything else, and every other platform, is spawned
 * exactly as given.
 */
export function resolveNodeCliCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists?: (file: string) => boolean,
): { command: string; args: readonly string[] } {
  if (platform !== "win32") return { command, args };
  const name = command.toLowerCase().replace(/\.cmd$/, "");
  const cli = name === "npm" ? "npm-cli.js" : name === "npx" ? "npx-cli.js" : undefined;
  if (!cli) return { command, args };
  const script = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", cli);
  if (!(exists ?? existsSync)(script)) return { command, args };
  return { command: execPath, args: [script, ...args] };
}

export function runBoundedProcess(opts: BoundedProcessOptions): Promise<BoundedProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    let child: ChildProcess;
    try {
      const resolved = resolveNodeCliCommand(opts.command, opts.args ?? []);
      child = spawn(resolved.command, [...resolved.args], {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: SPAWN_DETACHED,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // A descendant may still hold the pipes: keep draining them (the data
      // handlers cap what is kept) but let them no longer hold the loop open.
      unrefStream(child.stdout);
      unrefStream(child.stderr);
      (child as { unref?: () => void }).unref?.();
      resolve({
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? (timedOut && !exited ? "SIGKILL" : null),
        stdout,
        stderr,
        timedOut,
        ...(error ? { error } : {}),
      });
    };

    opts.onSpawn?.(child);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < opts.maxOutputChars) {
        stdout += chunk.toString().slice(0, opts.maxOutputChars - stdout.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < opts.maxOutputChars) {
        stderr += chunk.toString().slice(0, opts.maxOutputChars - stderr.length);
      }
    });

    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      exited ??= { code, signal };
      if (settled) return;
      if (opts.killTreeOnExit && !timedOut) killProcessTree(child, "SIGTERM");
      // 'close' normally follows at once; when a descendant keeps the pipes
      // open it never does, and this is the answer.
      timers.push(setTimeout(() => finish(), EXIT_DRAIN_GRACE_MS));
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      exited ??= { code, signal };
      finish();
    });

    timers.push(setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS));
      // The hard deadline: resolve even if no exit is ever reported.
      timers.push(setTimeout(() => finish(), KILL_GRACE_MS + 1_000));
    }, opts.timeoutMs));
  });
}
