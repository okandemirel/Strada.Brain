/**
 * A lease never writes or deletes the campaign's acceptance checks
 * (GDD-drift plan W07).
 *
 * The checks under Assets/StradaAcceptance are what a milestone is judged by.
 * A worker that could publish an edited check — `Assert.Pass()` in place of
 * the GDD's bound — or delete one would write its own green. Before this the
 * lease commit treated the folder like any other: a new or edited check was
 * copied into the project and its commit replayed onto HEAD, and on a project
 * with no lease ledger a deleted check was REMOVED, because every commit that
 * ever touched it is a `campaign:` commit — exactly what the history rule
 * accepts as "the system's own leftover".
 *
 * The folder is still seeded: a worker reads and runs the checks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const CHECK = join("Assets", "StradaAcceptance", "M1", "Acceptance_M1.cs");
const CHECK_META = `${CHECK}.meta`;
const FOLDER_META = join("Assets", "StradaAcceptance.meta");
const CANONICAL = "// REQ r1 — the jump is 2 units\nAssert.That(observed, Is.InRange(1.9, 2.1));\n";

let source: string;
let leaseRoot: string;
const extra: string[] = [];

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "lease-acceptance-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "lease-acceptance-root-"));
  mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
});

afterEach(() => {
  for (const dir of [source, leaseRoot, ...extra.splice(0)]) rmSync(dir, { recursive: true, force: true });
});

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=w@x", "-c", "user.name=worker", ...args], { cwd, encoding: "utf8" }).trim();
}

/** The campaign's checks for M1, committed the way the campaign commits them. */
function withChecks(opts: { git: boolean }): void {
  mkdirSync(join(source, "Assets", "StradaAcceptance", "M1"), { recursive: true });
  writeFileSync(join(source, CHECK), CANONICAL, "utf8");
  writeFileSync(join(source, CHECK_META), "guid: 0123456789abcdef0123456789abcdef\n", "utf8");
  writeFileSync(join(source, FOLDER_META), "guid: fedcba9876543210fedcba9876543210\n", "utf8");
  if (!opts.git) return;
  gitAt(source, "init", "-q");
  gitAt(source, "add", "-A");
  gitAt(source, "commit", "-qm", "campaign: acceptance checks for M1 (system-owned)");
}

function tempCopyManager(projectRoot = source): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({ projectRoot, leaseRoot, preferGitWorktree: false });
}

/** The default lease kind on a git project. */
function gitManager(projectRoot = source): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({ projectRoot, leaseRoot });
}

