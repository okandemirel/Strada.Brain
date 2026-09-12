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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, utimesSync, chmodSync, renameSync, promises as fsp } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runProcess } from "../../utils/process-runner.js";
import { WorkspaceLeaseManager, DEFAULT_WORKSPACE_COPY_EXCLUDES, isAlreadyGone, reconcileSeedBaseline, stampUnchanged, existedAtSeed, readLeaseSeed, writeLeaseSeed, isDerivedBuildOutput } from "./workspace-lease-manager.js";
import type { SeedStamp } from "./workspace-lease-manager.js";

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

  it("a pair is not published when the project's copy could not be backed up (Codex 2026-09-12 P#17)", async () => {
    // The backup failed and the replacement went in anyway: when the .meta
    // then could not follow, there was nothing to put the pair back from.
    mkdirSync(join(source, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png"), "old pixels", "utf8");
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "old importer", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png"), "new pixels", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png.meta"), "new importer", "utf8");

    const realCopy = fsp.copyFile.bind(fsp);
    const spy = vi.spyOn(fsp, "copyFile").mockImplementation(async (from: never, to: never, mode?: never) => {
      if (String(to).endsWith(".prev")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return realCopy(from, to, mode);
    });
    try {
      const result = await lease.commit();

      // The project keeps its own pair, whole.
      expect(readFileSync(join(source, "Assets", "Sprites", "Hero.png"), "utf8")).toBe("old pixels");
      expect(readFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "utf8")).toBe("old importer");
      expect(result.written).toEqual([]);
      expect(result.failed.some((f) => f.startsWith(join("Assets", "Sprites", "Hero.png") + " ("))).toBe(true);
      // …and the worker's version is preserved, not dropped.
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Sprites", "Hero.png"), "utf8")).toBe("new pixels");
    } finally {
      spy.mockRestore();
      await lease.release();
    }
  });

  it("a rollback that could not be applied keeps the project's previous version (Codex 2026-09-12 P#17)", async () => {
    mkdirSync(join(source, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png"), "old pixels", "utf8");
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "old importer", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png"), "new pixels", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png.meta"), "new importer", "utf8");

    // The .meta cannot be written, and putting the asset back fails too — the
    // staging directory used to be deleted with the only surviving copy of
    // the project's own version inside it.
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from: never, to: never) => {
      if (String(to).endsWith("Hero.png.meta") || String(from).endsWith(".restore")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realRename(from, to);
    });
    try {
      const result = await lease.commit();

      const inconsistent = result.failed.find((f) => f.startsWith(join("Assets", "Sprites", "Hero.png") + " ("));
      expect(inconsistent).toContain("previous version is kept at");
      const kept = join(result.conflictsQuarantinedUnder!, "previous", "Assets", "Sprites", "Hero.png");
      expect(readFileSync(kept, "utf8")).toBe("old pixels");
      // The staging directory still goes; the recovery copy is elsewhere.
      expect(existsSync(join(source, ".strada", "lease-staging"))).toBe(false);
    } finally {
      spy.mockRestore();
      await lease.release();
    }
  });

  it("keeps the staged copy when a rollback can be neither applied nor preserved (Codex 2026-09-12 Q#6)", async () => {
    mkdirSync(join(source, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png"), "old pixels", "utf8");
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "old importer", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png"), "new pixels", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png.meta"), "new importer", "utf8");

    // The .meta cannot be written, the rollback cannot be applied, and the
    // recovery copy cannot be written either — and the staging directory (the
    // last place the project's own version exists) used to be deleted anyway.
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (from: never, to: never) => {
      if (String(to).endsWith("Hero.png.meta") || String(from).endsWith(".restore")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realRename(from, to);
    });
    const realCopy = fsp.copyFile.bind(fsp);
    const copySpy = vi.spyOn(fsp, "copyFile").mockImplementation(async (from: never, to: never, mode?: never) => {
      if (String(to).includes(join("lease-conflicts")) && String(to).includes("previous")) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realCopy(from, to, mode);
    });
    try {
      const result = await lease.commit();

      const inconsistent = result.failed.find((f) => f.startsWith(join("Assets", "Sprites", "Hero.png") + " ("));
      expect(inconsistent).toContain("staged copy under");
      const staging = join(source, ".strada", "lease-staging");
      expect(existsSync(staging)).toBe(true);
      const kept = readdirSync(staging).flatMap((d) => readdirSync(join(staging, d)).map((f) => readFileSync(join(staging, d, f), "utf8")));
      expect(kept).toContain("old pixels");
    } finally {
      renameSpy.mockRestore();
      copySpy.mockRestore();
      await lease.release();
    }
  });

  it("rolls an OVERWRITTEN asset back when its .meta cannot follow (Codex 2026-09-11 N#6)", async () => {
    // The asset exists in the project. Its new version lands, the .meta write
    // then fails, and the project used to be left with NEW ART beside an OLD
    // IMPORTER and nothing to put back.
    mkdirSync(join(source, "Assets", "Sprites"), { recursive: true });
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png"), "old pixels", "utf8");
    writeFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "old importer", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png"), "new pixels", "utf8");
    writeFileSync(join(lease.path, "Assets", "Sprites", "Hero.png.meta"), "new importer", "utf8");

    // The .meta's own write is what fails — after the asset has landed.
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from: never, to: never) => {
      if (String(to).endsWith("Hero.png.meta")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return realRename(from, to);
    });
    try {
      const result = await lease.commit();

      // The pair is whole, and it is the project's own version.
      expect(readFileSync(join(source, "Assets", "Sprites", "Hero.png"), "utf8")).toBe("old pixels");
      expect(readFileSync(join(source, "Assets", "Sprites", "Hero.png.meta"), "utf8")).toBe("old importer");
      expect(result.failed.some((f) => f.includes("rolled back"))).toBe(true);
      // …and the worker's version is preserved rather than lost.
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Sprites", "Hero.png"), "utf8")).toBe("new pixels");
      // No staging residue in the project.
      expect(existsSync(join(source, ".strada", "lease-staging"))).toBe(false);
    } finally {
      spy.mockRestore();
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
  it("does not delete a file someone CHANGED while the worker ran, nor split its pair (Codex 2026-09-11 N#7)", async () => {
    // The deletion rule asks whose file it is; it never asked whether the file
    // is still the one the worker decided about. A scene rewritten in the
    // project while the worker ran was deleted with its newer bytes.
    mkdirSync(join(source, "Assets"), { recursive: true });
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity"), "scene", "utf8");
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity.meta"), "meta", "utf8");
    execSync(
      "git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm 'campaign: Sprint 1 — foundations'",
      { cwd: source },
    );
    const lease = await gitManager().acquireLease({ label: "t" });
    rmSync(join(lease.path, "Assets", "InitTestScene4abd18f9.unity"));
    rmSync(join(lease.path, "Assets", "InitTestScene4abd18f9.unity.meta"));
    // New scene work lands in the project while the worker runs.
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity"), "NEW SCENE WORK, much longer than before", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(existsSync(join(source, "Assets", "InitTestScene4abd18f9.unity"))).toBe(true);
    expect(readFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity"), "utf8")).toContain("NEW SCENE WORK");
    // …and its .meta is not left behind without it.
    expect(existsSync(join(source, "Assets", "InitTestScene4abd18f9.unity.meta"))).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.removed).toEqual(
      expect.arrayContaining([join("Assets", "InitTestScene4abd18f9.unity"), join("Assets", "InitTestScene4abd18f9.unity.meta")]),
    );
  });

  it("deletes an asset and its .meta TOGETHER (Codex 2026-09-12 P#5)", async () => {
    // Deciding member by member deleted the asset and then declined its .meta,
    // because the .meta's "is the partner unchanged?" check stat'ed a file the
    // same loop had just removed. The project kept an orphaned .meta.
    mkdirSync(join(source, "Assets"), { recursive: true });
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity"), "scene", "utf8");
    writeFileSync(join(source, "Assets", "InitTestScene4abd18f9.unity.meta"), "meta", "utf8");
    execSync(
      "git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm 'campaign: Sprint 1 — foundations'",
      { cwd: source },
    );
    const lease = await gitManager().acquireLease({ label: "t" });
    rmSync(join(lease.path, "Assets", "InitTestScene4abd18f9.unity"));
    rmSync(join(lease.path, "Assets", "InitTestScene4abd18f9.unity.meta"));

    const result = await lease.commit();
    await lease.release();

    expect(existsSync(join(source, "Assets", "InitTestScene4abd18f9.unity"))).toBe(false);
    expect(existsSync(join(source, "Assets", "InitTestScene4abd18f9.unity.meta"))).toBe(false);
    expect(result.deleted.map((d) => d.split(" — ")[0]).sort()).toEqual(
      [join("Assets", "InitTestScene4abd18f9.unity"), join("Assets", "InitTestScene4abd18f9.unity.meta")].sort(),
    );
    expect(result.removed).toEqual([]);
  });

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

  it("does not replay a version the worker took back (Codex 2026-09-11 N#8)", async () => {
    // The worker committed version B, then restored A without committing.
    // Copy-back writes A (or nothing, when the project already has it) and the
    // replay recorded B — a project commit describing a deliverable the
    // working tree does not have.
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    const inLease = join(lease.path, "Assets", "Scripts", "Board.cs");
    writeFileSync(inLease, "version B", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board B"');
    writeFileSync(inLease, "version A", "utf8"); // taken back, never committed

    const result = await lease.commit();
    await lease.release();

    // Whatever the commit says, it may not claim B.
    const headTree = git(source, "show --name-only --format= HEAD");
    if (headTree.includes("Board.cs")) {
      expect(git(source, "show HEAD:Assets/Scripts/Board.cs")).toBe("version A");
    }
    expect(readFileSync(join(source, "Assets", "Scripts", "Board.cs"), "utf8")).toBe("version A");
    expect(result.commitsReplayed?.replayed ?? 0).toBeLessThanOrEqual(1);
  });

  it("a series that ends at withdrawn content is held WHOLE, not just at its last commit (Codex 2026-09-12 P#10)", async () => {
    // seed A → commit B → commit C → restore A without committing. Holding
    // only the last commit replayed B, so the project's history ended at a
    // version the lease no longer had.
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    const inLease = join(lease.path, "Assets", "Scripts", "Existing.cs");
    writeFileSync(inLease, "version B", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board B"');
    writeFileSync(inLease, "version C", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board C"');
    writeFileSync(inLease, "original", "utf8"); // taken back to the seed, never committed

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("original");
    // No commit in the project may describe B or C for that path.
    const log = git(source, "log --format=%H");
    for (const sha of log.split("\n").filter(Boolean)) {
      const shown = execSync(`git show ${sha}:Assets/Scripts/Existing.cs`, { cwd: source, encoding: "utf8" });
      expect(shown).toBe("original");
    }
    expect(result.commitsReplayed?.replayed ?? 0).toBe(0);
  });

  it("a person's STAGED version survives the replay (Codex 2026-09-12 Q#12)", async () => {
    // The replay points the index at HEAD for every path it touched. A
    // selection the person had staged on one of those paths lives only in the
    // index, and resetting it threw their work away with nothing said.
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    // The person stages their own version and then puts the file back to what
    // HEAD holds — a common shape ("stage this hunk, keep working"). The
    // selection now exists only in the index.
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "the person's staged version", "utf8");
    git(source, "add Assets/Scripts/Existing.cs");
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "the worker's version", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: worker edit"');

    await lease.commit();
    await lease.release();

    expect(git(source, "show :Assets/Scripts/Existing.cs")).toBe("the person's staged version");
  });

  it("a commit whose metadata cannot be READ is a hole in the series (Codex 2026-09-12 T#4)", async () => {
    // A failed `git show` dropped its commit from the list, so a two-commit
    // series looked like a one-commit series: the replay published the prefix
    // and reported skipped: 0.
    makeGitRepo();
    const before = git(source, "rev-parse HEAD");
    let shows = 0;
    const mgr = new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
      commandRunner: (async (spec: { args: string[] }) => {
        // The SECOND commit's metadata read fails.
        if (spec.args.includes("show") && spec.args.includes("-s") && ++shows === 2) {
          return { exitCode: 1, stdout: "", stderr: "simulated object read failure", timedOut: false };
        }
        return runProcess(spec as never);
      }) as never,
    });
    const lease = await mgr.acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "One.cs"), "1", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: one"');
    writeFileSync(join(lease.path, "Assets", "Scripts", "Two.cs"), "2", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: two"');

    const result = await lease.commit();
    await lease.release();

    expect(git(source, "rev-parse HEAD")).toBe(before);
    expect(result.commitsReplayed?.replayed).toBe(0);
  });

  it("a failed git INSPECTION aborts the chain too, not just a failed stage (Codex 2026-09-12 S#5)", async () => {
    // Two paths incremented `skipped` without aborting: a diff-tree that could
    // not be read, and a write-tree that failed. Both moved HEAD to a prefix
    // of the series.
    makeGitRepo();
    const before = git(source, "rev-parse HEAD");
    let writeTrees = 0;
    const mgr = new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
      commandRunner: (async (spec: { args: string[] }) => {
        if (spec.args.includes("write-tree") && ++writeTrees === 2) {
          return { exitCode: 1, stdout: "", stderr: "simulated write-tree failure", timedOut: false };
        }
        return runProcess(spec as never);
      }) as never,
    });
    const lease = await mgr.acquireLease({ label: "t" });
    const inLease = join(lease.path, "Assets", "Scripts", "Board.cs");
    writeFileSync(inLease, "v1", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board v1"');
    writeFileSync(join(lease.path, "Assets", "Scripts", "Other.cs"), "v2", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: other"');

    const result = await lease.commit();
    await lease.release();

    expect(git(source, "rev-parse HEAD")).toBe(before);
    expect(result.commitsReplayed?.replayed).toBe(0);
  });

  it("an index it could not READ is an index it does not touch (Codex 2026-09-12 S#6)", async () => {
    // A failed `diff --cached` was treated as "nothing staged" and the paths
    // were reset anyway — which is exactly how a person's staged selection
    // disappears.
    makeGitRepo();
    const mgr = new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
      commandRunner: (async (spec: { args: string[] }) => {
        if (spec.args.includes("diff") && spec.args.includes("--cached")) {
          return { exitCode: 1, stdout: "", stderr: "simulated index read failure", timedOut: false };
        }
        return runProcess(spec as never);
      }) as never,
    });
    const lease = await mgr.acquireLease({ label: "t" });
    // The person stages their own version, then restores the working file.
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "the person's staged version", "utf8");
    git(source, "add Assets/Scripts/Existing.cs");
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "the worker's version", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: worker edit"');

    await lease.commit();
    await lease.release();

    expect(git(source, "show :Assets/Scripts/Existing.cs")).toBe("the person's staged version");
  });

  it("a series that cannot be built whole leaves the branch where it was (Codex 2026-09-12 Q#7)", async () => {
    // HEAD moved once per commit, so a later commit that could not be staged
    // left the project's history ending at an EARLIER version of the work.
    makeGitRepo();
    const before = git(source, "rev-parse HEAD");
    let readTrees = 0;
    const mgr = new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
      commandRunner: (async (spec: { args: string[] }) => {
        // The SECOND commit of the series cannot be staged.
        if (spec.args.includes("read-tree") && ++readTrees === 2) {
          return { exitCode: 1, stdout: "", stderr: "simulated index failure", timedOut: false };
        }
        return runProcess(spec as never);
      }) as never,
    });
    const lease = await mgr.acquireLease({ label: "t" });
    const inLease = join(lease.path, "Assets", "Scripts", "Board.cs");
    writeFileSync(inLease, "v1", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board v1"');
    writeFileSync(inLease, "v2", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: board v2"');

    const result = await lease.commit();
    await lease.release();

    // Nothing was applied: the files are in the project as uncommitted work,
    // and no commit claims a version of them that is not the final one.
    expect(git(source, "rev-parse HEAD")).toBe(before);
    expect(result.commitsReplayed?.replayed).toBe(0);
    expect(readFileSync(join(source, "Assets", "Scripts", "Board.cs"), "utf8")).toBe("v2");
  });

  it("a path whose current content cannot be read is held, not replayed (Codex 2026-09-12 P#10)", async () => {
    // The worker committed the file and then removed it without committing.
    // `hash-object` has nothing to answer with, and failing open replayed a
    // commit that adds a file the lease does not have.
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Extra.cs"), "scaffolding", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: scaffolding"');
    rmSync(join(lease.path, "Assets", "Scripts", "Extra.cs")); // withdrawn, never committed

    const result = await lease.commit();
    await lease.release();

    expect(existsSync(join(source, "Assets", "Scripts", "Extra.cs"))).toBe(false);
    expect(git(source, "show --name-only --format= HEAD")).not.toContain("Extra.cs");
    expect(result.commitsReplayed?.replayed ?? 0).toBe(0);
  });

  it("a path with a comma in its name is carried whole (Codex 2026-09-12 P#10)", async () => {
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Hero,Idle.cs"), "frames", "utf8");
    git(lease.path, "add -A");
    git(lease.path, 'commit -q -m "feat: idle"');

    const result = await lease.commit();
    await lease.release();

    expect(result.commitsReplayed?.replayed).toBe(1);
    expect(git(source, "show --name-only --format= HEAD")).toContain("Assets/Scripts/Hero,Idle.cs");
    expect(readFileSync(join(source, "Assets", "Scripts", "Hero,Idle.cs"), "utf8")).toBe("frames");
    // The path is staged as committed, not left as a staged reversal.
    expect(git(source, "status --porcelain -- 'Assets/Scripts/Hero,Idle.cs'")).toBe("");
  });

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

