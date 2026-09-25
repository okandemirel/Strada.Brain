import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
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

  it("carries the stored delivery package — and null when no campaign layer answered", async () => {
    // The portal reads the package from THIS payload (plan 6.1), so a restarted
    // daemon and a browser that never saw the chat are served the same rows.
    const view = {
      latest: null,
      index: [],
      note: "no delivery has been packaged on this machine yet",
    };
    const served = await buildBuildStatus({ campaign: undefined, guardian: undefined, measure: false, deliveryPackages: view });
    expect(served.deliveryPackages).toBe(view);
    // A status built without a campaign layer says null, which the page renders
    // as "no package block" rather than as an empty package.
    const none = await buildBuildStatus({ campaign: undefined, guardian: undefined, measure: false });
    expect(none.deliveryPackages).toBeNull();
  });

  it("measures a real project without holding the event loop (CHN-8)", async () => {
    // The default measurer walked Assets/ synchronously: the dashboard's
    // measure=1 stalled every channel for the length of the walk.
    const root = mkdtempSync(join(os.tmpdir(), "build-status-measure-"));
    try {
      for (let d = 0; d < 20; d++) {
        const dir = join(root, "Assets", "Pack", `D${d}`);
        mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 15; f++) writeFileSync(join(dir, `m${f}.mat.meta`), `guid: ${String(d * 100 + f).padStart(32, "0")}\n`);
      }
      // Once first, so the measurer's module is loaded and only the
      // measurement itself is timed below.
      await buildBuildStatus({ campaign: undefined, guardian: undefined, projectRoot: root, measure: true });
      let ticks = 0;
      let running = true;
      const beat = (): void => {
        if (!running) return;
        ticks++;
        setImmediate(beat);
      };
      setImmediate(beat);
      const status = await buildBuildStatus({ campaign: undefined, guardian: undefined, projectRoot: root, measure: true });
      running = false;
      expect(status.measurementError).toBeUndefined();
      expect(status.measurement).not.toBeNull();
      expect(ticks).toBeGreaterThan(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
