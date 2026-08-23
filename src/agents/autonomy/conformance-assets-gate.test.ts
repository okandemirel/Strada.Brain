/**
 * The gate that asks what the user already owns.
 *
 * Measured on PixelFlow: 25 sprites and zero meshes shipped for a design whose
 * own words are "softly rendered dimensional stages", while three Asset Store
 * packages the user had already downloaded sat on disk — one of them a vehicle
 * package containing two .fbx meshes. The tool that finds them, unity_my_assets,
 * was registered, advertised to the model in every phase, and described as
 * "use this BEFORE generating or importing any art". Across a 2 MB run log it
 * was called zero times.
 *
 * So the missing piece was never the capability. It was that nothing made the
 * run stop and look. This gate is that stop, and it is deliberately cheap to
 * clear: one read-only lookup, whatever the lookup answers.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true,
  corePath: "/core",
  modulesInstalled: true,
  modulesPath: "/modules",
  mcpInstalled: true,
  mcpPath: "/mcp",
  mcpVersion: "1.0.0",
  warnings: [],
} as const;

const guardFor = () =>
  new StradaConformanceGuard(deps, {
    projectPath: mkdtempSync(join(os.tmpdir(), "assets-gate-")),
    enabled: true,
  });

const GATE = "[STRADA ASSETS UNSOURCED]";

/** A tool call that originates an art file inside the project. */
const drew = (guard: StradaConformanceGuard, path: string) =>
  guard.trackToolCall("file_write", { path }, false);

describe("a run that makes art without asking what the user owns", () => {
  it("is stopped, and the gate names the files it made", () => {
    const guard = guardFor();
    drew(guard, "/p/Assets/Art/tile.png");

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain(GATE);
    expect(prompt).toContain("Assets/Art/tile.png");
    expect(prompt).toContain("unity_my_assets");
  });

  it("counts every art file, and does not list them all", () => {
    const guard = guardFor();
    for (let i = 0; i < 7; i += 1) drew(guard, `/p/Assets/Art/tile${i}.png`);

    const prompt = guard.getPrompt() ?? "";
    expect(prompt).toContain("originated 7 art file(s)");
    expect(prompt).toContain("and 2 more");
  });

  it("catches meshes and audio, not only sprites", () => {
    for (const file of ["ship.fbx", "ship.obj", "ship.glb", "hit.wav", "hit.ogg"]) {
      const guard = guardFor();
      drew(guard, `/p/Assets/Art/${file}`);
      expect(guard.getPrompt() ?? "").toContain(GATE);
    }
  });
});

describe("what the gate deliberately ignores", () => {
  it("says nothing when no art was originated", () => {
    const guard = guardFor();
    guard.trackToolCall("file_write", { path: "/p/Assets/Scripts/Board.cs" }, false);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("leaves prefabs and materials alone — those compose art that exists", () => {
    for (const file of ["Ship.prefab", "Ship.mat", "Main.unity", "Config.asset"]) {
      const guard = guardFor();
      drew(guard, `/p/Assets/${file}`);
      expect(guard.getPrompt() ?? "").not.toContain(GATE);
    }
  });

  it("ignores art written outside the Unity project", () => {
    const guard = guardFor();
    drew(guard, "/tmp/scratch/preview.png");

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("ignores a write that failed — nothing was originated", () => {
    const guard = guardFor();
    guard.trackToolCall("file_write", { path: "/p/Assets/Art/tile.png" }, true);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });
});

describe("clearing the gate", () => {
  it("is cleared by asking, whatever the answer was", () => {
    const guard = guardFor();
    drew(guard, "/p/Assets/Art/tile.png");
    expect(guard.getPrompt() ?? "").toContain(GATE);

    // The honest answer "you own nothing that fits" clears it too: the rule
    // asks that the question was put, not that it was answered favourably.
    guard.trackToolCall("unity_my_assets", { query: "pixel tileset" }, false);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("is cleared by a lookup made before the art, not only after", () => {
    const guard = guardFor();
    guard.trackToolCall("unity_my_assets", {}, false);
    drew(guard, "/p/Assets/Art/tile.png");

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("gives up after two asks rather than looping forever", () => {
    const guard = guardFor();

    drew(guard, "/p/Assets/Art/a.png");
    expect(guard.getPrompt() ?? "").toContain(GATE);

    drew(guard, "/p/Assets/Art/b.png");
    const second = guard.getPrompt() ?? "";
    expect(second).toContain(GATE);
    expect(second).toContain("last time this is asked");

    drew(guard, "/p/Assets/Art/c.png");
    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("spends its budget per turn of work, not per question asked", () => {
    const guard = guardFor();
    drew(guard, "/p/Assets/Art/a.png");

    // Callers ask whether a gate is open and discard the text. Counting those
    // would burn the whole budget without the agent ever being told.
    for (let i = 0; i < 5; i += 1) expect(guard.getPrompt() ?? "").toContain(GATE);

    drew(guard, "/p/Assets/Art/b.png");
    expect(guard.getPrompt() ?? "").toContain("last time this is asked");
  });
});
