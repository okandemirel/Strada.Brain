/**
 * Change review and undo for what a run published (improvement 6.5).
 *
 * The defect this starts from: `resolveDiff` in the portal's code-store moved a
 * tab's fields around and nothing else, so "accept" / "reject" lived entirely in
 * the browser — what the user saw and what could actually be put back were two
 * different things, and for a run that had already published there was no undo
 * at all. The lease had copied its files into the project, replayed its commits
 * onto HEAD, and deleted the only other copy of the previous version together
 * with its workspace.
 *
 * The three things this has to get right, and where each is measured here:
 *   1. a HUMAN editing the same files while the run works never loses that edit
 *      to an undo — "a human editing the same files while the run works";
 *   2. the user SEES what would be undone before undoing it — "seeing before
 *      undoing";
 *   3. zero leftover changes after an undo, no half-reverted tree — "an undo
 *      leaves nothing over".
 *
 * And the direction that is just as much a defect: a safety check that refuses
 * a LEGITIMATE undo. A stat moves on a chmod, a touch or an xattr with no byte
 * changed, so there is a test for exactly that ("a touch or a chmod…").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  utimesSync,
  chmodSync,
  promises as fsp,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceLeaseManager, type WorkspaceCommandRunner } from "./workspace-lease-manager.js";
import { runProcess } from "../../utils/process-runner.js";
import {
  applyUndo,
  changeReviewDir,
  keepChanges,
  listChangeReviews,
  previewUndo,
  previousCopyPath,
  pruneChangeReviews,
  readChangeReview,
  writeChangeReview,
  MAX_CHANGE_REVIEWS,
} from "./workspace-change-review.js";

let source: string;
let leaseRoot: string;

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "change-review-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "change-review-root-"));
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

function manager(opts: { worktree?: boolean } = {}): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({
    projectRoot: source,
    leaseRoot,
    preferGitWorktree: opts.worktree ?? false,
    additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
  });
}

/** An argument array, not a shell string: cmd.exe keeps `'msg'` quotes literally. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** A real repository, with .strada ignored the way a project that uses Strada has to. */
function makeGitRepo(): void {
  writeFileSync(join(source, ".gitignore"), ".strada/\n", "utf8");
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "init");
}

