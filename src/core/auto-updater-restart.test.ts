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
