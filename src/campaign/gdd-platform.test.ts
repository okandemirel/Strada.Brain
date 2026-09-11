import { describe, expect, it } from "vitest";
import { gddPlatform, frameRateAnswersPlatform, buildSatisfiesTarget, targetOfBuild } from "./gdd-platform.js";

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

  it("a storefront is not an operating system, and an excluded mention does not hide a later one (Codex 2026-09-11 J#19)", () => {
    // Steam matched first and built Windows for a Linux game.
    expect(gddPlatform("Ships on Steam for Linux.")).toMatchObject({ target: "linux", targets: ["linux"] });
    // "App Store" is iOS only when no OS is named; "Mac app" is macOS.
    expect(gddPlatform("Buy the Mac app on the App Store.")).toMatchObject({ target: "macos" });
    expect(gddPlatform("Launching on the App Store this winter.")).toMatchObject({ target: "ios" });
    expect(gddPlatform("Sold on Steam.")).toMatchObject({ target: "windows" });
    // The first mention is excluded and the second is real.
    // …and the order follows the document: Linux is named first, the later
    // affirmative Windows mention is found rather than hidden by the denial.
    expect(gddPlatform("No Windows release at launch. Linux first; Windows later."))
      .toMatchObject({ target: "linux", targets: ["linux", "windows"] });
    // …and a document that only DENIES a platform still names none.
    expect(gddPlatform("No Windows release, ever.").targets).toEqual([]);
  });

  it("a store names its own platform unless an OS qualifies it, and PC is only a fallback (Codex 2026-09-11 K#14)", () => {
    // Two platforms: one named by its OS, one by its store.
    expect(gddPlatform("Release on Windows and Google Play.").targets).toEqual(["windows", "android"]);
    // …but a store QUALIFIED by an OS is that one platform, not two.
    expect(gddPlatform("Ships on Steam for Linux.").targets).toEqual(["linux"]);
    expect(gddPlatform("On the App Store for iOS.").targets).toEqual(["ios"]);
    // "PC" says desktop without saying which: only when nothing else does.
    expect(gddPlatform("Ships on PC running Linux.")).toMatchObject({ target: "linux", targets: ["linux"] });
    expect(gddPlatform("A PC game.")).toMatchObject({ target: "windows" });
    // …and a store still tells us it is a handheld.
    expect(gddPlatform("Release on Windows and Google Play.").handheld).toBe(true);
    expect(gddPlatform("Ships on Steam for Linux.").handheld).toBe(false);
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
  it("an OS BEFORE the store qualifies it too, and PC is resolved where it stands (Codex 2026-09-11 L#11)", () => {
    // "the Mac app on the App Store" is ONE platform. The qualifier check only
    // looked forward, so a macOS document also demanded an iOS build — and
    // that invented platform then blocked delivery forever.
    expect(gddPlatform("Buy the Mac app on the App Store.").targets).toEqual(["macos"]);
    expect(gddPlatform("Linux release via Steam.").targets).toEqual(["linux"]);
    // …but a coordinator between them still means two platforms.
    expect(gddPlatform("Release on Windows and Google Play.").targets).toEqual(["windows", "android"]);
    expect(gddPlatform("Mac app, and the App Store later.").targets).toEqual(["macos", "ios"]);
    // PC named beside a NON-desktop platform is still a desktop requirement:
    // suppressing every PC mention as soon as any OS appeared anywhere lost it.
    expect(gddPlatform("Release on PC and Android.").targets).toEqual(["windows", "android"]);
    // …and PC qualified by its own OS adds nothing.
    expect(gddPlatform("Ships on PC running Linux.").targets).toEqual(["linux"]);
  });

  it("a build's own words name its platform, and a different platform does not satisfy the request (Codex 2026-09-11 L#12)", () => {
    expect(targetOfBuild("StandaloneWindows64")).toBe("windows");
    expect(targetOfBuild("StandaloneOSX")).toBe("macos");
    expect(targetOfBuild("StandaloneLinux64")).toBe("linux");
    expect(targetOfBuild("/tmp/Build/Game.apk")).toBe("android");
    expect(targetOfBuild("/tmp/Build/Game.exe")).toBe("windows");
    expect(targetOfBuild("/tmp/Build/Game.app")).toBe("macos");
    expect(targetOfBuild("/tmp/Build/index.html")).toBe("webgl");
    expect(targetOfBuild(undefined)).toBeUndefined();
    expect(targetOfBuild("Release")).toBeUndefined();
    // A macOS artifact used to satisfy "Release on Windows" and reach done.
    expect(buildSatisfiesTarget("windows", "StandaloneOSX")).toBe(false);
    expect(buildSatisfiesTarget("windows", "StandaloneWindows64")).toBe(true);
    // The ARTIFACT contradicts the request even when the target is silent.
    expect(buildSatisfiesTarget("windows", undefined, "/tmp/Build/Game.app")).toBe(false);
    expect(buildSatisfiesTarget("windows", undefined, "/tmp/Build/Game.exe")).toBe(true);
    // Silence is not a contradiction: an unnamed build of an unnamed shape
    // still counts, because an unsatisfiable gate is worse than a named gap.
    expect(buildSatisfiesTarget("windows", undefined, undefined)).toBe(true);
    expect(buildSatisfiesTarget(undefined, "StandaloneOSX")).toBe(true);
  });
});
