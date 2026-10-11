import { Daemon } from "./daemon.js";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { takeSupervisorDeathMarker } from "../core/boot-report.js";

vi.mock("node:child_process", () => {
  return {
    fork: vi.fn(() => {
      const child = new EventEmitter();
      (child as any).pid = 12345;
      (child as any).kill = vi.fn();
      return child;
    }),
  };
});

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("Daemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets running to true after start()", async () => {
    const daemon = new Daemon({ entryPoint: "/fake/entry.js" });

    expect(daemon.isRunning()).toBe(false);
    await daemon.start();
    expect(daemon.isRunning()).toBe(true);
  });

  it("stop() resolves immediately when no child is present and sets isRunning to false", async () => {
    const daemon = new Daemon({ entryPoint: "/fake/entry.js" });

    // stop() without ever starting — no child process exists
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it("getRestartCount() starts at 0", () => {
    const daemon = new Daemon({ entryPoint: "/fake/entry.js" });

    expect(daemon.getRestartCount()).toBe(0);
  });

  it("uses default constructor values (maxRestarts=10, baseDelay=1000, maxDelay=60000)", () => {
    const daemon = new Daemon();

    // The defaults are private, but we can verify the daemon instantiates
    // without error and is in the expected initial state.
    expect(daemon.isRunning()).toBe(false);
    expect(daemon.getRestartCount()).toBe(0);
  });

  it("accepts custom constructor options", async () => {
    const daemon = new Daemon({
      entryPoint: "/custom/entry.js",
      args: ["serve", "--port", "3000"],
      maxRestarts: 5,
      baseDelay: 500,
      maxDelay: 30000,
    });

    // Daemon should instantiate cleanly with custom options
    expect(daemon.isRunning()).toBe(false);
    expect(daemon.getRestartCount()).toBe(0);

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);
  });
});

describe("Daemon.stop() graceful request (FND-25)", () => {
  async function startWithChild(platform: NodeJS.Platform) {
    const { fork } = await import("node:child_process");
    const daemon = new Daemon({ entryPoint: "/fake/entry.js", platform });
    await daemon.start();
    const child = vi.mocked(fork).mock.results.at(-1)!.value as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      send?: ReturnType<typeof vi.fn>;
      connected?: boolean;
    };
    return { daemon, child };
  }

  it("asks the child over IPC on Windows, where a signal is an immediate TerminateProcess", async () => {
    const { daemon, child } = await startWithChild("win32");
    child.connected = true;
    child.send = vi.fn();

    const stopped = daemon.stop();
    expect(child.send).toHaveBeenCalledWith({ type: "strada:shutdown" }, expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("exit", 0, null);
    await stopped;
  });

  it("keeps SIGTERM on POSIX", async () => {
    const { daemon, child } = await startWithChild("linux");
    child.connected = true;
    child.send = vi.fn();

    const stopped = daemon.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.send).not.toHaveBeenCalled();

    child.emit("exit", 0, null);
    await stopped;
  });
});

describe("the supervisor's death marker (dashboard#5)", () => {
  it("is surfaced by the next boot, whichever directory the supervisor and the boot ran from", async () => {
    // Writer and reader both resolved the marker against process.cwd(): a
    // boot started anywhere but the supervisor's directory never reported the
    // death. Two temp directories stand in for the two working directories.
    const { fork } = await import("node:child_process");
    const savedCwd = process.cwd();
    const savedExitCode = process.exitCode;
    const supervisorCwd = mkdtempSync(join(tmpdir(), "supervisor-cwd-"));
    const bootCwd = mkdtempSync(join(tmpdir(), "boot-cwd-"));
    // The give-up branch messages Telegram when a token is set; not from a test.
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const daemon = new Daemon({ entryPoint: "/fake/entry.js", maxRestarts: 0 });
    try {
      process.chdir(supervisorCwd);
      await daemon.start();
      const child = vi.mocked(fork).mock.results.at(-1)!.value as EventEmitter;
      // A limit of 0: the first crash is the one the supervisor gives up on.
      child.emit("exit", 1, null);
      expect(daemon.isRunning()).toBe(false);

      process.chdir(bootCwd);
      const warning = takeSupervisorDeathMarker();
      expect(warning, "the boot found no marker").not.toBeNull();
      expect(warning).toContain("The supervisor gave up before this boot");
      // Reported once: the boot consumed it.
      expect(takeSupervisorDeathMarker()).toBeNull();
    } finally {
      process.chdir(savedCwd);
      process.exitCode = savedExitCode;
      vi.unstubAllEnvs();
    }
  });
});
