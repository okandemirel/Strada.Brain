/**
 * A submodule on a local path must still reach the agent's workspace.
 *
 * Strada.Core and Strada.MCP are developed side by side with the game, so the
 * supported setup wires them as submodules pointing at local directories. Since
 * the CVE-2022-39253 mitigation, git refuses to clone a submodule over the
 * `file` transport unless `protocol.file.allow` says otherwise — and it
 * deliberately ignores the setting when it comes from repository config, so
 * there is nothing a user can put in their own project to fix it. The value has
 * to be supplied on the command line.
 *
 * initSubmodules() ran a bare `git submodule update --init --recursive`, so
 * every such project got a workspace with an empty Packages/Submodules: no
 * Strada.Core, no base classes, no framework at all.
 *
 * Measured: a from-scratch run reported "transport 'file' not allowed", carried
 * on regardless, and produced modules written against a framework that was not
 * there. It stayed hidden for a while because a project whose submodules are not
 * yet committed gets them copied in by syncUncommittedState instead — commit the
 * project, and the only path left is the clone that fails.
 *
 * Passing the flag is scoped to this one internal operation on the user's own
 * configured project — the same tree the agent is about to read and write.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

/** A repo standing in for Strada.Core: real content, on a local path. */
function frameworkRepo(): string {
  const root = mkdtempSync(join(os.tmpdir(), "lease-framework-"));
  mkdirSync(join(root, "Runtime"), { recursive: true });
  writeFileSync(join(root, "Runtime", "ModuleConfig.cs"), "// framework\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "framework");
  return root;
}

/** A project carrying that framework as a local-path submodule, fully committed. */
function projectWithLocalSubmodule(framework: string): string {
  const root = mkdtempSync(join(os.tmpdir(), "lease-localsub-"));
  mkdirSync(join(root, "Assets"), { recursive: true });
  writeFileSync(join(root, "Assets", "Game.cs"), "// game\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  git(
    root,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    framework,
    "Packages/Submodules/Strada.Core",
  );
  // Committed: syncUncommittedState has nothing to copy, so the submodule
  // checkout is the only way the framework can reach the workspace.
  git(root, "add", "-A");
  git(root, "commit", "-qm", "add framework");
  return root;
}

describe("a workspace for a project with local-path submodules", () => {
  it("contains the submodule's content", async () => {
    const framework = frameworkRepo();
    const root = projectWithLocalSubmodule(framework);

    const manager = new WorkspaceLeaseManager({
      projectRoot: root,
      leaseRoot: mkdtempSync(join(os.tmpdir(), "lease-root-")),
    });
    const lease = await manager.acquireLease({ preferGitWorktree: true });
    expect(lease.kind, "this only means anything on the worktree path").toBe("git-worktree");

    expect(
      existsSync(join(lease.path, "Packages", "Submodules", "Strada.Core", "Runtime", "ModuleConfig.cs")),
      "the agent's workspace has no framework — it will write against an API that is not there",
    ).toBe(true);

    await lease.release();
  });
});
