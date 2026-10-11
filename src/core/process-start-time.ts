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
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Fields after "(comm) ": state is field 3, starttime field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTicks = Number(fields[19]);
      const btime = fs.readFileSync("/proc/stat", "utf-8").split("\n").find((line) => line.startsWith("btime "));
      const bootSeconds = Number(btime?.slice("btime ".length));
      if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds) || !btime) return null;
      return bootSeconds * 1000 + (startTicks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND;
    }
    const probe = process.platform === "win32"
      ? spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: "utf-8", timeout: 10_000, windowsHide: true })
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
    if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
    const parsed = Date.parse(probe.stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let ownStartTime: number | null = null;

/** This process's start time, measured the way a checker will measure it. */
export function getProcessStartTime(): number {
  ownStartTime ??= readProcessStartTime(process.pid) ?? Date.now() - process.uptime() * 1000;
  return ownStartTime;
}
