/**
 * A file the agent deleted is a decision the project should hear about.
 *
 * commit() adds and updates and never deletes, which is right — removing a
 * user's files is not a commit's call. But saying nothing means the project
 * silently diverges from what the agent believes it produced.
 *
 * Measured: a run repaired four malformed .asmdef files, then removed them while
 * restructuring. The lease ended clean; the project kept the original broken
 * copies, and nothing reported the gap. The next run started from a project the
 * previous one believed it had fixed, and spent its first hour repairing them
 * again.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

/** A project holding the given committed files. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(os.tmpdir(), "lease-deletions-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

function manager(root: string): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({
    projectRoot: root,
    leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-deletions-root-")),
  });
}

describe("files the agent deleted", () => {
  it("reports them without removing them", async () => {
    const root = repo({ "Assets/Broken.asmdef": "{ bad json", "Assets/Keep.cs": "// keep\n" });
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    rmSync(join(lease.path, "Assets", "Broken.asmdef"));
    const result = await lease.commit();

    expect(result.removed).toContain("Assets/Broken.asmdef");
    // Reported, not acted on: the file is still the user's to keep or drop.
    expect(existsSync(join(root, "Assets", "Broken.asmdef"))).toBe(true);
    expect(existsSync(join(root, "Assets", "Keep.cs"))).toBe(true);

    await lease.release();
  });

  it("says nothing when the agent deleted nothing", async () => {
    const root = repo({ "Assets/Keep.cs": "// keep\n" });
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    writeFileSync(join(lease.path, "Assets", "New.cs"), "// new\n");
    const result = await lease.commit();

    expect(result.removed).toEqual([]);
    expect(result.written).toContain("Assets/New.cs");

    await lease.release();
  });

  it("does not report a file the agent replaced", async () => {
    // Rewriting a file is not deleting it; only a genuine removal counts.
    const root = repo({ "Assets/Board.cs": "// old\n" });
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    writeFileSync(join(lease.path, "Assets", "Board.cs"), "// new\n");
    const result = await lease.commit();

    expect(result.removed).toEqual([]);
    expect(readFileSync(join(root, "Assets", "Board.cs"), "utf8")).toBe("// new\n");

    await lease.release();
  });

  it("does not report a file the user had already removed themselves", async () => {
    // Gone from both sides is not the agent's doing, and telling the user their
    // own deletion "diverged" would be noise.
    const root = repo({ "Assets/Gone.cs": "// x\n" });
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    rmSync(join(lease.path, "Assets", "Gone.cs"));
    rmSync(join(root, "Assets", "Gone.cs"));
    const result = await lease.commit();

    expect(result.removed).toEqual([]);

    await lease.release();
  });
});