/** Every file in the project and its bytes — the "nothing left over" measure. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".strada") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        // A directory the run created and an undo emptied is still a change.
        if (readdirSync(full).length === 0) out[`${relative(root, full)}/`] = "(empty directory)";
        continue;
      }
      if (!entry.isFile()) continue;
      out[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

describe("change review: what a run published is recorded", () => {
  it("records a restore for a file it overwrote and a delete for one it created, with the project's previous bytes preserved", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");

    const result = await lease.commit();
    await lease.release();

    expect(result.changeReview).toBeDefined();
    expect(result.changeReview!.changes).toBe(2);
    expect(result.changeReview!.undoable).toBe(2);
    const record = readChangeReview(source, result.changeReview!.id)!;
    const byPath = new Map(record.changes.map((c) => [c.path, c]));
    expect(byPath.get(join("Assets", "Scripts", "Existing.cs"))!.action).toBe("restore");
    expect(byPath.get(join("Assets", "Scripts", "New.cs"))!.action).toBe("delete");
    // The project's previous bytes are kept — the copy the write phase already
    // made and used to delete with the staging directory.
    const previous = byPath.get(join("Assets", "Scripts", "Existing.cs"))!.previousPath!;
    expect(readFileSync(previous, "utf8")).toBe("the user's version");
    // …and the record knows exactly what it put on disk, so a later edit by a
    // person is distinguishable from the run's own work.
    expect(byPath.get(join("Assets", "Scripts", "New.cs"))!.publishedHash).toBe(
      createHash("sha256").update("brand new").digest("hex"),
    );
  });

  it("records nothing when a commit published nothing", async () => {
    put(source, "Assets/Scripts/Existing.cs", "untouched");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    const result = await lease.commit();
    await lease.release();

    expect(result.written).toEqual([]);
    expect(result.changeReview).toBeUndefined();
    expect(listChangeReviews(source)).toEqual([]);
  });
});

describe("seeing before undoing", () => {
  it("names every path, what would happen to it, and the commits that would go — and writes nothing", async () => {
    makeGitRepo();
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "existing");
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");
    git(lease.path, "add", "-A");
    git(lease.path, "commit", "-qm", "run: two files");
    const result = await lease.commit();
    await lease.release();

    const before = snapshotTree(source);
    const preview = (await previewUndo(source, result.changeReview!.id))!;

    expect(preview.complete).toBe(true);
    expect(preview.ready).toBe(2);
    expect(preview.changedSince).toBe(0);
    expect(new Set(preview.entries.map((e) => `${e.action} ${e.path}`))).toEqual(
      new Set([`restore ${join("Assets", "Scripts", "Existing.cs")}`, `delete ${join("Assets", "Scripts", "New.cs")}`]),
    );
    expect(preview.history).not.toBeNull();
    expect(preview.history!.state).toBe("ready");
    expect(preview.history!.commits).toBe(1);
    // A preview is a read. Nothing on disk moved, and the review is still open.
    expect(snapshotTree(source)).toEqual(before);
    expect(readChangeReview(source, result.changeReview!.id)!.status).toBe("open");
  });

  it("shows a file a human edited after the run as changed-since, before any undo runs", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");
    const result = await lease.commit();
    await lease.release();

    // The user is in the editor: they keep working on the file the run touched.
    writeFileSync(join(source, "Assets/Scripts/Existing.cs"), "the run's version, then mine", "utf8");

    const preview = (await previewUndo(source, result.changeReview!.id))!;
    const entry = preview.entries.find((e) => e.path === join("Assets", "Scripts", "Existing.cs"))!;
    expect(entry.state).toBe("changed-since");
    expect(entry.detail).toContain("after the run published it");
    expect(preview.complete).toBe(false);
    expect(preview.ready).toBe(1); // the created file is still the run's own
  });
});

describe("an undo leaves nothing over", () => {
  it("puts the files, the empty directories and HEAD back exactly as they were before the run", async () => {
    makeGitRepo();
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    put(source, "Assets/Scripts/Untouched.cs", "nobody touches this");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "existing");
    const baseHead = git(source, "rev-parse", "HEAD").trim();
    const before = snapshotTree(source);

    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Generated/New.cs", "brand new");
    git(lease.path, "add", "-A");
    git(lease.path, "commit", "-qm", "run: rewrote one file, added another");
    const result = await lease.commit();
    await lease.release();

    // The run really did land, in the files AND in the history.
    expect(readFileSync(join(source, "Assets/Scripts/Existing.cs"), "utf8")).toBe("the run's version");
    expect(git(source, "rev-parse", "HEAD").trim()).not.toBe(baseHead);
    expect(snapshotTree(source)).not.toEqual(before);

    const undo = await applyUndo(source, result.changeReview!.id);

    expect(undo.status).toBe("undone");
    expect(undo.leftOver).toEqual([]);
    expect(undo.historyMoved).toBe(true);
    expect(undo.restored).toEqual([join("Assets", "Scripts", "Existing.cs")]);
    expect(undo.deleted).toEqual([join("Assets", "Generated", "New.cs")]);
    // Every file, byte for byte — including the directory the run created,
    // which an undo that only removed files would have left behind empty.
    expect(snapshotTree(source)).toEqual(before);
    expect(existsSync(join(source, "Assets/Generated"))).toBe(false);
    expect(git(source, "rev-parse", "HEAD").trim()).toBe(baseHead);
    // …and nothing is staged or unstaged: the index went back with the ref.
    expect(git(source, "status", "--porcelain").trim()).toBe("");
    expect(readChangeReview(source, result.changeReview!.id)!.status).toBe("undone");
  });

  it("puts a file the run DELETED back, with its previous bytes", async () => {
    // The run removes a file the system itself generated — the one deletion
    // class a lease commit applies (system-owned-path.ts).
    put(source, "Assets/Scenes/InitTestScene123.unity", "generated scaffold");
    put(source, "Assets/Scripts/Keep.cs", "keep");
    const before = snapshotTree(source);
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    rmSync(join(lease.path, "Assets/Scenes/InitTestScene123.unity"));
    writeFileSync(join(lease.path, "Assets/Scripts/Keep.cs"), "the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();
    expect(result.deleted.some((d) => d.includes("InitTestScene123.unity"))).toBe(true);

    const preview = (await previewUndo(source, result.changeReview!.id))!;
    expect(preview.entries.find((e) => e.path.includes("InitTestScene123"))!.action).toBe("restore-deleted");
    const undo = await applyUndo(source, result.changeReview!.id);

    expect(undo.status).toBe("undone");
    expect(undo.leftOver).toEqual([]);
    expect(snapshotTree(source)).toEqual(before);
  });

  it("rolls the whole undo back when one file cannot be put back — the tree is exactly as the undo found it", async () => {
    put(source, "Assets/Scripts/A.cs", "user A");
    put(source, "Assets/Scripts/B.cs", "user B");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/A.cs"), "run A", "utf8");
    writeFileSync(join(lease.path, "Assets/Scripts/B.cs"), "run B", "utf8");
    const result = await lease.commit();
    await lease.release();
    const published = snapshotTree(source);

    // One of the two restores fails at the last step. Which one goes first is
    // not fixed, so the invariant is the one that matters: after a refused
    // undo, BOTH files hold what the run published.
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from: never, to: never) => {
      if (String(to).endsWith(join("Assets", "Scripts", "B.cs"))) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realRename(from, to);
    });
    try {
      const undo = await applyUndo(source, result.changeReview!.id);

      expect(undo.status).toBe("refused");
      expect(undo.restored).toEqual([]);
      expect(undo.leftOver).toEqual([]);
      expect(undo.reason).toContain("as it was before the undo");
      expect(snapshotTree(source)).toEqual(published);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a human editing the same files while the run works", () => {
  it("refuses the whole undo by default and names the file, changing nothing", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    put(source, "Assets/Scripts/Other.cs", "other, the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    writeFileSync(join(lease.path, "Assets/Scripts/Other.cs"), "other, the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();

    // The user was in the editor while the run published.
    writeFileSync(join(source, "Assets/Scripts/Existing.cs"), "mine, written after the run", "utf8");
    const published = snapshotTree(source);

    const undo = await applyUndo(source, result.changeReview!.id);

    expect(undo.status).toBe("refused");
    expect(undo.kept).toEqual([join("Assets", "Scripts", "Existing.cs")]);
    expect(undo.reason).toContain(join("Assets", "Scripts", "Existing.cs"));
    expect(undo.reason).toContain('onBlocked: "skip"');
    // Nothing moved — not even the file that WAS safe to revert.
    expect(snapshotTree(source)).toEqual(published);
    expect(readFileSync(join(source, "Assets/Scripts/Existing.cs"), "utf8")).toBe("mine, written after the run");
  });

  it("with onBlocked skip, reverts the rest and keeps the human's version byte for byte", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    put(source, "Assets/Scripts/Other.cs", "other, the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    writeFileSync(join(lease.path, "Assets/Scripts/Other.cs"), "other, the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();

    writeFileSync(join(source, "Assets/Scripts/Existing.cs"), "mine, written after the run", "utf8");

    const undo = await applyUndo(source, result.changeReview!.id, { onBlocked: "skip" });

    expect(undo.status).toBe("partially-undone");
    expect(undo.restored).toEqual([join("Assets", "Scripts", "Other.cs")]);
    expect(undo.kept).toEqual([join("Assets", "Scripts", "Existing.cs")]);
    expect(undo.leftOver).toEqual([]);
    expect(undo.reason).toContain("someone changed after the run");
    // The human's work is untouched; everything else is back to pre-run.
    expect(readFileSync(join(source, "Assets/Scripts/Existing.cs"), "utf8")).toBe("mine, written after the run");
    expect(readFileSync(join(source, "Assets/Scripts/Other.cs"), "utf8")).toBe("other, the user's version");
    expect(readChangeReview(source, result.changeReview!.id)!.status).toBe("partially-undone");
  });

  it("a human deleting the file the run wrote is a decision the undo does not overrule", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();

    rmSync(join(source, "Assets/Scripts/Existing.cs"));

    const preview = (await previewUndo(source, result.changeReview!.id))!;
    expect(preview.entries[0]!.state).toBe("changed-since");
    expect(preview.entries[0]!.detail).toContain("removed after the run published it");
    const undo = await applyUndo(source, result.changeReview!.id);
    expect(undo.status).toBe("refused");
    expect(existsSync(join(source, "Assets/Scripts/Existing.cs"))).toBe(false);
  });

  it("a touch or a chmod that changed no byte does not block a legitimate undo", async () => {
    // The opposite defect: a safety rule that refuses an undo the user is
    // entitled to. A stat moves on a chmod, a touch, or an xattr an indexer
    // writes — none of them is a concurrent edit, and the content says so.
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");
    const result = await lease.commit();
    await lease.release();

    const touched = join(source, "Assets/Scripts/Existing.cs");
    utimesSync(touched, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    chmodSync(join(source, "Assets/Scripts/New.cs"), 0o600);
    expect(statSync(touched).mtimeMs).toBeGreaterThan(Date.now());

    const preview = (await previewUndo(source, result.changeReview!.id))!;
    expect(preview.entries.map((e) => e.state)).toEqual(["ready", "ready"]);
    expect(preview.complete).toBe(true);

    const undo = await applyUndo(source, result.changeReview!.id);
    expect(undo.status).toBe("undone");
    expect(undo.leftOver).toEqual([]);
    expect(readFileSync(touched, "utf8")).toBe("the user's version");
    expect(existsSync(join(source, "Assets/Scripts/New.cs"))).toBe(false);
  });

  it("undoes a review the user had already decided to keep — changing your mind is not an error", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const before = snapshotTree(source);
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();

    expect(keepChanges(source, result.changeReview!.id)!.status).toBe("kept");
    const undo = await applyUndo(source, result.changeReview!.id);

    expect(undo.status).toBe("undone");
    expect(snapshotTree(source)).toEqual(before);
  });

  it("refuses to move HEAD when something committed after the run, and says which commit it found", async () => {
    makeGitRepo();
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "existing");
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    git(lease.path, "add", "-A");
    git(lease.path, "commit", "-qm", "run: rewrote a file");
    const result = await lease.commit();
    await lease.release();

    // The user commits their own work on top of the run's.
    put(source, "Assets/Scripts/Mine.cs", "my own work");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "mine");
    const published = snapshotTree(source);

    const preview = (await previewUndo(source, result.changeReview!.id))!;
    expect(preview.history!.state).toBe("moved-on");
    expect(preview.complete).toBe(false);
    const undo = await applyUndo(source, result.changeReview!.id);

    expect(undo.status).toBe("refused");
    expect(undo.reason).toContain("git history");
    expect(undo.historyMoved).toBe(false);
    expect(snapshotTree(source)).toEqual(published);
  });
});

describe("the undo is itself recoverable", () => {
  it("keeps the version the run published, so an undo is not a second way to lose work", async () => {
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");
    const result = await lease.commit();
    await lease.release();

    await applyUndo(source, result.changeReview!.id);

    const undone = join(changeReviewDir(source, result.changeReview!.id), "undone");
    expect(readFileSync(join(undone, "Assets", "Scripts", "Existing.cs"), "utf8")).toBe("the run's version");
    expect(readFileSync(join(undone, "Assets", "Scripts", "New.cs"), "utf8")).toBe("brand new");
    // No staging residue in the review directory either.
    expect(existsSync(join(changeReviewDir(source, result.changeReview!.id), "staging"))).toBe(false);
  });

  it("lists the reviews a project holds, newest first", async () => {
    put(source, "Assets/Scripts/A.cs", "user A");
    for (const body of ["run 1", "run 2"]) {
      const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
      writeFileSync(join(lease.path, "Assets/Scripts/A.cs"), body, "utf8");
      await lease.commit();
      await lease.release();
      await new Promise((r) => setTimeout(r, 5));
    }
    const reviews = listChangeReviews(source);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.createdAt).toBeGreaterThanOrEqual(reviews[1]!.createdAt);
  });
});

describe("a review id is a name, not a path", () => {
  it("refuses an id that tries to walk out of the review root", async () => {
    // The id arrives from a checkpoint row and from a portal request; `..` in it
    // would point every read — and every restore — somewhere else entirely.
    expect(() => changeReviewDir(source, "../../etc")).toThrow(/Not a change review id/);
    expect(await previewUndo(source, "../../etc")).toBeUndefined();
    const undo = await applyUndo(source, "..");
    expect(undo.status).toBe("refused");
    expect(undo.reason).toContain("no change review named");
  });
});

describe("the undo journal is a window, not an archive", () => {
  /** A review as it sits on disk, with the copy it keeps. */
  function synthetic(id: string, createdAt: number): void {
    const previous = previousCopyPath(source, id, join("Assets", "Scripts", "A.cs"));
    mkdirSync(dirname(previous), { recursive: true });
    writeFileSync(previous, `previous of ${id}`, "utf8");
    writeChangeReview({
      version: 1,
      reviewId: id,
      projectRoot: source,
      leaseId: id,
      createdAt,
      status: "kept",
      changes: [{ path: join("Assets", "Scripts", "A.cs"), action: "restore", previousPath: previous }],
    });
  }

  it("keeps the most recent reviews and retires the rest with the copies they hold", () => {
    for (let i = 0; i < 25; i++) synthetic(`review-${String(i).padStart(2, "0")}`, 1_700_000_000_000 + i * 1_000);

    const removed = pruneChangeReviews(source);

    expect(removed).toBe(5);
    const kept = listChangeReviews(source).map((r) => r.reviewId);
    expect(kept).toHaveLength(MAX_CHANGE_REVIEWS);
    expect(kept).toContain("review-24");
    expect(kept).not.toContain("review-00");
    expect(existsSync(changeReviewDir(source, "review-00"))).toBe(false);
  });

  it("a new commit's record retires the oldest by itself", async () => {
    for (let i = 0; i < MAX_CHANGE_REVIEWS; i++) synthetic(`review-${String(i).padStart(2, "0")}`, 1_700_000_000_000 + i * 1_000);
    put(source, "Assets/Scripts/A.cs", "user A");

    const lease = await manager().acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, "Assets/Scripts/A.cs"), "the run's version", "utf8");
    const result = await lease.commit();
    await lease.release();

    const ids = listChangeReviews(source).map((r) => r.reviewId);
    expect(ids).toHaveLength(MAX_CHANGE_REVIEWS);
    expect(ids).toContain(result.changeReview!.id);
    expect(ids).not.toContain("review-00");
    // The newest review still works after the prune.
    expect((await previewUndo(source, result.changeReview!.id))!.ready).toBe(1);
  });
});

