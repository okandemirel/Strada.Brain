import { describe, expect, it } from "vitest";

/**
 * The real-tree guardian EDITS the user's project when this verdict says red,
 * so a red verdict must carry a compile diagnostic. Measured live 2026-09-03
 * 11:24: unity_verify_change returned "Connection lost" and the guardian
 * declared the tree uncompilable, launching an autonomous repair task against
 * the project the user was inspecting.
 *
 * This pins the classification rule the wiring in stage-runtime.ts uses.
 */
function classify(result: { content: string; isError?: boolean }): { ok: boolean; ran: boolean } {
  const detail = result.content;
  const carriesCompileDiagnostic =
    /error\s+CS\d+|compile (failed|succeeded)|\d+\s+error\(s\)|compile entries|verification (FAILED|passed)/i.test(detail);
  if (result.isError === true && !carriesCompileDiagnostic) return { ok: true, ran: false };
  return { ok: result.isError !== true, ran: true };
}

describe("real-tree compile verdict", () => {
  it("treats a connection loss as UNMEASURED, not as a broken tree", () => {
    expect(classify({ content: "Error in unity_verify_change (elapsed=5867ms): Connection lost. Input received: {}", isError: true }))
      .toEqual({ ok: true, ran: false });
  });

  it("treats a real compile failure as red", () => {
    expect(classify({ content: "Headless compile failed with 4 error(s) (43 compile entries including warnings).", isError: true }))
      .toEqual({ ok: false, ran: true });
    expect(classify({ content: "Assets/Modules/A.cs(3,5): error CS1061: no such member", isError: true }))
      .toEqual({ ok: false, ran: true });
  });

  it("treats a clean run as green", () => {
    expect(classify({ content: "Headless compile succeeded (0 errors).", isError: false }))
      .toEqual({ ok: true, ran: true });
  });
});
