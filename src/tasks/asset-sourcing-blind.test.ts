import { describe, expect, it } from "vitest";
import { deriveTestVerdict, detectAssetSourcingBlind } from "./test-verdict.js";

/**
 * Audited 2026-09-06: across a whole campaign unity_my_assets_cloud was called
 * three times, all three answered "The Unity account link expired or was
 * revoked — re-run the Unity Link step" (token refresh HTTP 412), and not one
 * word reached the channel or the delivery report. The only real-art source
 * was dead for the entire build and nobody was told.
 */
const DEAD = "Error: The Unity account link expired or was revoked — re-run the Unity Link step. Detail: token refresh returned HTTP 412";
const MISSING = "Unity account is not linked. Run the Unity Link step once (it opens the standard Unity sign-in dialog) so the headless path can refresh tokens.";

describe("a dead Unity link is evidence", () => {
  it("reads the tool's own sentence off the result", () => {
    expect(detectAssetSourcingBlind([{ content: DEAD, isError: true }])).toContain("link expired or was revoked");
    expect(detectAssetSourcingBlind([{ content: MISSING, isError: true }])).toContain("is not linked");
  });

  it("is undefined when no tool said so", () => {
    expect(detectAssetSourcingBlind([{ content: "PlayMode verification passed: 3 of 3 tests passed" }])).toBeUndefined();
    expect(detectAssetSourcingBlind([])).toBeUndefined();
  });

  it("rides the verdict even when no test ran", () => {
    const v = deriveTestVerdict([{ content: DEAD, isError: true }]);
    expect(v.testsGreen).toBeUndefined();
    expect(v.assetSourcingBlind).toContain("re-run the Unity Link step");
  });

  it("does not disturb a real test verdict", () => {
    const v = deriveTestVerdict([
      { content: DEAD, isError: true },
      { content: "PlayMode verification passed: 3 of 3 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(v.testsGreen).toBe(true);
    expect(v.unfiltered).toBe(true);
    expect(v.assetSourcingBlind).toBeDefined();
  });
});
