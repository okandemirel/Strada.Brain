/**
 * The gate that asks what the user already owns.
 *
 * Measured on PixelFlow: 25 sprites and zero meshes shipped for a design whose
 * own words are "softly rendered dimensional stages", while three Asset Store
 * packages the user had already downloaded sat on disk — one of them a vehicle
 * package containing two .fbx meshes. The tool that finds them, unity_my_assets_cloud,
 * was registered, advertised to the model in every phase, and described as
 * "use this BEFORE generating or importing any art". Across a 2 MB run log it
 * was called zero times.
 *
 * So the missing piece was never the capability. It was that nothing made the
 * run stop and look. This gate is that stop, and it is deliberately cheap to
 * clear: one read-only lookup, whatever the lookup answers.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
    expect(prompt).toContain("unity_my_assets_cloud");
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
    guard.trackToolCall("unity_my_assets_cloud", { query: "pixel tileset" }, false);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("is cleared by a lookup made before the art, not only after", () => {
    const guard = guardFor();
    guard.trackToolCall("unity_my_assets_cloud", {}, false);
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

/**
 * The way it actually happened.
 *
 * The gate above keys on art being ORIGINATED, on the theory that the moment to
 * ask "does the user already have one of these" is just before making one. Run
 * 52 showed that is half the problem: the agent originated no art at all. It
 * wrote fifteen C# files, seven assembly definitions, six ScriptableObjects and
 * a scene — and zero sprites, zero prefabs, zero meshes. Then it played the game
 * and captured sixty identical frames.
 *
 * The gate never fired, because nothing triggered it. The silence and the empty
 * scene both looked correct. [STRADA NOTHING DRAWN] reported the symptom without
 * ever naming the cause.
 */

/**
 * A project with game code, a scene and a config asset, plus whatever art is
 * passed in.
 *
 * The code sits under Assets/Scripts rather than Assets/Modules on purpose:
 * nothing obliges an agent to use the Modules layout, and putting it there would
 * put [STRADA MODULE INCOMPLETE] in front of the gate under test.
 */
function playedProject(art: readonly string[] = []): string {
  const root = mkdtempSync(join(os.tmpdir(), "assets-empty-"));
  const scripts = join(root, "Assets", "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "Board.cs"), "public class Board {}");
  writeFileSync(join(scripts, "GameConfig.asset"), "%YAML 1.1");
  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  for (const file of art) {
    const full = join(root, "Assets", "Art", file);
    mkdirSync(join(root, "Assets", "Art"), { recursive: true });
    writeFileSync(full, "x");
  }
  return root;
}

/** A run that wrote game code into that project and then played the game. */
function ranTheGame(root: string): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall(
    "file_write",
    { path: join(root, "Assets", "Scripts", "Board.cs") },
    false,
  );
  guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);
  return guard;
}

describe("a game that was played and has nothing in it to draw", () => {
  it("is stopped, and the gate names the cause rather than the symptom", () => {
    const prompt = ranTheGame(playedProject()).getPrompt() ?? "";

    expect(prompt).toContain(GATE);
    expect(prompt).toContain("contains no art whatsoever");
    expect(prompt).toContain("unity_my_assets_cloud");
  });

  it("says nothing once the project has art of any kind", () => {
    for (const art of ["tile.png", "ship.fbx"]) {
      const prompt = ranTheGame(playedProject([art])).getPrompt() ?? "";
      expect(prompt).not.toContain(GATE);
    }
  });

  it("counts a prefab as something to draw, via the gate that then takes over", () => {
    // A prefab of primitives and materials renders perfectly well, so it counts.
    // It cannot be observed here directly: a prefab in the project hands the
    // turn to a later gate. What that gate says is the evidence — [STRADA NO
    // CAMERA] complains about the missing camera precisely BECAUSE it considers
    // the prefab drawable content, which is the judgement under test.
    const prompt = ranTheGame(playedProject(["Ship.prefab"])).getPrompt() ?? "";

    expect(prompt).not.toContain(GATE);
    expect(prompt).toContain("already carries a renderer");
  });

  it("does not count art that belongs to the framework packages", () => {
    // Packages/ ships its own sprites and meshes. Counting those would let a
    // project with an empty Assets/ folder claim it has something to show.
    const root = playedProject();
    const packaged = join(root, "Packages", "Submodules", "Strada.Modules", "Art");
    mkdirSync(packaged, { recursive: true });
    writeFileSync(join(packaged, "icon.png"), "x");

    expect(ranTheGame(root).getPrompt() ?? "").toContain(GATE);
  });

  it("says nothing before the game has ever been run", () => {
    // A project mid-build is allowed to have nothing in it yet, and the gates
    // for "not assembled" and "never run" say that better.
    const root = playedProject();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall(
      "file_write",
      { path: join(root, "Assets", "Scripts", "Board.cs") },
      false,
    );

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("says nothing to a run that wrote no game code", () => {
    const root = playedProject();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });

  it("is cleared by looking, exactly as the other reason is", () => {
    const guard = ranTheGame(playedProject());
    expect(guard.getPrompt() ?? "").toContain(GATE);

    guard.trackToolCall("unity_my_assets_cloud", { query: "3d cube" }, false);

    expect(guard.getPrompt() ?? "").not.toContain(GATE);
  });
});