/**
 * Codex round 12 #13 / #14: the window between "what an undo would do" and the
 * undo doing it.
 *
 * Both findings are the same shape — the apply phase trusted a measurement it
 * took earlier — and both end with the wrong BYTES in the user's project, so
 * every assertion here reads the file, never the return value:
 *
 *   #13 two undos of the same review, overlapping: the first loses git's
 *       compare-and-swap to the second and its rollback puts the version the
 *       user REJECTED back on disk, under a HEAD that says it was reverted.
 *   #14 a person edits a file while the undo is deciding: the restore trusts
 *       the hash from the preview and overwrites their edit.
 */
describe("an undo that overlaps something else", () => {
  /** Resolve after `ms` — a bounded wait, never a bet on a race being won. */
  const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** A run that rewrote one tracked file and committed, in a real repository. */
  async function publishIntoRepo(): Promise<{ reviewId: string; baseHead: string; before: Record<string, string> }> {
    makeGitRepo();
    put(source, "Assets/Scripts/Existing.cs", "the user's version");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "existing");
    const baseHead = git(source, "rev-parse", "HEAD").trim();
    const before = snapshotTree(source);
    const lease = await manager({ worktree: true }).acquireLease({ label: "t" });
    writeFileSync(join(lease.path, "Assets/Scripts/Existing.cs"), "the run's version", "utf8");
    put(lease.path, "Assets/Scripts/New.cs", "brand new");
    git(lease.path, "add", "-A");
    git(lease.path, "commit", "-qm", "run: rewrote one file, added another");
    const result = await lease.commit();
    await lease.release();
    expect(readFileSync(join(source, "Assets/Scripts/Existing.cs"), "utf8")).toBe("the run's version");
    return { reviewId: result.changeReview!.id, baseHead, before };
  }

  // ROUND 12 #13. The portal can send the same decision twice (a retry, two
  // tabs, a double click). Nothing serialized the two undos, and the copy each
  // one keeps to roll itself back lived at one fixed path per review.
  it("a second undo of the same review never leaves the rejected bytes on disk", async () => {
    const { reviewId, baseHead, before } = await publishIntoRepo();

    // The first undo is held at the moment it would move HEAD — after its file
    // phase, before git's compare-and-swap. Real interleaving, no bet: the
    // second undo starts only once the first has reached that point.
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let reached = (): void => {};
    const reachedUpdateRef = new Promise<void>((r) => { reached = r; });
    const held: WorkspaceCommandRunner = async (spec) => {
      if (spec.args.includes("update-ref")) {
        reached();
        await gate;
      }
      return runProcess({ ...spec, maxOutput: spec.maxOutput ?? 16_384 });
    };

    const first = applyUndo(source, reviewId, { runner: held });
    await Promise.race([reachedUpdateRef, after(4000)]);
    const second = applyUndo(source, reviewId);
    // Bounded: the fix makes `second` WAIT for `first`, so this must not depend
    // on it finishing.
    await Promise.race([second, after(1000)]);
    release();
    await Promise.all([first, second]);

    // THE MEASURE: the user rejected "the run's version". It may not be what
    // the project holds afterwards, whichever undo won.
    expect(readFileSync(join(source, "Assets/Scripts/Existing.cs"), "utf8")).toBe("the user's version");
    expect(existsSync(join(source, "Assets/Scripts/New.cs"))).toBe(false);
    expect(git(source, "rev-parse", "HEAD").trim()).toBe(baseHead);
    expect(snapshotTree(source)).toEqual(before);
  }, 20_000);

  // ROUND 12 #14. The preview said "ready"; by the time the restore ran, a
  // person had saved the file. Their bytes are not ours to discard — the same
  // rule the lease commit already follows.
  it("refuses a restore when the file changed between the preview and the write", async () => {
    const { reviewId } = await publishIntoRepo();
    const target = join(source, "Assets/Scripts/Existing.cs");

    // Held inside applyUndo's own preview (its only git read), which is exactly
    // the window the finding names.
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let previewing = (): void => {};
    const inPreview = new Promise<void>((r) => { previewing = r; });
    const held: WorkspaceCommandRunner = async (spec) => {
      if (spec.args.includes("rev-parse")) {
        previewing();
        await gate;
      }
      return runProcess({ ...spec, maxOutput: spec.maxOutput ?? 16_384 });
    };

    const undo = applyUndo(source, reviewId, { runner: held });
    await Promise.race([inPreview, after(4000)]);
    writeFileSync(target, "a person saved this while the undo was deciding", "utf8");
    release();
    const result = await undo;

    expect(readFileSync(target, "utf8")).toBe("a person saved this while the undo was deciding");
    expect(result.status).toBe("refused");
    expect(result.restored).toEqual([]);
    // The created file is part of the same all-or-nothing undo: it stays.
    expect(readFileSync(join(source, "Assets/Scripts/New.cs"), "utf8")).toBe("brand new");
  }, 20_000);

  it("refuses to delete a file the run created once a person has edited it", async () => {
    const { reviewId } = await publishIntoRepo();
    const created = join(source, "Assets/Scripts/New.cs");

    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let previewing = (): void => {};
    const inPreview = new Promise<void>((r) => { previewing = r; });
    const held: WorkspaceCommandRunner = async (spec) => {
      if (spec.args.includes("rev-parse")) {
        previewing();
        await gate;
      }
      return runProcess({ ...spec, maxOutput: spec.maxOutput ?? 16_384 });
    };

    const undo = applyUndo(source, reviewId, { runner: held });
    await Promise.race([inPreview, after(4000)]);
    writeFileSync(created, "brand new, and then my own line", "utf8");
    release();
    const result = await undo;

    expect(readFileSync(created, "utf8")).toBe("brand new, and then my own line");
    expect(result.status).toBe("refused");
    expect(result.deleted).toEqual([]);
  }, 20_000);
});

