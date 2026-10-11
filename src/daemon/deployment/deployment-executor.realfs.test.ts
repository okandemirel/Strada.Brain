/**
 * DeploymentExecutor against real scripts and a real SQLite ledger: what
 * `strada daemon deploy:status` / `deploy:history` and GET /api/deployment
 * read back after a deploy, a failure, a rollback, or a script that cannot run.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentExecutor } from "./deployment-executor.js";
import type { DeploymentConfig } from "./deployment-types.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The script cases spawn `#!/bin/sh` files directly (no shell) and make one
 * unrunnable through its mode bits. Windows does neither: CreateProcess
 * cannot start a shebang script (spawn UNKNOWN), and access(X_OK) ignores
 * mode bits there. windows-test runs every test file, so they are POSIX-only.
 */
const runsShebangScripts = process.platform !== "win32";

function config(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    enabled: true,
    scriptPath: "scripts/deploy.sh",
    testCommand: "true",
    targetBranch: "main",
    requireCleanGit: false,
    testTimeoutMs: 10_000,
    executionTimeoutMs: 10_000,
    cooldownMinutes: 30,
    notificationUrgency: "high",
    ...overrides,
  };
}

describe("DeploymentExecutor ledger (real scripts, real SQLite)", () => {
  const roots: string[] = [];
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(): { root: string; script(name: string, body: string, executable?: boolean): void; marker(name: string): boolean } {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "strada-deploy-ledger-")));
    roots.push(root);
    mkdirSync(path.join(root, "scripts"));
    return {
      root,
      script(name, body, executable = true) {
        const file = path.join(root, "scripts", name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, executable ? 0o755 : 0o644);
      },
      marker: (name) => existsSync(path.join(root, name)),
    };
  }

  function executorFor(root: string, overrides: Partial<DeploymentConfig>, options?: ConstructorParameters<typeof DeploymentExecutor>[4]): DeploymentExecutor {
    const db = new Database(":memory:");
    dbs.push(db);
    return new DeploymentExecutor(config(overrides), root, quietLogger, db, options);
  }

  describe.skipIf(!runsShebangScripts)("a failed deploy that was rolled back", () => {
    it("counts as failed, keeps why the deploy failed, and records who approved it", async () => {
      const p = project();
      p.script("deploy.sh", "echo 'migration 42 failed' >&2\nexit 3");
      p.script("rollback.sh", "echo 'rolled back'");
      const executor = executorFor(p.root, { rollbackScriptPath: "scripts/rollback.sh" });
      const id = executor.logProposal();

      const result = await executor.execute({ id, approvedBy: "alice" });

      expect(result.success).toBe(false);
      const [row] = executor.getHistory(1);
      expect(row!.status).toBe("rollback_completed");
      expect(row!.error).toContain("migration 42 failed");
      expect(row!.scriptOutput).toContain("rolled back");
      expect(row!.approvedBy).toBe("alice");
      expect(row!.approvedAt).toEqual(expect.any(Number));
      expect(executor.getStats()).toMatchObject({ totalDeployments: 1, successful: 0, failed: 1 });
    });

    it("keeps the deploy's error and adds the rollback's when the rollback fails too", async () => {
      const p = project();
      p.script("deploy.sh", "echo 'deploy broke' >&2\nexit 1");
      p.script("rollback.sh", "echo 'rollback broke' >&2\nexit 1");
      const executor = executorFor(p.root, { rollbackScriptPath: "scripts/rollback.sh" });
      const id = executor.logProposal();

      await executor.execute({ id });

      const [row] = executor.getHistory(1);
      expect(row!.status).toBe("rollback_failed");
      expect(row!.error).toContain("deploy broke");
      expect(row!.error).toContain("rollback broke");
      expect(executor.getStats().failed).toBe(1);
    });
  });

  describe("the circuit breaker state", () => {
    it("is the deploy breaker's, not a constant CLOSED", () => {
      const p = project();
      const breaker = new CircuitBreaker(1, 60_000, 60_000);
      const executor = executorFor(p.root, {}, { circuitState: () => breaker.getState() });
      expect(executor.getStats().circuitBreakerState).toBe("CLOSED");

      breaker.recordFailure();

      expect(executor.getStats().circuitBreakerState).toBe("OPEN");
    });
  });

  describe.skipIf(!runsShebangScripts)("a script that cannot run once the deploy is approved", () => {
    it("an unrunnable post-verify script fails verification and rolls the live release back", async () => {
      const p = project();
      p.script("deploy.sh", "touch deployed");
      p.script("verify.sh", "exit 0", false);
      p.script("rollback.sh", "touch rolledback");
      const executor = executorFor(p.root, {
        postScriptPath: "scripts/verify.sh",
        rollbackScriptPath: "scripts/rollback.sh",
      });
      const id = executor.logProposal();

      const result = await executor.execute({ id });

      expect(result.success).toBe(false);
      expect(p.marker("deployed")).toBe(true);
      expect(p.marker("rolledback")).toBe(true);
      const [row] = executor.getHistory(1);
      expect(row!.status).toBe("rollback_completed");
      expect(row!.error).toMatch(/verify\.sh/);
      expect(executor.getStats().failed).toBe(1);
      expect(executor.isInProgress()).toBe(false);
    });

    it("an unrunnable post-verify script with no rollback ends the row as post_verify_failed", async () => {
      const p = project();
      p.script("deploy.sh", "exit 0");
      p.script("verify.sh", "exit 0", false);
      const executor = executorFor(p.root, { postScriptPath: "scripts/verify.sh" });
      const id = executor.logProposal();

      await executor.execute({ id });

      const [row] = executor.getHistory(1);
      expect(row!.status).toBe("post_verify_failed");
      expect(row!.error).toMatch(/not executable/);
    });

    it("an unrunnable deploy script ends the approved row as failed, with the reason", async () => {
      const p = project();
      p.script("deploy.sh", "exit 0", false);
      const executor = executorFor(p.root, {});
      const id = executor.logProposal();

      await expect(executor.execute({ id, approvedBy: "bob" })).rejects.toThrow(/not executable/);

      const [row] = executor.getHistory(1);
      expect(row!.status).toBe("failed");
      expect(row!.error).toMatch(/not executable/);
      expect(row!.approvedBy).toBe("bob");
      expect(executor.getStats().failed).toBe(1);
      expect(executor.isInProgress()).toBe(false);
    });
  });
});