describe("an edit made WHILE the lease was seeded is not overwritten (Codex 2026-09-11 N#4)", () => {
  it("keeps the pre-seed stamp for a file that moved during seeding", async () => {
    // Both snapshots used to be taken after the copy, so the concurrent edit
    // became the baseline and the worker's version — made from the old bytes
    // — overwrote it with zero conflicts reported.
    const mgr = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    const target = join(source, "Assets", "Scripts", "Existing.cs");
    // The copy is slow enough for the edit to land inside it.
    const realCopy = fsp.copyFile.bind(fsp);
    const spy = vi.spyOn(fsp, "copyFile").mockImplementation(async (from: never, to: never, mode?: never) => {
      await realCopy(from, to, mode);
      if (String(from) === target) writeFileSync(target, "MAIN CONCURRENT EDIT", "utf8");
    });
    let lease;
    try {
      lease = await mgr.acquireLease({ label: "t", workerId: "w", forceTempCopy: true });
    } finally {
      spy.mockRestore();
    }
    // The worker edits the file it received.
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "WORKER BASE + FEATURE", "utf8");

    const result = await lease.commit();

    // The person's edit stands, and the worker's version is preserved.
    expect(readFileSync(target, "utf8")).toBe("MAIN CONCURRENT EDIT");
    expect(result.written).not.toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(result.conflicts).toContain(join("Assets", "Scripts", "Existing.cs"));
    await lease.release();
  });
});

