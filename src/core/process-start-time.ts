/**
 * Process start times: what tells a lock's writer apart from a later process
 * that the OS gave the same pid. The update lock and the runtime lock both
 * record their writer's start time and compare it with the live process's.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

/** Holder start times within this margin are the same process (clock and tick rounding). */
export const START_TIME_MARGIN_MS = 5000;
/** USER_HZ: the unit of /proc/<pid>/stat starttime, fixed at 100 by the Linux user ABI. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/**
 * When `pid` started (ms since the epoch) as the OS reports it, or null when
 * that cannot be determined here. The update lock compares THE HOLDER's start
 * time with the one it recorded; comparing the checker's own start time (as
 * before) judged every live holder that started >5 s apart from the checker
 * as "PID reuse" and broke its lock mid-update (COR-3).
 */
export function readProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const startTicks = readStartTicks(pid, "/proc");
      const btime = fs.readFileSync("/proc/stat", "utf-8").split("\n").find((line) => line.startsWith("btime "));
      const bootSeconds = Number(btime?.slice("btime ".length));
      if (startTicks === null || !Number.isFinite(bootSeconds) || !btime) return null;
      return bootSeconds * 1000 + (startTicks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND;
    }
    const probe = process.platform === "win32"
      ? spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: "utf-8", timeout: 10_000, windowsHide: true })
      // ps prints lstart in its user's language ("Pzt 12 Eki 01:04:41 2026"
      // under tr_TR), which Date.parse cannot read; only C's form parses.
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" },
      });
    if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
    const parsed = Date.parse(probe.stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** /proc/<pid>/stat's starttime: the clock ticks after boot at which `pid` started. */
function readStartTicks(pid: number, procRoot: string): number | null {
  const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf-8");
  // Fields after "(comm) ": state is field 3, starttime field 22.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTicks = Number(fields[19]);
  return Number.isFinite(startTicks) ? startTicks : null;
}

/**
 * When `pid` started, as `<boot id>:<clock ticks since boot>`, on Linux; null
 * elsewhere or when it cannot be read. The epoch time above adds btime, the
 * wall clock minus the time since boot, so it moves whenever the clock is
 * stepped (Docker Desktop's VM re-syncs its clock after the host sleeps) and a
 * live holder no longer matches what it recorded. This one never moves, so a
 * lock compares it exactly. `procRoot` is a test seam.
 */
export function readProcessBootStart(pid: number, procRoot = "/proc"): string | null {
  if (process.platform !== "linux") return null;
  try {
    const bootId = fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, "utf-8").trim();
    const startTicks = readStartTicks(pid, procRoot);
    return bootId && startTicks !== null ? `${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
}

let ownStartTime: number | null = null;
let ownBootStart: string | null | undefined;

/** This process's start time, measured the way a checker will measure it. */
export function getProcessStartTime(): number {
  ownStartTime ??= readProcessStartTime(process.pid) ?? Date.now() - process.uptime() * 1000;
  return ownStartTime;
}

/** This process's {@link readProcessBootStart}. */
export function getProcessBootStart(): string | null {
  if (ownBootStart === undefined) ownBootStart = readProcessBootStart(process.pid);
  return ownBootStart;
}
