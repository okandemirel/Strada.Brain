import { describe, expect, it } from "vitest";
import { SelfVerification } from "./self-verification.js";

describe("SelfVerification", () => {
  it("accepts verification-oriented shell commands as a clean verification signal", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Test.cs" }, {
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
    expect(verifier.getState().touchedFiles.has("Assets/Test.cs")).toBe(true);
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
