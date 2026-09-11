import { describe, expect, it } from "vitest";
import { gddPlatform, frameRateAnswersPlatform } from "./gdd-platform.js";

describe("the platform the GDD asks for (Codex 2026-09-11 B#11)", () => {
  it("names the FIRST target and carries every platform the document asks for", () => {
    expect(gddPlatform("Ships on Android first, Google Play in Q3.")).toMatchObject({ target: "android", targets: ["android"], handheld: true });
    expect(gddPlatform("A WebGL game for itch.io.")).toMatchObject({ target: "webgl", targets: ["webgl"], handheld: false });
    // Two platforms used to resolve to NO target, so the build took whatever
    // the project had active and the report never named the second one
    // (Codex 2026-09-11 F#11).
    const many = gddPlatform("Ships on Steam for Windows and later on iOS.");
    expect(many.target).toBe("windows");
    expect(many.targets).toEqual(["windows", "ios"]);
    expect(many.handheld).toBe(true);
    expect(gddPlatform("A game about harbours.")).toEqual({ handheld: false, targets: [] });
    expect(gddPlatform(undefined)).toEqual({ handheld: false, targets: [] });
  });

  it("'mid-range phones' is a handheld even when no store is named", () => {
    const p = gddPlatform("Target 60 fps on mid-range phones.");
    expect(p.handheld).toBe(true);
    expect(p.target).toBeUndefined();
    expect(p.evidence).toContain("mid-range phones");
  });

  it("an EXCLUDED platform is not a request, and a named target must be the one built (Codex 2026-09-11 D#32, D#33)", () => {
    expect(gddPlatform("Target: Android only; no iOS release.")).toMatchObject({ target: "android" });
    // iOS named, Android built: that frame rate answers nothing.
    expect(frameRateAnswersPlatform(gddPlatform("iOS only."), "Android")).toBe(false);
    expect(frameRateAnswersPlatform(gddPlatform("iOS only."), "iOS")).toBe(true);
    expect(frameRateAnswersPlatform(gddPlatform("Ships on Android."), "Android")).toBe(true);
  });

  it("a desktop player does not answer a handheld frame-rate claim", () => {
    const phones = gddPlatform("Target 60 fps on mid-range phones.");
    expect(frameRateAnswersPlatform(phones, "StandaloneOSX")).toBe(false);
    expect(frameRateAnswersPlatform(phones, "Android")).toBe(true);
    expect(frameRateAnswersPlatform(phones, undefined)).toBe(false);
    // A game that names no handheld is answered by whatever it was built for.
    expect(frameRateAnswersPlatform(gddPlatform("A desktop strategy game."), "StandaloneOSX")).toBe(true);
  });
});
