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
  });
});
