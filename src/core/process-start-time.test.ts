import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessBootStart, readProcessStartTime } from "./process-start-time.js";

// Languages whose `ps -o lstart=` Date.parse cannot read: "Pzt 12 Eki
// 01:04:41 2026", "Mo. 12 Okt. 01:04:41 2026", "月 10/12 01:04:41 2026".
const LOCALIZED = ["tr_TR.UTF-8", "de_DE.UTF-8", "ja_JP.UTF-8"];

function rawLstart(env: NodeJS.ProcessEnv): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf-8", env }).stdout.trim();
}

describe("readProcessStartTime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The runtime lock and the update lock both identify their writer by this
  // reading; a null one identifies nobody, so `strada kill` and `restart`
  // found no runtime on a machine whose user speaks Turkish.
  it("reads a start time whatever language the shell speaks", { skip: process.platform === "win32" }, (ctx) => {
    const inC = Date.parse(rawLstart({ ...process.env, LC_ALL: "C" }));
    expect(Number.isFinite(inC)).toBe(true);

    const measured: string[] = [];
    for (const locale of LOCALIZED) {
      // A machine without this locale prints the C form; it measures nothing.
      if (Number.isFinite(Date.parse(rawLstart({ ...process.env, LC_ALL: locale, LANG: locale, LC_TIME: locale })))) continue;
      measured.push(locale);
      vi.stubEnv("LANG", locale);
      vi.stubEnv("LC_ALL", locale);
      vi.stubEnv("LC_TIME", locale);
      const startedAt = readProcessStartTime(process.pid);
      // ps prints whole seconds; /proc (Linux) counts ticks.
      expect(startedAt, locale).not.toBeNull();
      expect(Math.abs(startedAt! - inC), locale).toBeLessThan(1_000);
      vi.unstubAllEnvs();
    }
    if (measured.length === 0) ctx.skip("no localized locale is installed here");
  });
});

describe("readProcessBootStart", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const roots: string[] = [];
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fakeProc(pid: number, comm: string, startTicks: number): string {
    const root = mkdtempSync(join(tmpdir(), "strada-fake-proc-"));
    roots.push(root);
    mkdirSync(join(root, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(root, "sys", "kernel", "random", "boot_id"), "6f1c2d3e-0000-4000-8000-000000000001\n");
    mkdirSync(join(root, String(pid)));
    // Fields 4..21 are irrelevant here; starttime is field 22.
    const middle = Array.from({ length: 18 }, (_, i) => String(i + 4)).join(" ");
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) S ${middle} ${startTicks} 1000 200\n`);
    return root;
  }

  // Wall-clock steps (Docker Desktop's VM re-syncs its clock after the host
  // sleeps) move btime and with it every epoch start time; the start counted
  // from boot does not move.
  it("is the boot id and the clock ticks since boot at which the pid started (Linux)", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    // A command name may hold spaces and parentheses; the fields follow the last ")".
    const root = fakeProc(4242, "node (x) y", 987654);
    expect(readProcessBootStart(4242, root)).toBe("6f1c2d3e-0000-4000-8000-000000000001:987654");
    expect(readProcessBootStart(4243, root)).toBeNull();
  });

  it("is null where there is no /proc to count from", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    expect(readProcessBootStart(4242, fakeProc(4242, "node", 1))).toBeNull();
  });
});
