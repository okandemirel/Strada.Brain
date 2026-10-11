/**
 * COR-15: the daemon's post-update restart sat inside the notify branch, so
 * with AUTO_UPDATE_NOTIFY=false the update rebuilt dist/ in place and the
 * running process never restarted onto it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUpdater } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("auto-update restart (COR-15)", () => {
  it("restarts the daemon after a successful update even with notices off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-restart-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    vi.useFakeTimers();
    const updater = new AutoUpdater(
      {
        autoUpdate: {
          enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest",
          notify: false, autoRestart: true, autoRestartDelayMs: 1000,
        },
      },
      { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry,
      { hasRunningTasks: () => false },
      { installRoot: dir, commandRunner: async () => "", isDaemonProcess: () => true },
    );
    const notices: string[] = [];
    updater.setNotifyFn((msg) => notices.push(msg));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    (updater as unknown as { startIdleMonitoring(): void }).startIdleMonitoring();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(notices).toEqual([]);
    updater.shutdown();
  });

  // Audit core-bootstrap#1: idleness was read once, before an update that runs
  // for minutes. A task that started meanwhile (a chat, the campaign's next
  // sprint) was aborted by the SIGTERM two seconds after the update finished.
  it("waits for work that started during the update before restarting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-restart-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    vi.useFakeTimers();
    let running = false;
    let lastActivity = 0;
    const updater = new AutoUpdater(
      {
        autoUpdate: {
          enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest",
          notify: false, autoRestart: true, autoRestartDelayMs: 1000,
        },
      },
      {
        isIdle: (minutes: number) => Date.now() - lastActivity >= minutes * 60_000,
        getActiveChatIds: () => [],
      } as unknown as ChannelActivityRegistry,
      { hasRunningTasks: () => running },
      {
        installRoot: dir,
        commandRunner: async (cmd, args) => {
          if (cmd === "npm" && args[1] === "build") {
            running = true; // the next sprint was submitted while the build ran
            lastActivity = Date.now();
          }
          return "";
        },
        isDaemonProcess: () => true,
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      (updater as unknown as { startIdleMonitoring(): void }).startIdleMonitoring();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy).not.toHaveBeenCalled();

      running = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy, "restarted while the chat was still active").not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      updater.shutdown();
    }
  });
});

const FIRST = "1111111111111111111111111111111111111111";
const SECOND = "2222222222222222222222222222222222222222";

/**
 * A checkout one commit behind, whose origin the test moves. Every pull,
 * build and SIGTERM lands in `events`, in order; the SIGTERM shuts the
 * updater down as the shutdown handlers do (bootstrap's disposables).
 */
