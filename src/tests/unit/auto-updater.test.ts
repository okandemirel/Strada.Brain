import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("AutoUpdater", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {}
    }
    tmpDirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  describe("detectInstallMethod", () => {
    it("should detect git when .git directory exists", async () => {
      const dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );
      expect(updater.detectInstallMethod()).toBe("git");
    });

    it("should detect npm-local when install root is outside the global npm root", async () => {
      const dir = makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        {
          installRoot: dir,
          globalNpmRootResolver: () => path.join(dir, "global-node-modules"),
        },
      );
      expect(updater.detectInstallMethod()).toBe("npm-local");
    });

    it("should detect npm-global when install root lives under the global npm root", async () => {
      const dir = makeTmpDir();
      const globalRoot = path.join(dir, "global-node-modules");
      const installRoot = path.join(globalRoot, "strada-brain");
      fs.mkdirSync(installRoot, { recursive: true });
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        {
          installRoot,
          globalNpmRootResolver: () => globalRoot,
        },
      );
      expect(updater.detectInstallMethod()).toBe("npm-global");
    });
  });

  describe("parseVersionFromOutput", () => {
    it("should parse semver from npm view output", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.parseVersionFromOutput("1.2.3\n")).toBe("1.2.3");
      expect(AutoUpdater.parseVersionFromOutput("  0.2.0 \n")).toBe("0.2.0");
    });

    it("should return null for invalid output", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.parseVersionFromOutput("npm ERR!")).toBeNull();
      expect(AutoUpdater.parseVersionFromOutput("")).toBeNull();
    });
  });

  describe("isNewerVersion", () => {
    it("should correctly compare semver versions", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.2.0")).toBe(true);
      expect(AutoUpdater.isNewerVersion("0.2.0", "0.1.0")).toBe(false);
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.1.0")).toBe(false);
      expect(AutoUpdater.isNewerVersion("1.0.0", "2.0.0")).toBe(true);
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    });
  });

  describe("lockfile", () => {
    it("should acquire and release lock", async () => {
      const dir = makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );

      expect(updater.acquireLock()).toBe(true);
      const lockPath = path.join(dir, ".strada-update.lock");
      expect(fs.existsSync(lockPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(content.pid).toBe(process.pid);
      expect(content.timestamp).toBeDefined();

      updater.releaseLock();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("should not acquire lock when held by live process", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
      );

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );
      expect(updater.acquireLock()).toBe(false);
    });

    it("should detect stale lock from dead process", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999999, timestamp: Date.now() }),
      );

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    });

    it("should detect stale lock older than 30 minutes", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          timestamp: Date.now() - 31 * 60 * 1000,
        }),
      );

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    });
  });

  describe("shutdown", () => {
    it("should shutdown cleanly without errors", async () => {
      const dir = makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        { installRoot: dir },
      );
      expect(() => updater.shutdown()).not.toThrow();
    });
  });

  describe("performUpdate", () => {
    it("refreshes installed launcher bindings after a successful git update", async () => {
      const dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, ".git"));

      const commandRunner = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return "abc123\n";
        }
        return "";
      });
      const sourceLauncherRefresher = vi.fn(async () => {});

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        {
          installRoot: dir,
          commandRunner,
          sourceLauncherRefresher,
        },
      );

      await expect(updater.performUpdate()).resolves.toBe(true);
      expect(commandRunner.mock.calls.map(([cmd, args]) => `${cmd} ${(args as string[]).join(" ")}`)).toEqual([
        "git rev-parse HEAD",
        "git pull origin main",
        "npm run build",
      ]);
      expect(sourceLauncherRefresher).toHaveBeenCalledTimes(1);
    });

    it("keeps the update successful when launcher refresh fails", async () => {
      const dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, ".git"));

      const commandRunner = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return "abc123\n";
        }
        return "";
      });
      const sourceLauncherRefresher = vi.fn(async () => {
        throw new Error("wrapper rewrite failed");
      });
      const notifyFn = vi.fn();

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(
        mockConfig(),
        mockRegistry(),
        mockExecutor(),
        {
          installRoot: dir,
          commandRunner,
          sourceLauncherRefresher,
        },
      );
      updater.setNotifyFn(notifyFn);

      await expect(updater.performUpdate()).resolves.toBe(true);
      expect(notifyFn).toHaveBeenCalledWith(
        expect.stringContaining("launcher bindings were not refreshed"),
      );
    });
  });
});

function mockConfig() {
  return {
    autoUpdate: {
      enabled: true,
      intervalHours: 24,
      idleTimeoutMin: 5,
      channel: "stable" as const,
      notify: true,
      autoRestart: true,
    },
  };
}

function mockRegistry() {
  return {
    isIdle: () => true,
    getActiveChatIds: () => [],
    getLastActivityTime: () => 0,
    recordActivity: () => {},
  };
}

function mockExecutor() {
  return { hasRunningTasks: () => false };
}
