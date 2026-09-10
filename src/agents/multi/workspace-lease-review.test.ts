/**
 * The twelve lease-lifecycle defects an adversarial review found on
 * 2026-09-07, each reproduced against real git in temp directories before
 * the fix and pinned here. Seven were data loss: a user's file deleted or
 * overwritten by a commit that reported success.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, readlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WorkspaceLeaseManager, readCommitLedger } from "./workspace-lease-manager.js";
import { LEASE_WRITTEN_LEDGER } from "./system-owned-path.js";
import { CAPTURE_MARKER_FILE } from "./capture-retention.js";

let source: string;
let leaseRoot: string;
const EXCL = ["Library", "Temp", "Logs", "Builds", "obj"];

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "lease-review-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "lease-review-root-"));
});
afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(leaseRoot, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return abs;
}
function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=a@b -c user.name=t ${cmd}`, { cwd, encoding: "utf8" });
}
function manager(opts: { worktree?: boolean; projectRoot?: string } = {}): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({
    projectRoot: opts.projectRoot ?? source,
    leaseRoot,
    additionalExcludes: EXCL,
    preferGitWorktree: opts.worktree ?? false,
  });
}
const past = new Date(Date.now() - 60_000);

describe("deletions: only the system's own files go, and every applied deletion is recoverable", () => {
  it("a user's Assets/Editor and Assets/Tests scripts are not 'scaffolding scenes'", async () => {
    put(source, "Assets/Editor/BuildPipeline.cs", "user editor script");
    put(source, "Assets/Tests/PlayerTests.cs", "user test");
    put(source, "Assets/Tests/InitTestScene123.unity", "scaffold");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    rmSync(join(lease.path, "Assets/Editor/BuildPipeline.cs"));
    rmSync(join(lease.path, "Assets/Tests/PlayerTests.cs"));
    rmSync(join(lease.path, "Assets/Tests/InitTestScene123.unity"));
    const result = await lease.commit();
    await lease.release();
    expect(existsSync(join(source, "Assets/Editor/BuildPipeline.cs"))).toBe(true);
    expect(existsSync(join(source, "Assets/Tests/PlayerTests.cs"))).toBe(true);
    expect(existsSync(join(source, "Assets/Tests/InitTestScene123.unity"))).toBe(false);
    expect([...result.removed].sort()).toEqual([join("Assets", "Editor", "BuildPipeline.cs"), join("Assets", "Tests", "PlayerTests.cs")]);
  });

  it("a loose script that merely shares a module file's NAME is not a duplicate", async () => {
    put(source, "Assets/Scripts/Utils.cs", "the user's utils");
    put(source, "Assets/Modules/Core/Utils.cs", "unrelated module utils");
    put(source, "Assets/Scripts/Dup.cs", "same bytes");
    put(source, "Assets/Modules/Core/Dup.cs", "same bytes");
    put(source, LEASE_WRITTEN_LEDGER, "Assets/Scripts/Ledgered.cs\n");
    put(source, "Assets/Scripts/Ledgered.cs", "older lease output");
    put(source, "Assets/Modules/Core/Ledgered.cs", "module version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    for (const f of ["Utils.cs", "Dup.cs", "Ledgered.cs"]) rmSync(join(lease.path, "Assets/Scripts", f));
    const result = await lease.commit();
    await lease.release();
    expect(existsSync(join(source, "Assets/Scripts/Utils.cs"))).toBe(true); // name only: stays
    expect(existsSync(join(source, "Assets/Scripts/Dup.cs"))).toBe(false); // byte-identical: goes
    expect(existsSync(join(source, "Assets/Scripts/Ledgered.cs"))).toBe(false); // a lease wrote it: goes
    expect(result.deleted.join("\n")).toContain("Ledgered.cs — loose duplicate");
    // …and both applied deletions are recoverable.
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, "deleted", "Assets/Scripts/Ledgered.cs"), "utf8")).toBe("older lease output");
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, "deleted", "Assets/Scripts/Dup.cs"), "utf8")).toBe("same bytes");
  });

  it("a user's file swept into a 'campaign:' envelope commit is not the system's without the ledger's word", async () => {
    put(source, "Assets/Scripts/MyLevelDesign.cs", "the user's uncommitted design");
    put(source, "Assets/Scripts/Generated.cs", "lease output");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm 'campaign: Sprint 3 — envelope'");
    put(source, LEASE_WRITTEN_LEDGER, "Assets/Scripts/Generated.cs\n");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    rmSync(join(lease.path, "Assets/Scripts/MyLevelDesign.cs"));
    rmSync(join(lease.path, "Assets/Scripts/Generated.cs"));
    const result = await lease.commit();
    await lease.release();
    expect(existsSync(join(source, "Assets/Scripts/MyLevelDesign.cs"))).toBe(true);
    expect(existsSync(join(source, "Assets/Scripts/Generated.cs"))).toBe(false);
    expect(result.removed).toEqual([join("Assets", "Scripts", "MyLevelDesign.cs")]);
  });

  it("the ledger records what each commit wrote", async () => {
    put(source, "Assets/Scripts/Existing.cs", "x");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scripts/New.cs", "agent work");
    await lease.commit();
    await lease.release();
    expect(readFileSync(join(source, LEASE_WRITTEN_LEDGER), "utf8")).toContain("Assets/Scripts/New.cs");
  });
});

describe("writes: the user's copy is never overwritten by a version the agent wrote blind", () => {
  it("a file the commit could not write is quarantined, not destroyed with the lease", async () => {
    put(source, "Assets/Scripts/Locked.cs", "original");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scripts/Locked.cs", "the agent's version");
    chmodSync(join(source, "Assets/Scripts/Locked.cs"), 0o444);
    chmodSync(join(source, "Assets/Scripts"), 0o555);
    let result;
    try {
      result = await lease.commit();
    } finally {
      chmodSync(join(source, "Assets/Scripts"), 0o755);
      chmodSync(join(source, "Assets/Scripts/Locked.cs"), 0o644);
    }
    await lease.release();
    expect(result.failed.length + result.written.length).toBeGreaterThan(0);
    if (result.failed.length > 0) {
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets/Scripts/Locked.cs"), "utf8")).toBe("the agent's version");
    }
  });

  it("a gitignored user file the worktree never held is a conflict, not a write", async () => {
    put(source, "Assets/Scripts/Existing.cs", "x");
    put(source, ".gitignore", "Assets/StreamingAssets/config.json\n");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm init");
    put(source, "Assets/StreamingAssets/config.json", '{"apiKey":"USER-SECRET"}');
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    expect(lease.kind).toBe("git-worktree");
    expect(existsSync(join(lease.path, "Assets/StreamingAssets/config.json"))).toBe(false);
    put(lease.path, "Assets/StreamingAssets/config.json", '{"levels":1}');
    const result = await lease.commit();
    await lease.release();
    expect(readFileSync(join(source, "Assets/StreamingAssets/config.json"), "utf8")).toContain("USER-SECRET");
    expect(result.conflicts).toEqual([join("Assets", "StreamingAssets", "config.json")]);
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, "Assets/StreamingAssets/config.json"), "utf8")).toBe('{"levels":1}');
  });

  it("a file the user deleted during the run is not re-created by an agent edit", async () => {
    put(source, "Assets/Scripts/Obsolete.cs", "old");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scripts/Obsolete.cs", "agent edit");
    rmSync(join(source, "Assets/Scripts/Obsolete.cs"));
    const result = await lease.commit();
    await lease.release();
    expect(existsSync(join(source, "Assets/Scripts/Obsolete.cs"))).toBe(false);
    expect(result.conflicts).toEqual([join("Assets", "Scripts", "Obsolete.cs")]);
  });

  it("an asset and its .meta travel together or not at all", async () => {
    put(source, "Assets/Art/Hero.png", "PNG-v1");
    put(source, "Assets/Art/Hero.png.meta", "guid: 9\nv1 importer");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Art/Hero.png", "PNG-v2");
    put(lease.path, "Assets/Art/Hero.png.meta", "guid: 9\nv2 importer");
    // The editor touches the project's .meta while the agent runs.
    writeFileSync(join(source, "Assets/Art/Hero.png.meta"), "guid: 9\nuser importer");
    const result = await lease.commit();
    await lease.release();
    expect(result.written).toEqual([]);
    expect(result.conflicts.sort()).toEqual([join("Assets", "Art", "Hero.png"), join("Assets", "Art", "Hero.png.meta")]);
    expect(readFileSync(join(source, "Assets/Art/Hero.png"), "utf8")).toBe("PNG-v1");
  });

  it("git stash inside a worktree lease does not revert the user's WIP in the project", async () => {
    put(source, "Assets/Scripts/Player.cs", "class Player { }");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm init");
    put(source, "Assets/Scripts/Player.cs", "class Player { /* WIP */ }");
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    expect(readFileSync(join(lease.path, "Assets/Scripts/Player.cs"), "utf8")).toContain("WIP");
    git(lease.path, "stash -q");
    put(lease.path, "Assets/Scripts/Other.cs", "agent work");
    const result = await lease.commit();
    await lease.release();
    expect(readFileSync(join(source, "Assets/Scripts/Player.cs"), "utf8")).toContain("WIP");
    expect(result.written).toEqual([join("Assets", "Scripts", "Other.cs")]);
  });

  it("an uncommitted relative symlink stays relative inside the worktree", async () => {
    put(source, "Packages/Shared/Config.cs", "USER ORIGINAL");
    put(source, "Assets/Scripts/A.cs", "x");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm init");
    mkdirSync(join(source, "Packages/Vendored"), { recursive: true });
    symlinkSync("../Shared", join(source, "Packages/Vendored/Shared"));
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    const link = join(lease.path, "Packages/Vendored/Shared");
    expect(readlinkSync(link)).toBe("../Shared");
    await lease.release();
  });
});