function restartRig(opts: {
  /** Runs inside `npm run build`; the update waits for what it returns. */
  onBuild?: (head: string) => Promise<void> | void;
  /** Runs inside `git fetch`; the check waits for what it returns. */
  onFetch?: () => Promise<void> | void;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-restart-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-restart-state-"));
  dirs.push(dir, stateRoot);
  fs.mkdirSync(path.join(dir, ".git"));
  const state = { running: false, head: "0".repeat(40), remote: FIRST };
  const events: string[] = [];
  const versionOf = (sha: string): string => (sha === SECOND ? "4.2.941" : "4.2.940");
  const commandRunner = async (cmd: string, args: string[]): Promise<string> => {
    const sub = args.join(" ");
    if (cmd === "npm" && sub === "run build") {
      events.push(`npm run build ${state.head.slice(0, 4)}`);
      await opts.onBuild?.(state.head);
      return "";
    }
    if (cmd !== "git") return "";
    if (sub === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main\n";
    if (sub.startsWith("fetch")) await opts.onFetch?.();
    if (sub === "rev-parse HEAD") return `${state.head}\n`;
    if (sub === "rev-parse origin/main") return `${state.remote}\n`;
    if (sub.startsWith("rev-list --count")) return state.head === state.remote ? "0\n" : "1\n";
    if (sub === "show origin/main:package.json") return JSON.stringify({ version: versionOf(state.remote) });
    if (sub.startsWith("pull")) {
      events.push(`git pull ${state.remote.slice(0, 4)}`);
      state.head = state.remote;
      return "";
    }
    return "";
  };
  const updater = new AutoUpdater(
    {
      autoUpdate: {
        enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest",
        notify: true, autoRestart: true, autoRestartDelayMs: 1000,
      },
    },
    { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry,
    { hasRunningTasks: () => state.running },
    {
      installRoot: dir,
      stateRoot,
      commandRunner,
      sourceLauncherRefresher: async () => {},
      healthChecker: async () => {},
      isDaemonProcess: () => true,
    },
  );
  const notices: string[] = [];
  updater.setNotifyFn((msg) => notices.push(msg));
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === process.pid && signal === "SIGTERM") {
      events.push("SIGTERM");
      updater.shutdown();
    }
    return true;
  }) as typeof process.kill);
  const internals = updater as unknown as {
    startIdleMonitoring(): void;
    restartWhenIdle(delayMs: number): void;
  };
  return { dir, state, events, notices, updater, internals };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("an update and the restart after the last one never overlap", () => {
  // Review of 1dbe763e. The restart waits for idleness without bound, and an
  // update a webhook queued meanwhile waits for the same idleness. Once the
  // sprint ended the update's idle loop ticked first, and the restart's next
  // tick SIGTERMed the process in the middle of that update's build — no
  // health check, no rollback, no record, its npm still writing dist/ while
  // the daemon wrapper booted onto it.
  it("starts no update while a restart onto the last one is pending, and leaves it to the restarted process", async () => {
    vi.useFakeTimers();
    // The second build takes minutes, as a real one does: long enough for the
    // restart's next look to land inside it.
    const secondBuild = deferred();
    const rig = restartRig({
      onBuild: (head) => {
        if (head === FIRST) rig.state.running = true; // the next sprint starts during the build
        return head === SECOND ? secondBuild.promise : undefined;
      },
    });
    try {
      rig.internals.startIdleMonitoring();
      await vi.advanceTimersByTimeAsync(30_000); // t=30s: the first update
      await vi.advanceTimersByTimeAsync(1_000); // t=31s: its restart waits; next look at t=61s
      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111"]);

      // t=41s: a push lands and the webhook queues it; its idle loop looks at t=71s.
      await vi.advanceTimersByTimeAsync(10_000);
      rig.state.remote = SECOND;
      const result = await rig.updater.requestImmediateCheck();
      expect(result.available).toBe(true);

      // t=65s: the sprint ends, between the restart's look and the update loop's.
      await vi.advanceTimersByTimeAsync(24_000);
      rig.state.running = false;
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111", "SIGTERM"]);
      // The restarted process finds it again (init checks first).
      expect(fs.readFileSync(path.join(rig.dir, ".strada", "pending-update"), "utf-8")).toBe("4.2.941");
    } finally {
      secondBuild.release();
      rig.updater.shutdown();
    }
  });

  // A check during the update queued a newer one; the success that followed
  // cleared it from disk before the restart.
  it("keeps an update queued during the last one for the restarted process", async () => {
    vi.useFakeTimers();
    const build = deferred();
    const rig = restartRig({ onBuild: () => build.promise });
    try {
      rig.internals.startIdleMonitoring();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111"]);

      rig.state.remote = SECOND;
      expect(await rig.updater.requestImmediateCheck()).toMatchObject({ available: true });
      build.release();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111", "SIGTERM"]);
      expect(fs.readFileSync(path.join(rig.dir, ".strada", "pending-update"), "utf-8")).toBe("4.2.941");
    } finally {
      rig.updater.shutdown();
    }
  });

  // Review of 1dbe763e: a second success armed a second restart loop without
  // clearing the first, shutdown() cleared only the newest, and the leftover
  // sent a second SIGTERM, which the shutdown handlers take as a forced exit.
  it("arms one restart however often it is asked for", async () => {
    vi.useFakeTimers();
    const rig = restartRig();
    rig.state.running = true;
    try {
      rig.internals.restartWhenIdle(1000);
      rig.internals.restartWhenIdle(1000);
      await vi.advanceTimersByTimeAsync(10_000);
      rig.state.running = false;
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(rig.events).toEqual(["SIGTERM"]);
    } finally {
      rig.updater.shutdown();
    }
  });

  it("does not restart while this process's update is still running", async () => {
    vi.useFakeTimers();
    const build = deferred();
    const rig = restartRig({ onBuild: () => build.promise });
    try {
      const update = rig.updater.performUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111"]);

      rig.internals.restartWhenIdle(1000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(rig.events, "SIGTERM sent in the middle of the build").toEqual(["git pull 1111", "npm run build 1111"]);

      build.release();
      await expect(update).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rig.events).toEqual(["git pull 1111", "npm run build 1111", "SIGTERM"]);
    } finally {
      rig.updater.shutdown();
    }
  });

  // The idle loop's check runs `git fetch` before it acts; a shutdown (the
  // operator's stop, or the restart) that lands meanwhile left the loop to
  // pull and build in a process that was going down.
  it("starts no update once the updater has shut down", async () => {
    vi.useFakeTimers();
    const fetch = deferred();
    let fetches = 0;
    const rig = restartRig({ onFetch: () => (++fetches === 1 ? fetch.promise : undefined) });
    try {
      rig.internals.startIdleMonitoring();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetches).toBe(1);

      rig.updater.shutdown();
      fetch.release();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(rig.events).toEqual([]);
    } finally {
      rig.updater.shutdown();
    }
  });

  // Review of 1dbe763e: until the restart the old process runs with the new
  // dist/ on disk (COR-15), and the wait has no bound. It said so once.
  it("keeps saying a restart waits, and asks for one by hand after two hours, without forcing it", async () => {
    vi.useFakeTimers();
    const rig = restartRig();
    rig.state.running = true;
    const { getLoggerSafe } = await import("../utils/logger.js");
    const logger = getLoggerSafe();
    const infos: string[] = [];
    const warns: string[] = [];
    vi.spyOn(logger, "info").mockImplementation((msg: string) => { infos.push(msg); return logger; });
    vi.spyOn(logger, "warn").mockImplementation((msg: string) => { warns.push(msg); return logger; });
    try {
      rig.internals.restartWhenIdle(1000);
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);

      expect(infos.filter((m) => m.startsWith("Auto-update restart waits")).length).toBeGreaterThanOrEqual(6);
      expect(warns.filter((m) => m.startsWith("Auto-update restart still waits"))).toHaveLength(1);
      expect(rig.notices.join("\n")).toContain(`stopping PID ${process.pid} is enough`);
      expect(rig.events).toEqual([]);
    } finally {
      rig.updater.shutdown();
    }
  });
});
