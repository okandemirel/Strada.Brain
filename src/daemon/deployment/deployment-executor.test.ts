import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeploymentExecutor, type DeploymentDatabase } from "./deployment-executor.js";
import type { DeploymentConfig } from "./deployment-types.js";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { EventEmitter } from "node:events";

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
  (proc as Record<string, unknown>).kill = vi.fn();

  setTimeout(() => {
    proc.emit("close", exitCode, signal);
  }, 5);

  return proc;
}

function createMockProcessWithOutput(
  stdoutData: string,
  stderrData: string,
  exitCode = 0,
): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as Record<string, unknown>).stdout = stdout;
  (proc as Record<string, unknown>).stderr = stderr;
  (proc as Record<string, unknown>).pid = 12345;
  (proc as Record<string, unknown>).kill = vi.fn();

  setTimeout(() => {
    if (stdoutData) stdout.emit("data", Buffer.from(stdoutData));
    if (stderrData) stderr.emit("data", Buffer.from(stderrData));
    proc.emit("close", exitCode, null);
  }, 5);

  return proc;
}

function createDefaultConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    enabled: true,
    scriptPath: "scripts/deploy.sh",
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

function createMockDb(): DeploymentDatabase {
  const tables: Record<string, Record<string, unknown>[]> = {};

  return {
    exec: vi.fn((sql: string) => {
      if (sql.includes("CREATE TABLE") && sql.includes("deployment_log")) {
        tables.deployment_log = [];
      }
    }),
    prepare: vi.fn((sql: string) => ({
      run: vi.fn((...params: unknown[]) => {
        if (sql.includes("INSERT INTO deployment_log")) {
          tables.deployment_log = tables.deployment_log ?? [];
          tables.deployment_log.push({
            id: params[0],
            proposed_at: params[1],
            agent_id: params[2],
            status: params[3],
          });
        }
        if (sql.includes("UPDATE deployment_log SET status = ?, script_output")) {
          const id = params[4] as string;
          const entry = tables.deployment_log?.find((e) => e.id === id);
          if (entry) {
            entry.status = params[0];
            entry.script_output = params[1];
            entry.duration = params[2];
            entry.error = params[3];
          }
        }
        if (sql.includes("UPDATE deployment_log SET status = ?") && !sql.includes("script_output")) {
          const id = sql.includes("approved_at") ? params[2] : params[1];
          const entry = tables.deployment_log?.find((e) => e.id === id);
          if (entry) {
            entry.status = params[0];
            if (sql.includes("approved_at")) entry.approved_at = params[1];
          }
        }
        return { changes: 1 };
      }),
      get: vi.fn((..._params: unknown[]) => {
        if (sql.includes("COUNT(*)")) {
          const statusFilter = sql.match(/WHERE status = \?/);
          const statusIn = sql.match(/WHERE status IN/);
          if (statusFilter) {
            return { cnt: tables.deployment_log?.filter((e) => e.status === _params[0]).length ?? 0 };
          }
          if (statusIn) {
            const statuses = _params as string[];
            return { cnt: tables.deployment_log?.filter((e) => statuses.includes(e.status as string)).length ?? 0 };
          }
          return { cnt: tables.deployment_log?.length ?? 0 };
        }
        if (sql.includes("ORDER BY proposed_at DESC LIMIT 1")) {
          const sorted = [...(tables.deployment_log ?? [])].sort(
            (a, b) => (b.proposed_at as number) - (a.proposed_at as number),
          );
          return sorted[0];
        }
        return undefined;
      }),
      all: vi.fn((..._params: unknown[]) => {
        return [...(tables.deployment_log ?? [])].sort(
          (a, b) => (b.proposed_at as number) - (a.proposed_at as number),
        ).slice(0, (_params[0] as number) ?? 20);
      }),
    })),
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("DeploymentExecutor", () => {
  let executor: DeploymentExecutor;
  let db: DeploymentDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("execute", () => {
    it("executes deployment script and returns success result", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      // Log a proposal first
      const proposalId = executor.logProposal();

      mockSpawn.mockReturnValueOnce(createMockProcessWithOutput("Deployed!", "", 0));

      const result = await executor.execute({ id: proposalId, approvedBy: "admin" });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Deployed!");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns failure when script exits non-zero", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();
      mockSpawn.mockReturnValueOnce(createMockProcessWithOutput("", "Error occurred", 1));

      const result = await executor.execute({ id: proposalId });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error occurred");
    });

    it("returns failure when no script path configured", async () => {
      const config = createDefaultConfig({ scriptPath: undefined });
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const result = await executor.execute({ id: "test-id" });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain("No deployment script configured");
    });

    it("prevents concurrent deployments", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      // Create a slow process that won't resolve quickly
      const slowProc = new EventEmitter() as unknown as ChildProcess;
      (slowProc as Record<string, unknown>).stdout = new EventEmitter();
      (slowProc as Record<string, unknown>).stderr = new EventEmitter();
      (slowProc as Record<string, unknown>).pid = 12345;
      (slowProc as Record<string, unknown>).kill = vi.fn();

      mockSpawn.mockReturnValueOnce(slowProc);

      // Start first deployment (don't await)
      const first = executor.execute({ id: proposalId });

      // Try second deployment immediately
      const second = await executor.execute({ id: "second-id" });

      expect(second.success).toBe(false);
      expect(second.stderr).toContain("already in progress");

      // Resolve first
      slowProc.emit("close", 0, null);
      await first;
    });

    it("runs post-verify script on success when configured", async () => {
      const config = createDefaultConfig({ postScriptPath: "scripts/verify.sh" });
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      // Deploy script succeeds, then post-verify succeeds
      mockSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcess(0));

      const result = await executor.execute({ id: proposalId });

      expect(result.success).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("returns post_verify_failed when post-verify script fails", async () => {
      const config = createDefaultConfig({ postScriptPath: "scripts/verify.sh" });
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      // Deploy script succeeds, post-verify fails
      mockSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcessWithOutput("", "Verify failed", 1));

      const result = await executor.execute({ id: proposalId });

      expect(result.success).toBe(false);
    });

    it("handles spawn error gracefully", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      const errorProc = new EventEmitter() as unknown as ChildProcess;
      (errorProc as Record<string, unknown>).stdout = new EventEmitter();
      (errorProc as Record<string, unknown>).stderr = new EventEmitter();
      (errorProc as Record<string, unknown>).pid = 12345;
      (errorProc as Record<string, unknown>).kill = vi.fn();
      setTimeout(() => errorProc.emit("error", new Error("spawn ENOENT")), 5);

      mockSpawn.mockReturnValueOnce(errorProc);

      const result = await executor.execute({ id: proposalId });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain("spawn ENOENT");
    });

    it("caps stdout/stderr at 10KB", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      const bigOutput = "x".repeat(20_000);
      mockSpawn.mockReturnValueOnce(
        createMockProcessWithOutput(bigOutput, bigOutput, 0),
      );

      const result = await executor.execute({ id: proposalId });

      expect(result.stdout.length).toBeLessThanOrEqual(10_240);
      expect(result.stderr.length).toBeLessThanOrEqual(10_240);
    });

    it("sets deployment environment variables", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();
      mockSpawn.mockReturnValueOnce(createMockProcess(0));

      await executor.execute({ id: proposalId, approvedBy: "admin" });

      const spawnCall = mockSpawn.mock.calls[0];
      const options = spawnCall[2] as { env: Record<string, string> };
      expect(options.env.DEPLOY_TRIGGER).toBe("auto");
      expect(options.env.DEPLOY_PROPOSAL_ID).toBe(proposalId);
      expect(options.env.DEPLOY_APPROVED_BY).toBe("admin");
    });
  });

  describe("cancel", () => {
    it("sends SIGTERM to active process", async () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const proposalId = executor.logProposal();

      const proc = new EventEmitter() as unknown as ChildProcess;
      (proc as Record<string, unknown>).stdout = new EventEmitter();
      (proc as Record<string, unknown>).stderr = new EventEmitter();
      (proc as Record<string, unknown>).pid = 12345;
      const killFn = vi.fn();
      (proc as Record<string, unknown>).kill = killFn;

      mockSpawn.mockReturnValueOnce(proc);

      // Start deployment (don't await)
      const promise = executor.execute({ id: proposalId });

      // Wait a tick for spawn to be called
      await new Promise((r) => setTimeout(r, 2));

      executor.cancel();
      expect(killFn).toHaveBeenCalledWith("SIGTERM");

      // Resolve the process
      proc.emit("close", null, "SIGTERM");
      await promise;
    });
  });

  describe("isInProgress", () => {
    it("returns false when no deployment running", () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      expect(executor.isInProgress()).toBe(false);
    });
  });

  describe("logProposal", () => {
    it("creates a proposed entry and returns UUID", () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const id = executor.logProposal("agent-1");

      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("getHistory", () => {
    it("returns deployment log entries", () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      executor.logProposal();
      executor.logProposal();

      const history = executor.getHistory(10);
      expect(history.length).toBe(2);
    });
  });

  describe("getStats", () => {
    it("returns aggregate statistics", () => {
      const config = createDefaultConfig();
      db = createMockDb();
      executor = new DeploymentExecutor(config, "/project", mockLogger, db);

      const stats = executor.getStats("CLOSED");

      expect(stats.totalDeployments).toBe(0);
      expect(stats.successful).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.circuitBreakerState).toBe("CLOSED");
    });
  });
});
