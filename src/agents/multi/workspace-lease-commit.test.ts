/**
 * Workspace lease write-back.
 *
 * A lease used to be write-only: createTempCopy() seeded it, the agent wrote
 * into it, and release() deleted the directory. Measured on a live run — a task
 * that asked for one C# file called file_write successfully against
 * `<tmp>/strada-workspaces/task-<id>/Assets/Scripts/Board.cs`, read it back,
 * ran quality checks on it, reported success, and the user's project never
 * received a byte. The agent was doing the work and throwing it away, which
 * presented to the user as "the agent produces nothing".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

let source: string;
let leaseRoot: string;

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "lease-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "lease-root-"));
  mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(leaseRoot, { recursive: true, force: true });
});

function manager() {
  return new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
}

/** The DEFAULT lease kind on a git project — neither production call site sets
 *  forceTempCopy, so this is what a real task actually gets. */
function gitManager() {
  return new WorkspaceLeaseManager({
    projectRoot: source,
    leaseRoot,
    additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
  });
}

function makeGitRepo(): void {
  execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm init", {
    cwd: source,
  });
}

describe("workspace lease commit", () => {
  it("copies a file the agent created back into the project", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "namespace PixelFlow { }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Board.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Board.cs"), "utf8")).toBe(
      "namespace PixelFlow { }",
    );
  });

  it("copies a modification back", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "edited", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("edited");
  });

  it("reports untouched files as neither written nor conflicting", async () => {
    // cpSync preserves timestamps, so an mtime comparison would call every
    // seeded file modified. Content is what decides.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    const result = await lease.commit();
    await lease.release();

    expect(result.written).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("refuses to overwrite a file the user changed while the agent worked", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "agent version", "utf8");

    // The user edits the same file after the lease was taken.
    const target = join(source, "Assets", "Scripts", "Existing.cs");
    writeFileSync(target, "user version", "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(result.written).not.toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(target, "utf8")).toBe("user version");
  });

  it("never deletes from the project", async () => {
    // Deleting inside the lease must not propagate: a conservative write-back
    // can lose nothing, and an agent that removes a file it misread would
    // otherwise destroy the user's work.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    rmSync(join(lease.path, "Assets", "Scripts", "Existing.cs"));

    await lease.commit();
    await lease.release();

    expect(existsSync(join(source, "Assets", "Scripts", "Existing.cs"))).toBe(true);
  });

  it("leaves a user's uncommitted edit alone on the default git-worktree lease", async () => {
    // The bug this exists to prevent, and the reason the first version of these
    // tests was worthless: they all forced temp-copy, and the DEFAULT kind on a
    // git project is a worktree — seeded from HEAD, not the working tree. Every
    // file the user had modified-but-uncommitted therefore differed from the
    // lease, read as agent work, and was overwritten with its committed
    // contents. Measured before the fix: an agent that created only an
    // unrelated Board.cs reported written:[Board.cs, Player.cs] and reverted
    // Player.cs.
    makeGitRepo();
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "user uncommitted work", "utf8");

    const lease = await gitManager().acquireLease({ label: "task-42", workerId: "42" });
    expect(lease.kind).toBe("git-worktree");
    // The agent touches only an unrelated file.
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "class Board {}", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe(
      "user uncommitted work",
    );
  });

  it("commits an agent edit on a git-worktree lease", async () => {
    // The other half: skipping untouched files must not skip real work.
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "task-43", workerId: "43" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "agent edit", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("agent edit");
  });

  it("does not push excluded build directories into the project", async () => {
    // commitLease walks the LEASE, and a lease path is never the project root,
    // so the shared filter took its derived-copy branch and dropped the
    // configured excludes — Library/Temp/Logs/Builds/obj could travel back into
    // a Unity project that deliberately keeps them out.
    const lease = await gitManager().acquireLease({ label: "t", forceTempCopy: true });
    mkdirSync(join(lease.path, "Library"), { recursive: true });
    writeFileSync(join(lease.path, "Library", "ArtifactDB"), "derived", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).not.toContain(join("Library", "ArtifactDB"));
    expect(existsSync(join(source, "Library", "ArtifactDB"))).toBe(false);
  });

  it("treats a file the user created during the run as a conflict", async () => {
    // The conflict gate used to be guarded by `seeded !== undefined`, so a path
    // absent at seed time skipped the check entirely and was overwritten with
    // force. A user who creates a file while the agent works would lose it to
    // whatever the agent happened to write at the same path.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "New.cs"), "agent version", "utf8");
    writeFileSync(join(source, "Assets", "Scripts", "New.cs"), "user version", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toContain(join("Assets", "Scripts", "New.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "New.cs"), "utf8")).toBe("user version");
  });

  it("creates missing directories in the project", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    mkdirSync(join(lease.path, "Assets", "Editor"), { recursive: true });
    writeFileSync(join(lease.path, "Assets", "Editor", "Tool.cs"), "class Tool {}", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Editor", "Tool.cs"));
    expect(existsSync(join(source, "Assets", "Editor", "Tool.cs"))).toBe(true);
  });

  it("keeps committing the remaining files when one file cannot be written", async () => {
    // The walk used to have no per-file guard: one throw (an editor-locked
    // asset, a target replaced by a directory mid-run) aborted the whole
    // commit, and every file after it was silently lost with the workspace.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Good.cs"), "good", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Blocked.cs"), "blocked", "utf8");
    // The project side turned Blocked.cs's path into a DIRECTORY while the
    // agent ran — cpSync(file → existing dir) throws, deterministically.
    mkdirSync(join(source, "Assets", "Scripts", "Blocked.cs"), { recursive: true });

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Good.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Good.cs"), "utf8")).toBe("good");
    expect(result.failed.some((f) => f.startsWith(join("Assets", "Scripts", "Blocked.cs")))).toBe(
      true,
    );
  });

  it("quarantines the agent's version of conflicted files instead of destroying it", async () => {
    // A conflict means the user's copy wins — but the agent's version used to
    // be deleted together with the released workspace. Measured in production:
    // an editor touching one .meta reclassified real agent work as conflict,
    // and hours of it vanished. The agent side must survive somewhere diffable.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "agent version", "utf8");

    const target = join(source, "Assets", "Scripts", "Existing.cs");
    writeFileSync(target, "user version", "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(result.conflictsQuarantinedUnder).toBeTruthy();
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, join("Assets", "Scripts", "Existing.cs")), "utf8")).toBe(
      "agent version",
    );
    expect(readFileSync(target, "utf8")).toBe("user version");
  });

  it("leaves no quarantine behind when there are no conflicts", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "fresh", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([]);
    expect(result.conflictsQuarantinedUnder).toBeNull();
    expect(existsSync(join(source, ".strada", "lease-conflicts"))).toBe(false);
  });
});

