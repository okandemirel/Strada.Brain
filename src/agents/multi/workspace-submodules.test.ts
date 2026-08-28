/**
 * A worktree workspace must contain the project's submodules.
 *
 * `git worktree add` leaves submodule paths as empty directories, and the
 * product's own installer puts the framework there — installStradaDep runs
 * `git submodule add` for Strada.Core, installStradaMcpSubmodule the same for
 * Strada.MCP. So the install path and the isolation path contradicted each
 * other: every project set up the supported way handed its agent a workspace
 * with no framework in it.
 *
 * Measured on a full Pixel Flow build: 295 Strada.Core .cs files in the project,
 * zero in the workspace. The agent looked — `list_directory Packages/Submodules/
 * Strada.Core` answered "directory not found", the source glob found nothing,
 * `shell_exec` there failed on a missing parent — and then wrote its own
 * invention: a GameModuleConfig deriving from ScriptableObject, an .asmdef
 * referencing Unity.ugui rather than Strada.Core, and not one generator call.
 * 42 files that look like a Strada module and are not one.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";
import type { WorkspaceCommandRunner } from "./workspace-lease-manager.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

type Invocation = { args: readonly string[]; cwd: string };

/** Records git invocations; reports success unless a matcher says otherwise. */
function recordingRunner(fail?: (args: readonly string[]) => boolean): {
  runner: WorkspaceCommandRunner;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  const runner: WorkspaceCommandRunner = async ({ args, cwd }) => {
    calls.push({ args: args ?? [], cwd: cwd ?? "" });
    const a = args ?? [];
    if (a.includes("rev-parse")) {
      return { exitCode: 0, stdout: "true", stderr: "" };
    }
    if (a.includes("worktree") && a.includes("add")) {
      // A real `git worktree add` creates the directory; the fake must too, or
      // the lease manager's own existence checks see nothing.
      const target = a[a.length - 2];
      if (target) mkdirSync(target, { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (fail?.(a)) {
      return { exitCode: 1, stdout: "", stderr: "fatal: could not read from remote" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

/** A project root that git would report as a repo, with or without submodules. */
function projectRoot(withSubmodules: boolean): string {
  const root = mkdtempSync(join(os.tmpdir(), "lease-submodule-test-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  if (withSubmodules) {
    writeFileSync(
      join(root, ".gitmodules"),
      '[submodule "Packages/Submodules/Strada.Core"]\n\tpath = Packages/Submodules/Strada.Core\n\turl = https://example.invalid/Strada.Core.git\n',
    );
  }
  return root;
}

function submoduleCall(calls: Invocation[]): Invocation | undefined {
  return calls.find((c) => c.args.includes("submodule") && c.args.includes("update"));
}

describe("worktree workspaces carry the project's submodules", () => {
  it("checks out submodules into the new worktree", async () => {
    const root = projectRoot(true);
    const { runner, calls } = recordingRunner();
    const manager = new WorkspaceLeaseManager({ projectRoot: root, leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-submodule-leases-")), commandRunner: runner });

    const lease = await manager.acquireLease({ preferGitWorktree: true });
    expect(lease.kind).toBe("git-worktree");

    const call = submoduleCall(calls);
    expect(call, "no `git submodule update` ran — the workspace has no framework in it").toBeDefined();
    expect(call!.args).toContain("--init");
    expect(call!.args).toContain("--recursive");
    // Inside the workspace, not the project: initialising the project's own
    // submodules would leave the workspace exactly as empty as before.
    expect(call!.cwd).toBe(lease.path);
    expect(call!.args).toEqual(expect.arrayContaining(["-C", lease.path]));

    await lease.release();
  });

  it("runs the checkout after the worktree exists, not before", async () => {
    const root = projectRoot(true);
    const { runner, calls } = recordingRunner();
    const manager = new WorkspaceLeaseManager({ projectRoot: root, leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-submodule-leases-")), commandRunner: runner });
    const lease = await manager.acquireLease({ preferGitWorktree: true });

    const addIndex = calls.findIndex((c) => c.args.includes("worktree") && c.args.includes("add"));
    const subIndex = calls.findIndex((c) => c.args.includes("submodule"));
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(subIndex).toBeGreaterThan(addIndex);

    await lease.release();
  });

  it("skips the checkout when the project has no submodules", async () => {
    // No .gitmodules, nothing to do — and a pointless git call on every lease
    // is a cost paid by every task.
    const root = projectRoot(false);
    const { runner, calls } = recordingRunner();
    const manager = new WorkspaceLeaseManager({ projectRoot: root, leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-submodule-leases-")), commandRunner: runner });

    const lease = await manager.acquireLease({ preferGitWorktree: true });
    expect(submoduleCall(calls)).toBeUndefined();
    await lease.release();
  });

  it("still hands over a usable workspace when the checkout fails", async () => {
    // A submodule behind an unreachable remote degrades the workspace; it must
    // not take the task down with it.
    const root = projectRoot(true);
    const { runner } = recordingRunner((a) => a.includes("submodule"));
    const manager = new WorkspaceLeaseManager({ projectRoot: root, leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-submodule-leases-")), commandRunner: runner });

    const lease = await manager.acquireLease({ preferGitWorktree: true });
    expect(lease.kind).toBe("git-worktree");
    expect(existsSync(lease.path)).toBe(true);
    await lease.release();
  });
});
