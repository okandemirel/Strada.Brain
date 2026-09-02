/**
 * What a gate may still say after it has stopped asking.
 *
 * A conformance gate is an ASK, and an ask has to be able to give up: three
 * refusals and [STRADA NOTHING DRAWN] goes quiet, because a rule that cannot be
 * cleared stops being a rule and becomes a loop.
 *
 * Going quiet was then read as satisfied. Measured on run 52: the gate fired
 * three times, fell silent on the fourth, and the run finished `failed: false`
 * with a 123-character success message for a game whose sixty captured frames
 * were identical. The gate's own last words are "say the game does not render
 * rather than reporting it as delivered" — advice with nothing behind it.
 *
 * So the ask budget governs how often the agent is asked; this governs what may
 * be claimed, and it never goes quiet.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** A project with module code, so the drawing rules apply at all. */
function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "unmet-"));
  mkdirSync(join(root, "Assets", "Modules", "BoardModule", "Scripts"), { recursive: true });
  return root;
}

/**
 * The same project, assembled: config class, asmdef, config asset and a scene
 * that references it.
 *
 * Needed because the gates are ordered and [STRADA GAME NOT ASSEMBLED] sits
 * above [STRADA NOTHING DRAWN]. Without this the drawing gate is never the one
 * returned, its ask budget is never spent, and a test claiming to exhaust that
 * budget passes without ever having reached it — which is exactly how the first
 * version of the test below passed while proving nothing.
 */
const RENDERERS = 6;

function assembled(renderers = 6): string {
  const root = project();
  void RENDERERS;
  const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
  writeFileSync(
    join(moduleRoot, "Scripts", "BoardModuleConfig.cs"),
    "public class BoardModuleConfig : ModuleConfig {}",
  );
  writeFileSync(join(moduleRoot, "Scripts", "Board.asmdef"), JSON.stringify({ name: "Board" }));
  writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");

  // Its own play-mode and edit-mode test assemblies, each in its own folder —
  // Unity allows one .asmdef per directory. Without these
  // [STRADA MODULE TESTS MISSING] shadows the drawing gate instead.
  for (const [dir, name] of [
    [join("Tests", "Runtime", "Board"), "Board.Tests"],
    [join("Tests", "Editor", "Board"), "Board.Editor.Tests"],
  ] as const) {
    const testDir = join(moduleRoot, dir);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, `${name}.asmdef`), JSON.stringify({ name }));
    writeFileSync(join(testDir, "BoardTests.cs"), "[Test] public void Passes() {}");
  }
  const scenes = join(root, "Assets", "Scenes");
  mkdirSync(scenes, { recursive: true });
  let sceneBody = "  _gameConfig: {fileID: 11400000, guid: abc}";
  for (let i = 0; i < RENDERERS; i++) {
    sceneBody += `\n--- !u!1 &${i + 10}\nGameObject:\n  m_Name: Cube${i}`;
    sceneBody += `\n--- !u!212 &${i + 500}\nMeshRenderer:\n  m_GameObject: {fileID: ${i + 10}}`;
  }
  writeFileSync(join(scenes, "Main.unity"), sceneBody);

  // Art, so [STRADA ASSETS UNSOURCED] — which speaks before the drawing gate —
  // has nothing to say and the drawing gate is the one whose budget gets spent.
  const art = join(root, "Assets", "Art");
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "tile.png"), "pixels");
  return root;
}

function framesOf(root: string, pixels: readonly string[]): void {
  const dir = join(root, "Recordings");
  mkdirSync(dir, { recursive: true });
  pixels.forEach((content, i) => writeFileSync(join(dir, `frame_${i}.png`), content));
}

/** A run that wrote module code and played the game. */
function runThatPlayed(root: string): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall(
    "file_write",
    { path: join(root, "Assets", "Modules", "BoardModule", "Scripts", "Board.cs") },
    false,
  );
  guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);
  return guard;
}

describe("what blocks delivery", () => {
  it("reports identical frames as undelivered", () => {
    const root = project();
    framesOf(root, Array.from({ length: 60 }, () => "same-pixels"));

    // This fixture also holds no art, which is a second true condition (the
    // cause behind the identical frames) — so look for the render entry rather
    // than for a list of exactly one.
    expect(runThatPlayed(root).unmetDeliveryConditions()).toContainEqual(
      expect.stringContaining("never been observed to render"),
    );
  });

  it("reports a game that was played but captured nothing", () => {
    const root = project();

    expect(runThatPlayed(root).unmetDeliveryConditions()).toContainEqual(
      expect.stringContaining("no frame has ever been captured"),
    );
  });

  it("says nothing once the frames actually differ AND a playfield exists", () => {
    const root = assembled();
    framesOf(root, ["one", "two", "three"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([]);
  });

  it("still objects when frame variety is HUD-level", () => {
    // Measured 2026-08-24: HUD progress-bar variation alone (13% distinct)
    // satisfied the old differing-frames rule while nothing was drawn.
    const root = assembled(0);
    // 2 distinct of 10 = 20% — below the 25% substantive-variety bar.
    framesOf(root, ["same", "same", "same", "same", "same", "same", "same", "same", "same", "diff"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("vary too little"),
    ]);
  });
});

describe("where the game's code lives does not matter", () => {
  it("reports identical frames for a game written outside Assets/Modules/", () => {
    // Audited 2026-09-02: nothingDrawnReason() keyed on touchedModuleRoots, so a
    // game under Assets/Scripts/ (or Assets/Game/) — which wroteProjectCode was
    // introduced to cover — was exempt from the one enforced delivery condition
    // and could finish approved on 60 identical frames of empty sky.
    const root = project();
    framesOf(root, Array.from({ length: 60 }, () => "same-pixels"));
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: join(root, "Assets", "Scripts", "Game.cs") }, false);
    guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);

    expect(guard.unmetDeliveryConditions()).toContainEqual(
      expect.stringContaining("never been observed to render"),
    );
  });
});

