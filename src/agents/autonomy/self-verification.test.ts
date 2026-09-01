import { describe, expect, it } from "vitest";
import { SelfVerification } from "./self-verification.js";

describe("SelfVerification", () => {
  it("accepts verification-oriented shell commands as a clean verification signal", () => {
    // Assets/Thing.cs, not Assets/Test.cs: a filename ending in Test.cs marks a
    // test file, and those are deliberately not settled by a typecheck.
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Thing.cs" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);

    verifier.track("shell_exec", { command: "npm run typecheck:src" }, {
      toolCallId: "tc-verify",
      content: "$ npm run typecheck:src\nExit code: 0",
      isError: false,
    });

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Thing.cs")).toBe(true);
    expect(verifier.getState().lastVerificationAt).not.toBeNull();
  });

  it("treats generic Unity verification tools as valid clean signals", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Gameplay/TestSystem.cs" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);

    verifier.track("unity_editmode_test", {}, {
      toolCallId: "tc-unity-verify",
      content: "All tests passed",
      isError: false,
    });

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Gameplay/TestSystem.cs")).toBe(true);
  });

  it("a failing test run keeps the gate open after a clean compile (and a red body beats a green flag)", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Gameplay/Board.cs" }, {
      toolCallId: "tc-w", content: "written", isError: false,
    });
    // Clean headless compile clears the compilable-changes gate…
    verifier.track("unity_verify_change", {}, {
      toolCallId: "tc-c", content: "compile green", isError: false,
    });
    expect(verifier.needsVerification()).toBe(false);

    // …then a PlayMode run whose BODY reports failures (success-shaped flag)
    // must reopen the gate: measured class — a run declared DONE over a
    // failing suite because nothing tracked the red result.
    verifier.track("unity_playmode_verify", {}, {
      toolCallId: "tc-t", content: "PlayMode verification FAILED: 5 of 95 tests failed", isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);
    expect(verifier.getPrompt()).toContain("[TESTS FAILING]");

    // A later green run closes it.
    verifier.track("unity_playmode_verify", {}, {
      toolCallId: "tc-t2", content: "All 95 tests passed", isError: false,
    });
    expect(verifier.needsVerification()).toBe(false);
  });

  it("flags a redundant re-compile when nothing changed since the last clean verify", () => {
    const verifier = new SelfVerification();
    verifier.track("file_write", { path: "Assets/Modules/BoardModule/Board.cs" }, {
      toolCallId: "w", content: "written", isError: false,
    });
    verifier.track("unity_verify_change", {}, {
      toolCallId: "v", content: "compile green", isError: false,
    });
    // Nothing touched since: another compile would burn minutes for an
    // identical answer.
    expect(verifier.isRedundantVerification()).toBe(true);

    verifier.track("file_edit", { path: "Assets/Modules/BoardModule/Board.cs" }, {
      toolCallId: "w2", content: "edited", isError: false,
    });
    expect(verifier.isRedundantVerification()).toBe(false);
  });

  it("tracks nested batch_execute mutations and verification results", () => {
    const verifier = new SelfVerification();

    verifier.track(
      "batch_execute",
      {
        operations: [
          { tool: "file_write", input: { path: "Assets/Gameplay/BatchedSystem.cs" } },
          { tool: "unity_editmode_test", input: {} },
        ],
      },
      {
        toolCallId: "tc-batch",
        content: JSON.stringify({
          results: [
            { tool: "file_write", success: true, content: "written" },
            { tool: "unity_editmode_test", success: true, content: "all green" },
          ],
        }),
        isError: false,
      },
    );

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Gameplay/BatchedSystem.cs")).toBe(true);
  });

  it("retains touched files across clean verification for completion review", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "src/runtime/reviewer.ts" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    verifier.track("shell_exec", { command: "npm run lint:src" }, {
      toolCallId: "tc-lint",
      content: "$ npm run lint:src\nExit code: 0",
      isError: false,
    });

    const state = verifier.getState();
    expect(state.pendingFiles.size).toBe(0);
    expect(state.touchedFiles.has("src/runtime/reviewer.ts")).toBe(true);
    expect(verifier.hasTouchedFiles()).toBe(true);
  });
});
