/**
 * Wave width under a task lease.
 *
 * Until 2026-09-10 a leased task ran its supervisor nodes one at a time no
 * matter what the configuration said: a 12-node plan with 1-hour nodes was a
 * 12-hour sprint. The clamp is right for a SHARED lease (one worktree, no
 * lock) and wrong once the executor grants every node a worktree of its own.
 */
import { describe, expect, it } from "vitest";
import { nodeParallelism } from "./supervisor-brain.js";

describe("nodeParallelism", () => {
  it("a shared task lease serializes the wave", () => {
    expect(nodeParallelism({ workspaceLease: { id: "task" } }, 6)).toBe(1);
  });

  it("per-node workspaces restore the configured width under a task lease", () => {
    expect(nodeParallelism({ workspaceLease: { id: "task" }, nodeWorkspaces: "per-node" }, 6)).toBe(6);
  });

  it("no lease was never clamped — nodes take their own leases downstream", () => {
    expect(nodeParallelism({}, 4)).toBe(4);
    expect(nodeParallelism({ nodeWorkspaces: "per-node" }, 4)).toBe(4);
  });
});