describe("a moved mtime is not a user edit", () => {
  // Measured 2026-09-07 21:32: a failed branch merge rewrote 169 project files
  // byte-for-byte one second before the lease commit; the commit read every
  // one as "the user changed it" and quarantined the sprint's scene placements.
  it("writes an agent edit over a project file whose mtime moved but whose bytes still equal the seed-time HEAD", async () => {
    put(source, "Assets/Scenes/Main.unity", "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Root\n");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm base");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scenes/Main.unity", "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Root\n--- !u!1001 &1001\nPrefabInstance:\n");
    // Something rewrote the project's copy with the same bytes (a merge, a reimport).
    const target = join(source, "Assets/Scenes/Main.unity");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);
    const result = await lease.commit();
    await lease.release();
    expect(result.conflicts).toEqual([]);
    expect(result.written).toEqual([join("Assets", "Scenes", "Main.unity")]);
    expect(readFileSync(target, "utf8")).toContain("PrefabInstance");
  });

  it("still refuses when the bytes differ from the seed-time HEAD", async () => {
    put(source, "Assets/Scripts/Player.cs", "class Player { }");
    git(source, "init -q");
    git(source, "add -A");
    git(source, "commit -qm base");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scripts/Player.cs", "class Player { /* agent */ }");
    const target = join(source, "Assets/Scripts/Player.cs");
    writeFileSync(target, "class Player { /* user */ }");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);
    const result = await lease.commit();
    await lease.release();
    expect(result.conflicts).toEqual([join("Assets", "Scripts", "Player.cs")]);
    expect(readFileSync(target, "utf8")).toContain("/* user */");
  });
});

