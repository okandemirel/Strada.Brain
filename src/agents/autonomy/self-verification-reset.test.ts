/**
 * AUT-22 (audited 2026-09-24): reset() left the failing-test flag set, and
 * the console parser read "10 errors" as the success signal "0 errors".
 */
import { describe, expect, it } from "vitest";
import { SelfVerification } from "./self-verification.js";

describe("SelfVerification small correctness (AUT-22)", () => {
  it("reset() clears a failing test run", () => {
    const verifier = new SelfVerification();
    verifier.track("dotnet_test", {}, { toolCallId: "t", content: "Failed!  - Failed:     1, Passed:     2", isError: true });
    expect(verifier.needsVerification()).toBe(true);
    verifier.reset();
    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getPrompt()).not.toContain("TESTS FAILING");
  });

  it("\"10 errors\" does not clear recorded console errors", () => {
    const verifier = new SelfVerification();
    verifier.track("unity_compile_wait", {}, {
      toolCallId: "a",
      content: "Assets/A.cs(1,1): error CS0103: nope",
      isError: false,
    });
    expect(verifier.hasUnresolvedUnityErrors()).toBe(true);
    verifier.track("unity_compile_wait", {}, { toolCallId: "b", content: "Compilation finished with 10 errors", isError: false });
    expect(verifier.hasUnresolvedUnityErrors()).toBe(true);
    // …while a real zero still clears them.
    verifier.track("unity_compile_wait", {}, { toolCallId: "c", content: "Compilation finished with 0 errors", isError: false });
    expect(verifier.hasUnresolvedUnityErrors()).toBe(false);
  });
});
