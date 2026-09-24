// SEC-2: project-confined, bounded file access for the bundled file skills.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../agents/tools/tool.interface.js";
import {
  readRegularFile,
  resolveProjectPath,
  searchLinesInWorker,
  walkProjectFiles,
  type ProjectWalk,
  type ProjectWalkLimits,
} from "./project-files.js";

let base: string;
let project: string;
let context: ToolContext;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "strada-project-files-")));
  project = join(base, "project");
  await mkdir(project);
  context = { projectPath: project, workingDirectory: base, readOnly: false };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, content = "x"): Promise<string> {
  const full = join(project, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  return full;
}

async function walkAll(root: string, limits?: ProjectWalkLimits): Promise<{ files: string[]; walk: ProjectWalk }> {
  const walk: ProjectWalk = { truncated: false };
  const files: string[] = [];
  for await (const file of walkProjectFiles(root, walk, limits)) files.push(file.relPath);
  return { files: files.sort(), walk };
}

describe("resolveProjectPath", () => {
  it("resolves relative input against the project root, and refuses what path-guard refuses", async () => {
    await put("a.txt");
    expect(await resolveProjectPath(context, "a.txt")).toEqual({ ok: true, fullPath: join(project, "a.txt") });
    expect(await resolveProjectPath(context, ".")).toEqual({ ok: true, fullPath: project });
    expect(await resolveProjectPath(context, "..")).toMatchObject({ ok: false, error: expect.stringContaining("outside the project") });
    expect(await resolveProjectPath(context, ".env")).toMatchObject({ ok: false, error: expect.stringContaining("sensitive") });
    await mkdir(join(project, ".ssh"));
    expect(await resolveProjectPath(context, ".ssh")).toMatchObject({ ok: false, error: expect.stringContaining("sensitive") });
    expect(await resolveProjectPath({ ...context, projectPath: "" }, ".")).toMatchObject({ ok: false });
  });
});

describe("walkProjectFiles", () => {
  it("yields regular files only, never through symlinks, never sensitive entries", async () => {
    await put("a.txt");
    await put("dir/b.cs");
    await put(".env");
    await put("dir/.ssh/id_ed25519");
    await put("node_modules/pkg/index.js");
    await symlink(join(project, "a.txt"), join(project, "link.txt"));
    await symlink(join(project, "dir"), join(project, "link-dir"));
    if (process.platform !== "win32") spawnSync("mkfifo", [join(project, "pipe")]);
    expect((await walkAll(project)).files).toEqual(["a.txt", join("dir", "b.cs")]);
  });

  it("stops at the entry and depth limits and says so", async () => {
    for (let i = 0; i < 5; i++) await put(`f${i}.txt`);
    const capped = await walkAll(project, { maxDepth: 20, maxEntries: 3 });
    expect(capped.files).toHaveLength(3);
    expect(capped.walk.truncated).toBe(true);
    expect((await walkAll(project, { maxDepth: 20, maxEntries: 5 })).walk.truncated).toBe(false);

    await put("d1/d2/deep.txt");
    const shallow = await walkAll(join(project, "d1"), { maxDepth: 0, maxEntries: 100 });
    expect(shallow.files).toEqual([]);
    expect(shallow.walk.truncated).toBe(true);
    expect((await walkAll(join(project, "d1"), { maxDepth: 1, maxEntries: 100 })).files).toEqual([join("d2", "deep.txt")]);
  });
});

describe("readRegularFile", () => {
  it("reads a regular file up to the limit and refuses anything else", async () => {
    const small = await put("small.txt", "hello");
    expect(await readRegularFile(small, 5)).toEqual({ kind: "text", text: "hello", size: 5 });
    expect(await readRegularFile(small, 4)).toEqual({ kind: "too-large", size: 5 });
    expect(await readRegularFile(project, 100)).toEqual({ kind: "not-a-file" });
    expect(await readRegularFile(join(project, "missing"), 100)).toMatchObject({ kind: "error" });
    if (process.platform !== "win32") {
      const pipe = join(project, "pipe");
      expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
      expect(await readRegularFile(pipe, 100)).toEqual({ kind: "not-a-file" });
      await symlink(small, join(project, "link.txt"));
      expect(await readRegularFile(join(project, "link.txt"), 100)).toMatchObject({ kind: "error" });
    }
  });
});

describe("searchLinesInWorker", () => {
  it("returns line matches, capped", async () => {
    const files = [{ file: "a.txt", text: "one\nTWO\nthree TWO" }, { file: "b.txt", text: "TWO" }];
    expect(await searchLinesInWorker("TWO", files, 10)).toEqual([
      { file: "a.txt", line: 2, text: "TWO" },
      { file: "a.txt", line: 3, text: "three TWO" },
      { file: "b.txt", line: 1, text: "TWO" },
    ]);
    expect(await searchLinesInWorker("TWO", files, 2)).toHaveLength(2);
  });

  it("abandons a pattern that runs past the timeout, without blocking this thread", async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    const started = Date.now();
    try {
      expect(await searchLinesInWorker("(x+x+)+y", [{ file: "a", text: "x".repeat(40) }], 10, 300)).toBeNull();
    } finally {
      clearInterval(interval);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(5);
  });
});