describe("a lease's writes into the acceptance folder are refused", () => {
  it("a NEW check the worker wrote is not published, is reported, and its bytes are kept for review", async () => {
    withChecks({ git: false });
    const lease = await tempCopyManager().acquireLease({ label: "t", forceTempCopy: true });
    // Seeded: the worker can read the checks it is judged by.
    expect(readFileSync(join(lease.path, CHECK), "utf8")).toBe(CANONICAL);
    const planted = join("Assets", "StradaAcceptance", "M1", "Planted.cs");
    writeFileSync(join(lease.path, planted), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(existsSync(join(source, planted))).toBe(false);
    expect(result.conflicts).toEqual([planted]);
    expect(result.refusedSystemOwned).toEqual([planted]);
    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, planted), "utf8")).toBe("Assert.Pass();");
  });

  it("an EDITED check is not published and its commit is not replayed; the rest of the commit is", async () => {
    withChecks({ git: true });
    const lease = await gitManager().acquireLease({ label: "t" });
    expect(lease.kind).toBe("git-worktree");
    writeFileSync(join(lease.path, CHECK), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, FOLDER_META), "guid: 00000000000000000000000000000000\n", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "feat: board, and make the jump check pass");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, CHECK), "utf8")).toBe(CANONICAL);
    expect(readFileSync(join(source, FOLDER_META), "utf8")).toContain("fedcba98");
    expect([...(result.refusedSystemOwned ?? [])].sort()).toEqual([CHECK, FOLDER_META].sort());
    expect(result.conflicts).toEqual(expect.arrayContaining([CHECK, FOLDER_META]));
    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
    // The replayed commit carries the worker's code and nothing of the checks.
    expect(result.commitsReplayed?.replayed).toBe(1);
    expect(gitAt(source, "show", "--name-only", "--format=", "HEAD")).toBe("Assets/Scripts/Board.cs");
    expect(gitAt(source, "show", "HEAD:Assets/StradaAcceptance/M1/Acceptance_M1.cs")).toBe(CANONICAL.trim());
    expect(gitAt(source, "log", "--format=%s", "--", "Assets/StradaAcceptance")).toBe(
      "campaign: acceptance checks for M1 (system-owned)",
    );
  });

  it("an edit the worker committed and then took back never enters the project's history", async () => {
    // The working copy ends byte-identical to the project's, so there is
    // nothing to publish — but the series still holds a commit that rewrote
    // the check, and replaying it would put the worker's version of a check
    // into HEAD's history.
    withChecks({ git: true });
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, CHECK), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "feat: board, and make the jump check pass");
    writeFileSync(join(lease.path, CHECK), CANONICAL, "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "chore: put the check back");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, CHECK), "utf8")).toBe(CANONICAL);
    // Nothing differed from the project, so nothing was refused.
    expect(result.refusedSystemOwned ?? []).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(gitAt(source, "log", "--format=%s", "--", "Assets/StradaAcceptance")).toBe(
      "campaign: acceptance checks for M1 (system-owned)",
    );
    expect(gitAt(source, "show", "HEAD:Assets/Scripts/Board.cs")).toBe("board");
  });

  it("holds when the project is reached through a symlink and a link in it leads into the folder", async () => {
    withChecks({ git: false });
    // The project by a second name (and on macOS /var is /private/var too).
    const link = `${source}-link`;
    symlinkSync(source, link, "dir");
    extra.push(link);
    // A link INSIDE the project that leads into the folder.
    symlinkSync(join(source, "Assets", "StradaAcceptance"), join(source, "Assets", "Scripts", "Checks"), "dir");

    const lease = await tempCopyManager(link).acquireLease({ label: "t", forceTempCopy: true });
    const planted = join("Assets", "StradaAcceptance", "M2", "Planted.cs");
    mkdirSync(join(lease.path, "Assets", "StradaAcceptance", "M2"), { recursive: true });
    writeFileSync(join(lease.path, planted), "Assert.Pass();", "utf8");
    // The worker replaces the project's link with a real directory in its
    // lease; published, the file would land through the project's link.
    const through = join("Assets", "Scripts", "Checks", "M1", "Through.cs");
    rmSync(join(lease.path, "Assets", "Scripts", "Checks"), { recursive: true, force: true });
    mkdirSync(join(lease.path, "Assets", "Scripts", "Checks", "M1"), { recursive: true });
    writeFileSync(join(lease.path, through), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect([...(result.refusedSystemOwned ?? [])].sort()).toEqual([planted, through].sort());
    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
    expect(existsSync(join(source, planted))).toBe(false);
    expect(existsSync(join(source, "Assets", "StradaAcceptance", "M1", "Through.cs"))).toBe(false);
    expect(readdirSync(join(source, "Assets", "StradaAcceptance", "M1")).sort()).toEqual(
      ["Acceptance_M1.cs", "Acceptance_M1.cs.meta"],
    );
  });

  it("holds on a git-worktree lease of a project reached through a symlink", async () => {
    withChecks({ git: true });
    const link = `${source}-link`;
    symlinkSync(source, link, "dir");
    extra.push(link);
    const lease = await gitManager(link).acquireLease({ label: "t" });
    expect(lease.kind).toBe("git-worktree");
    const planted = join("Assets", "StradaAcceptance", "M1", "Planted.cs");
    writeFileSync(join(lease.path, planted), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, CHECK), "Assert.Pass();", "utf8");
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "feat: board, and make the jump check pass");

    const result = await lease.commit();
    await lease.release();

    expect([...(result.refusedSystemOwned ?? [])].sort()).toEqual([CHECK, planted].sort());
    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
    expect(existsSync(join(source, planted))).toBe(false);
    expect(readFileSync(join(source, CHECK), "utf8")).toBe(CANONICAL);
    expect(gitAt(source, "show", "--name-only", "--format=", "HEAD")).toBe("Assets/Scripts/Board.cs");
  });

  it("holds however the folder's name is cased, before the campaign has created it", async () => {
    // APFS and NTFS are case-insensitive by default: a folder planted as
    // assets/stradaacceptance IS the folder the campaign later writes into.
    const lease = await tempCopyManager().acquireLease({ label: "t", forceTempCopy: true });
    const planted = join("Assets", "stradaACCEPTANCE", "M1", "Acceptance_M1.cs");
    mkdirSync(join(lease.path, "Assets", "stradaACCEPTANCE", "M1"), { recursive: true });
    writeFileSync(join(lease.path, planted), "Assert.Pass();", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.refusedSystemOwned).toEqual([planted]);
    expect(result.written).toEqual([]);
    expect(readdirSync(join(source, "Assets"))).toEqual(["Scripts"]);
  });

  it("an untouched seeded check is neither a conflict nor a refusal", async () => {
    withChecks({ git: true });
    const lease = await gitManager().acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "board", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([]);
    expect(result.refusedSystemOwned).toBeUndefined();
    expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
  });
});

describe("a lease's deletions in the acceptance folder are declined", () => {
  it("a deleted check stays in the project even where every commit that touched it was the campaign's", async () => {
    withChecks({ git: true });
    // Positive control: the same history rule DOES apply to a campaign leftover.
    mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(source, "Assets", "Scripts", "Leftover.cs"), "leftover", "utf8");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "campaign: Sprint 1 — foundations");
    // A project from before the lease ledger: the history rule decides.
    expect(existsSync(join(source, ".strada", "lease-written.log"))).toBe(false);

    const lease = await gitManager().acquireLease({ label: "t" });
    rmSync(join(lease.path, CHECK));
    rmSync(join(lease.path, CHECK_META));
    rmSync(join(lease.path, FOLDER_META));
    rmSync(join(lease.path, "Assets", "Scripts", "Leftover.cs"));
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "chore: remove the checks that fail");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, CHECK), "utf8")).toBe(CANONICAL);
    expect(existsSync(join(source, CHECK_META))).toBe(true);
    expect(existsSync(join(source, FOLDER_META))).toBe(true);
    expect(result.removed).toEqual(expect.arrayContaining([CHECK, CHECK_META, FOLDER_META]));
    expect(result.deleted.map((d) => d.split(" — ")[0])).toEqual([join("Assets", "Scripts", "Leftover.cs")]);
    expect(existsSync(join(source, "Assets", "Scripts", "Leftover.cs"))).toBe(false);
    // Nor does the deletion reach HEAD through the replayed commit.
    expect(gitAt(source, "show", "HEAD:Assets/StradaAcceptance/M1/Acceptance_M1.cs")).toBe(CANONICAL.trim());
  });
});
