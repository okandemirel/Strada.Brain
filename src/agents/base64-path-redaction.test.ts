/**
 * A long file path is not a base64 payload.
 *
 * "/" counts as a base64 delimiter, so any run of 60+ path characters with no
 * dot or underscore matched the block rule and was replaced. Measured
 * 2026-08-20: the failure log reported a missing file as "[base64:61ch].cs" —
 * the redaction ate the one thing that line exists to say, and the longer the
 * path, the likelier it was eaten.
 */

import { describe, it, expect } from "vitest";
import { sanitizePromptInjection } from "./orchestrator-text-utils.js";

describe("redacting base64 without eating paths", () => {
  it("leaves a long project path alone", () => {
    const path = "Assets/Modules/LevelModule/Scripts/Services/LevelProgressionService.cs";

    expect(path.length).toBeGreaterThan(60);
    expect(sanitizePromptInjection(path)).toContain("LevelProgressionService.cs");
  });

  it("leaves a deep path with no extension alone", () => {
    const path = "Assets/Modules/GameFlowModule/Scripts/Services/Internal/Runtime/Handlers";

    expect(sanitizePromptInjection(path)).toContain("Handlers");
  });

  it("still redacts a real base64 blob", () => {
    const blob = "dGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZyBhbmQga2VlcHMgcnVubmluZyBvbndhcmR0aGUgcXVpY2sgYnJvd24gZm94IGp1bXBzIG92ZXIgdGhlIGxhenkgZG9nIGFuZCBrZWVwcyBydW5uaW5nIG9ud2FyZA==";

    const out = sanitizePromptInjection(blob);

    expect(out, "a genuine base64 payload survived redaction").not.toContain("dGhlIHF1aWNrIGJyb3duIGZveCBqdW");
  });

  it("still redacts a blob whose slashes do not divide it into path segments", () => {
    const blob = "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkaGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxk/QQ==";

    const out = sanitizePromptInjection(blob);

    expect(out).not.toContain("aGVsbG93b3JsZGhlbGxvd29ybGQ");
  });

  it("does not mistake a blob with a single slash for a path", () => {
    // The "at least three segments" rule earns its place here: two short
    // pieces either side of one slash is what base64 looks like, not a path.
    const blob = "QWxwaGFCcmF2b0NoYXJsaWVEZWx0YUVj/Rm94dHJvdEdvbGZIb3RlbEluZGlhSnVs";

    expect(blob.length).toBeGreaterThan(60);
    expect(blob.split("/")).toHaveLength(2);
    expect(sanitizePromptInjection(blob), "a two-piece blob was taken for a path").not.toContain("QWxwaGFCcmF2b0NoYXJsaWVEZ");
  });
});
