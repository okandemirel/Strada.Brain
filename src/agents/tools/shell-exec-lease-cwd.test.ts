import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellExecTool } from "./shell-exec.js";

/**
 * Under a workspace lease the agent knows the project by its REAL path (the
 * GDD and every user message name it), but projectPath is the lease copy.
 * Measured 2026-09-02 on Sprint 7: six shell_exec calls were refused with
 * "working directory must be within the project", each costing a turn.
 */
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("shell_exec working directory under a lease", () => {
  it("maps the real project root onto the lease instead of refusing", async () => {
    const source = tmp("source-");
    const lease = tmp("lease-");
    mkdirSync(join(lease, "Assets"), { recursive: true });
    writeFileSync(join(lease, "Assets", "marker.txt"), "in-lease");

    const tool = new ShellExecTool();
    const result = await tool.execute(
      { command: "ls marker.txt", working_directory: join(source, "Assets") },
      { projectPath: lease, sourceProjectPath: source } as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("marker.txt");
  });

  it("still refuses a directory outside both roots", async () => {
    const source = tmp("source-");
    const lease = tmp("lease-");
    const outside = tmp("outside-");

    const tool = new ShellExecTool();
    const result = await tool.execute(
      { command: "ls", working_directory: outside },
      { projectPath: lease, sourceProjectPath: source } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be within the project");
  });
});
