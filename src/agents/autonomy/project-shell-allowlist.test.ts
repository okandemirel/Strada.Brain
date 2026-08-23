import { describe, it, expect } from "vitest";
import { matchProjectScopedAllowlist } from "./project-shell-allowlist.js";

describe("project-scoped shell allowlist — canonical build/test/run pre-approval", () => {
  // Measured 2026-08-23: the conformance gate demanded "GAME NEVER RUN — run
  // the game"; the agent answered with exactly this command; the LLM shell
  // reviewer rejected it as "looks destructive". Gate and gatekeeper deadlocked.
  const root = "/Users/dev/PixelFlow";

  it("pre-approves Unity batchmode run against $PWD", () => {
    const cmd = '"/Applications/Unity/Hub/Editor/6000.3.22f1/Unity.app/Contents/MacOS/Unity" ' +
      "-batchmode -nographics -quit -projectPath \"$PWD\" -logFile \"$PWD/Library/build.log\"";
    expect(matchProjectScopedAllowlist(cmd, root)?.rule).toContain("unity-batchmode");
  });

  it("pre-approves Unity batchmode EditMode tests", () => {
    const cmd = '"/Applications/Unity/Hub/Editor/6000.3.22f1/Unity.app/Contents/MacOS/Unity" ' +
      `-batchmode -nographics -projectPath "$PWD" -runTests -testPlatform EditMode -testResults "$PWD/results.xml"`;
    expect(matchProjectScopedAllowlist(cmd, root)?.rule).toContain("unity-batchmode");
  });

  it("rejects Unity invocation without batchmode (interactive editor launch)", () => {
    const cmd = '"/Applications/Unity/Hub/Editor/6000.3.22f1/Unity.app/Contents/MacOS/Unity" -projectPath "$PWD"';
    expect(matchProjectScopedAllowlist(cmd, root)).toBeNull();
  });

  it("pre-approves dotnet build inside the project", () => {
    expect(matchProjectScopedAllowlist("dotnet build src/Core/PixelFlow.Core.csproj -v q", root)?.rule)
      .toContain("dotnet");
  });

  it("does NOT approve dotnet builds of /tmp side projects (the /tmp escape)", () => {
    expect(
      matchProjectScopedAllowlist("dotnet build /tmp/simcheck/simcheck.csproj -v q --nologo", root),
    ).toBeNull();
  });

  it("pre-approves read-only git inspection", () => {
    expect(matchProjectScopedAllowlist("git status --short", root)?.rule).toContain("git");
    expect(matchProjectScopedAllowlist("git log --oneline -5", root)).not.toBeNull();
  });

  it("never approves destructive commands regardless of shape", () => {
    expect(matchProjectScopedAllowlist("rm -rf / && git status", root)).toBeNull();
  });

  it("requires a project root to engage at all", () => {
    expect(matchProjectScopedAllowlist("dotnet test", undefined)).toBeNull();
  });
});
