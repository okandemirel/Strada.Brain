import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true,
  corePath: "/tmp/project/Packages/Strada.Core",
  modulesInstalled: true,
  modulesPath: "/tmp/project/Packages/Strada.Modules",
  mcpInstalled: true,
  mcpPath: "/tmp/project/Packages/Strada.MCP",
  mcpVersion: "1.0.0",
  warnings: [],
} as const;

describe("StradaConformanceGuard", () => {
  it("does not trigger conformance review for generic system wording alone", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Improve the system prompt and tidy the chat flow.");

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("does not block pure Strada analysis prompts without framework code changes", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Analyze whether Strada.Core review should block completion.");

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("requires a successful authoritative-source check before clearing framework code changes", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackToolCall("file_write", { path: "/tmp/project/Packages/Strada.Core/Runtime/FooSystem.cs" }, false);
    expect(guard.needsConformanceReview()).toBe(true);

    guard.trackToolCall("file_read", { path: "/tmp/project/Packages/Strada.Core/README.md" }, true);
    expect(guard.needsConformanceReview()).toBe(true);

    guard.trackToolCall("file_read", { path: "/tmp/project/Packages/Strada.Core/README.md" }, false);
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("inspects successful nested batch operations for conformance evidence", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackToolCall(
      "batch_execute",
      {
        operations: [
          { tool: "file_write", input: { path: "Assets/Gameplay/CombatSystem.cs" } },
          { tool: "file_read", input: { path: "/tmp/project/Packages/Strada.Modules/README.md" } },
        ],
      },
      false,
      JSON.stringify({
        results: [
          { tool: "file_write", success: true, content: "written" },
          { tool: "file_read", success: true, content: "docs" },
        ],
      }),
    );

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("accepts successful Strada generators as built-in conformance-aware paths", () => {
    const guard = new StradaConformanceGuard(deps);

    guard.trackPrompt("Create a Strada component for the new flow.");
    guard.trackToolCall("strada_create_component", { name: "FlowComponent" }, false);

    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("returns false when enabled=false regardless of state", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
      { enabled: false },
    );
    guard.trackToolCall("file_edit", { path: "Packages/strada.core/Runtime/Foo.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("does not trigger for game project .cs files when frameworkPathsOnly is default", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
    );
    guard.trackToolCall("file_edit", { path: "Assets/Game/LevelSolver.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("triggers for files inside Strada package directory", () => {
    const guard = new StradaConformanceGuard(
      { coreInstalled: true, corePath: "Packages/strada.core", modulesInstalled: false, modulesPath: null, mcpInstalled: false, mcpPath: null, mcpVersion: null, warnings: [] },
    );
    guard.trackToolCall("file_edit", { path: "Packages/strada.core/Runtime/Component.cs" }, false, "");
    expect(guard.needsConformanceReview()).toBe(true);
  });
});

/**
 * WP-1.2: with the default frameworkPathsOnly, the review fired only for a
 * write into a framework package — and those writes are now refused, so the
 * gate could fire only for a generator that failed. What it exists for is
 * game code written against the framework's API without looking at it.
 */
describe("the conformance review targets game code that uses the framework", () => {
  const installed = {
    coreInstalled: true,
    corePath: "/tmp/project/Packages/Submodules/Strada.Core",
    modulesInstalled: false,
    modulesPath: null,
    mcpInstalled: false,
    mcpPath: null,
    mcpVersion: null,
    warnings: [],
  } as const;
  const SYSTEM = "using Strada.Core.ECS;\nnamespace Game.Combat { public class DamageSystem : SystemBase {} }\n";

  it("asks after game code written against Strada.Core, until a framework source was consulted", () => {
    const guard = new StradaConformanceGuard(installed);

    guard.trackToolCall("file_write", { path: "Assets/Modules/Combat/DamageSystem.cs", content: SYSTEM }, false, "written");
    expect(guard.needsConformanceReview()).toBe(true);

    guard.trackToolCall("file_read", { path: "Packages/Submodules/Strada.Core/Runtime/ECS/SystemBase.cs" }, false, "...");
    expect(guard.needsConformanceReview()).toBe(false);
  });

  it("an edit counts by the file it leaves, not only by the text it inserted", () => {
    const root = mkdtempSync(join(tmpdir(), "conformance-retarget-"));
    try {
      mkdirSync(join(root, "Assets", "Modules", "Combat"), { recursive: true });
      writeFileSync(join(root, "Assets", "Modules", "Combat", "DamageSystem.cs"), SYSTEM);
      const guard = new StradaConformanceGuard(installed, { projectPath: root });

      guard.trackToolCall(
        "file_edit",
        { path: "Assets/Modules/Combat/DamageSystem.cs", old_string: "{}", new_string: "{ int damage; }" },
        false,
        "edited",
      );
      expect(guard.needsConformanceReview()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the framework vault the prompt points at counts as consulting the source", () => {
    const byName = new StradaConformanceGuard(installed);
    byName.trackToolCall("file_write", { path: "Assets/Modules/Combat/DamageSystem.cs", content: SYSTEM }, false, "written");
    byName.trackToolCall("vault_search", { query: "SystemBase OnUpdate", vaultId: "Strada.Core" }, false, "vault_search: 1 hit(s)");
    expect(byName.needsConformanceReview()).toBe(false);

    // The project's own vault, answering from the vendored package.
    const byHit = new StradaConformanceGuard(installed);
    byHit.trackToolCall("file_write", { path: "Assets/Modules/Combat/DamageSystem.cs", content: SYSTEM }, false, "written");
    byHit.trackToolCall(
      "vault_search",
      { query: "SystemBase OnUpdate" },
      false,
      "vault_search: 1 hit(s), ~40 tok, searched=[unity:ab12]\n\n--- [1] Packages/Submodules/Strada.Core/Runtime/ECS/SystemBase.cs:1-20 (vault=unity:ab12 source=fts score=0.5000) ---\npublic abstract class SystemBase {}",
    );
    expect(byHit.needsConformanceReview()).toBe(false);
  });

  it("a search that only found the game's own code does not count (guard)", () => {
    const guard = new StradaConformanceGuard(installed);
    guard.trackToolCall("file_write", { path: "Assets/Modules/Combat/DamageSystem.cs", content: SYSTEM }, false, "written");
    guard.trackToolCall(
      "vault_search",
      { query: "DamageSystem" },
      false,
      "vault_search: 1 hit(s), ~40 tok, searched=[unity:ab12]\n\n--- [1] Assets/Modules/Combat/DamageSystem.cs:1-3 (vault=unity:ab12 source=fts score=0.5000) ---\nusing Strada.Core.ECS;",
    );
    expect(guard.needsConformanceReview()).toBe(true);
  });

  it("game code that does not use the framework, and a framework write that was refused, do not ask (guard)", () => {
    const guard = new StradaConformanceGuard(installed);
    guard.trackToolCall("file_write", { path: "Assets/Scripts/Util/MathExt.cs", content: "namespace Game { static class MathExt {} }" }, false, "written");
    guard.trackToolCall("file_write", { path: "Packages/Submodules/Strada.Core/Runtime/Patch.cs", content: SYSTEM }, true, "Error: framework package");
    expect(guard.needsConformanceReview()).toBe(false);
  });
});

/**
 * An invented project the drawing gates can reach: a complete module, art on
 * disk, a wired scene, and `frames` captured into Recordings/ by this run.
 */
function kilnProject(frames: readonly string[], designDoc?: string): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), "conformance-kiln-"));
  const moduleRoot = join(root, "Assets", "Modules", "KilnModule");
  const scripts = join(moduleRoot, "Scripts");
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, "KilnModuleConfig.cs");
  writeFileSync(configPath, "public class KilnModuleConfig : ModuleConfig {}");
  writeFileSync(join(scripts, "Game.Modules.Kiln.asmdef"), '{"name":"Game.Modules.Kiln"}');
  writeFileSync(join(moduleRoot, "KilnModuleConfig.asset"), "%YAML 1.1");
  const tests = join(moduleRoot, "Tests", "Runtime");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "Game.Modules.Kiln.Tests.asmdef"), '{"name":"Game.Modules.Kiln.Tests"}');
  writeFileSync(join(tests, "KilnTests.cs"), "[Test] public void Fires() {}");
  mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
  writeFileSync(join(root, "Assets", "Scenes", "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
  mkdirSync(join(root, "Assets", "Art"), { recursive: true });
  writeFileSync(join(root, "Assets", "Art", "glaze.png"), "glaze");
  if (designDoc !== undefined) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "design.md"), designDoc);
  }
  const rec = join(root, "Recordings");
  mkdirSync(rec, { recursive: true });
  frames.forEach((content, i) => writeFileSync(join(rec, `frame_${String(i).padStart(5, "0")}.png`), content));
  return { root, configPath };
}

function playedKiln(root: string, configPath: string): StradaConformanceGuard {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall("file_write", { path: configPath }, false);
  guard.trackToolCall("unity_playmode_verify", { captureFrames: 60 }, false);
  return guard;
}

/** `total` frames of which exactly `distinct` differ from one another. */
const framesWithVariety = (distinct: number, total = 60): string[] =>
  Array.from({ length: total }, (_, i) => `kiln-shot-${i % distinct}`);

describe("frames that differ too little do not prove drawing", () => {
  // Frames can differ only because an overlay changes over an empty scene, so
  // the bar is a quarter of the sampled frames distinct, not merely two.
  it("fails at 14 distinct frames of 60 and names the ratio", () => {
    const { root, configPath } = kilnProject(framesWithVariety(14));
    try {
      const prompt = playedKiln(root, configPath).getPrompt() ?? "";
      expect(prompt).toContain("[STRADA NOTHING DRAWN]");
      expect(prompt).toContain("frames vary too little to prove drawing: 14/60 distinct");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes at 15 distinct frames of 60, the quarter itself", () => {
    const { root, configPath } = kilnProject(framesWithVariety(15));
    try {
      const guard = playedKiln(root, configPath);
      expect(guard.getPrompt() ?? "").not.toContain("[STRADA NOTHING DRAWN]");
      expect(guard.unmetDeliveryConditions().join("\n")).not.toContain("never been observed to render");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the drawing asks claim nothing about a particular game", () => {
  it("asks for the play the design describes without assuming it has levels", () => {
    const design =
      "# Kiln Hours\n\nOne continuous firing shift: pots arrive on a cart, the player loads and fires " +
      "them, and the shift ends when the kiln cracks. There are no rounds and no stages.\n";
    const { root, configPath } = kilnProject(framesWithVariety(1, 12), design);
    try {
      const prompt = playedKiln(root, configPath).getPrompt() ?? "";
      expect(prompt).toContain("[STRADA NOTHING DRAWN]");
      expect(prompt).toContain("the play its design describes");
      expect(prompt).not.toMatch(/\blevels?\b/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for a camera without claiming the prefabs carry renderers", () => {
    // Prefabs with a Transform and nothing else: no renderer anywhere.
    const root = mkdtempSync(join(tmpdir(), "conformance-no-camera-"));
    try {
      const scripts = join(root, "Assets", "Scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, "Kiln.cs"), "public class Kiln {}");
      mkdirSync(join(root, "Assets", "Prefabs"), { recursive: true });
      writeFileSync(
        join(root, "Assets", "Prefabs", "Pot.prefab"),
        "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Pot\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n",
      );
      mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
      writeFileSync(join(root, "Assets", "Scenes", "Workshop.unity"), "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Bench\n");
      const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
      guard.trackToolCall("file_write", { path: join(scripts, "Kiln.cs") }, false);

      const prompt = guard.getPrompt() ?? "";
      expect(prompt).toContain("[STRADA NO CAMERA]");
      expect(prompt).toContain("Workshop.unity holds no Camera");
      expect(prompt).not.toMatch(/carr(?:y|ies) a renderer/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
