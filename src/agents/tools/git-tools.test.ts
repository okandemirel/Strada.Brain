import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import {
  GitStatusTool,
  GitDiffTool,
  GitLogTool,
  GitCommitTool,
  GitBranchTool,
  GitBranchListTool,
  GitPushTool,
  GitStashTool,
} from "./git-tools.js";
import type { ToolContext } from "./tool.interface.js";
import { WorkspaceLeaseManager, type WorkspaceLease } from "../multi/workspace-lease-manager.js";

let tempDir: string;
let ctx: ToolContext;

// GIT_DIR and friends (set when this runs under a git hook) would aim the
// fixture's writes at the real repository; the temp repo is the only target.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function git(args: string) {
  execSync(`git ${args}`, { cwd: tempDir, stdio: "pipe", env: gitEnv });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "git-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
  git("init");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  git("config commit.gpgsign false");
  // Git for Windows defaults core.autocrlf to true, so a worktree checkout
  // would hand "hello\r\n" back; the tests compare the bytes they wrote.
  git("config core.autocrlf false");
  await writeFile(join(tempDir, "file.txt"), "hello\n");
  git("add .");
  git('commit -m "initial"');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("GitStatusTool", () => {
  const tool = new GitStatusTool();

  it("shows clean working tree", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("##");
    // Audited 2026-09-02: `-b` always prints the branch header, so the
    // "clean" sentence was unreachable and a clean tree came back as a bare
    // `## main` line. The header stays, and the verdict is stated.
    expect(result.content).toContain("Working tree is clean. No changes.");
  });

  it("does not call a dirty tree clean", async () => {
    await writeFile(join(tempDir, "file.txt"), "changed\n");
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain(" M file.txt");
    expect(result.content).not.toContain("Working tree is clean");
  });

  it("shows modified files", async () => {
    await writeFile(join(tempDir, "file.txt"), "changed\n");
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("M");
    expect(result.content).toContain("file.txt");
  });

  it("shows untracked files", async () => {
    await writeFile(join(tempDir, "new.txt"), "new\n");
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("??");
    expect(result.content).toContain("new.txt");
  });
});

describe("GitDiffTool", () => {
  const tool = new GitDiffTool();

  it("shows no diff for clean tree", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("No differences");
  });

  it("shows unstaged changes", async () => {
    await writeFile(join(tempDir, "file.txt"), "changed\n");
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("changed");
    expect(result.content).toContain("-hello");
  });

  it("shows staged changes", async () => {
    await writeFile(join(tempDir, "file.txt"), "staged\n");
    git("add file.txt");
    const result = await tool.execute({ staged: true }, ctx);
    expect(result.content).toContain("staged");
  });

  it("filters by path", async () => {
    await writeFile(join(tempDir, "file.txt"), "changed\n");
    await writeFile(join(tempDir, "other.txt"), "other\n");
    git("add other.txt");
    const result = await tool.execute({ path: "file.txt" }, ctx);
    expect(result.content).toContain("file.txt");
    expect(result.content).not.toContain("other.txt");
  });
});

describe("GitLogTool", () => {
  const tool = new GitLogTool();

  it("shows commit history", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("initial");
  });

  it("refuses a non-integer count and an unknown format; 'full' is honoured (TLS-17)", async () => {
    const nan = await tool.execute({ count: "abc" }, ctx);
    expect(nan.isError).toBe(true);
    expect(nan.content).toContain("'count' must be an integer");
    const bogus = await tool.execute({ format: "fancy" }, ctx);
    expect(bogus.isError).toBe(true);
    expect(bogus.content).toContain("'format' must be one of");
    const full = await tool.execute({ format: "full", count: "1" }, ctx);
    expect(full.isError).toBeFalsy();
    expect(full.content).toContain("Commit: Test");
  });

  it("respects count parameter", async () => {
    await writeFile(join(tempDir, "a.txt"), "a");
    git("add .");
    git('commit -m "second"');
    await writeFile(join(tempDir, "b.txt"), "b");
    git("add .");
    git('commit -m "third"');

    const result = await tool.execute({ count: 1 }, ctx);
    expect(result.content).toContain("third");
    expect(result.content).not.toContain("initial");
  });
});

