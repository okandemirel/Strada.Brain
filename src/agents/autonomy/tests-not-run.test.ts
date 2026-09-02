import { describe, expect, it } from "vitest";

import { SelfVerification, looksLikeTestFile } from "./self-verification.js";

function write(sv: SelfVerification, path: string) {
  sv.track("file_write", { path, content: "x" }, { content: "File written" });
}
function verified(sv: SelfVerification, tool: string, ok = true, input: Record<string, unknown> = {}) {
  sv.track(tool, input, { content: ok ? "passed" : "failed", isError: !ok });
}

describe("a compile is not a test run", () => {
  it("still wants verification after a clean compile of changed test files", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Tests/Runtime/ScoringServiceTests.cs");
    verified(sv, "unity_verify_change");

    // The compile cleared the compilable-changes flag; the tests are still unrun.
    expect(sv.needsVerification()).toBe(true);
    expect(sv.getPrompt()).toContain("TESTS NOT RUN");
    expect(sv.getPrompt()).toContain("ScoringServiceTests.cs");
  });

  it("is satisfied once a tool actually runs them", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Tests/Runtime/ScoringServiceTests.cs");
    verified(sv, "unity_verify_change");
    verified(sv, "unity_playmode_verify");

    expect(sv.needsVerification()).toBe(false);
  });

  it("does not gate a run that never touched a test file", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Scripts/ScoringService.cs");
    verified(sv, "unity_verify_change");

    expect(sv.needsVerification()).toBe(false);
  });

  it("stops asking after the run has genuinely tried and failed", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Tests/Runtime/ScoringServiceTests.cs");
    for (let i = 0; i < 3; i++) verified(sv, "unity_playmode_verify", false);

    // The build gate legitimately stays up — a failed verification is a failed
    // verification. What must stop is this gate, which the run cannot satisfy.
    expect(sv.getPrompt()).not.toContain("TESTS NOT RUN");
  });

  /**
   * Audited 2026-09-02: getPrompt() emitted "[VERIFICATION REQUIRED] You
   * modified compilable files without verifying:" unconditionally — with zero
   * bullets under it once a clean compile had emptied pendingFiles — above the
   * real [TESTS NOT RUN] / [TESTS FAILING] sections. The headline named a
   * measurement that did not happen and steered the run toward re-running the
   * compile that had just passed.
   */
  it("does not claim unverified compilable files once the compile has passed", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Scripts/ScoringService.cs");
    write(sv, "Assets/Modules/ScoringModule/Tests/Runtime/ScoringServiceTests.cs");
    verified(sv, "unity_verify_change");

    const prompt = sv.getPrompt();
    expect(prompt).toContain("TESTS NOT RUN");
    expect(prompt).not.toContain("[VERIFICATION REQUIRED]");
    expect(prompt).not.toContain("without verifying");
  });

  it("does not claim unverified compilable files on the failing-tests path either", () => {
    const sv = new SelfVerification();
    write(sv, "Assets/Modules/ScoringModule/Scripts/ScoringService.cs");
    verified(sv, "unity_verify_change");
    sv.track("unity_playmode_verify", {}, {
      content: "PlayMode verification FAILED: 5 of 95 tests failed", isError: false,
    });

    const prompt = sv.getPrompt();
    expect(prompt).toContain("TESTS FAILING");
    expect(prompt).not.toContain("[VERIFICATION REQUIRED]");
  });

  it("counts a shell test runner as a test run", () => {
    const sv = new SelfVerification();
    write(sv, "src/agents/thing.test.ts");
    verified(sv, "shell_exec", true, { command: "npx vitest run src/agents" });

    expect(sv.needsVerification()).toBe(false);
  });
});

describe("looksLikeTestFile", () => {
  it("recognises the shapes this project uses", () => {
    expect(looksLikeTestFile("Assets/Modules/X/Tests/Runtime/YTests.cs")).toBe(true);
    // A stub or fixture living beside the tests: only the directory says so,
    // and changing one means the tests around it need running again.
    expect(looksLikeTestFile("Assets/Modules/X/Tests/Runtime/BoardServiceStub.cs")).toBe(true);
    expect(looksLikeTestFile("Assets/Modules/X/Scripts/YTests.cs")).toBe(true);
    expect(looksLikeTestFile("src/thing.test.ts")).toBe(true);
    expect(looksLikeTestFile("Assets/Modules/X/Scripts/Services/YService.cs")).toBe(false);
    // "Latest.cs" ends in "test" but is not a test file.
    expect(looksLikeTestFile("Assets/Modules/X/Scripts/Latest.cs")).toBe(false);
  });
});
