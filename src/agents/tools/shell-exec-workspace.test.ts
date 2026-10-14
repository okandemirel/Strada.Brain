/**
 * A shell command must act on the workspace, not on the project it was copied
 * from.
 *
 * shell_exec guards its working directory through path-guard, and then hands the
 * command string to bash untouched. An absolute path inside the command walks
 * straight past that guard — and the task text routinely carries one, because
 * "add a level editor to <the user's project path>" is an ordinary way to ask.
 *
 * Measured in live runs, and unchanged by telling the agent about it in the
 * preamble:
 *   mkdir -p <source>/Assets/Scripts/<Folder>
 *   Unity -batchmode -quit -projectPath <source>
 * The first wrote into the user's project instead of the lease; the second
 * compiled a tree holding none of the agent's work and reported a clean build.
 *
 * The two paths name the same project, so the source path is not a different
 * place — it is a stale name for this one. Rewriting it is what the agent meant,
 * and saying so in the result is what stops it happening again.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { ShellExecTool } from "./shell-exec.js";
import type { ToolContext } from "./tool-core.interface.js";

let workspace: string;
let sourceProject: string;
let tool: ShellExecTool;

beforeEach(() => {
  sourceProject = mkdtempSync(join(os.tmpdir(), "shell-source-"));
  workspace = mkdtempSync(join(os.tmpdir(), "shell-workspace-"));
  mkdirSync(join(sourceProject, "Assets"), { recursive: true });
  mkdirSync(join(workspace, "Assets"), { recursive: true });
  tool = new ShellExecTool();
});

/**
 * `mkdir -p` in the platform's own shell. cmd.exe's mkdir creates the parents
 * by itself, has no -p, and reads a "/" as the start of a switch.
 */
const mkdirP = (...dirs: string[]): string =>
  process.platform === "win32"
    ? `mkdir ${dirs.map((dir) => dir.replace(/\//g, "\\")).join(" ")}`
    : `mkdir -p ${dirs.join(" ")}`;

const ctx = (): ToolContext =>
  ({
    projectPath: workspace,
    sourceProjectPath: sourceProject,
    workingDirectory: workspace,
    readOnly: false,
  }) as ToolContext;

describe("a command naming the source project", () => {
  it("writes into the workspace instead", async () => {
    const result = await tool.execute(
      { command: mkdirP(`${sourceProject}/Assets/Modules/CartographyModule`) },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(
      existsSync(join(workspace, "Assets", "Modules", "CartographyModule")),
      "the agent's directory did not land in its workspace",
    ).toBe(true);
    expect(
      existsSync(join(sourceProject, "Assets", "Modules", "CartographyModule")),
      "the agent wrote into the user's project",
    ).toBe(false);
  });

  it("says it redirected, so the agent stops using the stale path", async () => {
    // Rewriting silently would fix each command and teach nothing.
    const result = await tool.execute(
      { command: `ls ${sourceProject}/Assets` },
      ctx(),
    );

    expect(result.content).toMatch(/workspace/i);
    expect(result.content).toContain(workspace);
  });

  it("reads the workspace's file, not the source project's", async () => {
    writeFileSync(join(sourceProject, "Assets", "Compass.cs"), "// stale\n");
    writeFileSync(join(workspace, "Assets", "Compass.cs"), "// the agent's work\n");

    const result = await tool.execute(
      { command: `cat ${sourceProject}/Assets/Compass.cs` },
      ctx(),
    );

    expect(result.content).toContain("the agent's work");
    expect(result.content).not.toContain("// stale");
  });

  it("rewrites every occurrence in the command", async () => {
    const result = await tool.execute(
      { command: mkdirP(`${sourceProject}/Assets/A`, `${sourceProject}/Assets/B`) },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(workspace, "Assets", "A"))).toBe(true);
    expect(existsSync(join(workspace, "Assets", "B"))).toBe(true);
    expect(existsSync(join(sourceProject, "Assets", "A"))).toBe(false);
  });

  it("leaves a command that names no project path alone", async () => {
    const result = await tool.execute({ command: "echo hello" }, ctx());

    expect(result.content).toContain("hello");
    expect(result.content).not.toMatch(/redirected/i);
  });

  it("does nothing when there is no separate source project", async () => {
    // Without a lease, projectPath IS the user's project and the rule is a
    // no-op — it must not rewrite anything or add noise.
    const result = await tool.execute(
      { command: "echo plain" },
      { projectPath: workspace, workingDirectory: workspace, readOnly: false } as ToolContext,
    );

    expect(result.content).toContain("plain");
    expect(result.content).not.toMatch(/redirected/i);
  });
});