describe("retention and salvage", () => {
  it("a no-op commit leaves the user's Recorder takes alone; only lease-written entries are pruned", async () => {
    for (let i = 0; i < 30; i++) {
      const dir = join(source, "Recordings", `take-${String(i).padStart(2, "0")}`);
      put(dir, "frame.png", "x");
      utimesSync(dir, past, past);
    }
    for (let i = 0; i < 26; i++) {
      const dir = join(source, "Recordings", `lease-${String(i).padStart(2, "0")}`);
      put(dir, "frame.png", "x");
      writeFileSync(join(dir, CAPTURE_MARKER_FILE), "lease");
      utimesSync(dir, past, past);
    }
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Recordings/this-run/frame.png", "new");
    const result = await lease.commit();
    await lease.release();
    for (let i = 0; i < 30; i++) expect(existsSync(join(source, "Recordings", `take-${String(i).padStart(2, "0")}`))).toBe(true);
    expect(existsSync(join(source, "Recordings", "this-run", CAPTURE_MARKER_FILE))).toBe(true);
    expect(result.capturesPruned?.removed).toBe(2); // 26 old + 1 new marked, keep 25
  });

  it("an orphan that died mid-commit carries a ledger: salvage reads it, finishes what it can, and removes it (#34)", async () => {
    const orphan = join(leaseRoot, `task-1-${randomUUID()}`);
    put(orphan, "Assets/Scripts/HalfWritten.cs", "agent work");
    writeFileSync(join(orphan, ".strada-lease-owner.json"), JSON.stringify({ pid: 2147483000, startedAt: 1, projectRoot: source }));
    writeFileSync(`${orphan}.commit.json`, JSON.stringify({ startedAt: 123, sourceRoot: source, planned: ["Assets/Scripts/HalfWritten.cs"] }));
    expect(readCommitLedger(orphan)?.planned).toEqual(["Assets/Scripts/HalfWritten.cs"]);
    manager();
    for (let i = 0; i < 50 && existsSync(orphan); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(orphan)).toBe(false);
    // no seed maps → quarantine-only, the planned file is kept for review
    expect(existsSync(`${orphan}.commit.json`)).toBe(false);
    expect(readCommitLedger(orphan)).toBeUndefined();
  });

  it("a commit that finishes leaves no ledger behind", async () => {
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    put(lease.path, "Assets/Scripts/Done.cs", "x");
    await lease.commit();
    expect(existsSync(`${lease.path}.commit.json`)).toBe(false);
    await lease.release();
  });

  it("an orphan recorded for another project is left for that project's manager", async () => {
    const projectB = mkdtempSync(join(tmpdir(), "lease-review-b-"));
    try {
      const orphan = join(leaseRoot, `task-1-${randomUUID()}`);
      put(orphan, "Assets/Scripts/NewFromA.cs", "agent work for A");
      writeFileSync(join(orphan, ".strada-lease-owner.json"), JSON.stringify({ pid: 2147483000, startedAt: 1, projectRoot: source }));
      manager({ projectRoot: projectB });
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(join(projectB, ".strada"))).toBe(false);
    } finally {
      rmSync(projectB, { recursive: true, force: true });
    }
  });
});
