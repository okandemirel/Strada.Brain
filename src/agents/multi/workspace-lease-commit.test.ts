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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { WorkspaceLeaseManager, DEFAULT_WORKSPACE_COPY_EXCLUDES, isAlreadyGone } from "./workspace-lease-manager.js";

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

  it("holds a .meta whose asset failed BEFORE the write phase — even when the asset's name carries parentheses (#34)", async () => {
    // The pair rule recovered the failed path by stripping " (reason)" off the
    // report string: "Hero (1).png (EACCES…)" became "Hero", and the .meta of
    // a texture that could not be read travelled alone.
    mkdirSync(join(source, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sprites", "Hero (1).png"), "v1", "utf8");
    writeFileSync(join(source, "Assets", "Sprites", "Hero (1).png.meta"), "meta v1", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    const asset = join(lease.path, "Assets", "Sprites", "Hero (1).png");
    writeFileSync(asset, "v2", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero (1).png.meta"), "meta v2", "utf8");
    chmodSync(asset, 0o000); // sameContent() cannot read it → processFile fails
    try {
      const result = await lease.commit();
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Sprites", "Hero (1).png") + " ("))).toBe(true);
      expect(result.conflicts).toContain(join("Assets", "Sprites", "Hero (1).png.meta"));
      expect(result.written).not.toContain(join("Assets", "Sprites", "Hero (1).png.meta"));
      expect(readFileSync(join(source, "Assets", "Sprites", "Hero (1).png.meta"), "utf8")).toBe("meta v1");
    } finally {
      chmodSync(asset, 0o644);
      await lease.release();
    }
  });

  it("holds a .meta whose asset failed DURING the write phase (#34)", async () => {
    // A new asset whose copy fails (locked, permission) used to leave its
    // freshly written .meta in the project: the hold only knew failures decided
    // before the write phase.
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    mkdirSync(join(lease.path, "Assets", "Sprites"), { recursive: true });
    const asset = join(lease.path, "Assets", "Sprites", "Boss.png");
    writeFileSync(asset, "pixels", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Boss.png.meta"), "importer", "utf8");
    chmodSync(asset, 0o000); // a NEW file is never read before the copy → the copy itself fails
    try {
      const result = await lease.commit();
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Sprites", "Boss.png") + " ("))).toBe(true);
      expect(existsSync(join(source, "Assets", "Sprites", "Boss.png.meta"))).toBe(false);
      expect(result.conflicts).toContain(join("Assets", "Sprites", "Boss.png.meta"));
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Sprites", "Boss.png.meta"), "utf8")).toBe("importer");
    } finally {
      chmodSync(asset, 0o644);
      await lease.release();
    }
  });

  it("the editor's per-user state (UserSettings) is engine state: neither copied nor committed by default (2026-09-10)", async () => {
    // Measured 21:43: a play-through inside the lease rewrote UserSettings/*
    // there; the commit read them as files the agent wrote blind and
    // quarantined both against the project's own editor state.
    makeGitRepo();
    mkdirSync(join(source, "UserSettings"), { recursive: true });
    writeFileSync(join(source, "UserSettings", "Search.settings"), "project editor state", "utf8");
    const lease = await new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, additionalExcludes: DEFAULT_WORKSPACE_COPY_EXCLUDES }).acquireLease({ label: "t" });
    mkdirSync(join(lease.path, "UserSettings"), { recursive: true });
    writeFileSync(join(lease.path, "UserSettings", "Search.settings"), "lease editor state", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Real.cs"), "class Real {}", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Real.cs"));
    expect(result.conflicts).toEqual([]);
    expect(result.written).not.toContain(join("UserSettings", "Search.settings"));
    expect(readFileSync(join(source, "UserSettings", "Search.settings"), "utf8")).toBe("project editor state");
    expect(DEFAULT_WORKSPACE_COPY_EXCLUDES).toContain("UserSettings");
  });

  it("withdraws a NEW asset whose .meta could not follow, so the pair never lands half (Codex 2026-09-11 #3)", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    mkdirSync(join(lease.path, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(lease.path, "Assets", "Sprites", "Boss.png"), "pixels", "utf8");
    const meta = join(lease.path, "Assets", "Sprites", "Boss.png.meta");
    writeFileSync(meta, "importer", "utf8");
    chmodSync(meta, 0o000); // only the .meta is unreadable: the asset's copy succeeds first
    try {
      const result = await lease.commit();
      expect(existsSync(join(source, "Assets", "Sprites", "Boss.png"))).toBe(false);
      expect(existsSync(join(source, "Assets", "Sprites", "Boss.png.meta"))).toBe(false);
      expect(result.written).toEqual([]);
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Sprites", "Boss.png") + " (withdrawn"))).toBe(true);
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Sprites", "Boss.png.meta") + " ("))).toBe(true);
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Sprites", "Boss.png"), "utf8")).toBe("pixels");
    } finally {
      chmodSync(meta, 0o644);
      await lease.release();
    }
  });

  it("only an ALREADY-GONE file counts as a withdrawal (Codex 2026-09-11 C#36)", () => {
    expect(isAlreadyGone(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
    expect(isAlreadyGone(Object.assign(new Error("locked"), { code: "EBUSY" }))).toBe(false);
    expect(isAlreadyGone(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(false);
    expect(isAlreadyGone(undefined)).toBe(false);
  });

  it("a commit whose ledger cannot be removed still succeeds (Codex 2026-09-11 #8)", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Fine.cs"), "ok", "utf8");
    chmodSync(leaseRoot, 0o555); // the ledger lives beside the lease dir: unlink now fails
    try {
      const result = await lease.commit();
      expect(result.written).toContain(join("Assets", "Scripts", "Fine.cs"));
      expect(readFileSync(join(source, "Assets", "Scripts", "Fine.cs"), "utf8")).toBe("ok");
    } finally {
      chmodSync(leaseRoot, 0o755);
      await lease.release();
    }
  });

  it("replay never lands a file under an unreadable directory the walk could not copy home (Codex 2026-09-11 #4)", async () => {
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    mkdirSync(join(lease.path, "Assets", "Locked"), { recursive: true });
    writeFileSync(join(lease.path, "Assets", "Locked", "New.cs"), "class New {}", "utf8");
    execSync("git add -A && git -c user.email=a@b -c user.name=t commit -qm 'locked work'", { cwd: lease.path });
    chmodSync(join(lease.path, "Assets", "Locked"), 0o000);
    try {
      const result = await lease.commit();
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Locked") + " (unreadable"))).toBe(true);
      const tree = execSync("git ls-tree -r --name-only HEAD", { cwd: source }).toString();
      expect(tree).not.toContain("Assets/Locked/New.cs");
      expect(existsSync(join(source, "Assets", "Locked", "New.cs"))).toBe(false);
    } finally {
      chmodSync(join(lease.path, "Assets", "Locked"), 0o755);
      await lease.release();
    }
  });

  it("replay never lands an excluded top-level directory the copy-back skipped (Codex 2026-09-11 #7)", async () => {
    makeGitRepo();
    const lease = await new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, additionalExcludes: DEFAULT_WORKSPACE_COPY_EXCLUDES }).acquireLease({ label: "t" });
    mkdirSync(join(lease.path, "UserSettings"), { recursive: true });
    writeFileSync(join(lease.path, "UserSettings", "Search.settings"), "editor state", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Real.cs"), "class Real {}", "utf8");
    execSync("git add -A -f && git -c user.email=a@b -c user.name=t commit -qm 'with editor state'", { cwd: lease.path });
    const result = await lease.commit();
    await lease.release();
    expect(result.written).toContain(join("Assets", "Scripts", "Real.cs"));
    const tree = execSync("git ls-tree -r --name-only HEAD", { cwd: source }).toString();
    expect(tree).toContain("Assets/Scripts/Real.cs");
    expect(tree).not.toContain("UserSettings/Search.settings");
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

describe("seed snapshot resilience", () => {
  it("acquires a lease when one project directory cannot be stat-walked, instead of failing the delegation", async () => {
    // Measured 2026-09-02: snapshotMtimes walked the LIVE project with a bare
    // readdirSync/statSync. One entry that vanished or was locked between the
    // readdir and its stat threw straight out of acquireLease, so the parent
    // saw "[Sub-agent failed: EACCES: permission denied, stat '…']" before the
    // sub-agent ever started. commitLease's walk already guards this case.
    mkdirSync(join(source, "Assets", "Sealed"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sealed", "Secret.cs"), "sealed", "utf8");
    makeGitRepo();
    // Readable but not searchable: readdirSync lists the children, statSync on
    // each of them throws EACCES — the deterministic form of the race.
    chmodSync(join(source, "Assets", "Sealed"), 0o444);
    try {
      const lease = await gitManager().acquireLease({ label: "seed-walk" });
      writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "namespace PixelFlow { }", "utf8");
      const result = await lease.commit();
      await lease.release();
      expect(result.written).toContain(join("Assets", "Scripts", "Board.cs"));
      expect(readFileSync(join(source, "Assets", "Scripts", "Board.cs"), "utf8")).toBe("namespace PixelFlow { }");
    } finally {
      chmodSync(join(source, "Assets", "Sealed"), 0o755);
    }
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

  it("a lease acquired while boot salvage is still running waits for it (Codex review 2026-09-08: acquisition raced salvage)", async () => {
    const orphan = join(leaseRoot, "task-0badf00d-cafe-4bad-8fee-1234567890ab");
    mkdirSync(join(orphan, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(orphan, "Assets", "Scripts", "Orphaned.cs"), "orphan work", "utf8");

    const manager2 = manager();
    // No waitFor: acquire immediately, while the constructor's salvage is in flight.
    const lease = await manager2.acquireLease({ label: "during-salvage", forceTempCopy: true });
    try {
      expect(existsSync(orphan)).toBe(false); // salvage finished before the lease was handed out
      const conflictDir = join(source, ".strada", "lease-conflicts", "orphan-task-0ba");
      expect(readFileSync(join(conflictDir, "Assets", "Scripts", "Orphaned.cs"), "utf8")).toBe("orphan work");
    } finally {
      await lease.release();
    }
  });

  it("with the seed maps the lease persisted, salvage COMMITS the crashed owner's work and quarantines only real conflicts", async () => {
    // Measured 2026-09-08 08:19: a restart mid-task quarantined five real
    // Rocket sprites (186 KB each, drawn over 274-byte placeholders) and three
    // prefab edits; the project kept the placeholders because salvage had no
    // seed maps and could only quarantine. The lease now writes its seed maps
    // at acquire; a crashed owner's salvage commits by the live rules.
    const lease = await manager().acquireLease({ label: "crash", forceTempCopy: true });
    // The seed sidecar sits BESIDE the lease, out of the agent's reach.
    expect(existsSync(`${lease.path}.seed.json`)).toBe(true);
    expect(existsSync(join(lease.path, ".strada-lease-seed.json"))).toBe(false);
    // Agent work in the lease: a new file and an edit of a seeded file.
    writeFileSync(join(lease.path, "Assets", "Scripts", "RocketNose.png"), "REAL ART 186KB", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "agent edit", "utf8");
    utimesSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    // The user evolved another seeded file in the PROJECT during the run.
    writeFileSync(join(source, "Assets", "Scripts", "UserFile.cs"), "user evolved this", "utf8");
    utimesSync(join(source, "Assets", "Scripts", "UserFile.cs"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    writeFileSync(join(lease.path, "Assets", "Scripts", "UserFile.cs"), "agent copy", "utf8");
    utimesSync(join(lease.path, "Assets", "Scripts", "UserFile.cs"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    // The owner died without release(): its pid is gone.
    const ownerFile = join(lease.path, ".strada-lease-owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
    writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 4194303 }), "utf8");
    // The pre-seed claim sidecar names the same dead pid.
    const claimFile = `${lease.path}.claim.json`;
    if (existsSync(claimFile)) {
      const claim = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
      writeFileSync(claimFile, JSON.stringify({ ...claim, pid: 4194303 }), "utf8");
    }
    // Salvage runs once per lease root per process, so the crashed lease is
    // moved to a root this process has never constructed against.
    const leaseRoot2 = mkdtempSync(join(tmpdir(), "lease-root2-"));
    const orphanPath = join(leaseRoot2, lease.path.split("/").pop()!);
    renameSync(lease.path, orphanPath);
    if (existsSync(claimFile)) renameSync(claimFile, `${orphanPath}.claim.json`);
    renameSync(`${lease.path}.seed.json`, `${orphanPath}.seed.json`);

    const manager2 = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot: leaseRoot2, preferGitWorktree: false });
    await vi.waitFor(() => {
      expect(existsSync(orphanPath)).toBe(false);
    }, { timeout: 5000 });

    // Agent work landed in the project.
    expect(readFileSync(join(source, "Assets", "Scripts", "RocketNose.png"), "utf8")).toBe("REAL ART 186KB");
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("agent edit");
    // The user's concurrent edit was kept; the agent's copy went to quarantine.
    expect(readFileSync(join(source, "Assets", "Scripts", "UserFile.cs"), "utf8")).toBe("user evolved this");
    const conflictDir = join(source, ".strada", "lease-conflicts", `orphan-${orphanPath.split("/").pop()!.slice(0, 8)}`);
    expect(readFileSync(join(conflictDir, "Assets", "Scripts", "UserFile.cs"), "utf8")).toBe("agent copy");
    // The seed sidecar never travels into the project and goes with the orphan.
    expect(existsSync(join(source, ".strada-lease-seed.json"))).toBe(false);
    expect(existsSync(`${orphanPath}.seed.json`)).toBe(false);
    await (await manager2.acquireLease({ label: "after", forceTempCopy: true })).release();
    rmSync(leaseRoot2, { recursive: true, force: true });
  });

  it("a lease that still carries its seed INSIDE the workspace (pre-move) is salvaged by the same rules", async () => {
    const lease = await manager().acquireLease({ label: "old-layout", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "OldLayoutWork.cs"), "agent work", "utf8");
    // Move the sidecar to where the pre-a3b0f64e code wrote it.
    renameSync(`${lease.path}.seed.json`, join(lease.path, ".strada-lease-seed.json"));
    const ownerFile = join(lease.path, ".strada-lease-owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
    writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 4194303 }), "utf8");
    const claimFile = `${lease.path}.claim.json`;
    if (existsSync(claimFile)) {
      const claim = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
      writeFileSync(claimFile, JSON.stringify({ ...claim, pid: 4194303 }), "utf8");
    }
    const leaseRoot2 = mkdtempSync(join(tmpdir(), "lease-root4-"));
    const orphanPath = join(leaseRoot2, lease.path.split("/").pop()!);
    renameSync(lease.path, orphanPath);
    if (existsSync(claimFile)) renameSync(claimFile, `${orphanPath}.claim.json`);

    const manager2 = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot: leaseRoot2, preferGitWorktree: false });
    await vi.waitFor(() => { expect(existsSync(orphanPath)).toBe(false); }, { timeout: 5000 });
    expect(readFileSync(join(source, "Assets", "Scripts", "OldLayoutWork.cs"), "utf8")).toBe("agent work");
    expect(existsSync(join(source, ".strada-lease-seed.json"))).toBe(false);
    await (await manager2.acquireLease({ label: "after2", forceTempCopy: true })).release();
    rmSync(leaseRoot2, { recursive: true, force: true });
  });

  it("a lease acquired right after construction is seeded AFTER salvage has written the crashed owner's work", async () => {
    // Review 2026-09-08 (81985efd): salvage ran fire-and-forget while the
    // campaign's boot resubmission seeded its lease — 0 of 2000 salvaged
    // files reached the new lease, and the agent's later edit of one read
    // as a user conflict.
    const lease = await manager().acquireLease({ label: "crash2", forceTempCopy: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(lease.path, "Assets", "Scripts", `Work${i}.cs`), `work ${i}`, "utf8");
    }
    const ownerFile = join(lease.path, ".strada-lease-owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
    writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 4194303 }), "utf8");
    const claimFile = `${lease.path}.claim.json`;
    if (existsSync(claimFile)) {
      const claim = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
      writeFileSync(claimFile, JSON.stringify({ ...claim, pid: 4194303 }), "utf8");
    }
    const leaseRoot2 = mkdtempSync(join(tmpdir(), "lease-root3-"));
    const orphanPath = join(leaseRoot2, lease.path.split("/").pop()!);
    renameSync(lease.path, orphanPath);
    if (existsSync(claimFile)) renameSync(claimFile, `${orphanPath}.claim.json`);
    renameSync(`${lease.path}.seed.json`, `${orphanPath}.seed.json`);

    const manager2 = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot: leaseRoot2, preferGitWorktree: false });
    const fresh = await manager2.acquireLease({ label: "boot", forceTempCopy: true });
    // Every salvaged file is in the new lease's seed.
    for (let i = 0; i < 40; i++) {
      expect(existsSync(join(fresh.path, "Assets", "Scripts", `Work${i}.cs`))).toBe(true);
    }
    // And editing one of them commits as agent work, not as a user conflict.
    writeFileSync(join(fresh.path, "Assets", "Scripts", "Work7.cs"), "edited", "utf8");
    utimesSync(join(fresh.path, "Assets", "Scripts", "Work7.cs"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const result = await fresh.commit();
    expect(result.written).toContain(join("Assets", "Scripts", "Work7.cs"));
    expect(result.conflicts).toHaveLength(0);
    await fresh.release();
    rmSync(leaseRoot2, { recursive: true, force: true });
  });

  /** Resolves once salvage has finished its loop (the trailing prune runs after it). */
  function salvageDone(): { runner: (p: { args: string[] }) => Promise<never>; done: Promise<void> } {
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => { resolve = r; });
    const runner = async (p: { args: string[] }) => {
      if (p.args.includes("prune")) resolve();
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 } as never;
    };
    return { runner, done };
  }

  it("leaves the orphan in place when its work could NOT be quarantined, and reports what it preserved", async () => {
    // Measured 2026-09-02: with the quarantine destination unwritable, commitLease
    // still counted every divergent file as a conflict (the cpSync failure was
    // swallowed), salvage removed the workspace unconditionally, and the log said
    // {conflictsQuarantined: 2} while zero bytes were preserved anywhere.
    const orphan = join(leaseRoot, "task-deadbeef-cafe-4bad-8fee-1234567890ab");
    mkdirSync(join(orphan, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(orphan, "Assets", "Scripts", "HoursOfWork.cs"), "HOURS OF AGENT WORK", "utf8");
    // The quarantine root is a FILE, so mkdirSync under it fails (ENOTDIR) —
    // the deterministic stand-in for a read-only or full .strada.
    mkdirSync(join(source, ".strada"), { recursive: true });
    writeFileSync(join(source, ".strada", "lease-conflicts"), "not a directory", "utf8");

    const { runner, done } = salvageDone();
    new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false, commandRunner: runner as never });
    await done;

    expect(existsSync(join(orphan, "Assets", "Scripts", "HoursOfWork.cs")), "the only copy was deleted").toBe(true);
    expect(readFileSync(join(orphan, "Assets", "Scripts", "HoursOfWork.cs"), "utf8")).toBe("HOURS OF AGENT WORK");
    expect(existsSync(join(source, "Assets", "Scripts", "HoursOfWork.cs"))).toBe(false);
  });

  it("counts only files actually written to quarantine", async () => {
    const orphan = join(leaseRoot, "task-deadbeef-cafe-4bad-8fee-1234567890ab");
    mkdirSync(join(orphan, "Assets"), { recursive: true });
    writeFileSync(join(orphan, "Assets", "A.cs"), "a", "utf8");
    writeFileSync(join(orphan, "Assets", "B.cs"), "b", "utf8");
    const quarantine = join(source, ".strada", "lease-conflicts", "orphan-task-dea");
    // Pre-plant a DIRECTORY where B.cs's quarantine copy must go: cpSync of a
    // file onto a directory fails, so exactly one of two conflicts is preserved.
    mkdirSync(join(quarantine, "Assets", "B.cs"), { recursive: true });

    const { runner, done } = salvageDone();
    new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false, commandRunner: runner as never });
    await done;

    expect(readFileSync(join(quarantine, "Assets", "A.cs"), "utf8")).toBe("a");
    // Partial preservation must not cost the workspace.
    expect(existsSync(join(orphan, "Assets", "B.cs"))).toBe(true);
  });
});

describe("capture retention rides the commit", () => {
  it("retires the oldest Recordings/ entries after the copy-back and reports it", async () => {
    const past = new Date(Date.now() - 48 * 60 * 60_000);
    for (let i = 0; i < 30; i++) {
      const dir = join(source, "Recordings", `old_${String(i).padStart(2, "0")}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "frame_0.png"), "x");
      writeFileSync(join(dir, ".strada-capture"), "lease"); // entries an earlier lease wrote
      utimesSync(dir, past, past);
    }
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    mkdirSync(join(lease.path, "Recordings", "this_run"), { recursive: true });
    writeFileSync(join(lease.path, "Recordings", "this_run", "frame_0.png"), "new");

    const result = await lease.commit();
    await lease.release();

    expect(result.capturesPruned?.removed).toBe(6);
    expect(existsSync(join(source, "Recordings", "this_run", "frame_0.png"))).toBe(true);
    expect(existsSync(join(source, "Recordings", "old_29"))).toBe(false);
  });
});

describe("deletions of the system's own files are applied; the user's stay", () => {
  // Measured 2026-09-07: every attempt deleted Assets/Scripts/PlayfieldBuilder.cs
  // (a duplicate the conformance gate forbids editing) and the InitTestScene
  // scaffolding the hygiene gate demands removed; every commit put them back.
  it("removes a scaffolding scene and a campaign-authored duplicate, keeps a user file", async () => {
    mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity"), "scene", "utf8");
    writeFileSync(join(source, "Assets", "Scripts", "PlayfieldBuilder.cs"), "dup", "utf8");
    writeFileSync(join(source, "Assets", "Scripts", "UserNotes.cs"), "mine", "utf8");
    execSync(
      "git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm 'campaign: Sprint 1 — foundations' " +
        "&& echo more >> Assets/Scripts/UserNotes.cs && git add -A && git -c user.email=a@b -c user.name=t commit -qm 'my own tweak'",
      { cwd: source },
    );
    const lease = await gitManager().acquireLease({ label: "t" });
    rmSync(join(lease.path, "Assets", "InitTestScene4abd18f9.unity"));
    rmSync(join(lease.path, "Assets", "Scripts", "PlayfieldBuilder.cs"));
    rmSync(join(lease.path, "Assets", "Scripts", "UserNotes.cs"));

    const result = await lease.commit();
    await lease.release();

    expect(result.deleted.map((d) => d.split(" — ")[0])).toEqual(
      expect.arrayContaining([join("Assets", "InitTestScene4abd18f9.unity"), join("Assets", "Scripts", "PlayfieldBuilder.cs")]),
    );
    expect(result.deleted.join("\n")).toContain("scaffolding scene");
    expect(result.deleted.join("\n")).toContain("every commit that touched it was the system's own");
    expect(result.removed).toEqual([join("Assets", "Scripts", "UserNotes.cs")]);
    expect(existsSync(join(source, "Assets", "InitTestScene4abd18f9.unity"))).toBe(false);
    expect(existsSync(join(source, "Assets", "Scripts", "PlayfieldBuilder.cs"))).toBe(false);
    expect(existsSync(join(source, "Assets", "Scripts", "UserNotes.cs"))).toBe(true);
  });
});

describe("a loose script with a module twin is the system's own duplicate", () => {
  // Measured 2026-09-07 15:58: Assets/Scripts/PlayfieldBuilder.cs, with a
  // user-worded history, came back on every attempt while the module copy
  // held the real one and the framework-paths refusal said "delete it".
  it("applies the deletion even when the history is not campaign-only", async () => {
    mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
    mkdirSync(join(source, "Assets", "Modules", "PresentationModule", "Scripts"), { recursive: true });
    // Byte-identical: a duplicate by content, whatever its history says.
    writeFileSync(join(source, "Assets", "Scripts", "PlayfieldBuilder.cs"), "module copy", "utf8");
    writeFileSync(join(source, "Assets", "Modules", "PresentationModule", "Scripts", "PlayfieldBuilder.cs"), "module copy", "utf8");
    writeFileSync(join(source, "Assets", "Scripts", "Solo.cs"), "no twin", "utf8");
    execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm 'feat: construct PlayfieldBuilder runtime'", { cwd: source });
    const lease = await gitManager().acquireLease({ label: "t" });
    rmSync(join(lease.path, "Assets", "Scripts", "PlayfieldBuilder.cs"));
    rmSync(join(lease.path, "Assets", "Scripts", "Solo.cs"));

    const result = await lease.commit();
    await lease.release();

    expect(result.deleted.join("\n")).toContain("PlayfieldBuilder.cs — loose duplicate of Assets/Modules/PresentationModule/Scripts/PlayfieldBuilder.cs");
    expect(existsSync(join(source, "Assets", "Scripts", "PlayfieldBuilder.cs"))).toBe(false);
    expect(result.removed).toEqual([join("Assets", "Scripts", "Solo.cs")]); // no twin: stays, reported
  });
});

describe("lease commit replay (measured 2026-09-10: three worker commits dangling in the game repo, no salvage branch)", () => {
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.email=w@x -c user.name=worker ${cmd}`, { cwd, encoding: "utf8" }).trim();

  it("replays the agent's commits onto the project's HEAD, in order, with author, message and content", async () => {
    makeGitRepo();
    writeFileSync(join(source, "Assets", "Scripts", "Wip.cs"), "user wip", "utf8"); // uncommitted → becomes the seed commit
    const before = git(source, "rev-parse HEAD");
    const lease = await gitManager().acquireLease({ label: "t" });
    expect(lease.kind).toBe("git-worktree");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "v1", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board v1"');
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "v2", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "edited", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board v2"');

    const result = await lease.commit();
    await lease.release();

    expect(result.commitsReplayed).toEqual({ replayed: 2, skipped: 0, shas: expect.any(Array) });
    expect(git(source, "log --format=%s -n 3")).toBe("feat: board v2\nfeat: board v1\ninit");
    expect(git(source, "log --format=%an -n 1")).toBe("worker");
    expect(git(source, "log --format=%B -n 1")).toContain("Strada-Lease-Commit:");
    expect(git(source, `show ${before}..HEAD~1 --format= --name-only`)).toBe("Assets/Scripts/Board.cs");
    expect(git(source, "show HEAD~1:Assets/Scripts/Board.cs")).toBe("v1");
    expect(git(source, "show HEAD:Assets/Scripts/Board.cs")).toBe("v2");
    expect(readFileSync(join(source, "Assets", "Scripts", "Board.cs"), "utf8")).toBe("v2");
    // The replayed paths read as committed; the user's own WIP is still theirs, uncommitted.
    expect(git(source, "status --porcelain -- Assets")).toBe("?? Assets/Scripts/Wip.cs");
    // Nothing is stranded, so no salvage branch is needed.
    expect(git(source, "branch --list 'lease-salvage/*'")).toBe("");
  });

  it("does not commit a conflicted path on the user's behalf, and salvages the stranded commit on a branch", async () => {
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "agent", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: existing"');
    const stranded = git(lease.path, "rev-parse HEAD");
    // The user edits the same file while the agent works.
    const target = join(source, "Assets", "Scripts", "Existing.cs");
    writeFileSync(target, "user", "utf8");
    utimesSync(target, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(result.commitsReplayed).toEqual({ replayed: 0, skipped: 1, shas: [] });
    expect(git(source, "log --format=%s -n 2")).toBe("init");
    expect(readFileSync(target, "utf8")).toBe("user");
    expect(git(source, "branch --list 'lease-salvage/*'")).toContain("lease-salvage/");
    expect(git(source, `branch --contains ${stranded} --list 'lease-salvage/*'`)).toContain("lease-salvage/");
  });

  it("leaves the user's staged changes staged and uncommitted", async () => {
    makeGitRepo();
    writeFileSync(join(source, "Assets", "Scripts", "Staged.cs"), "staged by user", "utf8");
    git(source, "add Assets/Scripts/Staged.cs");
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "v1", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board"');

    await lease.commit();
    await lease.release();

    expect(git(source, "log --format=%s -n 1")).toBe("feat: board");
    expect(git(source, "show HEAD --format= --name-only")).toBe("Assets/Scripts/Board.cs");
    expect(git(source, "status --porcelain -- Assets")).toBe("A  Assets/Scripts/Staged.cs");
  });

  it("makes no project commit when the agent committed nothing", async () => {
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "v1", "utf8"); // written, not committed
    const result = await lease.commit();
    await lease.release();
    expect(result.commitsReplayed).toBeUndefined();
    expect(git(source, "log --format=%s -n 2")).toBe("init");
    expect(git(source, "branch --list 'lease-salvage/*'")).toBe("");
  });
});
