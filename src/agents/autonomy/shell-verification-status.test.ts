/**
 * AUT-2 (audited 2026-09-24): the shell verifier trusted the shell's exit
 * status. A pipe, `;`, `||` or `&` after the verifier hands the status to a
 * different command, so a failing `dotnet test` / `vitest` run that exits 0
 * through `| tail`, `|| true` or `; echo done` recorded lastBuildOk=true,
 * emptied the pending list and closed the failing-test gate.
 */
import { describe, expect, it } from "vitest";
import { SelfVerification, shellVerification } from "./self-verification.js";

const DOTNET_FAILED = [
  "  Failed Game.Tests.BoardTests.ClearsRow [4 ms]",
  "  Error Message:",
  "   Assert.AreEqual failed. Expected:<3>. Actual:<2>.",
  "",
  "Failed!  - Failed:     1, Passed:    10, Skipped:     0, Total:    11, Duration: 52 ms - Game.Tests.dll (net8.0)",
].join("\n");

const DOTNET_PASSED =
  "Passed!  - Failed:     0, Passed:    11, Skipped:     0, Total:    11, Duration: 48 ms - Game.Tests.dll (net8.0)";

const shellResult = (command: string, stdout: string) => ({
  toolCallId: "s",
  content: `$ ${command}\nExit code: 0 | Duration: 900ms\n\n--- stdout ---\n${stdout}`,
  isError: false,
  metadata: { exitCode: 0 },
});

function wroteTests(): SelfVerification {
  const verifier = new SelfVerification();
  verifier.track("file_write", { path: "Assets/Tests/BoardTests.cs" }, { toolCallId: "w", content: "written", isError: false });
  expect(verifier.needsVerification()).toBe(true);
  return verifier;
}

describe("shell verification reads only the status the shell returns (AUT-2)", () => {
  it.each([
    ["dotnet test 2>&1 | tail -5", DOTNET_FAILED],
    ["dotnet test || true", DOTNET_FAILED],
    ["dotnet test; echo done", `${DOTNET_FAILED}\ndone`],
    ["npx vitest run | tail -3", " Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 9 passed (11)\n   Duration  1.2s"],
    ["npx jest | tail -4", "Test Suites: 1 failed, 1 passed, 2 total\nTests:       2 failed, 5 passed, 7 total"],
    ["pytest -q || true", "F.....\n1 failed, 5 passed in 0.12s"],
  ])("a failing run that exits 0 through `%s` keeps the gates open", (command, stdout) => {
    const verifier = wroteTests();
    verifier.track("shell_exec", { command }, shellResult(command, stdout));
    expect(verifier.getState().lastBuildOk).not.toBe(true);
    expect(verifier.getState().pendingFiles.size).toBe(1);
    expect(verifier.needsVerification()).toBe(true);
    expect(verifier.getPrompt()).toMatch(/TESTS (?:FAILING|NOT RUN)|VERIFICATION REQUIRED/);
  });

  it("a masked run with nothing to show for itself settles nothing", () => {
    const verifier = wroteTests();
    verifier.track("shell_exec", { command: "dotnet build | tail -1" }, shellResult("dotnet build | tail -1", ""));
    expect(verifier.getState().lastBuildOk).toBeNull();
    expect(verifier.needsVerification()).toBe(true);
  });

  it("a masked run that printed a passing verdict and no failure still settles the debt", () => {
    const verifier = wroteTests();
    verifier.track("shell_exec", { command: "dotnet test 2>&1 | tail -3" }, shellResult("dotnet test 2>&1 | tail -3", DOTNET_PASSED));
    expect(verifier.getState().lastBuildOk).toBe(true);
    expect(verifier.needsVerification()).toBe(false);
  });

  it("a verifier whose status IS the line's is still believed on a silent exit 0", () => {
    const verifier = wroteTests();
    verifier.track("shell_exec", { command: "cd Game && dotnet test" }, shellResult("cd Game && dotnet test", ""));
    expect(verifier.getState().lastBuildOk).toBe(true);
  });

  it.each([
    ["dotnet test", "ran"],
    ["cd Game && dotnet test", "ran"],
    ["dotnet build && echo ok", "ran"],
    ["cat list | dotnet test", "ran"],
    ["dotnet build;", "ran"],
    ["dotnet test | tail -5", "maybe"],
    ["dotnet test |& tail -5", "maybe"],
    ["dotnet test || true", "maybe"],
    ["dotnet test; echo done", "maybe"],
    ["dotnet test\necho done", "maybe"],
    ["dotnet test & wait", "maybe"],
    ["dotnet build && echo ok || true", "maybe"],
    ["(dotnet test) || true", "maybe"],
    ["false || dotnet build", "maybe"],
    ["dotnet build; dotnet test", "maybe"],
    ["true || dotnet build", "no"],
    ["false && dotnet build; true", "no"],
    ["echo 'dotnet test | tail'", "no"],
    ["dotnet test 'unterminated", "no"],
  ] as const)("%j → %s", (command, expected) => {
    expect(shellVerification(command)).toBe(expected);
  });
});
