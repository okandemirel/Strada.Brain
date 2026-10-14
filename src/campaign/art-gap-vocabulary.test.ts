/**
 * Which audit findings the campaign calls art.
 *
 * isArtGap decides the ORDER of the gap sprints: an art gap goes first,
 * because everything visible depends on it. So a word read as art that isn't
 * costs a sprint — the audio gap is worked as art, and the art gap that does
 * exist waits behind it.
 *
 * The findings below are invented: a two-player winter curling-and-cargo game
 * about hauling crates across a frozen harbour. Nothing here is an asset name
 * from any real project, which is the point — the vocabulary has to be the one
 * any game's art is described with.
 */

import { describe, expect, it } from "vitest";
import { isArtGap } from "./campaign-manager.js";

describe("isArtGap — findings that ARE about art", () => {
  it.each([
    "Glacier cliff textures are missing",
    "The harbour tileset has no ice variants",
    "Cactus-crate walk animation absent",
    "Crate sprites for the heavy variant were never made",
    "No art at all for the dockside crane",
    "The sled mesh is a grey box",
    "Ice materials are the default white",
    "The frost shader was never written",
    "Steam-vent vfx missing from the boiler room",
    "Snow particles never implemented",
    "Toolbar icons are placeholders",
    "Skipper portraits were never drawn",
    "The score panel has no graphics",
    "No illustrations for the between-round cards",
    "Tilemaps for the upper harbour are empty",
    "The crew visuals were never started",
    "Promotional artwork is not in the repo",
  ])("counts %s", (finding) => {
    expect(isArtGap(finding)).toBe(true);
  });

  it.each([
    // "model" and "background" are art only with an art word beside them.
    "3D models for the harbour cranes are missing",
    "Low-poly models for the crates were never made",
    "Character models have no rig",
    "Background plates for the three harbours are missing",
    "Background images for the title card were never made",
  ])("counts %s, because an art word sits beside the shared noun", (finding) => {
    expect(isArtGap(finding)).toBe(true);
  });
});

describe("isArtGap — findings that are NOT about art", () => {
  it.each([
    // Audio. This one used to be read as art because the pattern matched the
    // stem "background" anywhere in the line.
    "Background music loop absent",
    "The crate-landing sound effect is not wired",
    // A C# type, not a mesh.
    "Save data model is not versioned",
    "The harbour state model has no migration",
    // Words that merely BEGIN with "art".
    "Audit artifact not archived",
    "Artillery accuracy is not covered by a test",
    "The articulation of the crane arm is not simulated",
    // Ordinary coverage gaps, so the art sprint does not swallow them.
    "Frost warning: the overnight alert is not covered",
    "Harvest ledger: the season's weight tally is not covered",
    "Two-player turn order is not covered by a test",
  ])("does not count %s", (finding) => {
    expect(isArtGap(finding)).toBe(false);
  });
});