describe("the seed records what the file WAS, not only when it was touched (Codex 2026-09-11 N#3)", () => {
  it("publishes a worker rewrite that preserved the seed mtime", async () => {
    // An asset pipeline that copies with timestamps preserved leaves the
    // mtime exactly as the lease found it. The commit read that as "the agent
    // never touched this file", returned empty success arrays, and release
    // deleted the worker's only copy.
    const mgr = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    const lease = await mgr.acquireLease({ label: "t", workerId: "w", forceTempCopy: true });
    const inLease = join(lease.path, "Assets", "Scripts", "Existing.cs");
    const before = readFileSync(inLease, "utf8");
    expect(before).toBe("original");
    const stat = statSync(inLease);
    writeFileSync(inLease, "rewritten by the worker", "utf8");
    // …and the mtime is put back exactly where it was.
    utimesSync(inLease, stat.atime, stat.mtime);

    const result = await lease.commit();

    expect(result.written).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("rewritten by the worker");
    await lease.release();
  });

  it("still leaves an untouched file alone", async () => {
    const mgr = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    const lease = await mgr.acquireLease({ label: "t", workerId: "w", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "New.cs"), "new work", "utf8");

    const result = await lease.commit();

    expect(result.written).toEqual([join("Assets", "Scripts", "New.cs")]);
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("original");
    await lease.release();
  });
});

