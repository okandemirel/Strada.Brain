/**
 * The build tool's fenced JSON verdict → the campaign's build evidence.
 * A missing or broken verdict is `ran: false` — disclosed, never a pass.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlayerBuildOutput, makeRunPlayer } from "./stage-runtime.js";

const realArtifact = mkdtempSync(join(tmpdir(), "build-artifact-")) + "/Game.app";
writeFileSync(realArtifact, "binary");

const built =
  "PLAYER BUILT (StandaloneOSX).\nTarget StandaloneOSX; 2 scene(s): Assets/Scenes/Main.unity, Assets/Scenes/Level.unity; 118 s; 3 warning(s); 0 error(s).\n" +
  "Artifact: /p/Builds/StandaloneOSX/Game.app — 83.9 MB on disk.\n\n```json\n" +
  JSON.stringify({
    ok: true, reasons: [],
    result: { built: true, exitCode: 0, target: "StandaloneOSX", outputPath: realArtifact, sizeBytes: 88_000_000, durationMs: 118_000, warnings: 3, scenes: ["a", "b"], errors: [] },
    artifact: { path: realArtifact, exists: true, sizeBytes: 88_000_000 },
    measuredAt: "2026-09-10T13:00:00.000Z",
  }) + "\n```";

describe("makeRunPlayer — the tool's own failure reaches the caller (Codex 2026-09-11 D#6)", () => {
  const registry = (result: { content?: unknown; isError?: boolean }, names = ["unity_run_player"]) => ({
    getAvailableToolNames: () => names,
    execute: async () => result,
  });

  it("throws what an unsupported host said, and stays silent on success", async () => {
    await expect(makeRunPlayer(registry({ content: "unsupported artifact on this host", isError: true }))("/p", "/p/Game.apk"))
      .rejects.toThrow(/unsupported artifact on this host/);
    await expect(makeRunPlayer(registry({ content: "PLAYER PLAY-THROUGH OK" }))("/p", "/p/Game.app")).resolves.toBeUndefined();
    await expect(makeRunPlayer(registry({}, []))("/p", "/p/Game.app")).rejects.toThrow(/not registered/);
  });
});

describe("parsePlayerBuildOutput", () => {
  it("a claimed artifact that is NOT on disk is not a successful build (Codex 2026-09-11 C#12)", () => {
    const claimed = "PLAYER BUILT.\n\n```json\n" + JSON.stringify({ ok: true, reasons: [], artifact: { path: "/does/not/exist/Game.app", exists: true } }) + "\n```";
    const parsed = parsePlayerBuildOutput(claimed);
    expect(parsed).toMatchObject({ ran: true, ok: false });
    expect(parsed.reasons?.join(" ")).toContain("is not on disk");
  });

  it("ok WITHOUT an artifact on disk is not a successful build (Codex 2026-09-11 B#3)", () => {
    const noArtifact = "PLAYER BUILT.\n\n```json\n" + JSON.stringify({ ok: true, reasons: [], artifact: { exists: false } }) + "\n```";
    const parsed = parsePlayerBuildOutput(noArtifact);
    expect(parsed).toMatchObject({ ran: true, ok: false });
    expect(parsed.reasons?.join(" ")).toContain("named no artifact");
    expect(parsed.artifactPath).toBeUndefined();
  });

  it("a built player: ran, ok, artifact path and size, target, duration, scene count", () => {
    expect(parsePlayerBuildOutput(built)).toEqual({
      ran: true, ok: true, reasons: [], target: "StandaloneOSX", durationMs: 118_000, scenes: 2,
      artifactPath: realArtifact, sizeBytes: 88_000_000,
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
