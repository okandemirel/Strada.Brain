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

    // Two separate facts about this project, each named for what it measured:
    // the frames never varied, and the run produced no scene to play.
    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("never been observed to render"),
      expect.stringContaining("not a runnable game"),
    ]);
  });

  it("reports a game that was played but captured nothing", () => {
    const root = project();

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([
      expect.stringContaining("no frame has ever been captured"),
      expect.stringContaining("not a runnable game"),
    ]);
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

describe("what does not block delivery", () => {
  it("does not blame the picture for a run that never played the game", () => {
    // Nothing has been observed to render because nothing was ever started —
    // saying so would report the never-run problem under the wrong name. What
    // this run IS owed a claim about is the assembly it never finished.
    const root = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall(
      "file_write",
      { path: join(root, "Assets", "Modules", "BoardModule", "Scripts", "Board.cs") },
      false,
    );

    const unmet = guard.unmetDeliveryConditions();
    expect(unmet.join(" ")).not.toContain("never been observed to render");
    expect(unmet).toEqual([expect.stringContaining("not a runnable game")]);
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
 * A design document that schedules more than this sprint builds.
 *
 * The acceptance bar for the rejected 2026-09-02 attempt: it mirrored
 * elementAssetCoverageReason() into the delivery claim, and that reason
 * measures the WHOLE GDD element schedule. A sprint asked for the board and
 * nothing else then could not deliver, because elements planned for later
 * sprints had no art yet.
 */
const GDD_SCHEDULING_MORE = [
  "# Test Game GDD",
  "",
  "## 4.1 Element Schedule",
  "",
  "| Unlock | Element | Notes |",
  "| ------ | ------- | ----- |",
  "| L21 | Rocket | blasts a row |",
  "| L36 | Ice Block | freezes a cell |",
  "| L48 | Colour Bomb | clears a colour |",
  "",
].join("\n");

/** A run that wrote module code and never started the game. */
function runThatNeverPlayed(root: string): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall(
    "file_write",
    { path: join(root, "Assets", "Modules", "BoardModule", "Scripts", "Board.cs") },
    false,
  );
  return guard;
}

describe("a game that was assembled and never started", () => {
  it("does not count as delivered", () => {
    const root = assembled();
    const guard = runThatNeverPlayed(root);

    // The gate must be the one actually asking, or the claim below proves
    // nothing about it.
    expect(guard.getPrompt() ?? "").toContain("GAME NEVER RUN");

    expect(guard.unmetDeliveryConditions()).toEqual([
      expect.stringContaining("never started the game"),
    ]);
  });

  it("still reports after the never-run gate has spent every ask", () => {
    // The measured failure: the ask budget ran out, getPrompt() went quiet, and
    // the run reported the game delivered because only NOTHING DRAWN was ever
    // mirrored into the delivery claim.
    const root = assembled();
    const guard = runThatNeverPlayed(root);

    for (let i = 0; i < 4; i += 1) {
      guard.trackToolCall("file_read", { path: join(root, "x.cs") }, false);
      guard.getPrompt();
    }
    expect(guard.getPrompt() ?? "").not.toContain("GAME NEVER RUN");

    expect(guard.unmetDeliveryConditions()).toEqual([
      expect.stringContaining("never started the game"),
    ]);
  });
});

describe("the delivery claim stays inside the sprint's own scope", () => {
  it("delivers a sprint that built and ran its own work, though the GDD schedules more", () => {
    // The rejection bar. Every element in GDD_SCHEDULING_MORE belongs to a
    // later sprint and has no art in this project; this sprint assembled its
    // scene, ran the game, and its frames varied. That is a delivery, and a
    // claim that read the whole schedule would refuse it.
    const root = assembled();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "GDD.md"), GDD_SCHEDULING_MORE);
    framesOf(root, ["one", "two", "three"]);

    expect(runThatPlayed(root).unmetDeliveryConditions()).toEqual([]);
  });
});
