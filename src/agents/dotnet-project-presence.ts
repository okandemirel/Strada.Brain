/**
 * Whether there is anything for `dotnet build` to build.
 *
 * The dotnet tools declare themselves available when the CLI is on PATH
 * (tool-registry.ts:690). That is only half the precondition: a Unity project
 * has no .sln or .csproj until the Editor has been opened once and generated
 * them, and `dotnet build` in a project without one fails with
 * `MSBUILD : error MSB1003: Specify a project or solution file`.
 *
 * Measured on two from-scratch runs: the agent reached for `dotnet_build` three
 * times, got MSB1003 each time, and each attempt cost a round-trip and an error
 * the model then had to interpret. The tool that does work there —
 * `unity_verify_change`, which compiles headlessly with no Editor open — was
 * sitting beside it in the same tool block.
 *
 * CLI presence is a property of the machine and is resolved once at
 * registration. Solution presence is a property of the project and changes
 * during a session, so it is resolved per run.
 */

import { readdirSync } from "node:fs";

/** Tools that cannot do anything without a solution or project file. */
export const DOTNET_PROJECT_TOOLS: ReadonlySet<string> = new Set(["dotnet_build", "dotnet_test"]);

/** Told to the model in place of the tools, so it looks in the right direction. */
export const NO_DOTNET_PROJECT_REASON =
  "no .sln or .csproj in the project yet — Unity generates them on first open; " +
  "use unity_verify_change to compile without the Editor";

/**
 * Does the project root hold a solution or C# project file?
 *
 * Only the root is checked: that is where Unity writes them, and walking a Unity
 * tree on every request to find one somewhere else would cost more than the
 * question is worth.
 */
export function hasDotnetProjectFile(projectPath: string): boolean {
  try {
    return readdirSync(projectPath).some(
      (entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"),
    );
  } catch {
    // An unreadable project root is not evidence that a solution exists.
    return false;
  }
}

/**
 * Per-run cache for {@link hasDotnetProjectFile}.
 *
 * Latches on: once a solution exists it is not going to vanish mid-run, and
 * Unity may generate one while the agent is working — so a false answer is
 * re-checked and a true one is not.
 */
export class DotnetProjectPresence {
  private present = false;

  constructor(private readonly projectPath: string) {}

  check(): boolean {
    if (this.present) return true;
    this.present = hasDotnetProjectFile(this.projectPath);
    return this.present;
  }
}
