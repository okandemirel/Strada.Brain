/**
 * The real-root cache must tell two directories apart on Windows too.
 *
 * It is keyed by project root and revalidated by the root's dev/ino. A
 * Windows file id is 64 bits, and read as a plain number it loses precision,
 * so two different directories could compare equal: a root re-pointed at
 * another directory then kept resolving to the old one (CI #1411, windows-
 * test). Here stat() without `bigint` answers the same dev/ino for every
 * path, as the rounded ids can, and the cache must still notice the switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BigIntStats, StatOptions, Stats } from "node:fs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = async (path: string, options?: StatOptions): Promise<Stats | BigIntStats> => {
    const real = await actual.stat(path, options);
    if (options?.bigint) return real;
    // What rounding a 64-bit id into a double can do: every entry collides.
    return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, { dev: 1, ino: 1 });
  };
  return { ...actual, stat };
});

const { mkdir, mkdtemp, rm, symlink, unlink, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { validatePath } = await import("./path-guard.js");

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "strada-pg-ino-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("path-guard real-root cache with imprecise file ids", () => {
  it("re-resolves a root re-pointed at another directory", async () => {
    const first = join(base, "first");
    const second = join(base, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "a.txt"), "a", "utf8");
    await writeFile(join(second, "b.txt"), "b", "utf8");
    const root = join(base, "project");
    await symlink(first, root, "dir");
    expect((await validatePath(root, "a.txt")).valid).toBe(true);

    await unlink(root);
    await symlink(second, root, "dir");
    const result = await validatePath(root, "b.txt");
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    // And the old root's files are not reachable through the new one.
    expect((await validatePath(root, "../first/a.txt")).valid).toBe(false);
  });
});
