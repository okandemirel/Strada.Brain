/**
 * Using the framework versus wearing it.
 *
 * Measured 2026-08-21 on a delivered project: 6 of Strada.Core's 194 public
 * types used. 22 hand-rolled public events against 0 uses of Communication's
 * 11 types; 37 Debug.Log calls against 0 uses of Logging's 10. It inherited
 * SystemBase for a tick, took [Inject], registered a ModuleConfig, and wrote a
 * plain C# game inside the shell.
 *
 * The rule counts REIMPLEMENTATION, never mere non-use: a game owes nobody a
 * state machine, and a guard that demanded every subsystem would fire on every
 * honest project.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { assessFrameworkBypass } from "./scene-wiring.js";
import { StradaConformanceGuard } from "./strada-conformance.js";

function io(files: Record<string, string>) {
  return {
    listFiles: () => Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
    exists: () => true,
  };
}

const events = (n: number) =>
  Array.from({ length: n }, (_, i) => `public event Action Thing${i};`).join("\n");
const logs = (n: number) =>
  Array.from({ length: n }, (_, i) => `Debug.Log("x${i}");`).join("\n");

describe("what the project built instead of using", () => {
  it("names hand-rolled events when the bus went untouched", () => {
    const found = assessFrameworkBypass("/p", io({ "/p/Assets/A.cs": events(6) }));

    expect(found).toHaveLength(1);
    expect(found[0]?.what).toContain("events");
    expect(found[0]?.count).toBe(6);
    expect(found[0]?.instead).toContain("Communication");
  });

  it("says nothing once the project actually uses the bus", () => {
    const found = assessFrameworkBypass("/p", io({
      "/p/Assets/A.cs": events(6),
      "/p/Assets/B.cs": "_bus.Publish(new Thing());",
    }));

    expect(found.filter((f) => f.what.includes("events"))).toHaveLength(0);
  });

  it("names Debug.Log only when StradaLog is nowhere", () => {
    const withStrada = assessFrameworkBypass("/p", io({
      "/p/Assets/A.cs": logs(12),
      "/p/Assets/B.cs": "StradaLog.LogWarning(\"x\", LogModule.Modules);",
    }));
    const without = assessFrameworkBypass("/p", io({ "/p/Assets/A.cs": logs(12) }));

    expect(withStrada).toHaveLength(0);
    expect(without[0]?.instead).toContain("StradaLog");
  });

  it("ignores a handful, which is not a pattern", () => {
    expect(assessFrameworkBypass("/p", io({ "/p/Assets/A.cs": events(2) }))).toHaveLength(0);
    expect(assessFrameworkBypass("/p", io({ "/p/Assets/A.cs": logs(3) }))).toHaveLength(0);
  });

  it("does not count tests, which may legitimately log and stub", () => {
    const found = assessFrameworkBypass("/p", io({ "/p/Assets/Tests/Runtime/T.cs": logs(30) }));

    expect(found).toHaveLength(0);
  });
});

describe("the gate the guard actually raises", () => {
  const deps = {
    coreInstalled: true, corePath: "/core", modulesInstalled: true, modulesPath: "/modules",
    mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
  } as const;

  /** An assembled, rendering game that still wrote its own event system. */
  function project(): { root: string; configPath: string } {
    const root = mkdtempSync(join(os.tmpdir(), "bypass-gate-"));
    const moduleRoot = join(root, "Assets", "Modules", "BoardModule");
    const scripts = join(moduleRoot, "Scripts");
    mkdirSync(scripts, { recursive: true });

    const configPath = join(scripts, "BoardModuleConfig.cs");
    writeFileSync(configPath, "public class BoardModuleConfig : ModuleConfig {}");
    writeFileSync(join(scripts, "Board.asmdef"), JSON.stringify({ name: "Board" }));
    writeFileSync(join(scripts, "CubeView.cs"), "public class CubeView : MonoBehaviour {}");
    writeFileSync(join(scripts, "BoardService.cs"), events(8));
    writeFileSync(join(moduleRoot, "BoardModuleConfig.asset"), "%YAML 1.1");

    const prefabs = join(moduleRoot, "Prefabs");
    mkdirSync(prefabs, { recursive: true });
    writeFileSync(join(prefabs, "Cube.prefab"), "GameObject:");

    const scenes = join(root, "Assets", "Scenes");
    mkdirSync(scenes, { recursive: true });
    writeFileSync(join(scenes, "Main.unity"), "  _gameConfig: {fileID: 11400000, guid: abc}");
    return { root, configPath };
  }

  it("names the rendering problem too, instead of hiding it behind this one", () => {
    // Measured 2026-08-21: an agent told to stop reimplementing spent that time
    // building a fourth service-and-system pair for rendering, because the gate
    // that would have said nothing renders was queued behind this one.
    const { root, configPath } = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt() ?? "";

    // This project HAS a view (CubeView), so only the bypass is open and there
    // is nothing else to mention.
    expect(prompt).toContain("[STRADA REIMPLEMENTED]");
    expect(prompt).not.toContain("Also still true");
  });

  it("blocks a run that reimplemented a subsystem, counting what it wrote", () => {
    const { root, configPath } = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);

    const prompt = guard.getPrompt();

    expect(prompt).toContain("[STRADA REIMPLEMENTED]");
    expect(prompt).toContain("8 hand-rolled C# events");
    expect(prompt).toContain("Communication");
    // It must say why it matters, not merely that it noticed.
    expect(prompt).toContain("not a style note");
  });

  it("says nothing to a run that wrote no project code", () => {
    const { root } = project();
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA REIMPLEMENTED]");
  });
});
