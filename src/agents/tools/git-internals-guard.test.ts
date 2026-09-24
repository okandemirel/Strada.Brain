import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileEditTool } from "./file-edit.js";
import { FileDeleteDirectoryTool, FileDeleteTool, FileRenameTool } from "./file-manage.js";
import { FileWriteTool } from "./file-write.js";
import type { ToolContext } from "./tool.interface.js";

/**
 * validatePath blocked only `.git/config` and `.git/credentials`, so the file
 * tools could write hooks (programs git_commit then runs), rewrite HEAD or the
 * index, and delete `.git/` wholesale.
 */
describe("file tools refuse to write or delete git internals", () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-internals-"));
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "index"), "index");
    writeFileSync(join(root, "notes.txt"), "notes\n");
    ctx = { projectPath: root, workingDirectory: root, readOnly: false };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("file_write into .git/hooks is refused and nothing is created", async () => {
    const result = await new FileWriteTool().execute({ path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(".git/");
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("file_write through a symlinked directory into .git is refused", async () => {
    symlinkSync(join(root, ".git", "hooks"), join(root, "hooks-link"), "junction");
    const result = await new FileWriteTool().execute({ path: "hooks-link/post-checkout", content: "#!/bin/sh\n" }, ctx);
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, ".git", "hooks", "post-checkout"))).toBe(false);
  });

  it("file_write of a nested repository's .git entry is refused", async () => {
    const result = await new FileWriteTool().execute({ path: "Packages/Sub/.git", content: "gitdir: /elsewhere\n" }, ctx);
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, "Packages", "Sub", ".git"))).toBe(false);
  });

  it("file_edit of .git/HEAD is refused and the file is unchanged", async () => {
    const result = await new FileEditTool().execute(
      { path: ".git/HEAD", old_string: "refs/heads/main", new_string: "refs/heads/other" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, ".git", "HEAD"), "utf-8")).toBe("ref: refs/heads/main\n");
  });

  it("file_delete of .git/index is refused", async () => {
    const result = await new FileDeleteTool().execute({ path: ".git/index", force: true }, ctx);
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, ".git", "index"))).toBe(true);
  });

  it("file_rename into or out of .git is refused", async () => {
    const into = await new FileRenameTool().execute({ old_path: "notes.txt", new_path: ".git/hooks/pre-push" }, ctx);
    expect(into.isError).toBe(true);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);

    const out = await new FileRenameTool().execute({ old_path: ".git/HEAD", new_path: "HEAD.bak" }, ctx);
    expect(out.isError).toBe(true);
    expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
  });

  it("file_delete_directory of .git is refused", async () => {
    const result = await new FileDeleteDirectoryTool().execute({ path: ".git" }, ctx);
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
  });

  it("names that only start with .git are still ordinary files", async () => {
    const ignore = await new FileWriteTool().execute({ path: ".gitignore", content: "Library/\n" }, ctx);
    expect(ignore.isError).toBeFalsy();
    const workflow = await new FileWriteTool().execute({ path: ".github/workflows/ci.yml", content: "on: push\n" }, ctx);
    expect(workflow.isError).toBeFalsy();
  });
});
