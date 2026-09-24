import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../../agents/tools/tool.interface.js";
import { tools } from "./index.js";

// ---------------------------------------------------------------------------
// Real files in a temporary project. SEC-2: these tools used to resolve paths
// against process.cwd() and walk anything; every path is now confined to
// `context.projectPath` through the built-in tools' path-guard.
// ---------------------------------------------------------------------------

let base: string;
let project: string;
let outside: string;
let context: ToolContext;
const fifos: string[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "strada-file-utils-")));
  project = join(base, "project");
  outside = join(base, "outside");
  await mkdir(project);
  await mkdir(outside);
  context = { projectPath: project, workingDirectory: project, readOnly: false };
});

afterEach(async () => {
  // A reader blocked on a FIFO (the pre-fix walk) is released by a writer.
  for (const fifo of fifos.splice(0)) {
    try {
      closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    } catch {
      /* nobody was waiting on it */
    }
  }
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, content: string | Buffer, root = project): Promise<string> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  return full;
}

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

const canMkfifo = process.platform !== "win32" && spawnSync("mkfifo", ["--version"]).error === undefined;

// ---------------------------------------------------------------------------
// file_stats
// ---------------------------------------------------------------------------

describe("file_stats", () => {
  const tool = findTool("file_stats");

  it("returns file statistics for a file, resolved against the project root", async () => {
    await put("test.txt", "hello world\nfoo bar baz\n");
    const result = await tool.execute({ path: "test.txt" }, context);
    expect(result.content).toContain(`File: ${join(project, "test.txt")}`);
    expect(result.content).toContain("Lines: 3");
    expect(result.content).toContain("Words: 5");
    expect(result.content).toContain("Characters: 24");
    expect(result.content).toContain("Size: 24 B");
    // An absolute path inside the project is accepted too.
    expect((await tool.execute({ path: join(project, "test.txt") }, context)).content).toContain("Lines: 3");
  });

  it("returns error when path parameter is missing", async () => {
    const result = await tool.execute({}, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("returns error when path is not a file", async () => {
    await mkdir(join(project, "somedir"));
    const result = await tool.execute({ path: "somedir" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not a file");
  });

  it("returns error when file does not exist", async () => {
    const result = await tool.execute({ path: "missing.txt" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("ENOENT");
  });

  it("rejects path with null byte", async () => {
    const result = await tool.execute({ path: "evil\0file.txt" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
  });

  it("refuses paths outside the project and sensitive files inside it", async () => {
    await put("secret.txt", "TOKEN=outside", outside);
    await put(".env", "TOKEN=inside");
    await symlink(join(outside, "secret.txt"), join(project, "link.txt"));
    for (const path of [join(outside, "secret.txt"), "../outside/secret.txt", "link.txt", "/etc/passwd"]) {
      const result = await tool.execute({ path }, context);
      expect(result.content, path).toContain("outside the project directory");
    }
    const env = await tool.execute({ path: ".env" }, context);
    expect(env.content).toContain("sensitive files is not permitted");
  });

  it("refuses without a project directory", async () => {
    const result = await tool.execute({ path: "test.txt" }, { ...context, projectPath: "" });
    expect(result.content).toContain("No project directory");
  });
});

// ---------------------------------------------------------------------------
// file_find_large
// ---------------------------------------------------------------------------

describe("file_find_large", () => {
  const tool = findTool("file_find_large");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("finds large files sorted by size descending", async () => {
    await put("big.bin", Buffer.alloc(3 * 1024));
    await put("small.txt", Buffer.alloc(100));
    await put("nested/medium.log", Buffer.alloc(2 * 1024));

    const result = await tool.execute({ directory: ".", minSizeKb: 1 }, context);
    expect(result.content).toContain("Found 2 file(s)");
    expect(result.content).toContain("big.bin");
    expect(result.content).toContain(join("nested", "medium.log"));
    expect(result.content).not.toContain("small.txt");
    expect(result.content.indexOf("big.bin")).toBeLessThan(result.content.indexOf("medium.log"));
  });

  it("uses default minSizeKb of 1024 when not specified", async () => {
    await put("large.bin", Buffer.alloc(500 * 1024));
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toContain("No files larger than");
  });

  it("limits results to 20 files", async () => {
    for (let i = 0; i < 25; i++) await put(`file${i}.bin`, Buffer.alloc(2 * 1024));
    const result = await tool.execute({ directory: ".", minSizeKb: 1 }, context);
    expect(result.content).toContain("Found 25 file(s)");
    const outputLines = result.content.split("\n").filter((l: string) => /file\d+\.bin/.test(l));
    expect(outputLines.length).toBe(20);
  });

  it("rejects directories outside the project and null bytes", async () => {
    const result = await tool.execute({ directory: outside }, context);
    expect(result.content).toContain("outside the project directory");
    const nul = await tool.execute({ directory: "sub\0evil" }, context);
    expect(nul.content).toContain("invalid characters");
  });

  it("does not follow symlinks out of the project", async () => {
    await put("huge.bin", Buffer.alloc(4 * 1024), outside);
    await symlink(outside, join(project, "linked-dir"));
    await symlink(join(outside, "huge.bin"), join(project, "linked.bin"));
    const result = await tool.execute({ directory: ".", minSizeKb: 1 }, context);
    expect(result.content).toContain("No files larger than");
  });
});

// ---------------------------------------------------------------------------
// file_line_search
// ---------------------------------------------------------------------------

describe("file_line_search", () => {
  const tool = findTool("file_line_search");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({ pattern: "test" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("returns error when pattern parameter is missing", async () => {
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("finds matching lines in files", async () => {
    await put("app.ts", "import express from 'express';\nconst TODO = 'fix this';\nexport default app;");
    await put("readme.md", "# README\nThis is a TODO item\n");
    const result = await tool.execute({ directory: ".", pattern: "TODO" }, context);
    expect(result.content).toContain("Found 2 match(es)");
    expect(result.content).toContain("app.ts:2:");
    expect(result.content).toContain("readme.md:2:");
  });

  it("supports regex patterns", async () => {
    await put("code.ts", "const x = 42;\nfunction hello() {}\nconst y = 99;\n");
    const result = await tool.execute({ directory: ".", pattern: "^const\\s+\\w+\\s*=" }, context);
    expect(result.content).toContain("Found 2 match(es)");
    expect(result.content).toContain("code.ts:1:");
    expect(result.content).toContain("code.ts:3:");
  });

  it("returns error for invalid regex", async () => {
    const result = await tool.execute({ directory: ".", pattern: "[invalid" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("Invalid regex");
  });

  it("returns no matches message when nothing found", async () => {
    await put("empty.txt", "nothing here\n");
    const result = await tool.execute({ directory: ".", pattern: "MISSING" }, context);
    expect(result.content).toContain("No matches found");
  });

  it("limits results to 50 matches", async () => {
    await put("big.txt", Array.from({ length: 60 }, (_, i) => `line ${i} MATCH`).join("\n"));
    const result = await tool.execute({ directory: ".", pattern: "MATCH" }, context);
    expect(result.content).toContain("Found 50 match(es)");
    expect(result.content).toContain("Results limited to 50");
  });

  it("rejects over-long patterns", async () => {
    const result = await tool.execute({ directory: ".", pattern: "a".repeat(501) }, context);
    expect(result.content).toContain("pattern too long");
  });

  it("stops a catastrophically backtracking pattern without blocking the event loop", async () => {
    await put("uniform.txt", `${"x".repeat(40)}\n`);
    let ticks = 0;
    const interval = setInterval(() => ticks++, 20);
    const started = Date.now();
    try {
      const result = await tool.execute({ directory: ".", pattern: "(x+x+)+y" }, context);
      expect(result.content).toContain("took too long");
    } finally {
      clearInterval(interval);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    // The main thread kept running timers while the pattern ran.
    expect(ticks).toBeGreaterThan(10);
  });

  // ---- SEC-2 ---------------------------------------------------------------
  it("searching `.` with a secret-looking pattern sees only the project, never sensitive files or anything outside it", async () => {
    await put("notes.txt", "TOKEN=visible-project-line\n");
    await put(".env", "TOKEN=project-dotenv\n");
    await put("config/.env.production", "TOKEN=project-dotenv-prod\n");
    await put("sub/.ssh/id_rsa", "TOKEN=project-ssh-key\n");
    await put("sub/.ssh/config", "TOKEN=project-ssh-config\n");
    await put(".env", "TOKEN=outside-dotenv\n", outside);
    await put("secret.txt", "TOKEN=outside-file\n", outside);
    await symlink(join(outside, "secret.txt"), join(project, "linked-secret.txt"));
    await symlink(outside, join(project, "linked-dir"));

    for (const directory of [".", project]) {
      const result = await tool.execute({ directory, pattern: "TOKEN|SECRET|PASSWORD" }, context);
      expect(result.content).toContain("Found 1 match(es)");
      expect(result.content).toContain("notes.txt:1: TOKEN=visible-project-line");
      expect(result.content).not.toMatch(/project-dotenv|project-ssh|outside-/);
    }

    for (const directory of ["..", outside, join(project, "linked-dir"), "/"]) {
      const result = await tool.execute({ directory, pattern: "TOKEN" }, context);
      expect(result.content, directory).toContain("outside the project directory");
    }
    const ssh = await tool.execute({ directory: "sub/.ssh", pattern: "TOKEN" }, context);
    expect(ssh.content).toContain("sensitive files is not permitted");
  });

  it.skipIf(!canMkfifo)("never opens a FIFO in the project (the walk used to block on it)", async () => {
    await put("notes.txt", "TOKEN=visible\n");
    const fifo = join(project, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    fifos.push(fifo);
    const result = await Promise.race([
      tool.execute({ directory: ".", pattern: "TOKEN" }, context),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("file_line_search blocked on a FIFO")), 5_000)),
    ]);
    expect(result.content).toContain("Found 1 match(es)");
  });
});
