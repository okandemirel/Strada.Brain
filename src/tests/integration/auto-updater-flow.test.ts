import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AutoUpdater } from "../../core/auto-updater.js";
import { ChannelActivityRegistry } from "../../core/channel-activity-registry.js";

describe("AutoUpdater Integration", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-"));
    tmpDirs.push(dir);
    return dir;
  }

  const mockAutoUpdateConfig = {
    autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest" as const, notify: true, autoRestart: true },
  };

  it("should complete full lockfile lifecycle", () => {
    makeTmpDir();
    const registry = new ChannelActivityRegistry();
    const updater = new AutoUpdater(mockAutoUpdateConfig, registry, { hasRunningTasks: () => false });

    expect(updater.acquireLock()).toBe(true);
    expect(updater.acquireLock()).toBe(false); // same PID, within 30min
    updater.releaseLock();
    expect(updater.acquireLock()).toBe(true);
    updater.releaseLock();
  });

  it("should integrate ChannelActivityRegistry for idle detection", () => {
    const registry = new ChannelActivityRegistry();
    expect(registry.isIdle(5)).toBe(true);
    registry.recordActivity("web", "chat-1");
    expect(registry.isIdle(5)).toBe(false);
    const chats = registry.getActiveChatIds();
    expect(chats).toHaveLength(1);
    expect(chats[0].channelName).toBe("web");
  });

  it("should shutdown cleanly without errors", () => {
    makeTmpDir();
    const registry = new ChannelActivityRegistry();
    const updater = new AutoUpdater(mockAutoUpdateConfig, registry, { hasRunningTasks: () => false });
    expect(() => updater.shutdown()).not.toThrow();
  });

  it("should detect install method based on directory contents", () => {
    const dir = makeTmpDir();
    const globalRoot = path.join(dir, "global-node-modules");
    const installRoot = path.join(globalRoot, "strada-brain");
    fs.mkdirSync(installRoot, { recursive: true });

    // Install root under the global npm root -> npm-global
    const registry = new ChannelActivityRegistry();
    let updater = new AutoUpdater(
      mockAutoUpdateConfig,
      registry,
      { hasRunningTasks: () => false },
      {
        installRoot,
        globalNpmRootResolver: () => globalRoot,
      },
    );
    expect(updater.detectInstallMethod()).toBe("npm-global");

    // Add .git -> git
    fs.mkdirSync(path.join(installRoot, ".git"));
    updater = new AutoUpdater(
      mockAutoUpdateConfig,
      new ChannelActivityRegistry(),
      { hasRunningTasks: () => false },
      {
        installRoot,
        globalNpmRootResolver: () => globalRoot,
      },
    );
    expect(updater.detectInstallMethod()).toBe("git");
  });
});
