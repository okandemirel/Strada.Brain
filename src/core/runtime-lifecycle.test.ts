import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeInspection, RuntimeProcessInfo } from "./auto-updater.js";
import {
  getMatchingLocalRuntimeProcesses,
  inferChannelFromRuntimeCommand,
  isTcpPortBusy,
  stopRuntimeProcesses,
} from "./runtime-lifecycle.js";

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
});
