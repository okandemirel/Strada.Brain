/**
 * openNoFollow on a platform WITHOUT O_NOFOLLOW (Windows), simulated here so
 * Linux CI keeps catching it. The Windows suite measured the gap: a write
 * followed a symlink at the target path and changed a file outside the project,
 * because O_NOFOLLOW was the only defence and Windows has none.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No O_NOFOLLOW, as on Windows, and a seam right before the open: the moment a
// path that was already checked can be swapped for a link.
const seam = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      seam.beforeOpen?.();
      return actual.open(...args);
    },
  };
});

const { openNoFollow } = await import("./open-no-follow.js");
const { writeFileInsideRoot } = await import("../agents/tools/file-write.js");
const { readRegularFile } = await import("../skills/project-files.js");

let root: string;
let project: string;
let victim: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "strada-nofollow-"));
  project = join(root, "project");
  mkdirSync(project);
  victim = join(root, "victim.txt");
  writeFileSync(victim, "original", "utf-8");
  seam.beforeOpen = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Swap `path` for a link to the victim, right before the open. */
function swapInLinkBeforeOpen(path: string): void {
  seam.beforeOpen = () => {
    seam.beforeOpen = undefined;
    try {
      unlinkSync(path);
    } catch {
      // nothing there yet
    }
    symlinkSync(victim, path);
  };
}

describe("a platform without O_NOFOLLOW", () => {
  it("is what this file simulates", () => {
    expect(fs.constants.O_NOFOLLOW).toBeUndefined();
  });

  it("writeFileInsideRoot refuses a link at the target and leaves what it points at untouched", async () => {
    const link = join(project, "Assets.cs");
    symlinkSync(victim, link);

    await expect(writeFileInsideRoot(project, link, "class X {}")).rejects.toMatchObject({ code: "ELOOP" });
    expect(readFileSync(victim, "utf-8")).toBe("original");
  });

  it("writeFileInsideRoot refuses a link swapped in after the check, without emptying its target", async () => {
    const file = join(project, "notes.txt");
    writeFileSync(file, "token = old\n");
    swapInLinkBeforeOpen(file);

    await expect(writeFileInsideRoot(project, file, "token = new\n")).rejects.toMatchObject({ code: "ELOOP" });
    expect(readFileSync(victim, "utf-8")).toBe("original");
  });

  it("writeFileInsideRoot refuses a link that appears where a new file was about to be created", async () => {
    const file = join(project, "New.cs");
    swapInLinkBeforeOpen(file);

    await expect(writeFileInsideRoot(project, file, "class New {}")).rejects.toMatchObject({ code: "ELOOP" });
    expect(readFileSync(victim, "utf-8")).toBe("original");
  });

  it("writeFileInsideRoot still replaces a regular file's whole content, and still creates one exclusively", async () => {
    const file = join(project, "Player.cs");
    writeFileSync(file, "a much longer original body\n");
    await writeFileInsideRoot(project, file, "short\n");
    expect(readFileSync(file, "utf-8")).toBe("short\n");

    const meta = join(project, "Player.cs.meta");
    await writeFileInsideRoot(project, meta, "guid: 1\n", { exclusive: true });
    expect(readFileSync(meta, "utf-8")).toBe("guid: 1\n");
    await expect(writeFileInsideRoot(project, meta, "guid: 2\n", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(meta, "utf-8")).toBe("guid: 1\n");
  });

  it("readRegularFile does not read through a link, whether it was there before or swapped in", async () => {
    const link = join(project, "link.txt");
    symlinkSync(victim, link);
    expect(await readRegularFile(link, 100)).toMatchObject({ kind: "error" });

    const file = join(project, "plain.txt");
    writeFileSync(file, "plain");
    swapInLinkBeforeOpen(file);
    expect(await readRegularFile(file, 100)).toMatchObject({ kind: "error" });

    writeFileSync(join(project, "ok.txt"), "fine");
    expect(await readRegularFile(join(project, "ok.txt"), 100)).toEqual({ kind: "text", text: "fine", size: 4 });
  });

  it("openNoFollow defers O_TRUNC until the open is proven, so a followed link is never emptied", async () => {
    const file = join(project, "data.bin");
    writeFileSync(file, "bytes");
    swapInLinkBeforeOpen(file);

    await expect(
      openNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC),
    ).rejects.toThrow(/symbolic link/);
    expect(readFileSync(victim, "utf-8")).toBe("original");
  });
});
