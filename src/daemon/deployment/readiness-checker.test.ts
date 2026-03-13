import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReadinessChecker } from "./readiness-checker.js";
import type { DeploymentConfig } from "./deployment-types.js";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants } from "node:fs";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

const mockSpawn = vi.mocked(realSpawn);
const mockAccessSync = vi.mocked(accessSync);

function createMockProcess(exitCode: number | null = 0, signal: string | null = null): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as Record<string, unknown>).stdout = stdout;
  (proc as Record<string, unknown>).stderr = stderr;
  (proc as Record<string, unknown>).pid = 12345;

  // Emit close event in next tick
  setTimeout(() => {
    proc.emit("close", exitCode, signal);
  }, 5);

  return proc;
}

function createMockProcessWithStdout(output: string, exitCode = 0): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as Record<string, unknown>).stdout = stdout;
  (proc as Record<string, unknown>).stderr = stderr;
  (proc as Record<string, unknown>).pid = 12345;

  setTimeout(() => {
    stdout.emit("data", Buffer.from(output));
    proc.emit("close", exitCode, null);
  }, 5);

  return proc;
}

function createDefaultConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    enabled: false,
    testCommand: "npm test",
    targetBranch: "main",
    requireCleanGit: true,
    testTimeoutMs: 300000,
    executionTimeoutMs: 600000,
    cooldownMinutes: 30,
    notificationUrgency: "high",
    ...overrides,
  };
}

const mockLogger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("ReadinessChecker", () => {
  let checker: ReadinessChecker;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkReadiness", () => {
    it("returns ready=true when test passes, git is clean, and branch matches", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      // Mock spawn calls in order: test command, git status, git branch
      mockSpawn
        .mockReturnValueOnce(createMockProcess(0)) // test passes
        .mockReturnValueOnce(createMockProcessWithStdout("")) // git clean
        .mockReturnValueOnce(createMockProcessWithStdout("main")); // branch matches

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(true);
      expect(result.testPassed).toBe(true);
      expect(result.gitClean).toBe(true);
      expect(result.branchMatch).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("returns ready=false when test command fails", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(1)) // test fails
        .mockReturnValueOnce(createMockProcessWithStdout("")) // git clean
        .mockReturnValueOnce(createMockProcessWithStdout("main")); // branch matches

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.testPassed).toBe(false);
      expect(result.reason).toContain("test command failed");
    });

    it("returns ready=false when git has uncommitted changes", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0)) // test passes
        .mockReturnValueOnce(createMockProcessWithStdout(" M src/file.ts\n")) // dirty
        .mockReturnValueOnce(createMockProcessWithStdout("main")); // branch matches

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.gitClean).toBe(false);
      expect(result.reason).toContain("uncommitted changes");
    });

    it("returns ready=false when branch does not match target", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0)) // test passes
        .mockReturnValueOnce(createMockProcessWithStdout("")) // git clean
        .mockReturnValueOnce(createMockProcessWithStdout("feature-branch")); // wrong branch

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.branchMatch).toBe(false);
      expect(result.reason).toContain("does not match target branch");
    });

    it("returns ready=false when test is killed by signal (timeout)", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(null, "SIGTERM")) // killed
        .mockReturnValueOnce(createMockProcessWithStdout("")) // git clean
        .mockReturnValueOnce(createMockProcessWithStdout("main")); // branch matches

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.testPassed).toBe(false);
    });

    it("returns cached result on second call without forceRefresh", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"));

      const first = await checker.checkReadiness();
      expect(first.cached).toBe(false);

      const second = await checker.checkReadiness();
      expect(second.cached).toBe(true);
      expect(second.ready).toBe(first.ready);

      // spawn should only have been called 3 times (not 6)
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it("re-runs check on forceRefresh", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"))
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"));

      await checker.checkReadiness();
      const second = await checker.checkReadiness(true);

      expect(second.cached).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(6);
    });

    it("skips git clean check when requireCleanGit is false", async () => {
      const config = createDefaultConfig({ requireCleanGit: false });
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0)) // test passes
        .mockReturnValueOnce(createMockProcessWithStdout("main")); // branch matches

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(true);
      expect(result.gitClean).toBe(true);
      // Only 2 spawn calls (test + branch), not 3
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("handles spawn error gracefully", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      const errorProc = new EventEmitter() as unknown as ChildProcess;
      (errorProc as Record<string, unknown>).stdout = new EventEmitter();
      (errorProc as Record<string, unknown>).stderr = new EventEmitter();
      setTimeout(() => errorProc.emit("error", new Error("spawn ENOENT")), 5);

      mockSpawn
        .mockReturnValueOnce(errorProc)
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"));

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.testPassed).toBe(false);
    });

    it("combines multiple failure reasons", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(1)) // test fails
        .mockReturnValueOnce(createMockProcessWithStdout(" M file.ts")) // dirty
        .mockReturnValueOnce(createMockProcessWithStdout("develop")); // wrong branch

      const result = await checker.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.reason).toContain("test command failed");
      expect(result.reason).toContain("uncommitted changes");
      expect(result.reason).toContain("does not match target branch");
    });
  });

  describe("invalidateCache", () => {
    it("clears cached result so next check re-runs", async () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      mockSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"))
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithStdout(""))
        .mockReturnValueOnce(createMockProcessWithStdout("main"));

      await checker.checkReadiness();
      checker.invalidateCache();
      const result = await checker.checkReadiness();

      expect(result.cached).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(6);
    });
  });

  describe("validateScriptPath", () => {
    it("returns resolved path for valid script within project root", () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);
      mockAccessSync.mockImplementation(() => undefined);

      const result = checker.validateScriptPath("scripts/deploy.sh");

      expect(result).toBe("/project/scripts/deploy.sh");
    });

    it("throws on path traversal attempt", () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      expect(() => checker.validateScriptPath("../../etc/passwd")).toThrow(
        "Script path traversal detected",
      );
    });

    it("throws on absolute path outside project root", () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);

      expect(() => checker.validateScriptPath("/etc/passwd")).toThrow(
        "Script path traversal detected",
      );
    });

    it("throws when script is not executable", () => {
      const config = createDefaultConfig();
      checker = new ReadinessChecker(config, "/project", mockLogger);
      mockAccessSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(() => checker.validateScriptPath("scripts/deploy.sh")).toThrow(
        "Script not found or not executable",
      );
    });
  });
});
