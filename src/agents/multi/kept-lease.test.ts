/**
 * A lease kept for salvage drops the engine caches a lease never publishes,
 * and nothing else. Seen 2026-11-18: a live run's kept leases each still held
 * a full Unity Library/ import cache.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceLeaseManager } from "../../core/bootstrap-stages/workspace-lease-setup.js";
import { shedKeptLease } from "./kept-lease.js";
import { workspaceCopyExcludes } from "./lease-copy-excludes.js";

describe("a lease kept for salvage", () => {
  let root: string;
  let lease: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kept-lease-"));
    lease = join(root, "task-1");
    mkdirSync(join(lease, "Library", "Artifacts"), { recursive: true });
    writeFileSync(join(lease, "Library", "Artifacts", "blob"), "cache");
    mkdirSync(join(lease, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(lease, "Assets", "Scripts", "Work.cs"), "class Work {}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("drops the engine cache and keeps the unpublished work", () => {
    const shed = shedKeptLease({ path: lease, leaseRoot: root }, ["Library", "Temp"]);

    expect(shed.removed).toEqual(["Library"]);
    expect(existsSync(join(lease, "Library"))).toBe(false);
    expect(existsSync(join(lease, "Assets", "Scripts", "Work.cs"))).toBe(true);
  });

  it("drops what the default copy-exclude list names when none is given", () => {
    expect(shedKeptLease({ path: lease, leaseRoot: root }).removed).toContain("Library");
  });

  it("drops nothing while a Unity editor may hold the lease open", () => {
    mkdirSync(join(lease, "Temp"));
    writeFileSync(join(lease, "Temp", "UnityLockfile"), "");

    const shed = shedKeptLease({ path: lease, leaseRoot: root }, ["Library", "Temp"]);

    expect(shed.removed).toEqual([]);
    expect(shed.skipped).toContain("UnityLockfile");
    expect(existsSync(join(lease, "Library", "Artifacts", "blob"))).toBe(true);
  });

  it("never follows a symlink out of the lease", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "not the lease's");
    rmSync(join(lease, "Library"), { recursive: true });
    symlinkSync(outside, join(lease, "Library"));

    expect(shedKeptLease({ path: lease, leaseRoot: root }, ["Library"]).removed).toEqual([]);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("ignores a name that is not a single path segment", () => {
    expect(shedKeptLease({ path: lease, leaseRoot: root }, ["../task-1/Assets", "..", "Assets/Scripts"]).removed).toEqual([]);
    expect(existsSync(join(lease, "Assets", "Scripts", "Work.cs"))).toBe(true);
  });

  it("touches nothing outside its lease root", () => {
    const shed = shedKeptLease({ path: lease, leaseRoot: join(root, "elsewhere") }, ["Library"]);

    expect(shed.removed).toEqual([]);
    expect(existsSync(join(lease, "Library"))).toBe(true);
  });
});

/**
 * Dropping the caches must change nothing a later commit or salvage delivers.
 * The commit walk and the lease seed skip the copy-exclude names, so a shed
 * name never reads as a file the agent deleted, even when the project tracks it.
 */
describe("a kept lease's commit after its caches were dropped", () => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...cleanEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it.each([["a temp copy", false], ["a git worktree", true]] as const)(
    "still publishes the work, and reports no deletion, in %s",
    async (_kind, gitWorktree) => {
      const folder = mkdtempSync(join(tmpdir(), "kept-lease-commit-"));
      folders.push(folder);
      const project = join(folder, "project");
      mkdirSync(join(project, "Assets"), { recursive: true });
      writeFileSync(join(project, "Assets", "A.cs"), "class A {}");
      // A project that TRACKS an excluded name: the case where a seed entry
      // under it could read as an agent deletion.
      mkdirSync(join(project, "UserSettings"), { recursive: true });
      writeFileSync(join(project, "UserSettings", "prefs.asset"), "prefs");
      if (gitWorktree) {
        git(project, "init", "-q");
        git(project, "add", "-A");
        git(project, "commit", "-qm", "initial");
      }
      const env = { WORKSPACE_LEASE_ROOT: join(folder, "leases") };
      const manager = createWorkspaceLeaseManager(project, env);
      const lease = await manager.acquireLease({ label: "kept", preferGitWorktree: gitWorktree });
      try {
        // The git row must really be a worktree, not a temp-copy fallback.
        expect(existsSync(join(lease.path, ".git"))).toBe(gitWorktree);
        // What the engine leaves in a lease, then the agent's work.
        mkdirSync(join(lease.path, "Library"), { recursive: true });
        writeFileSync(join(lease.path, "Library", "cache.bin"), "cache");
        mkdirSync(join(lease.path, "UserSettings"), { recursive: true });
        writeFileSync(join(lease.path, "UserSettings", "prefs.asset"), "prefs");
        writeFileSync(join(lease.path, "Assets", "New.cs"), "class New {}");

        const shed = shedKeptLease(lease, workspaceCopyExcludes(env));
        expect(shed.removed).toEqual(expect.arrayContaining(["Library", "UserSettings"]));

        const result = await lease.commit();

        expect(result.written).toContain(join("Assets", "New.cs"));
        expect([...result.removed, ...(result.deleted ?? [])]).toEqual([]);
        expect(readFileSync(join(project, "UserSettings", "prefs.asset"), "utf8")).toBe("prefs");
        expect(readFileSync(join(project, "Assets", "New.cs"), "utf8")).toBe("class New {}");
      } finally {
        await lease.release();
        await manager.dispose();
      }
    },
  );
});
