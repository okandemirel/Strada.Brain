/**
 * Shutting down must not throw away what the agent already wrote.
 *
 * dispose() released every outstanding lease without committing it, so a task
 * interrupted mid-run lost its files along with the workspace. Measured: a run
 * stopped by SIGINT had written
 * Modules/PixelFlow/Tests/Runtime/DomainModelTests.cs into its lease; after
 * "Strada Brain stopped. Shutdown complete." the file existed neither in the
 * project nor anywhere under the lease root. An hour of work, gone at exit.
 *
 * The asymmetry decides it, the same way it did for the abort path: publishing
 * work the user did not end up wanting is recoverable — the files are in their
 * project and git shows them — while discarding it is not.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceLeaseManager } from "./workspace-lease-manager.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

function repo(): string {
  const root = mkdtempSync(join(os.tmpdir(), "shutdown-commit-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  writeFileSync(join(root, "Assets", "Existing.cs"), "// committed\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

function manager(root: string): WorkspaceLeaseManager {
  return new WorkspaceLeaseManager({
    projectRoot: root,
    leaseRoot: mkdtempSync(join(os.tmpdir(), "shutdown-lease-root-")),
  });
}

describe("shutdown", () => {
  it("keeps the agent's work when leases are disposed", async () => {
    const root = repo();
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    mkdirSync(join(lease.path, "Assets", "Modules", "PixelFlow", "Tests", "Runtime"), {
      recursive: true,
    });
    writeFileSync(
      join(lease.path, "Assets", "Modules", "PixelFlow", "Tests", "Runtime", "DomainModelTests.cs"),
      "// the agent's work\n",
    );

    await leases.dispose();

    const landed = join(
      root,
      "Assets",
      "Modules",
      "PixelFlow",
      "Tests",
      "Runtime",
      "DomainModelTests.cs",
    );
    expect(existsSync(landed), "the agent's file was discarded at shutdown").toBe(true);
    expect(readFileSync(landed, "utf8")).toBe("// the agent's work\n");
  });

  it("still removes the workspace", async () => {
    // Committing must not turn into a leak: the directory has to go either way.
    const root = repo();
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });
    writeFileSync(join(lease.path, "Assets", "New.cs"), "// x\n");

    await leases.dispose();

    expect(existsSync(lease.path)).toBe(false);
    expect(leases.getActiveLeaseCount()).toBe(0);
  });

  it("releases even when the commit fails", async () => {
    // A lease that cannot be committed is exactly the case where leaking the
    // directory would be worst.
    const root = repo();
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });
    (lease as unknown as { commit: () => Promise<never> }).commit = async () => {
      throw new Error("disk full");
    };

    await expect(leases.dispose()).resolves.toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
  });

  it("does not touch a file the user changed during the run", async () => {
    // commit()'s conflict rule still applies at shutdown: the user's copy wins
    // and is reported rather than overwritten.
    const root = repo();
    const leases = manager(root);
    const lease = await leases.acquireLease({ preferGitWorktree: true });

    writeFileSync(join(lease.path, "Assets", "Existing.cs"), "// agent edit\n");
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "Assets", "Existing.cs"), "// the user's own edit\n");

    await leases.dispose();

    expect(readFileSync(join(root, "Assets", "Existing.cs"), "utf8")).toBe(
      "// the user's own edit\n",
    );
  });
});
