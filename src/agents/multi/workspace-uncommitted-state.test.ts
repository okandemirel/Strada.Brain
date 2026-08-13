/**
 * The agent must see the project as the user sees it, not as it was last
 * committed.
 *
 * `git worktree add ... HEAD` seeds from the last commit. Everything the user
 * has not committed — an edit in progress, a file just created, one just
 * deleted — is simply absent from the workspace the agent works in. Asked to fix
 * a bug in a file the user just changed, the agent reads the committed version
 * and fixes something that is no longer there.
 *
 * Measured: the supported setup flow runs `git submodule add` for Strada.Core
 * and Strada.MCP and never commits. A task started straight after setup got a
 * workspace with no .gitmodules and no framework — the submodule checkout has
 * nothing to check out from a HEAD that predates the install. The run produced
 * 42 files that imitate a Strada module and reference none of its APIs.
 *
 * These run against a real git repository: the whole point is what git actually
 * puts in a worktree, which a mocked runner cannot tell us.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

/** A repo with one committed file, ready to be made dirty. */
function committedRepo(): string {
  const root = mkdtempSync(join(os.tmpdir(), "lease-dirty-test-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  writeFileSync(join(root, "Assets", "Player.cs"), "// committed\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

async function leaseFor(root: string) {
  const manager = new WorkspaceLeaseManager({
    projectRoot: root,
    leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-root-")),
  });
  const lease = await manager.acquireLease({ preferGitWorktree: true });
  expect(lease.kind, "these assertions only mean anything on the worktree path").toBe("git-worktree");
  return lease;
}

describe("workspaces carry the user's uncommitted work", () => {
  it("shows an uncommitted edit, not the committed version", async () => {
    const root = committedRepo();
    writeFileSync(join(root, "Assets", "Player.cs"), "// the user's work in progress\n");

    const lease = await leaseFor(root);
    const seen = readFileSync(join(lease.path, "Assets", "Player.cs"), "utf8");

    expect(seen, "the agent is reading the committed version of a file the user edited").toBe(
      "// the user's work in progress\n",
    );
    await lease.release();
  });

  it("shows a file the user created but never committed", async () => {
    // This is the setup-flow case: `git submodule add` writes .gitmodules and
    // the framework, and does not commit.
    const root = committedRepo();
    writeFileSync(join(root, ".gitmodules"), "[submodule \"Strada.Core\"]\n");
    mkdirSync(join(root, "Assets", "New"), { recursive: true });
    writeFileSync(join(root, "Assets", "New", "Board.cs"), "// new\n");

    const lease = await leaseFor(root);
    expect(existsSync(join(lease.path, ".gitmodules"))).toBe(true);
    expect(readFileSync(join(lease.path, "Assets", "New", "Board.cs"), "utf8")).toBe("// new\n");
    await lease.release();
  });

  it("does not show a file the user deleted", async () => {
    const root = committedRepo();
    rmSync(join(root, "Assets", "Player.cs"));

    const lease = await leaseFor(root);
    expect(existsSync(join(lease.path, "Assets", "Player.cs"))).toBe(false);
    await lease.release();
  });

  it("follows a rename to its new path", async () => {
    const root = committedRepo();
    git(root, "mv", "Assets/Player.cs", "Assets/Character.cs");

    const lease = await leaseFor(root);
    expect(existsSync(join(lease.path, "Assets", "Character.cs"))).toBe(true);
    expect(existsSync(join(lease.path, "Assets", "Player.cs"))).toBe(false);
    await lease.release();
  });

  it("ignores files git is ignoring", async () => {
    // Unity projects carry a large ignored Library/; seeding it into every
    // workspace would make each lease a full project copy.
    const root = committedRepo();
    writeFileSync(join(root, ".gitignore"), "Library/\n");
    mkdirSync(join(root, "Library"), { recursive: true });
    writeFileSync(join(root, "Library", "artifact.bin"), "x".repeat(1000));

    const lease = await leaseFor(root);
    expect(existsSync(join(lease.path, "Library", "artifact.bin"))).toBe(false);
    await lease.release();
  });

  it("does not send seeded uncommitted files back on commit", async () => {
    // The hazard in fixing the above: files copied in at seed time are not the
    // agent's work, and commit() must not treat them as such. An earlier version
    // of commit() made exactly this mistake in reverse and reverted a user's
    // edit to its committed contents.
    const root = committedRepo();
    writeFileSync(join(root, "Assets", "Player.cs"), "// the user's work in progress\n");

    const lease = await leaseFor(root);
    writeFileSync(join(lease.path, "Assets", "Agent.cs"), "// agent output\n");
    const result = await lease.commit();

    expect(result.written).toContain("Assets/Agent.cs");
    expect(result.written).not.toContain("Assets/Player.cs");
    expect(result.conflicts).toEqual([]);
    // And the user's in-progress edit survived untouched.
    expect(readFileSync(join(root, "Assets", "Player.cs"), "utf8")).toBe(
      "// the user's work in progress\n",
    );
    await lease.release();
  });
});