describe("what does not block delivery", () => {
  it("stays silent about running for a game that is not assembled yet", () => {
    // A play-mode run of an unassembled project has nothing to load, and the
    // unbudgeted NOT ASSEMBLED gate never goes quiet about it — so "never run"
    // is only a delivery fact once there is something to run.
    const root = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall(
      "file_write",
      { path: join(root, "Assets", "Modules", "BoardModule", "Scripts", "Board.cs") },
      false,
    );

    expect(guard.unmetDeliveryConditions()).toEqual([]);
  });

  it("stays silent for a run that wrote no game code at all", () => {
    // A question about the project owes nobody a rendered frame.
    const root = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("unity_playmode_verify", {}, false);

    expect(guard.unmetDeliveryConditions()).toEqual([]);
  });
});

describe("the ask budget does not silence it", () => {
  it("still reports after the gate has spent every ask", () => {
    const root = assembled();
    framesOf(root, Array.from({ length: 60 }, () => "same-pixels"));
    const guard = runThatPlayed(root);

    // The gate must actually be the one being asked, or spending its budget
    // proves nothing.
    expect(guard.getPrompt() ?? "").toContain("NOTHING DRAWN");

    // Spend the three asks, each separated by a turn of work so the per-turn
    // budget actually decrements.
    for (let i = 0; i < 4; i += 1) {
      guard.trackToolCall("file_read", { path: join(root, "x.cs") }, false);
      guard.getPrompt();
    }
    expect(guard.getPrompt() ?? "").not.toContain("NOTHING DRAWN");

    // The asking is over. The fact is not.
    expect(guard.unmetDeliveryConditions()).toHaveLength(1);
  });
});

/**
 * Audited 2026-09-02: only NOTHING DRAWN was mirrored on the claim side. The
 * other budgeted asks — GAME NEVER RUN, PREFABS UNBOUND, ASSETS UNSOURCED (the
 * "nothing in it to draw" half), ELEMENT ASSETS MISSING — each end with "report
 * it that way rather than as done", and nothing checked whether that happened:
 * three asks, silence, and the run finished "approved" for a game that was
 * never started.
 */
describe("every budgeted ask is mirrored by the claim", () => {
  /** Assembled and wired, with nothing about the module for the other gates to say. */
  function assembledNeverRun(): { root: string; guard: StradaConformanceGuard } {
    const root = assembled();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall(
      "file_write",
      { path: join(root, "Assets", "Modules", "BoardModule", "Scripts", "Board.cs") },
      false,
    );
    return { root, guard };
  }

  it("reports an assembled game that was never run, after the asks are spent", () => {
    const { root, guard } = assembledNeverRun();
    expect(guard.getPrompt() ?? "").toContain("GAME NEVER RUN");

    for (let i = 0; i < 4; i += 1) {
      guard.trackToolCall("file_read", { path: join(root, "x.cs") }, false);
      guard.getPrompt();
    }
    expect(guard.getPrompt() ?? "").not.toContain("GAME NEVER RUN");

    expect(guard.unmetDeliveryConditions()).toEqual([
      expect.stringContaining("never run"),
    ]);
  });

  it("clears the never-run condition once play mode was attempted", () => {
    const { root, guard } = assembledNeverRun();
    framesOf(root, ["one", "two", "three"]);
    guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);

    expect(guard.unmetDeliveryConditions()).toEqual([]);
  });

  it("reports prefab configs that no asset instance binds", () => {
    const root = assembled();
    const scripts = join(root, "Assets", "Modules", "BoardModule", "Scripts");
    const configPath = join(scripts, "PresentationPrefabsConfig.cs");
    writeFileSync(
      configPath,
      "public class PresentationPrefabsConfig : ScriptableObject {\n" +
        "    [SerializeField] private GameObject _pigPrefab;\n}",
    );
    writeFileSync(`${configPath}.meta`, "fileFormatVersion: 2\nguid: 7f09385215284bf5ae25c59b4a8eb15e\n");
    framesOf(root, ["one", "two", "three"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("PresentationPrefabsConfig"),
    ]);
  });

  it("reports a played game with nothing in it to draw", () => {
    const root = assembled();
    rmSync(join(root, "Assets", "Art"), { recursive: true, force: true });
    framesOf(root, ["one", "two", "three"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("nothing in it to draw"),
    ]);
  });

  it("reports scheduled elements whose art is missing", () => {
    const root = assembled();
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(
      join(docs, "GDD.md"),
      "| Unlock | Element |\n| --- | --- |\n| L21 | Rocket |\n",
    );
    framesOf(root, ["one", "two", "three"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("Rocket"),
    ]);
  });
});