describe("size plus mtime cannot prove unchanged content (Codex 2026-09-12 P#16)", () => {
  it("publishes a worker rewrite that preserved BOTH the seed mtime and the seed size", async () => {
    // The N#3 fix added the size, and an edit of the same length defeats it:
    // `score = 1;` → `score = 9;` with the mtime put back reads as "the agent
    // never touched this file", and release then deletes the only copy.
    const mgr = manager();
    const lease = await mgr.acquireLease({ label: "t", workerId: "w", forceTempCopy: true });
    const inLease = join(lease.path, "Assets", "Scripts", "Existing.cs");
    const stat = statSync(inLease);
    expect(readFileSync(inLease, "utf8")).toBe("original");
    writeFileSync(inLease, "ORIGINAL", "utf8"); // same eight bytes, different content
    utimesSync(inLease, stat.atime, stat.mtime);

    const result = await lease.commit();

    expect(result.written).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("ORIGINAL");
    await lease.release();
  });

  it("a stamp answers with everything it recorded, and an older seed keeps its old answer", () => {
    const seed: SeedStamp = { m: 10, s: 8, c: 20 };
    expect(stampUnchanged(seed, { mtimeMs: 10, size: 8, ctimeMs: 20 })).toBe(true);
    expect(stampUnchanged(seed, { mtimeMs: 10, size: 8, ctimeMs: 99 })).toBe(false); // rewritten in place
    expect(stampUnchanged({ m: 10, s: 8, c: Number.NaN }, { mtimeMs: 10, size: 8, ctimeMs: 99 })).toBe(true);
    expect(stampUnchanged({ m: 10, s: 8, c: 20, absent: true }, { mtimeMs: 10, size: 8, ctimeMs: 20 })).toBe(false);
    expect(existedAtSeed(undefined)).toBe(false);
    expect(existedAtSeed({ m: 1, s: 1, c: 1, absent: true })).toBe(false);
    expect(existedAtSeed({ m: 1, s: 1, c: 1 })).toBe(true);
  });

  it("creation and deletion during seeding are baseline transitions, not gaps", () => {
    const before = new Map<string, SeedStamp>([
      ["kept.cs", { m: 1, s: 2, c: 3 }],
      ["edited.cs", { m: 1, s: 2, c: 3 }],
      ["deleted.cs", { m: 4, s: 5, c: 6 }],
    ]);
    const after = new Map<string, SeedStamp>([
      ["kept.cs", { m: 1, s: 2, c: 3 }],
      ["edited.cs", { m: 9, s: 2, c: 9 }],
      ["created.cs", { m: 7, s: 8, c: 9 }],
    ]);

    expect(reconcileSeedBaseline(before, after)).toBe(3);

    expect(after.get("kept.cs")).toEqual({ m: 1, s: 2, c: 3 });
    // The main process's edit is the baseline the WORKER never saw.
    expect(after.get("edited.cs")).toEqual({ m: 1, s: 2, c: 3 });
    // Deleted during seeding: the project HAD it, so putting it back is undoing
    // a deliberate deletion.
    expect(after.get("deleted.cs")).toEqual({ m: 4, s: 5, c: 6 });
    // Created during seeding: the baseline is ABSENCE, recorded explicitly, so
    // the agent's version of that path is a conflict rather than an update.
    expect(after.get("created.cs")?.absent).toBe(true);
    expect(existedAtSeed(after.get("created.cs"))).toBe(false);
  });
});

