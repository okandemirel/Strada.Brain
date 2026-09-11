import { describe, expect, it } from "vitest";
import { gddPlatform, frameRateAnswersPlatform } from "./gdd-platform.js";

describe("the platform the GDD asks for (Codex 2026-09-11 B#11)", () => {
  it("names one target when the document names one, and stays silent when it names several", () => {
    expect(gddPlatform("Ships on Android first, Google Play in Q3.")).toMatchObject({ target: "android", handheld: true });
    expect(gddPlatform("A WebGL game for itch.io.")).toMatchObject({ target: "webgl", handheld: false });
    const many = gddPlatform("Ships on Steam for Windows and later on iOS.");
    expect(many.target).toBeUndefined();
    expect(many.handheld).toBe(true);
    expect(gddPlatform("A game about harbours.")).toEqual({ handheld: false });
    expect(gddPlatform(undefined)).toEqual({ handheld: false });
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
