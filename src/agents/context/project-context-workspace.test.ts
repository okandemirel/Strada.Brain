/**
 * The agent verifies the tree it is working in, not the one it was told about.
 *
 * A delegated agent runs against a workspace lease: the orchestrator is handed
 * `workspaceLease.path`, and that copy is the only tree that holds the agent's
 * work until the lease commits. The task text, meanwhile, routinely names the
 * user's real project directory — "add a level editor to
 * ~/Documents/Games/PixelFlow" is an ordinary way to ask.
 *
 * Nothing reconciled the two. The project context stated the active path and
 * stopped there, so an agent with an absolute path in its instructions had no
 * reason to prefer one over the other.
 *
 * Measured, from-scratch run: the agent wrote two modules into its workspace,
 * then ran
 *   Unity -batchmode -quit -projectPath /Users/okan/.../PixelFlow
 * — the path from the task text. That directory had no Assets/Modules at all.
 * Unity compiled a project containing none of the agent's work, returned zero
 * errors in 5.8s, and the agent read it as a clean build.
 *
 * This is the fake-green signal the verification hardening was meant to close,
 * arriving through shell_exec instead of through the verify tool: no tool can
 * check the compile if the agent points the compiler somewhere else.
 */

import { describe, it, expect } from "vitest";
import { buildProjectContext } from "./strada-knowledge.js";

describe("project context under a workspace", () => {
  const context = buildProjectContext("/tmp/strada-workspaces/task-abc/PixelFlow");

  it("still states the active path", () => {
    expect(context).toContain("/tmp/strada-workspaces/task-abc/PixelFlow");
  });

  it("says this path wins over any path in the task text", () => {
    // The whole failure is the agent treating a remembered absolute path as
    // equally valid. It has to be told which one is stale.
    expect(context).toMatch(/task|instructions|request/i);
    expect(context).toMatch(/different (absolute )?path/i);
  });

  it("says the agent's work exists only under this path", () => {
    // Without the reason, the rule is arbitrary and gets reasoned around.
    expect(context).toMatch(/only.*(tree|copy|directory).*(work|changes|edits)|work.*only exists/i);
  });

  it("extends the rule to shell commands and compiles", () => {
    // file_write already resolves against projectPath; shell_exec does not, and
    // that is precisely where the measured failure happened.
    expect(context).toMatch(/shell|command/i);
    expect(context).toMatch(/compil|verif|build/i);
  });
});
