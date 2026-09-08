/**
 * Measured 2026-09-08 07:17-07:27: five file_read/list_directory calls in
 * ten minutes refused as "outside the project directory" because the model
 * named the real checkout while the run's project was its lease. The lease's
 * owner file says which checkout that is; the path is rewritten into the lease.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { redirectRealCheckoutPath, validatePath } from "./path-guard.js";

const owner = mkdtempSync(join(tmpdir(), "strada-owner-"));
const lease = mkdtempSync(join(tmpdir(), "strada-lease-"));
mkdirSync(join(owner, "Assets", "Scenes"), { recursive: true });
mkdirSync(join(lease, "Assets", "Scenes"), { recursive: true });
writeFileSync(join(lease, "Assets", "Scenes", "Main.unity"), "");
writeFileSync(join(lease, ".strada-lease-owner.json"), JSON.stringify({ pid: 1, startedAt: 0, projectRoot: owner }));

afterAll(() => {
  rmSync(owner, { recursive: true, force: true });
  rmSync(lease, { recursive: true, force: true });
});

describe("the real checkout's path names the lease's twin", () => {
  it("rewrites an absolute path under the owner checkout into the lease", async () => {
    expect(redirectRealCheckoutPath(lease, join(owner, "Assets", "Scenes", "Main.unity"))).toBe(join("Assets", "Scenes", "Main.unity"));
    expect(redirectRealCheckoutPath(lease, owner)).toBe(".");
    const result = await validatePath(lease, join(owner, "Assets", "Scenes", "Main.unity"));
    expect(result.valid).toBe(true);
    expect(result.fullPath.startsWith(lease) || result.fullPath.includes("strada-lease-")).toBe(true);
    expect(result.fullPath).not.toContain(owner);
    expect(result.redirectedFrom).toBe(join(owner, "Assets", "Scenes", "Main.unity"));
  });

  it("still refuses an absolute path that is in neither tree, and does nothing outside a lease", async () => {
    expect(redirectRealCheckoutPath(lease, "/etc/passwd")).toBeUndefined();
    expect((await validatePath(lease, "/etc/passwd")).valid).toBe(false);
    expect(redirectRealCheckoutPath(owner, join(lease, "Assets"))).toBeUndefined();
    // A sibling directory that merely shares the owner's prefix is not the owner.
    expect(redirectRealCheckoutPath(lease, `${owner}-evil/Assets`)).toBeUndefined();
  });
});
