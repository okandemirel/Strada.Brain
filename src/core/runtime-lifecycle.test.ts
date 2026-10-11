import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { LocalRuntimeInspection, RuntimeProcessInfo } from "./auto-updater.js";
import { acquireRuntimeLock, installLockPath, readRuntimeLockHolder } from "./runtime-lock.js";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  describeUnsignalledLockHolder,
  getMatchingLocalRuntimeProcesses,
  inferChannelFromRuntimeCommand,
  isTcpPortBusy,
  restartNeedsWebPorts,
  stopRuntimeProcesses,
} from "./runtime-lifecycle.js";
import { SHUTDOWN_TIMEOUT_MS } from "./shutdown-exit-code.js";

describe("runtime lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function makeInspection(runtimes: RuntimeProcessInfo[]): LocalRuntimeInspection {
    return {
      installRoot: "/repo/Strada.Brain",
      runtimes,
      matchingRuntime: runtimes[0] ?? null,
    };
  }

  it("filters matching runtime processes by install root and excludes the current pid", () => {
    const inspection = makeInspection([
      { pid: 101, cwd: "/repo/Strada.Brain", command: "node src/index.ts start --channel web" },
      { pid: 202, cwd: "/other/Strada.Brain", command: "node src/index.ts start --channel web" },
      { pid: process.pid, cwd: "/repo/Strada.Brain", command: "node src/index.ts start --channel web" },
    ]);

    expect(getMatchingLocalRuntimeProcesses(inspection)).toEqual([
      { pid: 101, cwd: "/repo/Strada.Brain", command: "node src/index.ts start --channel web" },
    ]);
  });

  describe("a runtime whose working directory is the config root (packaged, Docker, STRADA_SOURCE_CHECKOUT=false)", () => {
    // Every command chdirs to the config root, so the cwd scan never sees
    // this runtime; its lock under the config root names it.
    const holder = (pid: number, local = true, identified = local) => ({
      holder: { pid, startedAtIso: "2026-10-11T00:00:00Z", channel: "web,telegram", host: "box-b" },
      local,
      identified,
      lockFile: "/home/u/.strada/locks/0123456789abcdef.runtime.lock",
    });

    it("is found through the runtime lock", () => {
      const matching = getMatchingLocalRuntimeProcesses(makeInspection([]), process.pid, holder(4242));
      expect(matching.map((runtime) => runtime.pid)).toEqual([4242]);
      expect(inferChannelFromRuntimeCommand(matching[0]!.command, "cli")).toBe("web,telegram");
    });

    it("is listed once when the scan found it too", () => {
      const scanned = { pid: 101, cwd: "/repo/Strada.Brain", command: "node dist/index.js start --channel web" };
      expect(getMatchingLocalRuntimeProcesses(makeInspection([scanned]), process.pid, holder(101))).toEqual([scanned]);
    });

    it("is not offered for signalling when it runs on another host or in another container, or is this process", () => {
      expect(getMatchingLocalRuntimeProcesses(makeInspection([]), process.pid, holder(4242, false))).toEqual([]);
      expect(getMatchingLocalRuntimeProcesses(makeInspection([]), 4242, holder(4242))).toEqual([]);
    });

    it("is not offered for signalling when the process at its pid is not the one that wrote the lock", () => {
      expect(getMatchingLocalRuntimeProcesses(makeInspection([]), process.pid, holder(4242, true, false))).toEqual([]);
      const scanned = { pid: 101, cwd: "/elsewhere", command: "node dist/index.js start --channel web" };
      expect(getMatchingLocalRuntimeProcesses(makeInspection([scanned]), process.pid, holder(101, true, false))).toEqual([]);
    });

    it("a live runtime that chdir'd to its config root is found and stopped, whatever language its user speaks", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
      // The runtime and this checker both read start times with ps, which
      // prints them in the user's language; this machine's user speaks Turkish.
      for (const name of ["LANG", "LC_ALL", "LC_TIME"]) vi.stubEnv(name, "tr_TR.UTF-8");
      const configRoot = mkdtempSync(join(tmpdir(), "strada-lifecycle-config-"));
      const installRoot = mkdtempSync(join(tmpdir(), "strada-lifecycle-install-"));
      const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "runtime-lock.ts")).href;
      const scriptPath = join(configRoot, "runtime.mts");
      writeFileSync(scriptPath, [
        `process.chdir(${JSON.stringify(configRoot)});`,
        `const { acquireRuntimeLock } = await import(${JSON.stringify(moduleUrl)});`,
        `const r = await acquireRuntimeLock({ installRoot: ${JSON.stringify(installRoot)}, configRoot: ${JSON.stringify(configRoot)}, channelType: "web" });`,
        `process.stdout.write(r.acquired ? "acquired\\n" : "refused\\n");`,
        "setInterval(() => {}, 1e6);",
      ].join("\n"));
      const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", scriptPath], { stdio: ["ignore", "pipe", "inherit"] });
      try {
        const [line] = (await once(child.stdout!, "data")) as [Buffer];
        expect(line.toString().trim()).toBe("acquired");

        // What the scan reports for this install: nothing, the cwd is not the install root.
        const inspection: LocalRuntimeInspection = { installRoot, runtimes: [], matchingRuntime: null };
        const matching = getMatchingLocalRuntimeProcesses(
          inspection,
          process.pid,
          await readRuntimeLockHolder({ installRoot, configRoot }),
        );
        expect(matching.map((runtime) => runtime.pid)).toEqual([child.pid]);

        const exited = once(child, "exit");
        const result = await stopRuntimeProcesses(matching, { timeoutMs: 10_000, pollMs: 50 });
        expect(result.stopped.map((runtime) => runtime.pid)).toEqual([child.pid]);
        await exited;
      } finally {
        child.kill("SIGKILL");
        rmSync(configRoot, { recursive: true, force: true });
        rmSync(installRoot, { recursive: true, force: true });
      }
    });

    it("a lock whose pid now belongs to an unrelated process is never offered for signalling", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
      // A runtime that died without releasing its lock (a second Ctrl-C, an
      // exception in shutdown, SIGKILL, OOM) leaves its pid in the lock, and
      // the OS may give that pid to any process of this user.
      const configRoot = mkdtempSync(join(tmpdir(), "strada-lifecycle-config-"));
      const installRoot = mkdtempSync(join(tmpdir(), "strada-lifecycle-install-"));
      const lockPath = installLockPath(configRoot, installRoot, "runtime");
      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      try {
        await once(unrelated, "spawn");
        // This machine's host and pid namespace as a runtime records them, so the lock reads as local.
        const taken = await acquireRuntimeLock({ installRoot, configRoot, channelType: "web" });
        if (!taken.acquired) throw new Error("the test could not take its own lock");
        const written = JSON.parse(readFileSync(lockPath, "utf-8")) as { host: string; pidNamespace?: string };
        await taken.release();

        const anHourAgo = Date.now() - 3_600_000;
        const crashed = {
          pid: unrelated.pid,
          startedAtIso: new Date(anHourAgo).toISOString(),
          channel: "web",
          host: written.host,
          ...(written.pidNamespace ? { pidNamespace: written.pidNamespace } : {}),
        };
        const leftBehind = [
          ["a runtime that recorded when it started", { ...crashed, processStartedAtMs: anHourAgo - 5_000 }, "started-at-another-time"],
          ["a runtime that recorded no start time", crashed, "no-start-recorded"],
          ["a runtime from before owners recorded their host", { pid: unrelated.pid, startedAtIso: crashed.startedAtIso, channel: "web" }, "no-start-recorded"],
        ] as const;
        for (const [writer, lock, because] of leftBehind) {
          writeFileSync(lockPath, JSON.stringify(lock));
          const holder = await readRuntimeLockHolder({ installRoot, configRoot });
          // Still read as held, so a start is refused as before; only signalling it is withheld.
          expect(holder, writer).toMatchObject({ holder: { pid: unrelated.pid }, local: true, identified: false, unidentifiedBecause: because, lockFile: lockPath });

          const inspection: LocalRuntimeInspection = { installRoot, runtimes: [], matchingRuntime: null };
          expect(getMatchingLocalRuntimeProcesses(inspection, process.pid, holder).map((runtime) => runtime.pid), writer).toEqual([]);
          // What status, kill, restart and the start refusal print instead of "nothing is running".
          expect(describeUnsignalledLockHolder(holder)?.join("\n"), writer).toContain(`delete ${lockPath}`);
        }
      } finally {
        unrelated.kill("SIGKILL");
        rmSync(configRoot, { recursive: true, force: true });
        rmSync(installRoot, { recursive: true, force: true });
      }
    });
  });

  describe("what an operator is told about a lock holder kill and restart will not signal", () => {
    const lockFile = "/home/u/.strada/locks/0123456789abcdef.runtime.lock";
    const named = (local: boolean, identified: boolean, unidentifiedBecause?: "no-start-recorded" | "start-unreadable" | "started-at-another-time") => ({
      holder: { pid: 4242, startedAtIso: "", channel: "web", host: "box-b" },
      local,
      identified,
      ...(unidentifiedBecause ? { unidentifiedBecause } : {}),
      lockFile,
    });

    it("says nothing when there is no holder, or one kill and restart will stop", () => {
      expect(describeUnsignalledLockHolder(null)).toBeNull();
      expect(describeUnsignalledLockHolder(named(true, true))).toBeNull();
    });

    // Review of 74f6e347: the start refusal pointed at kill and restart, which
    // then did nothing, and nothing named the file to remove.
    it("names the pid, why it is left alone, and the lock file to remove", () => {
      const reasons = {
        "no-start-recorded": "records no start time",
        "start-unreadable": "could not be read here",
        "started-at-another-time": "after a crash its pid can pass to another process",
      } as const;
      for (const [because, says] of Object.entries(reasons)) {
        const [first, second] = describeUnsignalledLockHolder(named(true, false, because as keyof typeof reasons))!;
        expect(first, because).toContain(`(${lockFile}) names PID 4242`);
        expect(first, because).toContain(says);
        expect(first, because).toContain("kill and restart leave it alone");
        expect(second, because).toBe(`If PID 4242 is not a Strada runtime, delete ${lockFile} and start again.`);
      }
    });

    it("sends the operator to where a holder in another container or host runs", () => {
      const [first, second] = describeUnsignalledLockHolder(named(false, false))!;
      expect(first).toContain(`(${lockFile}) is held by PID 4242 on box-b`);
      expect(second).toContain("Stop it where it runs");
    });
  });

  it("infers channel from runtime command", () => {
    expect(inferChannelFromRuntimeCommand("node dist/index.js start --channel web", "cli")).toBe("web");
    expect(inferChannelFromRuntimeCommand("node dist/index.js cli", "web")).toBe("cli");
    expect(inferChannelFromRuntimeCommand("node dist/index.js start", "web")).toBe("web");
    expect(inferChannelFromRuntimeCommand("node dist/index.js start --channel web,telegram", "cli")).toBe("web,telegram");
    expect(inferChannelFromRuntimeCommand("node dist/index.js start --channel web,whatsapp", "cli")).toBe("cli");
  });

  it("falls back to default channel for invalid --channel values", () => {
    expect(inferChannelFromRuntimeCommand("node dist/index.js start --channel foobar", "web")).toBe("web");
    expect(inferChannelFromRuntimeCommand("node dist/index.js start --channel INVALID", "telegram")).toBe("telegram");
  });

  it("detects when a TCP port is busy", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe("object");
      expect(await isTcpPortBusy((address as net.AddressInfo).port)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("waits for the web ports on restart for every spec that includes web (COR-25)", () => {
    expect(restartNeedsWebPorts("web")).toBe(true);
    expect(restartNeedsWebPorts("web,telegram")).toBe(true);
    expect(restartNeedsWebPorts("telegram,web")).toBe(true);
    expect(restartNeedsWebPorts("telegram")).toBe(false);
    expect(restartNeedsWebPorts("cli")).toBe(false);
  });

  it("gracefully stops running runtime processes", async () => {
    const runtime: RuntimeProcessInfo = {
      pid: 1234,
      cwd: "/repo/Strada.Brain",
      command: "node src/index.ts start --channel web",
    };
    let alive = true;
    const sentSignals: Array<NodeJS.Signals | number | undefined> = [];
    const signalProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(1234);
      sentSignals.push(signal);
      if (signal === 0) {
        if (!alive) {
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      return true;
    });

    const result = await stopRuntimeProcesses([runtime], {
      timeoutMs: 1,
      pollMs: 1,
      signalProcess,
      delayMs: async () => {
        alive = false;
      },
    });

    expect(result.stopped).toEqual([runtime]);
    expect(result.failed).toEqual([]);
    expect(sentSignals).toContain("SIGTERM");
  });

  it("gives a runtime its whole graceful-shutdown budget before SIGKILL (COR-5)", async () => {
    expect(DEFAULT_STOP_TIMEOUT_MS).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);

    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // A shutdown that settles the background executor (10 s), commits leases
    // and flushes stores: well inside the runtime's own budget.
    const exitsAt = now + 30_000;
    const sentSignals: Array<NodeJS.Signals | number | undefined> = [];
    const runtime: RuntimeProcessInfo = { pid: 4242, cwd: "/repo/Strada.Brain", command: "node dist/index.js start" };
    const result = await stopRuntimeProcesses([runtime], {
      signalProcess: (_pid, signal) => {
        sentSignals.push(signal);
        if (signal === 0 && now >= exitsAt) {
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      },
      delayMs: async (ms) => {
        now += ms;
      },
    });

    expect(sentSignals).not.toContain("SIGKILL");
    expect(result.stopped).toEqual([runtime]);
  });
});
