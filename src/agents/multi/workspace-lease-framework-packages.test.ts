/**
 * A lease never publishes a write into a Strada framework package (WP-1.2).
 *
 * The file tools refuse such a write up front; this is the boundary for every
 * other way a worker changes its workspace — shell commands, Strada.MCP's
 * tools, a commit. The vendored framework is upstream's code at a recorded
 * commit: measured in a live campaign, runs had left their own reports inside
 * the vendored Strada.Core and Strada.MCP, and patched Core locally.
 * The package is still seeded, because a worker reads it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const CORE_FILE = join("Packages", "Submodules", "Strada.Core", "Runtime", "Service.cs");
const CORE_NOTE = join("Packages", "Submodules", "Strada.Core", "docs", "retro.md");
const ORIGINAL = "namespace Fw { public class Service {} }\n";
const ROUTE = join("Assets", "Scripts", "Route.cs");

let source: string;
let leaseRoot: string;

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "lease-framework-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "lease-framework-root-"));
  mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
  mkdirSync(join(source, "Packages", "Submodules", "Strada.Core", "Runtime"), { recursive: true });
  writeFileSync(join(source, CORE_FILE), ORIGINAL, "utf8");
  writeFileSync(join(source, "Assets", "Scripts", "Existing.cs"), "original", "utf8");
});

afterEach(() => {
  for (const dir of [source, leaseRoot]) rmSync(dir, { recursive: true, force: true });
});

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=w@x", "-c", "user.name=worker", ...args], { cwd, encoding: "utf8" }).trim();
}

describe("a lease's writes into a framework package are refused", () => {
  it("an edited framework file and a note dropped into the package are not published, are reported, and are kept for review", async () => {
    const manager = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
    // Seeded: the worker reads the framework it builds on.
    expect(readFileSync(join(lease.path, CORE_FILE), "utf8")).toBe(ORIGINAL);
    writeFileSync(join(lease.path, CORE_FILE), "namespace Fw { public class Service { /* patched */ } }\n", "utf8");
    mkdirSync(join(lease.path, "Packages", "Submodules", "Strada.Core", "docs"), { recursive: true });
    writeFileSync(join(lease.path, CORE_NOTE), "# what this run did", "utf8");
    writeFileSync(join(lease.path, ROUTE), "route", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, CORE_FILE), "utf8")).toBe(ORIGINAL);
    expect(existsSync(join(source, CORE_NOTE))).toBe(false);
    expect(result.written).toEqual([ROUTE]);
    expect([...(result.refusedFrameworkPackage ?? [])].sort()).toEqual([CORE_FILE, CORE_NOTE].sort());
    expect(result.conflicts).toEqual(expect.arrayContaining([CORE_FILE, CORE_NOTE]));
    expect(readFileSync(join(result.conflictsQuarantinedUnder!, CORE_NOTE), "utf8")).toBe("# what this run did");
  });

  it("a committed framework edit is not replayed; the rest of the commit is", async () => {
    gitAt(source, "init", "-q");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "vendor the framework as plain files");
    const lease = await new WorkspaceLeaseManager({ projectRoot: source, leaseRoot }).acquireLease({ label: "t" });
    expect(lease.kind).toBe("git-worktree");
    writeFileSync(join(lease.path, CORE_FILE), "namespace Fw { public class Service { /* patched */ } }\n", "utf8");
    writeFileSync(join(lease.path, ROUTE), "route", "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "feat: route, and patch the framework");

    const result = await lease.commit();
    await lease.release();

    expect(readFileSync(join(source, CORE_FILE), "utf8")).toBe(ORIGINAL);
    expect(result.refusedFrameworkPackage).toEqual([CORE_FILE]);
    expect(result.written).toEqual([ROUTE]);
    expect(result.commitsReplayed?.replayed).toBe(1);
    expect(gitAt(source, "show", "--name-only", "--format=", "HEAD")).toBe("Assets/Scripts/Route.cs");
    expect(gitAt(source, "show", "HEAD:Packages/Submodules/Strada.Core/Runtime/Service.cs")).toBe(ORIGINAL.trim());
  });

  it("a framework edit committed and then taken back never enters the project's history", async () => {
    // The working copy ends as the project has it, so nothing is refused at
    // copy-back — but replaying the series would put the patch into history.
    gitAt(source, "init", "-q");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "vendor the framework as plain files");
    const lease = await new WorkspaceLeaseManager({ projectRoot: source, leaseRoot }).acquireLease({ label: "t" });
    writeFileSync(join(lease.path, CORE_FILE), "namespace Fw { public class Service { /* patched */ } }\n", "utf8");
    writeFileSync(join(lease.path, ROUTE), "route", "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "feat: route, and patch the framework");
    writeFileSync(join(lease.path, CORE_FILE), ORIGINAL, "utf8");
    gitAt(lease.path, "add", "-A");
    gitAt(lease.path, "commit", "-qm", "chore: undo the framework patch");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toEqual([ROUTE]);
    expect(gitAt(source, "log", "--format=%s", "--", "Packages/Submodules/Strada.Core")).toBe(
      "vendor the framework as plain files",
    );
  });
});
