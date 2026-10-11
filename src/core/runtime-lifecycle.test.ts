import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { LocalRuntimeInspection, RuntimeProcessInfo } from "./auto-updater.js";
import { readRuntimeLockHolder } from "./runtime-lock.js";
import {
  DEFAULT_STOP_TIMEOUT_MS,
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
    const holder = (pid: number, local = true) => ({
      holder: { pid, startedAtIso: "2026-10-11T00:00:00Z", channel: "web,telegram" },
      local,
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

    it("a live runtime that chdir'd to its config root is found and stopped", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
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
