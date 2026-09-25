import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./tool.interface.js";

// The git-internals check runs between validatePath and the write: the seam
// where a path can be swapped for a symlink after it was validated.
const seam = vi.hoisted(() => ({ swap: undefined as (() => void) | undefined }));
vi.mock("./git-internals-guard.js", () => ({
  GIT_INTERNALS_ERROR: "git internals",
  isGitInternalsPath: async () => {
    seam.swap?.();
    return false;
  },
}));

const { FileEditTool } = await import("./file-edit.js");

let root: string;
let outside: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "file-edit-contained-"));
  outside = mkdtempSync(join(tmpdir(), "file-edit-outside-"));
  ctx = { projectPath: root, workingDirectory: root, readOnly: false };
  seam.swap = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("file_edit writes like file_write (TLS-12)", () => {
  it("does not write through a symlink swapped in after validation", async () => {
    const target = join(outside, "victim.txt");
    writeFileSync(target, "token = old\n");
    const inProject = join(root, "notes.txt");
    writeFileSync(inProject, "token = old\n");
    seam.swap = () => {
      unlinkSync(inProject);
      symlinkSync(target, inProject);
    };

    const result = await new FileEditTool().execute({ path: "notes.txt", old_string: "old", new_string: "new" }, ctx);

    expect(result.isError).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("token = old\n");
  });

  it("parallel edits of one file all land", async () => {
    const file = join(root, "Player.cs");
    const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
    writeFileSync(file, names.map((n) => `// ${n}\n`).join(""));
    const tool = new FileEditTool();

    const results = await Promise.all(
      names.map((n) => tool.execute({ path: "Player.cs", old_string: `// ${n}`, new_string: `// ${n.toUpperCase()}` }, ctx)),
    );

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe(names.map((n) => `// ${n.toUpperCase()}\n`).join(""));
  });
});