describe("the seed survives a restart exactly as it was written (Codex 2026-09-12 Q#5)", () => {
  it("keeps an explicitly ABSENT path across the sidecar round trip", () => {
    // Absence carries no timestamps, its NaNs serialise as null, and the
    // reader required a numeric mtime — so the entry vanished on reload and a
    // salvage deleted a file the live commit had just declined to delete.
    const lease = join(leaseRoot, "task-roundtrip");
    mkdirSync(lease, { recursive: true });
    writeLeaseSeed(lease, {
      seedHead: "abc123",
      leaseSeed: new Map([["Assets/Kept.cs", { m: 1, s: 2, c: 3 }]]),
      sourceSeed: new Map([
        ["Assets/Kept.cs", { m: 1, s: 2, c: 3 }],
        ["Assets/AppearedDuringSeeding.cs", { m: Number.NaN, s: Number.NaN, c: Number.NaN, absent: true as const }],
      ]),
    });

    const back = readLeaseSeed(lease)!;

    expect(back.seedHead).toBe("abc123");
    expect(back.sourceSeed.get("Assets/Kept.cs")).toEqual({ m: 1, s: 2, c: 3 });
    expect(existedAtSeed(back.sourceSeed.get("Assets/AppearedDuringSeeding.cs"))).toBe(false);
    expect(back.sourceSeed.get("Assets/AppearedDuringSeeding.cs")?.absent).toBe(true);
  });
});