describe("orphaned lease salvage at construction", () => {
  it("quarantines a crashed predecessor's work without writing into the project, removes the orphan", async () => {
    // A SIGKILLed process skips release() entirely — measured in production,
    // full project copies with hours of agent work were stranded under the
    // lease root until an external script salvaged them by hand.
    //
    // Salvage runs with NO seed maps, so it cannot tell agent work from files
    // the user deliberately deleted after the crash. Restoring "missing"
    // files resurrected deletions; the contract is now quarantine-only.
    const orphan = join(leaseRoot, "task-deadbeef-cafe-4bad-8fee-1234567890ab");
    mkdirSync(join(orphan, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(orphan, "Assets", "Scripts", "NewWork.cs"), "new agent work", "utf8");
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "user evolved this", "utf8");
    writeFileSync(join(orphan, "Assets", "Scripts", "Existing.cs"), "stale agent copy", "utf8");

    // Construction itself must trigger the salvage (fire-and-forget).
    const manager2 = manager();
    await vi.waitFor(() => {
      expect(existsSync(orphan)).toBe(false);
    }, { timeout: 5000 });

    // Nothing was written into the project: the missing file was NOT restored,
    // the user's evolved file was untouched.
    expect(existsSync(join(source, "Assets", "Scripts", "NewWork.cs"))).toBe(false);
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("user evolved this");
    // Both non-identical files were preserved in quarantine for review.
    const conflictDir = join(source, ".strada", "lease-conflicts", `orphan-${"task-deadbeef-cafe-4bad-8fee-1234567890ab".slice(0, 8)}`);
    expect(readFileSync(join(conflictDir, "Assets", "Scripts", "NewWork.cs"), "utf8")).toBe("new agent work");
    expect(readFileSync(join(conflictDir, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("stale agent copy");

    // The salvaging manager must remain fully usable afterwards.
    const lease = await manager2.acquireLease({ label: "post-salvage", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "AfterSalvage.cs"), "ok", "utf8");
    const result = await lease.commit();
    await lease.release();
    expect(result.written).toContain(join("Assets", "Scripts", "AfterSalvage.cs"));
  });
});
