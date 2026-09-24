import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeInspection, RuntimeProcessInfo } from "./auto-updater.js";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  getMatchingLocalRuntimeProcesses,
  inferChannelFromRuntimeCommand,
  isTcpPortBusy,
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