describe("GitCommitTool", () => {
  const tool = new GitCommitTool();

  it("blocks commit in read-only mode", async () => {
    const result = await tool.execute(
      { message: "test" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("requires a message", async () => {
    const result = await tool.execute({ message: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("fails when nothing is staged", async () => {
    const result = await tool.execute({ message: "empty" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no staged");
  });

  it("stages and commits files", async () => {
    await writeFile(join(tempDir, "new.txt"), "content\n");
    const result = await tool.execute(
      { message: "add new file", files: ["new.txt"] },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("add new file");

    // Verify commit exists
    const log = execSync("git log --oneline -1", { cwd: tempDir }).toString();
    expect(log).toContain("add new file");
  });

  it("commits already-staged files without files param", async () => {
    await writeFile(join(tempDir, "staged.txt"), "content\n");
    git("add staged.txt");
    const result = await tool.execute({ message: "staged commit" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("staged commit");
  });

  // Audited 2026-09-02: `files` was cast to string[] with no runtime check, so
  // a single path passed as a string was iterated character by character and
  // spread into `git add -- A s s e t s / ...` — the commit failed with an
  // error naming neither the cause nor the file, and a hyphen anywhere in the
  // path produced "file path must not start with '-'" about a path the caller
  // never wrote. Nothing validates tool input against inputSchema upstream.
  it("accepts a single file path given as a string", async () => {
    await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
    await writeFile(join(tempDir, "Assets", "Scripts", "Player-Controller.cs"), "class P {}\n");
    const result = await tool.execute(
      { message: "add controller", files: "Assets/Scripts/Player-Controller.cs" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const log = execSync("git log --oneline -1", { cwd: tempDir }).toString();
    expect(log).toContain("add controller");
  });

  it("stages the trimmed path it validated, not the raw one", async () => {
    await writeFile(join(tempDir, "padded.txt"), "content\n");
    const result = await tool.execute({ message: "add padded", files: ["  padded.txt  "] }, ctx);
    expect(result.isError).toBeUndefined();
  });

  // git runs the repository's hooks with the environment it was given, and
  // that was the full process.env — provider keys and bot tokens included.
  it("runs repository hooks without this process's secrets", async () => {
    const dump = join(tempDir, ".git", "hook-env.txt");
    await writeFile(
      join(tempDir, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\nenv > "${dump.replace(/\\/g, "/")}"\n`,
      { mode: 0o755 },
    );
    process.env["STRADA_TEST_PROVIDER_API_KEY"] = "sk-must-not-leak";
    try {
      await writeFile(join(tempDir, "hooked.txt"), "content\n");
      const result = await tool.execute({ message: "hooked", files: ["hooked.txt"] }, ctx);
      expect(result.isError).toBeUndefined();
      const env = await readFile(dump, "utf-8");
      expect(env).not.toContain("sk-must-not-leak");
      expect(env).toMatch(/^PATH=/m);
    } finally {
      delete process.env["STRADA_TEST_PROVIDER_API_KEY"];
    }
  });
});

/**
 * Branch LISTING is a read: it runs `git branch -a --format=…` and touches
 * nothing. Classifying the whole git_branch tool as a write (d9053f66 — correct
 * for create/checkout) took listing away with it: in a write-disabled phase the
 * agent can no longer see which branch it is on, and in an approving phase every
 * `git_branch action:list` goes to the human approval queue.
 */
describe("GitBranchListTool (audited 2026-09-02)", () => {
  const tool = new GitBranchListTool();

  it("lists branches with no write context at all", async () => {
    const result = await tool.execute({}, { ...ctx, readOnly: true });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/main|master/);
  });

  it("shows a branch created after it was registered", async () => {
    git("branch feature/listed");
    const result = await tool.execute({}, { ...ctx, readOnly: true });
    expect(result.content).toContain("feature/listed");
  });

  it("takes no branch name and cannot check anything out", async () => {
    git("branch feature/not-taken");
    const before = execSync("git rev-parse --abbrev-ref HEAD", { cwd: tempDir })
      .toString().trim();
    await tool.execute({ action: "checkout", name: "feature/not-taken" }, ctx);
    const after = execSync("git rev-parse --abbrev-ref HEAD", { cwd: tempDir })
      .toString().trim();
    expect(after).toBe(before);
  });
});

describe("GitBranchTool", () => {
  const tool = new GitBranchTool();

  it("lists branches", async () => {
    const result = await tool.execute({ action: "list" }, ctx);
    // Git default branch can be 'main' or 'master' depending on version
    expect(result.content).toMatch(/main|master/);
  });

  it("creates a new branch", async () => {
    const result = await tool.execute(
      { action: "create", name: "feature/test" },
      ctx,
    );
    expect(result.content).toContain("feature/test");
  });

  it("checks out a branch", async () => {
    git("branch feature/checkout");
    const result = await tool.execute(
      { action: "checkout", name: "feature/checkout" },
      ctx,
    );
    expect(result.content).toContain("feature/checkout");
  });

  // `git checkout <name>` reads a name that is not a ref as a pathspec and
  // restores it from the index: uncommitted edits vanished while the tool
  // reported "Switched to branch".
  it.each([".", "file.txt"])("never treats checkout name %j as a path to restore", async (name) => {
    await writeFile(join(tempDir, "file.txt"), "uncommitted work\n");
    const result = await tool.execute({ action: "checkout", name }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("Switched to branch");
    expect(await readFile(join(tempDir, "file.txt"), "utf-8")).toBe("uncommitted work\n");
  });

  it("requires name for create", async () => {
    const result = await tool.execute({ action: "create" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("blocks create in read-only mode", async () => {
    const result = await tool.execute(
      { action: "create", name: "test" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("blocks checkout in read-only mode", async () => {
    const result = await tool.execute(
      { action: "checkout", name: "master" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("blocks branch names starting with dash", async () => {
    const result = await tool.execute(
      { action: "create", name: "--delete" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must not start with '-'");
  });

  it("blocks branch names with shell metacharacters", async () => {
    const result = await tool.execute(
      { action: "create", name: "test;rm -rf /" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid characters");
  });
});

describe("GitStashTool", () => {
  const tool = new GitStashTool();

  it("stashes changes", async () => {
    await writeFile(join(tempDir, "file.txt"), "stash me\n");
    const result = await tool.execute({}, ctx);
    expect(result.content.toLowerCase()).toMatch(/stash|saved|no local changes/i);
  });

  it("lists stashes", async () => {
    const result = await tool.execute({ action: "list" }, ctx);
    // Either shows stash entries or "No stashes found"
    expect(result.isError).toBeUndefined();
  });

  // Audited 2026-09-02: a temp-copy workspace lease has no .git, so `git stash
  // list` exits 128 with empty stdout — and the tool said "No stashes found."
  it("reports a failed `git stash list` as an error, not as an empty stash list", async () => {
    const noRepo = await mkdtemp(join(tmpdir(), "not-a-repo-"));
    try {
      const result = await tool.execute(
        { action: "list" },
        { projectPath: noRepo, workingDirectory: noRepo, readOnly: false },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not a git repository/i);
      expect(result.content).not.toContain("No stashes found");
    } finally {
      await rm(noRepo, { recursive: true, force: true });
    }
  });

  it("stashes with a message", async () => {
    // Modify a tracked file so there's something to stash
    await writeFile(join(tempDir, "file.txt"), "stash me\n");
    const result = await tool.execute(
      { action: "push", message: "my stash" },
      ctx,
    );
    expect(result.content.toLowerCase()).toMatch(/stash|saved/i);
  });

  it("blocks push in read-only mode", async () => {
    const result = await tool.execute(
      { action: "push" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("blocks pop in read-only mode", async () => {
    const result = await tool.execute(
      { action: "pop" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("blocks drop in read-only mode", async () => {
    const result = await tool.execute(
      { action: "drop" },
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("allows list in read-only mode", async () => {
    const result = await tool.execute(
      { action: "list" },
      { ...ctx, readOnly: true },
    );
    // list is not a write operation, should not be blocked
    expect(result.isError).toBeUndefined();
  });

  // A workspace lease is a linked worktree of the user's checkout, and
  // refs/stash is shared by every worktree of a repository. A push on the
  // lease's clean tree stashed nothing yet reported success, and the pop that
  // followed took the USER's entry into the lease and dropped it from their
  // list (audit tools#2).
  describe("in a linked worktree (refs/stash is shared)", () => {
    let leaseRoot: string;
    let lease: string;
    let leaseCtx: ToolContext;
    const gitIn = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv }).toString().trim();

    beforeEach(async () => {
      leaseRoot = await mkdtemp(join(tmpdir(), "git-stash-lease-"));
      lease = join(leaseRoot, "lease");
      gitIn(tempDir, "worktree", "add", "--detach", lease, "HEAD");
      leaseCtx = { projectPath: lease, workingDirectory: lease, readOnly: false };
    });

    afterEach(async () => {
      await rm(leaseRoot, { recursive: true, force: true });
    });

    it("a push that saved nothing says so, and the pop after it leaves the user's entry alone", async () => {
      await writeFile(join(tempDir, "file.txt"), "USER WIP\n");
      gitIn(tempDir, "stash", "push", "-m", "USER WIP");

      // The lease tree is clean, as it is right after the seed commit.
      const push = await tool.execute({ action: "push" }, leaseCtx);
      const pop = await tool.execute({ action: "pop" }, leaseCtx);
      expect(await readFile(join(lease, "file.txt"), "utf-8")).toBe("hello\n");
      expect(gitIn(tempDir, "stash", "list")).toContain("USER WIP");
      expect(pop.isError).toBe(true);
      expect(push.content).toMatch(/nothing was stashed/i);
    });

    it("never drops or lists the user's stash entry", async () => {
      await writeFile(join(tempDir, "file.txt"), "USER WIP\n");
      gitIn(tempDir, "stash", "push", "-m", "USER WIP");

      const drop = await tool.execute({ action: "drop" }, leaseCtx);
      expect(gitIn(tempDir, "stash", "list")).toContain("USER WIP");
      expect(drop.isError).toBe(true);

      const list = await tool.execute({ action: "list" }, leaseCtx);
      expect(list.isError).toBeUndefined();
      expect(list.content).not.toContain("USER WIP");
      expect(list.content).toContain("1 other stash entry");
    });

    it("pops the entry it pushed here, not a newer one another checkout pushed", async () => {
      await writeFile(join(lease, "file.txt"), "lease work\n");
      const push = await tool.execute({ action: "push", message: "lease work" }, leaseCtx);
      expect(push.isError).toBeFalsy();
      expect(await readFile(join(lease, "file.txt"), "utf-8")).toBe("hello\n");

      await writeFile(join(tempDir, "file.txt"), "USER LATER\n");
      gitIn(tempDir, "stash", "push", "-m", "USER LATER");

      const pop = await tool.execute({ action: "pop" }, leaseCtx);
      expect(pop.isError).toBeFalsy();
      expect(await readFile(join(lease, "file.txt"), "utf-8")).toBe("lease work\n");
      const left = gitIn(tempDir, "stash", "list");
      expect(left).toContain("USER LATER");
      expect(left).not.toContain("lease work");
    });
  });
});

describe("GitPushTool", () => {
  const tool = new GitPushTool();

  it("blocks push in read-only mode", async () => {
    const result = await tool.execute(
      {},
      { ...ctx, readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("fails gracefully when no remote", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    // No remote configured, should fail gracefully
  });

  it("blocks remote name starting with dash", async () => {
    const result = await tool.execute(
      { remote: "--receive-pack=evil" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must not start with '-'");
  });

  it("blocks branch starting with dash", async () => {
    const result = await tool.execute(
      { branch: "-o evil" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must not start with '-'");
  });

  // `branch` was handed to git as a refspec verbatim, so its syntax could
  // force-update or delete the remote branch, and `remote` could be any URL
  // or path rather than a configured remote.
  describe("pushes only a branch, to a configured remote", () => {
    let bare: string;
    let current: string;
    const gitIn = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    const remoteHead = (ref: string): string =>
      gitIn(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${ref}`);

    beforeEach(async () => {
      bare = await mkdtemp(join(tmpdir(), "git-push-remote-"));
      gitIn(bare, "init", "--bare");
      current = gitIn(tempDir, "rev-parse", "--abbrev-ref", "HEAD");
      gitIn(tempDir, "remote", "add", "origin", bare);
      gitIn(tempDir, "push", "origin", `refs/heads/${current}:refs/heads/${current}`);
    });

    afterEach(async () => {
      await rm(bare, { recursive: true, force: true });
    });

    it("pushes the named branch to the configured remote", async () => {
      await writeFile(join(tempDir, "file.txt"), "second\n");
      gitIn(tempDir, "commit", "-am", "second");
      const result = await tool.execute({ remote: "origin", branch: current, set_upstream: true }, ctx);
      expect(result.isError).toBeFalsy();
      expect(remoteHead(current)).toBe(gitIn(tempDir, "rev-parse", "HEAD"));
      expect(gitIn(tempDir, "rev-parse", "--abbrev-ref", `${current}@{upstream}`)).toBe(`origin/${current}`);
    });

    it("refuses a branch that is a refspec", async () => {
      const before = remoteHead(current);
      for (const branch of ["+HEAD:" + current, ":" + current, "HEAD:refs/heads/other"]) {
        const result = await tool.execute({ remote: "origin", branch }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("not a valid branch name");
      }
      expect(remoteHead(current)).toBe(before);
      expect(remoteHead("other")).toBe("");
    });

    it("never force-updates the remote branch", async () => {
      const before = remoteHead(current);
      await writeFile(join(tempDir, "file.txt"), "rewritten\n");
      gitIn(tempDir, "commit", "-a", "--amend", "-m", "rewritten");
      const result = await tool.execute({ remote: "origin", branch: `+${current}` }, ctx);
      expect(result.isError).toBe(true);
      expect(remoteHead(current)).toBe(before);
    });

    it("refuses a URL or path in place of a configured remote name", async () => {
      const other = await mkdtemp(join(tmpdir(), "git-push-other-"));
      try {
        gitIn(other, "init", "--bare");
        // Forward slashes, which git takes on Windows too: a backslash is
        // refused earlier as an invalid character, and this is about the path
        // itself not being a configured remote.
        const remote = other.split(sep).join("/");
        const result = await tool.execute({ remote, branch: current }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("not a configured remote");
        expect(result.content).toContain("origin");
        expect(gitIn(other, "for-each-ref")).toBe("");
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });
});

describe("Git argument injection", () => {
  it("blocks ref starting with dash in diff", async () => {
    const tool = new GitDiffTool();
    const result = await tool.execute({ ref: "--output=/etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must not start with '-'");
  });

  it("blocks file path with shell chars in commit", async () => {
    const tool = new GitCommitTool();
    await writeFile(join(tempDir, "test.txt"), "content");
    const result = await tool.execute(
      { message: "test", files: ["test;rm -rf /"] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid characters");
  });

  it("blocks file path starting with dash in commit", async () => {
    const tool = new GitCommitTool();
    const result = await tool.execute(
      { message: "test", files: ["--cached"] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must not start with '-'");
  });
});

// file_read refuses `.env` and shell_exec refuses `git add .env`, yet
// git_commit staged and committed it and git_diff printed it (audit tools#3).
describe("the sensitive-file blocklist holds for the git tools", () => {
  const SECRET = "OPENAI_API_KEY=sk-live-XXXX";
  const head = () => execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();
  const stagedNames = () => execSync("git diff --cached --name-only", { cwd: tempDir }).toString().trim();

  it("git_commit refuses a named secret file and one reached through '.'", async () => {
    await writeFile(join(tempDir, ".env"), `${SECRET}\n`);
    await writeFile(join(tempDir, "server.pem"), "-----BEGIN EC PRIVATE KEY-----\n");
    await writeFile(join(tempDir, "Player.cs"), "class Player {}\n");
    const before = head();
    for (const files of [[".env"], ["server.pem"], ["."], ["Player.cs", "*"]]) {
      const result = await new GitCommitTool().execute({ message: "wip", files }, ctx);
      expect(result.isError, JSON.stringify(files)).toBe(true);
      expect(result.content).toMatch(/sensitive/i);
      expect(head()).toBe(before);
      expect(stagedNames()).toBe("");
    }
  });

  it("git_commit refuses a secret file something else already staged", async () => {
    await writeFile(join(tempDir, ".env"), `${SECRET}\n`);
    await writeFile(join(tempDir, "Player.cs"), "class Player {}\n");
    git("add .env");
    const before = head();
    const result = await new GitCommitTool().execute({ message: "wip", files: ["Player.cs"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(".env");
    expect(head()).toBe(before);
  });

  it("git_commit still commits the files it was asked to beside an untracked secret", async () => {
    await writeFile(join(tempDir, ".env"), `${SECRET}\n`);
    await writeFile(join(tempDir, "Player.cs"), "class Player {}\n");
    const result = await new GitCommitTool().execute({ message: "add player", files: ["Player.cs"] }, ctx);
    expect(result.isError).toBeUndefined();
    expect(execSync("git show --name-only --format= HEAD", { cwd: tempDir }).toString().trim()).toBe("Player.cs");
  });

  // A deletion carries none of the secret, and removing a tracked one is the fix.
  it("git_commit commits the removal of a tracked secret file", async () => {
    await writeFile(join(tempDir, ".env"), `${SECRET}\n`);
    git("add .env");
    git('commit -m "leaked"');
    await rm(join(tempDir, ".env"));
    const named = await new GitCommitTool().execute({ message: "remove env", files: [".env"] }, ctx);
    expect(named.content).not.toMatch(/sensitive/i);
    expect(named.isError).toBeUndefined();
    expect(execSync("git show --name-status --format= HEAD", { cwd: tempDir }).toString().trim()).toBe("D\t.env");

    await writeFile(join(tempDir, "server.pem"), "-----BEGIN EC PRIVATE KEY-----\n");
    git("add server.pem");
    git('commit -m "leaked pem"');
    git("rm --cached server.pem");
    const staged = await new GitCommitTool().execute({ message: "untrack pem" }, ctx);
    expect(staged.isError).toBeUndefined();
    expect(execSync("git show --name-status --format= HEAD", { cwd: tempDir }).toString().trim()).toBe("D\tserver.pem");
  });

  it("git_diff never prints a secret file, named, by ref, or as a blob range", async () => {
    await writeFile(join(tempDir, ".env"), "OPENAI_API_KEY=sk-live-ONE\n");
    git("add .env");
    git('commit -m "env one"');
    await writeFile(join(tempDir, ".env"), "OPENAI_API_KEY=sk-live-TWO\n");
    git("add .env");
    git('commit -m "env two"');
    await writeFile(join(tempDir, ".env"), "OPENAI_API_KEY=sk-live-THREE\n");
    await writeFile(join(tempDir, "file.txt"), "changed\n");

    const named = await new GitDiffTool().execute({ path: ".env" }, ctx);
    expect(named.isError).toBe(true);
    expect(named.content).not.toContain("sk-live");

    const all = await new GitDiffTool().execute({}, ctx);
    expect(all.content).toContain("+changed");
    expect(all.content).not.toContain("sk-live");
    expect(all.content).toContain(".env");

    const byRef = await new GitDiffTool().execute({ ref: "HEAD~2" }, ctx);
    expect(byRef.content).toContain("+changed");
    expect(byRef.content).not.toContain("sk-live");

    const blobs = await new GitDiffTool().execute({ ref: "HEAD~1:.env..HEAD:.env" }, ctx);
    expect(blobs.isError).toBe(true);
    expect(blobs.content).not.toContain("sk-live");

    const dir = await new GitDiffTool().execute({ path: "." }, ctx);
    expect(dir.content).toContain("+changed");
    expect(dir.content).not.toContain("sk-live");

    git("add .env file.txt");
    const staged = await new GitDiffTool().execute({ staged: true }, ctx);
    expect(staged.content).toContain("+changed");
    expect(staged.content).not.toContain("sk-live");
  });

  // For two blobs or two trees `git diff --name-only` names only the right
  // side, relative to the subtree, so the listing never saw the secret.
  it("git_diff refuses a blob pair or a subtree, whatever names the listing would show", async () => {
    await writeFile(join(tempDir, ".env"), "OPENAI_API_KEY=sk-live-ONE\n");
    await mkdir(join(tempDir, ".ssh"));
    await writeFile(join(tempDir, ".ssh", "config"), "IdentityFile sk-live-SSH\n");
    git("add .env .ssh");
    git('commit -m "secrets"');
    const emptyTree = execSync("git mktree", { cwd: tempDir, input: "" }).toString().trim();
    const blob = (spec: string) => execSync(`git rev-parse ${spec}`, { cwd: tempDir }).toString().trim();

    for (const ref of [
      "HEAD:.env..HEAD:file.txt",
      `${emptyTree}..HEAD:.ssh`,
      `${blob("HEAD:.env")}..${blob("HEAD:file.txt")}`,
      "HEAD^{tree}",
    ]) {
      const result = await new GitDiffTool().execute({ ref }, ctx);
      expect(result.content, ref).not.toContain("sk-live");
      expect(result.isError, ref).toBe(true);
    }

    await writeFile(join(tempDir, "file.txt"), "changed\n");
    git("add file.txt");
    git('commit -m "change"');
    const range = await new GitDiffTool().execute({ ref: "HEAD~1..HEAD" }, ctx);
    expect(range.isError).toBeUndefined();
    expect(range.content).toContain("+changed");
  });
});

// Every git-worktree lease holds the lease manager's owner file, untracked, at
// its top level, and the blocklist covers it so the agent cannot forge it. A
// commit check that read it as a secret refused every `files: ["."]` in a lease.
describe("git_commit in a workspace lease", () => {
  let leaseRoot: string;
  let lease: WorkspaceLease;
  let leaseCtx: ToolContext;
  const inLease = (...args: string[]): string =>
    execFileSync("git", args, { cwd: lease.path, stdio: "pipe", env: gitEnv }).toString().trim();

  beforeEach(async () => {
    leaseRoot = await mkdtemp(join(tmpdir(), "git-commit-lease-"));
    lease = await new WorkspaceLeaseManager({ projectRoot: tempDir, leaseRoot }).acquireLease();
    expect(lease.kind, "these assertions only mean anything on the worktree path").toBe("git-worktree");
    expect(inLease("status", "--porcelain")).toContain("?? .strada-lease-owner.json");
    leaseCtx = { projectPath: lease.path, workingDirectory: lease.path, readOnly: false };
  });

  afterEach(async () => {
    await lease.release();
    await rm(leaseRoot, { recursive: true, force: true });
  });

  it("commits '.' and '*' without the lease's own bookkeeping", async () => {
    for (const [name, files] of [["Player.cs", ["."]], ["Enemy.cs", ["*"]]] as const) {
      await writeFile(join(lease.path, name), "class C {}\n");
      const result = await new GitCommitTool().execute({ message: `add ${name}`, files: [...files] }, leaseCtx);
      expect(result.content, name).not.toMatch(/sensitive/i);
      expect(result.isError, name).toBeUndefined();
      expect(inLease("show", "--name-only", "--format=", "HEAD")).toBe(name);
    }
    expect(inLease("status", "--porcelain")).toBe("?? .strada-lease-owner.json");
  });

  it("commits what a shell `git add -A` staged, and leaves the owner file out of it", async () => {
    await writeFile(join(lease.path, "Player.cs"), "class Player {}\n");
    inLease("add", "-A");
    const result = await new GitCommitTool().execute({ message: "add player" }, leaseCtx);
    expect(result.content).not.toMatch(/sensitive/i);
    expect(result.isError).toBeUndefined();
    expect(inLease("show", "--name-only", "--format=", "HEAD")).toBe("Player.cs");
    expect(inLease("status", "--porcelain")).toBe("?? .strada-lease-owner.json");
  });

  it("still refuses a file of that name anywhere but the lease's top level", async () => {
    await mkdir(join(lease.path, "Assets"));
    await writeFile(join(lease.path, "Assets", ".strada-lease-owner.json"), "{}\n");
    const head = inLease("rev-parse", "HEAD");
    const result = await new GitCommitTool().execute({ message: "wip", files: ["."] }, leaseCtx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Assets/.strada-lease-owner.json");
    expect(inLease("rev-parse", "HEAD")).toBe(head);
  });
});

describe("git path arguments accept the Windows separator (TLS-15)", () => {
  it("a backslash in a path is a separator, not an invalid character; in a ref it is still refused", async () => {
    const diff = await new GitDiffTool().execute({ path: "Assets\\Scripts\\Player.cs" }, ctx);
    const log = await new GitLogTool().execute({ path: "Assets\\Scripts\\Player.cs" }, ctx);
    const commit = await new GitCommitTool().execute({ message: "m", files: ["Assets\\Player.cs"] }, ctx);
    for (const result of [diff, log, commit]) expect(result.content).not.toContain("invalid characters");
    const ref = await new GitDiffTool().execute({ ref: "HEAD\\x" }, ctx);
    expect(ref.content).toContain("invalid characters");
  });
});
