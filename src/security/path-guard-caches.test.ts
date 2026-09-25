/**
 * SEC-23: the path-guard caches are keyed by project root, and every task
 * lease is a new root. They must stay bounded, and a root that now names a
 * different directory must not reuse its old realpath.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_GUARD_CACHE_MAX_ROOTS, leaseOwnerRootOf, pathGuardCacheSizes, validatePath } from "./path-guard.js";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "strada-pg-cache-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("path-guard caches (SEC-23)", () => {
  it("hold at most PATH_GUARD_CACHE_MAX_ROOTS roots however many leases come and go", async () => {
    const roots = PATH_GUARD_CACHE_MAX_ROOTS + 60;
    for (let i = 0; i < roots; i++) {
      const root = join(base, `task-${i.toString(16)}`);
      await mkdir(root);
      await writeFile(join(root, ".strada-lease-owner.json"), JSON.stringify({ projectRoot: base }), "utf8");
      expect((await validatePath(root, "Assets/a.cs", { allowMissingParents: true })).valid).toBe(true);
      expect(leaseOwnerRootOf(root)).toBe(base);
    }
    const sizes = pathGuardCacheSizes();
    expect(sizes.realRoots).toBeLessThanOrEqual(PATH_GUARD_CACHE_MAX_ROOTS);
    expect(sizes.leaseOwners).toBeLessThanOrEqual(PATH_GUARD_CACHE_MAX_ROOTS);
  });

  it("re-resolves a root that now names a different directory", async () => {
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
  });
});
