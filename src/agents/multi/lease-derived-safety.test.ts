import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("derived lease safety", () => {
  it("a lease derived from another lease skips the configured heavy directories", async () => {
    // Audited 2026-09-01: the derived branch consulted only its own small
    // exclude set, so a multi-GB Unity Library was copied into every node
    // workspace.
    const project = tmp("proj-");
    const leaseRoot = tmp("leases-");
    const parent = join(leaseRoot, "parent-lease");
    mkdirSync(join(parent, "Library"), { recursive: true });
    writeFileSync(join(parent, "Library", "huge.bin"), "x".repeat(1024));
    mkdirSync(join(parent, "Assets"), { recursive: true });
    writeFileSync(join(parent, "Assets", "Compass.cs"), "class Compass {}");

    const manager = new WorkspaceLeaseManager({
      projectRoot: project,
      leaseRoot,
      additionalExcludes: ["Library", "Temp", "Logs"],
    });
    const lease = await manager.acquireLease({
      label: "node",
      workerId: "n1",
      sourceRoot: parent,
      forceTempCopy: true,
    });

    expect(existsSync(join(lease.path, "Assets", "Compass.cs"))).toBe(true);
    expect(existsSync(join(lease.path, "Library"))).toBe(false);
    await lease.release();
  });

  it("conflict quarantine lands under the PROJECT, not inside the parent lease", async () => {
    const project = tmp("proj-");
    const leaseRoot = tmp("leases-");
    const parent = join(leaseRoot, "parent-lease");
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(parent, "shared.txt"), "original");

    const manager = new WorkspaceLeaseManager({ projectRoot: project, leaseRoot });
    const lease = await manager.acquireLease({
      label: "node",
      workerId: "n1",
      sourceRoot: parent,
      forceTempCopy: true,
    });
    // Both sides diverge: the lease edits, the source moves underneath it.
    writeFileSync(join(lease.path, "shared.txt"), "agent version");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(parent, "shared.txt"), "someone else");

    const result = await lease.commit();
    expect(result.conflicts).toContain("shared.txt");
    // Survives the parent's deletion because it is under the project root.
    expect(result.conflictsQuarantinedUnder?.startsWith(project)).toBe(true);
    expect(readdirSync(join(project, ".strada", "lease-conflicts")).length).toBeGreaterThan(0);
    await lease.release();
  });

  it("a lease whose parent is gone refuses to commit rather than re-create it, and shutdown keeps it", async () => {
    // Measured 2026-10-11: a kept delegation lease outlived its caller's
    // lease. The shutdown commit's lock re-made the caller's directory with
    // mkdir -p, the file was "written" into that ghost, and the lease was
    // released: nothing reached the project, and the log said it committed.
    const project = tmp("proj-");
    const leaseRoot = tmp("leases-");
    writeFileSync(join(project, "Sundial.cs"), "sundial");
    const manager = new WorkspaceLeaseManager({ projectRoot: project, leaseRoot, preferGitWorktree: false });
    const parent = await manager.acquireLease({ label: "task" });
    const child = await manager.acquireLease({ label: "delegate", sourceRoot: parent.path, forceTempCopy: true });
    writeFileSync(join(child.path, "New.cs"), "the delegate's file");
    // The caller publishes and releases first — the normal end of a task.
    await parent.commit();
    await parent.release();

    const result = await child.commit();

    expect(result.written).toEqual([]);
    expect(result.failed.join("\n")).toMatch(/no longer exists/);
    expect(existsSync(parent.path), "the released parent was re-created").toBe(false);

    await manager.dispose();
    expect(existsSync(parent.path)).toBe(false);
    expect(readFileSync(join(child.path, "New.cs"), "utf8"), "shutdown released the only copy").toBe("the delegate's file");
  });
});

describe("test-isolation guard", () => {
  it("refuses the shared default lease root under vitest", () => {
    // A test on the default lease root once deleted a running campaign's live lease.
    expect(() => new WorkspaceLeaseManager({ projectRoot: tmp("proj-") })).toThrow(/isolated leaseRoot/);
  });
});
