/**
 * TSK-9: deploy and readiness child processes waited on `'close'`, which
 * never fires while a background process the script started still holds its
 * stdout, and the timeout's kill reached only the direct child. These run
 * real scripts (POSIX shell), so the hang they guard against is the real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DeploymentExecutor, type DeploymentDatabase } from "./deployment-executor.js";
import { ReadinessChecker } from "./readiness-checker.js";
import { runBoundedProcess } from "./bounded-process.js";
import type { DeploymentConfig } from "./deployment-types.js";

const posix = process.platform !== "win32";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function config(overrides: Partial<DeploymentConfig>): DeploymentConfig {
  return {
    enabled: true,
    scriptPath: "deploy.sh",
    testCommand: "true",
    targetBranch: "main",
    requireCleanGit: false,
    testTimeoutMs: 20_000,
    executionTimeoutMs: 20_000,
    cooldownMinutes: 30,
    notificationUrgency: "high",
    ...overrides,
  };
}

/** Alive and not a zombie (a killed orphan waits for init to reap it). */
function running(pid: number): boolean {
  const stat = `/proc/${pid}/stat`;
  if (existsSync("/proc")) {
    if (!existsSync(stat)) return false;
    return !/\) Z /.test(readFileSync(stat, "utf8"));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(!posix)("deployment child processes are bounded (TSK-9)", () => {
  let dir: string;
  const leftovers: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bounded-process-"));
  });

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function script(name: string, body: string): void {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }

  function backgroundPid(): number {
    const pid = Number(readFileSync(join(dir, "bg.pid"), "utf8").trim());
    leftovers.push(pid);
    return pid;
  }

  it("a deploy script that leaves a background process holding stdout still completes", async () => {
    script("deploy.sh", `sleep 30 &\necho $! > bg.pid\necho deployed\nexit 0`);
    const db = new Database(":memory:");
    const executor = new DeploymentExecutor(config({}), dir, logger, db as unknown as DeploymentDatabase);
    const started = Date.now();

    const result = await executor.execute({ id: executor.logProposal() });

    const pid = backgroundPid();
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("deployed");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(executor.isInProgress()).toBe(false);
    // What a deploy script starts in the background may be the deployment
    // itself: it is left running.
    expect(running(pid)).toBe(true);
    db.close();
  }, 10_000);

  it("a timed-out deploy script is terminated together with its process tree", async () => {
    script("deploy.sh", `sleep 30 &\necho $! > bg.pid\nsleep 30\necho never`);
    const db = new Database(":memory:");
    const executor = new DeploymentExecutor(config({ executionTimeoutMs: 300 }), dir, logger, db as unknown as DeploymentDatabase);
    const started = Date.now();

    const result = await executor.execute({ id: executor.logProposal() });

    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitUntil(() => !running(backgroundPid()), 2_000)).toBe(true);
    db.close();
  }, 10_000);

  it("a readiness test command that leaves a watcher behind still yields a verdict, and the watcher is stopped", async () => {
    script("run-tests.sh", `sleep 30 &\necho $! > bg.pid\nexit 0`);
    const checker = new ReadinessChecker(config({ testCommand: "./run-tests.sh" }), dir, logger);
    const started = Date.now();

    const result = await checker.checkReadiness(true);

    expect(result.testPassed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitUntil(() => !running(backgroundPid()), 2_000)).toBe(true);
  }, 10_000);

  it("resolves at the hard deadline and reports the timeout", async () => {
    script("hang.sh", `sleep 30\necho never`);
    const result = await runBoundedProcess({
      command: join(dir, "hang.sh"),
      cwd: dir,
      timeoutMs: 200,
      maxOutputChars: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);
  }, 10_000);
});
