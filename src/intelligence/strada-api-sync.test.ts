/**
 * LRN-21: `strada sync --git-fallback` cached clones under `HOME ?? "/tmp"`
 * and reused whatever sat in the cache directory for ever, including a clone
 * cut off by the timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "node:child_process";
import { gitFallbackClone, stradaGitCacheRoot } from "./strada-api-sync.ts";

const git = vi.mocked(execFileSync);
let root: string;
let cloneFails: boolean;

/** A stand-in for git: `clone` writes a checkout, `rev-parse` checks one. */
function fakeGit(_file: string, args?: readonly string[]): Buffer {
  const argv = args ?? [];
  if (argv[0] === "clone") {
    const dest = argv[argv.length - 1]!;
    mkdirSync(join(dest, ".git"), { recursive: true });
    if (cloneFails) throw new Error("network unreachable");
    writeFileSync(join(dest, "marker"), "fresh clone");
    return Buffer.from("");
  }
  if (argv.includes("rev-parse")) {
    const dir = argv[argv.indexOf("-C") + 1]!;
    if (existsSync(join(dir, ".git", "no-head"))) throw new Error("fatal: Needed a single revision");
    return Buffer.from("0123abcd\n");
  }
  throw new Error(`unexpected git ${argv.join(" ")}`);
}

function existingClone(state: "valid" | "no-head" | "not-a-repo", ageMs = 0): string {
  const dir = join(root, "core");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker"), "older clone");
  if (state !== "not-a-repo") mkdirSync(join(dir, ".git"), { recursive: true });
  if (state === "no-head") writeFileSync(join(dir, ".git", "no-head"), "");
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(dir, at, at);
  return dir;
}

const cloneCalls = () => git.mock.calls.filter(([, args]) => (args as string[] | undefined)?.[0] === "clone");
const leftovers = () => readdirSync(root).filter((name) => name.includes(".clone-"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "strada-sync-cache-"));
  cloneFails = false;
  git.mockReset();
  git.mockImplementation(fakeGit as unknown as typeof execFileSync);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("the strada sync git cache (LRN-21)", () => {
  it("lives under the user's home directory, not a HOME-or-/tmp guess", async () => {
    const saved = process.env["HOME"];
    delete process.env["HOME"]; // services, CI; Windows never sets it
    try {
      vi.resetModules();
      const fresh = await import("./strada-api-sync.ts");
      expect(fresh.stradaGitCacheRoot()).toBe(join(homedir(), ".strada", "framework-cache"));
    } finally {
      if (saved !== undefined) process.env["HOME"] = saved;
    }
    expect(stradaGitCacheRoot()).toBe(join(homedir(), ".strada", "framework-cache"));
  });

  it("reuses a fresh, valid clone without cloning", async () => {
    const dir = existingClone("valid");
    await expect(gitFallbackClone("core", "https://example.invalid/core.git", "Core", root)).resolves.toBe(dir);
    expect(cloneCalls()).toHaveLength(0);
  });

  it("replaces a leftover directory that is not a checkout", async () => {
    const dir = existingClone("not-a-repo");
    await expect(gitFallbackClone("core", "https://example.invalid/core.git", "Core", root)).resolves.toBe(dir);
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("fresh clone");
    expect(leftovers()).toEqual([]);
  });

  it("replaces a clone whose HEAD does not resolve", async () => {
    const dir = existingClone("no-head");
    await gitFallbackClone("core", "https://example.invalid/core.git", "Core", root);
    expect(cloneCalls()).toHaveLength(1);
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("fresh clone");
  });

  it("refreshes a day-old clone, and keeps serving it when the refresh fails", async () => {
    const dir = existingClone("valid", 25 * 60 * 60 * 1000);
    cloneFails = true;
    await expect(gitFallbackClone("core", "https://example.invalid/core.git", "Core", root)).resolves.toBe(dir);
    expect(cloneCalls()).toHaveLength(1);
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("older clone");
    expect(leftovers()).toEqual([]);
  });

  it("leaves nothing behind when a first clone fails", async () => {
    cloneFails = true;
    await expect(gitFallbackClone("core", "https://example.invalid/core.git", "Core", root)).resolves.toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
});
