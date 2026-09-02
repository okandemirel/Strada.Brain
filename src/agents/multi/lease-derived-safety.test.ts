import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
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
    writeFileSync(join(parent, "Assets", "Board.cs"), "class Board {}");

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

    expect(existsSync(join(lease.path, "Assets", "Board.cs"))).toBe(true);
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
});

describe("test-isolation guard", () => {
  it("refuses the shared default lease root under vitest", () => {
    // 2026-09-02 18:09: a test on the default root deleted Sprint 7's live lease.
    expect(() => new WorkspaceLeaseManager({ projectRoot: tmp("proj-") })).toThrow(/isolated leaseRoot/);
  });
});
