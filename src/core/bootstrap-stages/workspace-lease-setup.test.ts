import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createWorkspaceLeaseManager } from "./workspace-lease-setup.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function projectWithTwoFolders(): { folder: string; project: string } {
  const folder = mkdtempSync(join(tmpdir(), "lease-setup-"));
  folders.push(folder);
  const project = join(folder, "project");
  for (const dir of ["Keep", "Heavy"]) {
    mkdirSync(join(project, dir), { recursive: true });
    writeFileSync(join(project, dir, "file.txt"), `${dir}\n`);
  }
  return { folder, project };
}

describe("createWorkspaceLeaseManager", () => {
  it("makes leases under WORKSPACE_LEASE_ROOT, and leaves out WORKSPACE_COPY_EXCLUDES", async () => {
    const { folder, project } = projectWithTwoFolders();
    const leaseRoot = join(folder, "leases");
    const manager = createWorkspaceLeaseManager(project, {
      WORKSPACE_LEASE_ROOT: leaseRoot,
      WORKSPACE_COPY_EXCLUDES: "Heavy",
    });
    const lease = await manager.acquireLease({ label: "setup" });
    try {
      expect(lease.leaseRoot).toBe(leaseRoot);
      expect(dirname(lease.path)).toBe(leaseRoot);
      expect(basename(lease.path)).toMatch(/^setup-/);
      expect(existsSync(join(lease.path, "Keep", "file.txt"))).toBe(true);
      expect(existsSync(join(lease.path, "Heavy"))).toBe(false);
    } finally {
      await lease.release();
      await manager.dispose();
    }
  });

  it("refuses a relative WORKSPACE_LEASE_ROOT, which would resolve against the process's directory", () => {
    const { project } = projectWithTwoFolders();
    expect(() => createWorkspaceLeaseManager(project, { WORKSPACE_LEASE_ROOT: "leases" })).toThrow(
      'WORKSPACE_LEASE_ROOT must be an absolute path, got "leases"',
    );
    expect(existsSync(join(process.cwd(), "leases"))).toBe(false);
  });

  it("takes a blank WORKSPACE_LEASE_ROOT as unset, which a test may not use", () => {
    const { project } = projectWithTwoFolders();
    // Under vitest the manager refuses the machine-global default: the reason a
    // golden run needs a root of its own.
    expect(() => createWorkspaceLeaseManager(project, { WORKSPACE_LEASE_ROOT: "  " })).toThrow(/isolated leaseRoot/);
  });
});
