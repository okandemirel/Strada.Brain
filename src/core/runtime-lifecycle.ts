import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LocalRuntimeInspection, RuntimeProcessInfo } from "./auto-updater.js";
import type { SupportedChannelType } from "../common/constants.js";

export interface StopRuntimeProcessesOptions {
  force?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  signalProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  delayMs?: (ms: number) => Promise<unknown>;
}

export interface StopRuntimeProcessesResult {
  stopped: RuntimeProcessInfo[];
  failed: RuntimeProcessInfo[];
  alreadyStopped: RuntimeProcessInfo[];
}

const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_MS = 200;

export function getMatchingLocalRuntimeProcesses(
  inspection: LocalRuntimeInspection,
  currentPid: number = process.pid,
): RuntimeProcessInfo[] {
  const installRoot = path.resolve(inspection.installRoot);
  return inspection.runtimes.filter((runtime) => (
    runtime.cwd !== null
    && path.resolve(runtime.cwd) === installRoot
    && runtime.pid !== currentPid
  ));
}

export function inferChannelFromRuntimeCommand(
  command: string,
  defaultChannel: SupportedChannelType,
): SupportedChannelType {
  const channelMatch = command.match(/--channel\s+([a-z]+)/i);
  const explicitChannel = channelMatch?.[1]?.toLowerCase();
  if (explicitChannel) {
    return explicitChannel as SupportedChannelType;
  }

  if (/\bcli\b/i.test(command)) {
    return "cli";
  }

  return defaultChannel;
}

export async function isTcpPortBusy(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === "EADDRINUSE") {
        resolve(true);
        return;
      }
      reject(error);
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}

function isProcessAlive(
  pid: number,
  signalProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean,
): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
  signalProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean,
  delayMs: (ms: number) => Promise<unknown>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid, signalProcess)) {
      return true;
    }
    await delayMs(pollMs);
  }
  return !isProcessAlive(pid, signalProcess);
}

export async function stopRuntimeProcesses(
  runtimes: readonly RuntimeProcessInfo[],
  options: StopRuntimeProcessesOptions = {},
): Promise<StopRuntimeProcessesResult> {
  const signalProcess = options.signalProcess ?? process.kill.bind(process);
  const delayMs = options.delayMs ?? sleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const force = options.force === true;

  const result: StopRuntimeProcessesResult = {
    stopped: [],
    failed: [],
    alreadyStopped: [],
  };

  for (const runtime of runtimes) {
    if (!isProcessAlive(runtime.pid, signalProcess)) {
      result.alreadyStopped.push(runtime);
      continue;
    }

    try {
      signalProcess(runtime.pid, force ? "SIGKILL" : "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        result.alreadyStopped.push(runtime);
      } else {
        result.failed.push(runtime);
      }
      continue;
    }

    let stopped = await waitForProcessExit(runtime.pid, timeoutMs, pollMs, signalProcess, delayMs);
    if (!stopped && !force) {
      try {
        signalProcess(runtime.pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          result.alreadyStopped.push(runtime);
          continue;
        }
      }
      stopped = await waitForProcessExit(runtime.pid, Math.min(timeoutMs, 2_000), pollMs, signalProcess, delayMs);
    }

    if (stopped) {
      result.stopped.push(runtime);
    } else {
      result.failed.push(runtime);
    }
  }

  return result;
}
