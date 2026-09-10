/**
 * The build tool's fenced JSON verdict → the campaign's build evidence.
 * A missing or broken verdict is `ran: false` — disclosed, never a pass.
 */
import { describe, expect, it } from "vitest";
import { parsePlayerBuildOutput } from "./stage-runtime.js";

const built =
  "PLAYER BUILT (StandaloneOSX).\nTarget StandaloneOSX; 2 scene(s): Assets/Scenes/Main.unity, Assets/Scenes/Level.unity; 118 s; 3 warning(s); 0 error(s).\n" +
  "Artifact: /p/Builds/StandaloneOSX/Game.app — 83.9 MB on disk.\n\n```json\n" +
  JSON.stringify({
    ok: true, reasons: [],
    result: { built: true, exitCode: 0, target: "StandaloneOSX", outputPath: "/p/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000, durationMs: 118_000, warnings: 3, scenes: ["a", "b"], errors: [] },
    artifact: { path: "/p/Builds/StandaloneOSX/Game.app", exists: true, sizeBytes: 88_000_000 },
    measuredAt: "2026-09-10T13:00:00.000Z",
  }) + "\n```";

describe("parsePlayerBuildOutput", () => {
  it("a built player: ran, ok, artifact path and size, target, duration, scene count", () => {
    expect(parsePlayerBuildOutput(built)).toEqual({
      ran: true, ok: true, reasons: [], target: "StandaloneOSX", durationMs: 118_000, scenes: 2,
      artifactPath: "/p/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000,
      detail: "PLAYER BUILT (StandaloneOSX).", measuredAt: "2026-09-10T13:00:00.000Z",
    });
  });

  it("a failed build keeps its reasons and names no artifact; an artifact that does not exist is not one", () => {
    const failed = "PLAYER BUILD FAILED.\n```json\n" + JSON.stringify({ ok: false, reasons: ["build failed with exit code 21"], result: { target: "Android", scenes: [], durationMs: 5 }, artifact: { path: "/p/x.apk", exists: false, sizeBytes: 0 } }) + "\n```";
    expect(parsePlayerBuildOutput(failed)).toMatchObject({ ran: true, ok: false, reasons: ["build failed with exit code 21"], target: "Android" });
    expect(parsePlayerBuildOutput(failed).artifactPath).toBeUndefined();
  });

  it("no verdict, or a broken one, is NOT MEASURED with the first line as the reason", () => {
    expect(parsePlayerBuildOutput("Unity crashed before the builder ran\nmore")).toEqual({ ran: false, detail: "Unity crashed before the builder ran" });
    expect(parsePlayerBuildOutput("")).toEqual({ ran: false, detail: "the build tool returned no verdict" });
    expect(parsePlayerBuildOutput("x\n```json\n{not json\n```")).toEqual({ ran: false, detail: "the build tool's verdict was not valid JSON" });
  });
});
