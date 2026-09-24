/**
 * AUT-7 (audited 2026-09-24): the console-error parse sat after the
 * verification block, whose inspection and inconclusive branches end in
 * `continue` — so a CS error read through unity_console_read or
 * unity_console_analyze never reached the unity-console gate.
 */
import { describe, expect, it } from "vitest";
import { SelfVerification } from "./self-verification.js";

const CS_ERROR = "Assets/Scripts/Player.cs(10,5): error CS0103: The name 'speed' does not exist in the current context";

describe("errors read from the Unity console are recorded (AUT-7)", () => {
  it.each(["unity_console_read", "unity_console_analyze"])("%s", (tool) => {
    const verifier = new SelfVerification();
    verifier.track(tool, {}, { toolCallId: "c", content: CS_ERROR, isError: false });
    expect(verifier.hasUnresolvedUnityErrors()).toBe(true);
    expect(verifier.getUnityConsoleErrors()[0]).toContain("CS0103");
  });

  it("an inconclusive compile status still records the errors it shows", () => {
    const verifier = new SelfVerification();
    verifier.track("unity_compile_status", {}, {
      toolCallId: "c",
      content: `{"status":"unknown"}\n${CS_ERROR}`,
      isError: false,
    });
    expect(verifier.hasUnresolvedUnityErrors()).toBe(true);
  });
});