describe("a person's edit that stats cannot see is not published over (Codex 2026-09-12 Q#5)", () => {
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.email=w@x -c user.name=worker ${cmd}`, { cwd, encoding: "utf8" }).trim();

  it("quarantines the worker's version when the project's copy changed under the same size and mtime", async () => {
    makeGitRepo();
    const target = join(source, "Assets", "Scripts", "Existing.cs");
    // A whole-second stamp, so putting it back is exact rather than rounded.
    const stamp = 1_600_000_000;
    utimesSync(target, stamp, stamp);
    const lease = await gitManager().acquireLease({ label: "t", workerId: "w" });
    // The person rewrites eight bytes over eight bytes and the mtime is put
    // back — the seed stamp cannot tell, and their edit used to be overwritten
    // with no conflict reported at all.
    writeFileSync(target, "PERSON!!", "utf8");
    utimesSync(target, stamp, stamp);
    expect(statSync(target).mtimeMs).toBe(stamp * 1000);
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "WORKER!!", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(target, "utf8")).toBe("PERSON!!");
    expect(result.written).not.toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(result.conflicts).toContain(join("Assets", "Scripts", "Existing.cs"));
    // …and the worker's version is preserved rather than dropped.
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("WORKER!!");
  });

  it("a changed ctime with NO commit to check against keeps the project's copy (Codex 2026-09-12 S#7)", async () => {
    // An untracked or gitignored file whose ctime moved may have changed under
    // us, and requiring PROOF of difference published the worker's version
    // over it. The agent's work is preserved in quarantine either way; the
    // person's file is not recoverable once overwritten.
    const target = join(source, "Assets", "Scripts", "Untracked.cs");
    writeFileSync(target, "the person's file", "utf8");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    chmodSync(target, 0o640); // ctime moves; no git, so nothing can prove the bytes
    writeFileSync(join(lease.path, "Assets", "Scripts", "Untracked.cs"), "the worker's version", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(target, "utf8")).toBe("the person's file");
    expect(result.conflicts).toContain(join("Assets", "Scripts", "Untracked.cs"));
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets", "Scripts", "Untracked.cs"), "utf8")).toBe("the worker's version");
  });

  it("a permission change that moved no byte is not a conflict", async () => {
    makeGitRepo();
    const lease = await gitManager().acquireLease({ label: "t", workerId: "w" });
    const target = join(source, "Assets", "Scripts", "Existing.cs");
    chmodSync(target, 0o640); // ctime moves, content does not
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "worker work", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(readFileSync(target, "utf8")).toBe("worker work");
    expect(git(source, "status --porcelain -- Assets/Scripts/Existing.cs")).not.toBe("");
  });
});

describe("compiler output is derived, at any depth (Codex 2026-09-12 R#4)", () => {
  it("does not carry, publish or conflict on bin/obj build output", async () => {
    // Measured live 2026-09-12 11:26 and 12:03: thirteen files under
    // Tools/PixelFlowCoreBuild/{bin,obj}/Debug differed between the lease and
    // the project — both had built them — so every one came back a CONFLICT,
    // the commit published nothing, and the whole node failed.
    mkdirSync(join(source, "Tools", "CoreBuild", "obj", "Debug"), { recursive: true });
    mkdirSync(join(source, "Tools", "CoreBuild", "bin", "Debug"), { recursive: true });
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "Tools", "CoreBuild", "obj", "Debug", "Core.cache"), "project build", "utf8");
    writeFileSync(join(source, "Tools", "CoreBuild", "bin", "Debug", "Core.dll"), "project build", "utf8");
    writeFileSync(join(source, "bin", "tools.sh"), "#!/bin/sh\necho hi\n", "utf8"); // a repository's own bin/

    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    // The worker builds too, and its outputs differ.
    mkdirSync(join(lease.path, "Tools", "CoreBuild", "obj", "Debug"), { recursive: true });
    mkdirSync(join(lease.path, "Tools", "CoreBuild", "bin", "Debug"), { recursive: true });
    writeFileSync(join(lease.path, "Tools", "CoreBuild", "obj", "Debug", "Core.cache"), "lease build", "utf8");
    writeFileSync(join(lease.path, "Tools", "CoreBuild", "bin", "Debug", "Core.dll"), "lease build", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Real.cs"), "the actual work", "utf8");
    writeFileSync(join(lease.path, "bin", "tools.sh"), "#!/bin/sh\necho edited\n", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([]);
    expect(result.written).toContain(join("Assets", "Scripts", "Real.cs"));
    // The project keeps its own compiler output, untouched…
    expect(readFileSync(join(source, "Tools", "CoreBuild", "obj", "Debug", "Core.cache"), "utf8")).toBe("project build");
    expect(readFileSync(join(source, "Tools", "CoreBuild", "bin", "Debug", "Core.dll"), "utf8")).toBe("project build");
    // …and a repository's own bin/ of scripts is not compiler output.
    expect(readFileSync(join(source, "bin", "tools.sh"), "utf8")).toBe("#!/bin/sh\necho edited\n");
  });

  it("knows what a build directory looks like, and what merely shares its name", () => {
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Debug", "a.dll"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "net8.0", "a.dll"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "netstandard2.1", "Core.AssemblyInfo.cs"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "project.assets.json"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.csproj.nuget.g.props"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "bin", "Release", "a.dll"))).toBe(true);
    expect(isDerivedBuildOutput(join("bin", "tools.sh"))).toBe(false);
    expect(isDerivedBuildOutput(join("Assets", "Scripts", "Object.cs"))).toBe(false);
    // A GAME'S OWN ASSETS in a folder called obj: a Wavefront model under
    // Assets/Models/obj was classified derived and dropped from publication,
    // which loses authored work (Codex 2026-09-12 S#8).
    expect(isDerivedBuildOutput(join("Assets", "Models", "obj", "Hero.obj"))).toBe(false);
    // A GAME'S OWN baked data in a folder called obj is not compiler output
    // either, whatever its extension (Codex 2026-09-12 T#10).
    expect(isDerivedBuildOutput(join("Assets", "obj", "terrain.cache"))).toBe(false);
    expect(isDerivedBuildOutput(join("Assets", "Models", "obj", "Hero.cache"))).toBe(false);
    // …while the names .NET actually writes there still count.
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.assets.cache"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.csproj.FileListAbsolute.txt"))).toBe(true);
    expect(isDerivedBuildOutput(join("Assets", "obj", "Pig", "body.fbx"))).toBe(false);
    expect(isDerivedBuildOutput(join("Tools", "X", "bin", "Custom", "a.dll"))).toBe(false);
  });
});

describe("publication never runs unlocked (Codex 2026-09-12 R#14)", () => {
  it("reports the commit as unfinished when another writer holds the project lock", async () => {
    // It used to proceed with a loud log — two publishers writing one tree,
    // which is exactly the interleaving the lock exists to prevent.
    writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
    const mgr = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false, projectLockTimeoutMs: 50 });
    const lease = await mgr.acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "the worker's work", "utf8");

    // A live holder: this very process, heartbeating, so it is never broken.
    const lockDir = join(source, ".strada", "locks", "project-write.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else", at: new Date().toISOString() }),
    );

    const result = await lease.commit();

    expect(result.written).toEqual([]);
    expect(result.failed.join(" ")).toContain("project write lock could not be taken");
    // The project keeps its copy and the worker's version is still in the lease.
    expect(readFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("original");
    expect(readFileSync(join(lease.path, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("the worker's work");
    rmSync(lockDir, { recursive: true, force: true });
    await lease.release();
  });
});
