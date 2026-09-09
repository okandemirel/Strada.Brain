import { describe, it, expect, vi } from "vitest";
import { buildBuildStatus, summarizeMeasurement } from "./build-status.js";
import type { BuiltAsSpecifiedReport } from "../agents/autonomy/built-as-specified.js";

const report: BuiltAsSpecifiedReport = {
  measured: true,
  scenes: [],
  shippedScenes: [{ scene: "Assets/Scenes/Main.unity" } as never],
  shippedRenderers: 27,
  shippedWorldRenderers: 20,
  referencedOnlyRenderers: 0,
  shippedProjectRefs: 40,
  shippedBuiltInRefs: 2,
  shippedMeshRenderers: 5,
  shippedSpriteRenderers: 22,
  artInventory: { prefabs: 31, models: 0, sprites: 519, placeholderSprites: 394, audio: 29, duplicateAudio: 4, shortAudio: 19 },
  unboundPrefabs: ["a"],
  unboundModels: [],
  unboundSprites: ["s", "t"],
  placeholderSpritePaths: [],
  boundPlaceholderSprites: 12,
  primitiveScripts: [],
  primitiveCallSites: 0,
  disclosures: [],
  incomplete: ["Assets/Big.unity skipped: over size cap"],
};

describe("buildBuildStatus", () => {
  it("does not measure unless asked, and says so with null rather than zeros", async () => {
    const measurer = vi.fn(() => report);
    const status = await buildBuildStatus({ campaign: undefined, guardian: undefined, projectRoot: "/p", measure: false, measurer });
    expect(measurer).not.toHaveBeenCalled();
    expect(status.measurement).toBeNull();
    expect(status.campaign).toBeNull();
    expect(status.guardian).toBeNull();
  });

  it("summarizes the delivery-gate report when asked", async () => {
    const status = await buildBuildStatus({ campaign: undefined, guardian: undefined, projectRoot: "/p", measure: true, measurer: () => report, now: 1_800_000_000_000 });
    expect(status.measurement).toMatchObject({
      measured: true,
      refusal: null,
      shippedScenes: ["Assets/Scenes/Main.unity"],
      shippedRenderers: 27,
      artInventory: { placeholderSprites: 394 },
      boundPlaceholderSprites: 12,
      unbound: { prefabs: 1, models: 0, sprites: 2 },
      incomplete: ["Assets/Big.unity skipped: over size cap"],
    });
    expect(summarizeMeasurement(report).measuredAt).toMatch(/^\d{4}-/);
  });

  it("reports a measurement failure instead of hiding it", async () => {
    const failing = await buildBuildStatus({
      campaign: undefined,
      guardian: undefined,
      projectRoot: "/p",
      measure: true,
      measurer: () => {
        throw new Error("EACCES Assets/");
      },
    });
    expect(failing.measurement).toBeNull();
    expect(failing.measurementError).toBe("EACCES Assets/");

    const noRoot = await buildBuildStatus({ campaign: undefined, guardian: undefined, measure: true, measurer: () => report });
    expect(noRoot.measurement).toBeNull();
    expect(noRoot.measurementError).toMatch(/No project path/);
  });
});
