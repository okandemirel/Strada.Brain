/**
 * M6 of the drift audit: every campaign planned as if the project were empty,
 * and each one added another implementation of work already there — three
 * parallel simulations in one measured game. The planner had no inventory
 * because nothing built one.
 */
import { describe, expect, it } from "vitest";
import { describeProjectInventory, readProjectInventory } from "./project-inventory.js";

function io(files: Record<string, string>) {
  return {
    listFiles: (_dir: string, match?: (f: string) => boolean) =>
      Object.keys(files).filter((f) => f.includes("/Assets/") && (match?.(f) ?? true)),
    readFile: (p: string) => files[p] ?? "",
    exists: (p: string) => p.endsWith("Assets") || Object.keys(files).some((f) => f.startsWith(p)),
  };
}

const PROJECT = {
  "/p/Assets/Modules/Harbor/Scripts/HarborModuleConfig.cs": "public class HarborModuleConfig : ModuleConfig { }",
  "/p/Assets/Modules/Harbor/Scripts/BeamService.cs": "public class BeamService : IBeamService { }",
  "/p/Assets/Modules/Tide/Scripts/TideModuleConfig.cs": "public class TideModuleConfig : StradaModuleConfig { }",
  "/p/Assets/Scenes/Harbor.unity": "GameObject:",
  "/p/Assets/Scenes/Sandbox.unity": "GameObject:",
  "/p/ProjectSettings/EditorBuildSettings.asset":
    "  - enabled: 1\n    path: Assets/Scenes/Harbor.unity\n  - enabled: 0\n    path: Assets/Scenes/Sandbox.unity\n",
};

describe("readProjectInventory", () => {
  it("names the modules, services and scenes the tree holds", () => {
    const inv = readProjectInventory("/p", io(PROJECT));

    expect(inv.measured).toBe(true);
    expect(inv.modules).toEqual(["Harbor", "Tide"]);
    expect(inv.services).toEqual(["BeamService"]);
    expect(inv.scenes).toEqual(["Assets/Scenes/Harbor.unity", "Assets/Scenes/Sandbox.unity"]);
    expect(inv.scriptCount).toBe(3);
  });

  it("names only the scenes the build actually opens", () => {
    expect(readProjectInventory("/p", io(PROJECT)).shippedScenes).toEqual(["Assets/Scenes/Harbor.unity"]);
  });

  it("says it measured nothing when the project has no Assets", () => {
    const inv = readProjectInventory("/p", { listFiles: () => [], readFile: () => "", exists: () => false });
    expect(inv.measured).toBe(false);
    expect(describeProjectInventory("/p", { listFiles: () => [], readFile: () => "", exists: () => false })).toBeNull();
  });

  it("has nothing to say about an empty project, where building from scratch is the right plan", () => {
    const empty = io({ "/p/Assets/.keep": "" });
    expect(describeProjectInventory("/p", empty)).toBeNull();
  });
});

describe("describeProjectInventory", () => {
  it("gives the planner the facts and the rule they serve", () => {
    const said = describeProjectInventory("/p", io(PROJECT)) ?? "";

    expect(said).toContain("WHAT THIS PROJECT ALREADY HAS");
    expect(said).toContain("measured from the tree just now");
    expect(said).toContain("modules: Harbor, Tide");
    expect(said).toContain("services: BeamService");
    expect(said).toContain("the build opens Assets/Scenes/Harbor.unity");
    // The rule, not only the list: a note nobody is told what to do with
    // changes no plan.
    expect(said).toContain("planned as a CHANGE to that file");
    expect(said).toContain("Adding a second module");
  });

  it("says plainly when no scene is enabled in the build", () => {
    const said = describeProjectInventory("/p", io({
      "/p/Assets/Modules/Harbor/Scripts/HarborModuleConfig.cs": "public class HarborModuleConfig : ModuleConfig { }",
      "/p/Assets/Scenes/Harbor.unity": "GameObject:",
    })) ?? "";

    expect(said).toContain("none enabled in the build");
  });
});
