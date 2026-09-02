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

    // Located rather than indexed: seeding a worktree also reads submodules and
    // the project's uncommitted state, and those calls must be free to move
    // without this assertion breaking for the wrong reason.
    const removeCall = calls.find((c) => c.args.includes("worktree") && c.args.includes("remove"));
    expect(removeCall?.args).toEqual([
      "-C",
      projectRoot,
      "worktree",
      "remove",
      "--force",
      lease.path,
    ]);
  });

  // acquire/commit used to be a full synchronous cpSync plus three synchronous
  // stat/compare walks. On a Unity tree that is minutes with the event loop
  // blocked: no timer, no socket read, no stream heartbeat runs, so a provider
  // stream that was fine got attributed a stall and the run was blamed on
  // "provider slowness" (audited 2026-09-02). Seeding must yield.
  it("yields to the event loop while seeding a large temp copy", async () => {
    const projectRoot = makeTempDir("workspace-lease-yield-");
    const leaseRoot = makeTempDir("workspace-lease-root-");
    // A tree big enough that the copy is not a single filesystem call.
    for (let d = 0; d < 12; d++) {
      const dir = join(projectRoot, `dir-${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 40; f++) {
        writeFileSync(join(dir, `file-${f}.txt`), `payload-${d}-${f}`.repeat(64));
      }
    }

    const { runner } = createRunner([]);
    const manager = new WorkspaceLeaseManager({ projectRoot, leaseRoot, commandRunner: runner });

    // A timer armed for the next tick. Node runs timers only between macrotasks,
    // so it can only fire while the seed is in flight if the seed actually awaits
    // real I/O — a synchronous cpSync/stat walk leaves it pending until the whole
    // lease is built.
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);

    const lease = await manager.acquireLease({ label: "big worker", forceTempCopy: true });
    clearTimeout(timer);

    expect(timerFired, "the event loop was blocked for the whole seed").toBe(true);
    // Identical semantics: the tree still arrived.
    expect(readFileSync(join(lease.path, "dir-5", "file-7.txt"), "utf8")).toBe(
      "payload-5-7".repeat(64),
    );
    await lease.release();
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

  it("can derive a temp-copy lease from an existing workspace root", async () => {
    const projectRoot = makeTempDir("workspace-lease-derived-project-");
    const leaseRoot = makeTempDir("workspace-lease-root-");
    const parentWorkspaceRoot = mkdtempSync(join(leaseRoot, "workspace-lease-derived-parent-"));
    tempDirs.push(parentWorkspaceRoot);
    writeFileSync(join(projectRoot, "base.txt"), "project");
    writeFileSync(join(parentWorkspaceRoot, "base.txt"), "parent");
    writeFileSync(join(parentWorkspaceRoot, "child.txt"), "derived");
    mkdirSync(join(parentWorkspaceRoot, "dist"), { recursive: true });
    mkdirSync(join(parentWorkspaceRoot, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(parentWorkspaceRoot, "dist", "bundle.js"), "compiled");
    writeFileSync(join(parentWorkspaceRoot, "node_modules", "left-pad", "index.js"), "module.exports = 0;");

    const { runner, calls } = createRunner([]);
    const manager = new WorkspaceLeaseManager({
      projectRoot,
      leaseRoot,
      commandRunner: runner,
    });

    const lease = await manager.acquireLease({
      workerId: "worker-derived",
      sourceRoot: parentWorkspaceRoot,
    });

    expect(lease.kind).toBe("temp-copy");
    expect(lease.sourceRoot).toBe(parentWorkspaceRoot);
    expect(readFileSync(join(lease.path, "base.txt"), "utf8")).toBe("parent");
    expect(readFileSync(join(lease.path, "child.txt"), "utf8")).toBe("derived");
    expect(readFileSync(join(lease.path, "dist", "bundle.js"), "utf8")).toBe("compiled");
    expect(existsSync(join(lease.path, "node_modules"))).toBe(false);
    expect(calls).toHaveLength(0);

    await lease.release();
  });

  it("rejects source roots outside the project and lease roots", async () => {
    const projectRoot = makeTempDir("workspace-lease-contained-project-");
    const leaseRoot = makeTempDir("workspace-lease-contained-root-");
    const unrelatedRoot = makeTempDir("workspace-lease-unrelated-");
    writeFileSync(join(projectRoot, "base.txt"), "project");
    writeFileSync(join(unrelatedRoot, "secret.txt"), "outside");

    const manager = new WorkspaceLeaseManager({
      projectRoot,
      leaseRoot,
      commandRunner: createRunner([]).runner,
    });

    await expect(manager.acquireLease({
      sourceRoot: unrelatedRoot,
      workerId: "worker-outside",
    })).rejects.toThrow("Workspace source root must be inside the project root or lease root");
  });

  it("a lease being seeded is owned from the first byte — a second process must not salvage it", async () => {
    // Measured 2026-09-02: acquireLease created and populated the workspace
    // (git worktree add + submodules + uncommitted state, up to minutes) and
    // wrote the owner sidecar only afterwards. A second install/daemon that
    // constructed a manager against the machine-global lease root in that
    // window read the sidecar-less dir as an orphan, quarantine-committed the
    // half-seeded tree and rm -rf'd the workspace the first process was still
    // writing into.
    const projectRoot = makeTempDir("workspace-lease-claim-project-");
    const leaseRoot = makeTempDir("workspace-lease-claim-root-");
    writeFileSync(join(projectRoot, "README.md"), "hello");

    // Process A's runner: `worktree add` creates the directory, then BLOCKS
    // until the test releases it — the seeding window, made deterministic.
    let releaseSeeding: () => void = () => {};
    const seeding = new Promise<void>((r) => { releaseSeeding = r; });
    let seededPath = "";
    const runnerA: WorkspaceCommandRunner = async (params) => {
      if (params.args.includes("rev-parse")) {
        return { stdout: "true", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      if (params.args.includes("worktree") && params.args.includes("add")) {
        seededPath = params.args[params.args.length - 2]!;
        mkdirSync(seededPath, { recursive: true });
        writeFileSync(join(seededPath, "README.md"), "hello");
        await seeding;
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    };
    const managerA = new WorkspaceLeaseManager({ projectRoot, leaseRoot, commandRunner: runnerA });
    const acquiring = managerA.acquireLease({ workerId: "worker-a" });
    await vi.waitFor(() => expect(seededPath).not.toBe(""));
    expect(existsSync(seededPath)).toBe(true);

    // Process B: a FRESH module instance (its own per-process salvaged-roots
    // set) constructing against the same lease root mid-seed.
    let pruned: () => void = () => {};
    const salvageDone = new Promise<void>((r) => { pruned = r; });
    const runnerB: WorkspaceCommandRunner = async (params) => {
      if (params.args.includes("prune")) pruned();
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    };
    vi.resetModules();
    const fresh = await import("./workspace-lease-manager.js");
    new fresh.WorkspaceLeaseManager({ projectRoot, leaseRoot, commandRunner: runnerB });
    // Give B's fire-and-forget salvage a chance to run; with nothing to salvage
    // it never prunes, so bound the wait instead of awaiting it.
    await Promise.race([salvageDone, new Promise((r) => setTimeout(r, 300))]);

    expect(existsSync(seededPath), "process B salvaged and deleted A's live, half-seeded lease").toBe(true);
    expect(existsSync(join(projectRoot, ".strada", "lease-conflicts"))).toBe(false);

    releaseSeeding();
    const lease = await acquiring;
    expect(lease.path).toBe(seededPath);
    expect(existsSync(join(lease.path, ".strada-lease-owner.json"))).toBe(true);
    // The pre-seed claim is retired once the in-dir sidecar exists.
    expect(existsSync(`${lease.path}.claim.json`)).toBe(false);
    await lease.release();
  });
});
