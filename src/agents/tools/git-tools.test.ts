import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  GitStatusTool,
  GitDiffTool,
  GitLogTool,
  GitCommitTool,
  GitBranchTool,
  GitPushTool,
  GitStashTool,
} from "./git-tools.js";
import type { ToolContext } from "./tool.interface.js";

let tempDir: string;
let ctx: ToolContext;

function git(args: string) {
  execSync(`git ${args}`, { cwd: tempDir, stdio: "pipe" });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "git-test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
  git("init");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  git("config commit.gpgsign false");
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
    // Status should only have the branch line for clean tree
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
});

describe("GitBranchTool", () => {
  const tool = new GitBranchTool();

  it("lists branches", async () => {
    const result = await tool.execute({ action: "list" }, ctx);
    expect(result.content).toContain("master");
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
