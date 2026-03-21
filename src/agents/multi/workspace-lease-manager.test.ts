import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";
import type { WorkspaceCommandRunner } from "./workspace-lease-manager.js";

describe("WorkspaceLeaseManager", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createRunner(
    responses: Array<Partial<Awaited<ReturnType<WorkspaceCommandRunner>>>>,
  ): {
    runner: WorkspaceCommandRunner;
    calls: Array<{ command: string; args: string[]; cwd: string }>;
  } {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runner = vi.fn<WorkspaceCommandRunner>(async (params) => {
      calls.push({ command: params.command, args: params.args, cwd: params.cwd });
      const next = responses.shift() ?? { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      return {
        stdout: next.stdout ?? "",
        stderr: next.stderr ?? "",
        exitCode: next.exitCode ?? 0,
        timedOut: next.timedOut ?? false,
        durationMs: next.durationMs ?? 1,
      };
    });
    return { runner, calls };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    vi.clearAllMocks();
  });

  it("creates a git worktree lease and removes it on release", async () => {
    const projectRoot = makeTempDir("workspace-lease-git-");
    const leaseRoot = makeTempDir("workspace-lease-root-");
    writeFileSync(join(projectRoot, "README.md"), "hello");

    const { runner, calls } = createRunner([
      { stdout: "true", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const manager = new WorkspaceLeaseManager({
      projectRoot,
      leaseRoot,
      commandRunner: runner,
    });

    const lease = await manager.acquireLease({
      label: "review worker",
      workerId: "worker-a",
    });

    expect(lease.kind).toBe("git-worktree");
    expect(lease.path).toContain(leaseRoot);
    expect(lease.path).toContain("worker-a");

    expect(calls[0]?.args).toEqual(["-C", projectRoot, "rev-parse", "--is-inside-work-tree"]);
    expect(calls[1]?.args[0]).toBe("-C");
    expect(calls[1]?.args[2]).toBe("worktree");
    expect(calls[1]?.args).toContain(lease.path);

    await lease.release();
    await lease.release();

    expect(calls[2]?.args).toEqual(["-C", projectRoot, "worktree", "remove", "--force", lease.path]);
  });

  it("falls back to a temp copy when git worktree setup fails", async () => {
    const projectRoot = makeTempDir("workspace-lease-copy-");
    const leaseRoot = makeTempDir("workspace-lease-root-");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "file.txt"), "payload");
    writeFileSync(join(projectRoot, ".git", "config"), "secret");

    const { runner, calls } = createRunner([
      { stdout: "true", exitCode: 0 },
      { stdout: "", stderr: "worktree unavailable", exitCode: 1 },
    ]);

    const manager = new WorkspaceLeaseManager({
      projectRoot,
      leaseRoot,
      commandRunner: runner,
    });

    const lease = await manager.acquireLease({ label: "analysis worker" });

    expect(lease.kind).toBe("temp-copy");
    expect(existsSync(join(lease.path, "src", "file.txt"))).toBe(true);
    expect(readFileSync(join(lease.path, "src", "file.txt"), "utf8")).toBe("payload");
    expect(existsSync(join(lease.path, ".git"))).toBe(false);

    await lease.release();
    await lease.release();

    expect(existsSync(lease.path)).toBe(false);
  });

  it("can be forced to use a temp copy without consulting git", async () => {
    const projectRoot = makeTempDir("workspace-lease-force-");
    const leaseRoot = makeTempDir("workspace-lease-root-");
    writeFileSync(join(projectRoot, "notes.txt"), "forced");

    const { runner, calls } = createRunner([]);
    const manager = new WorkspaceLeaseManager({
      projectRoot,
      leaseRoot,
      commandRunner: runner,
    });

    const lease = await manager.acquireLease({ forceTempCopy: true });

    expect(lease.kind).toBe("temp-copy");
    expect(readFileSync(join(lease.path, "notes.txt"), "utf8")).toBe("forced");
    expect(calls).toHaveLength(0);

    await lease.release();
  });
});