describe("a review record found in the project is untrusted input", () => {
  // The record lives inside the project, so a cloned or shared tree can carry one this process
  // never wrote. Nothing in it may make an undo write, delete or read outside the project.
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "change-review-outside-"));
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  function plant(reviewId: string, changes: unknown[], extra: Record<string, unknown> = {}): void {
    const dir = changeReviewDir(source, reviewId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "review.json"),
      JSON.stringify({ version: 1, reviewId, projectRoot: source, leaseId: reviewId, createdAt: 1, status: "open", changes, ...extra }),
      "utf8",
    );
  }
  const sha = (body: string): string => createHash("sha256").update(body).digest("hex");

  it("a target path that climbs out of the project is unrecoverable and nothing is written", async () => {
    const payload = put(source, ".strada/lease-conflicts/x/deleted/evil.desktop", "payload");
    const escape = relative(source, join(outside, "evil.desktop"));
    plant("planted-1", [{ path: escape, action: "restore-deleted", previousPath: payload, previousHash: sha("payload") }]);

    const preview = await previewUndo(source, "planted-1");
    expect(preview?.entries[0]?.state).toBe("unrecoverable");
    await applyUndo(source, "planted-1", { onBlocked: "skip" });
    expect(existsSync(join(outside, "evil.desktop"))).toBe(false);
  });

  it("a previous copy outside the project's change storage is never copied in", async () => {
    const secret = put(outside, "credentials", "secret");
    plant("planted-2", [{ path: "leak.txt", action: "restore-deleted", previousPath: secret, previousHash: sha("secret") }]);

    const preview = await previewUndo(source, "planted-2");
    expect(preview?.entries[0]?.state).toBe("unrecoverable");
    await applyUndo(source, "planted-2", { onBlocked: "skip" });
    expect(existsSync(join(source, "leak.txt"))).toBe(false);
  });

  it("a symlinked directory in the tree does not carry an undo outside the project", async () => {
    const payload = put(source, ".strada/lease-conflicts/x/deleted/evil.desktop", "payload");
    await fsp.symlink(outside, join(source, "Linked"), "dir");
    plant("planted-3", [{ path: join("Linked", "evil.desktop"), action: "restore-deleted", previousPath: payload, previousHash: sha("payload") }]);

    const preview = await previewUndo(source, "planted-3");
    expect(preview?.entries[0]?.state).toBe("unrecoverable");
    await applyUndo(source, "planted-3", { onBlocked: "skip" });
    expect(existsSync(join(outside, "evil.desktop"))).toBe(false);
  });

  it("a previous copy that is a link to a file outside the project is refused", async () => {
    put(outside, "credentials", "secret");
    const link = join(changeReviewDir(source, "planted-4"), "previous", "leak.txt");
    mkdirSync(dirname(link), { recursive: true });
    await fsp.symlink(join(outside, "credentials"), link);
    plant("planted-4", [{ path: "leak.txt", action: "restore-deleted", previousPath: link }]);

    const preview = await previewUndo(source, "planted-4");
    expect(preview?.entries[0]?.state).toBe("unrecoverable");
    await applyUndo(source, "planted-4", { onBlocked: "skip" });
    expect(existsSync(join(source, "leak.txt"))).toBe(false);
  });

  it("history whose base or head is not an object id is ignored", () => {
    plant("planted-5", [], { history: { base: "--output=/tmp/x", head: "a".repeat(40), commits: [], paths: [] } });
    expect(readChangeReview(source, "planted-5")?.history).toBeUndefined();
  });

  it("a legitimate restore from this review's own storage is still read as recoverable", () => {
    const prev = previousCopyPath(source, "legit-1", join("Assets", "A.cs"));
    plant("legit-1", [{ path: join("Assets", "A.cs"), action: "restore", previousPath: prev, previousHash: sha("a") }]);
    expect(readChangeReview(source, "legit-1")?.changes[0]?.unrecoverable).toBeUndefined();
  });
});
