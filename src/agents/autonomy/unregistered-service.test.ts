/**
 * A SERVICE NOTHING REGISTERS.
 *
 * Measured 2026-10-14 on a live proof run: 8 of the game's 9 services were
 * never registered with the container. Each one compiled, the suite was green,
 * and the module-shape gates saw a complete module — a service is registered
 * in a ModuleConfig's Configure, and nothing asked whether the service just
 * written appears there. What is not registered can only be reached by `new`
 * or by a hunt through the scene, which is the drift the framework prevents.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { assessUnregisteredServices } from "./scene-wiring.js";
import { StradaConformanceGuard } from "./strada-conformance.js";

function io(files: Record<string, string>) {
  return {
    listFiles: () => Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
    exists: () => true,
  };
}

describe("assessUnregisteredServices", () => {
  it("names a service no file registers", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({ "/p/Assets/Game/BeamService.cs": "public class BeamService : IBeamService { }" }),
    );
    expect(found).toEqual([{ name: "BeamService", file: "Assets/Game/BeamService.cs" }]);
  });

  it("says nothing about a service a ModuleConfig registers, by interface or alone", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({
        "/p/Assets/Game/BeamService.cs": "public class BeamService : IBeamService { }",
        "/p/Assets/Game/LaneService.cs": "public sealed class LaneService { }",
        "/p/Assets/Game/HarborModuleConfig.cs": [
          "public class HarborModuleConfig : ModuleConfig {",
          "  public override void Configure(IContainerBuilder builder) {",
          "    builder.RegisterService<IBeamService, BeamService>();",
          "    builder.RegisterService<global::Game.Modules.Harbor.LaneService>();",
          "  }",
          "}",
        ].join("\n"),
      }),
    );
    expect(found).toEqual([]);
  });

  it("takes an [AutoRegister] attribute as the registration it is", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({ "/p/Assets/Game/BeamService.cs": "[AutoRegisterService]\npublic class BeamService { }" }),
    );
    expect(found).toEqual([]);
  });

  it("does not ask an abstract service to be registered", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({ "/p/Assets/Game/BaseService.cs": "public abstract class BaseService { }" }),
    );
    expect(found).toEqual([]);
  });

  it("reads a test for the registration it holds, but never judges one as a declaration", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({
        "/p/Assets/Game/BeamService.cs": "public class BeamService { }",
        "/p/Assets/Tests/FakeService.cs": [
          "public class FakeService { }",
          "void Boot(IContainerBuilder b) { b.RegisterService<BeamService>(); }",
        ].join("\n"),
      }),
    );
    expect(found).toEqual([]);
  });

  it("judges only what the agent authored", () => {
    const files = {
      "/p/Assets/Game/BeamService.cs": "public class BeamService { }",
      "/p/Assets/Imported/VendorService.cs": "public class VendorService { }",
    };
    const found = assessUnregisteredServices("/p", io(files), (f) => f.includes("/Game/"));
    expect(found.map((s) => s.name)).toEqual(["BeamService"]);
  });

  it("stays silent when a file it cannot read might hold the registration", () => {
    const found = assessUnregisteredServices("/p", {
      listFiles: () => ["/p/Assets/Game/BeamService.cs", "/p/Assets/Game/Boot.cs"],
      readFile: (p: string) => {
        if (p.endsWith("Boot.cs")) throw new Error("EACCES");
        return "public class BeamService { }";
      },
      exists: () => true,
    });
    expect(found).toEqual([]);
  });

  it("does not take a comment or a string for a registration", () => {
    const found = assessUnregisteredServices(
      "/p",
      io({
        "/p/Assets/Game/BeamService.cs": "public class BeamService { }",
        "/p/Assets/Game/Notes.cs": [
          "// builder.RegisterService<BeamService>();",
          'const string todo = "RegisterService<BeamService>()";',
        ].join("\n"),
      }),
    );
    expect(found.map((s) => s.name)).toEqual(["BeamService"]);
  });

  it("says nothing when the project has no Assets folder", () => {
    expect(
      assessUnregisteredServices("/p", { listFiles: () => [], readFile: () => "", exists: () => false }),
    ).toEqual([]);
  });
});

describe("the gate the guard raises for an unregistered service", () => {
  const deps = {
    coreInstalled: true, corePath: "/core", modulesInstalled: true, modulesPath: "/modules",
    mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
  } as const;

  /** An assembled, rendering game with one service in a module. */
  function project(configBody: string): { root: string; configPath: string; servicePath: string } {
    const root = mkdtempSync(join(os.tmpdir(), "unregistered-gate-"));
    const moduleRoot = join(root, "Assets", "Modules", "HarborModule");
    const scripts = join(moduleRoot, "Scripts");
    mkdirSync(scripts, { recursive: true });

    const configPath = join(scripts, "HarborModuleConfig.cs");
    writeFileSync(configPath, configBody);
    writeFileSync(join(scripts, "Harbor.asmdef"), JSON.stringify({ name: "Harbor" }));
    writeFileSync(join(scripts, "BeamView.cs"), "public class BeamView : MonoBehaviour {}");
    const servicePath = join(scripts, "BeamService.cs");
    writeFileSync(servicePath, "public class BeamService : IBeamService { public bool Lit; }");
    writeFileSync(join(moduleRoot, "HarborModuleConfig.asset"), "%YAML 1.1");

    const prefabs = join(moduleRoot, "Prefabs");
    mkdirSync(prefabs, { recursive: true });
    writeFileSync(join(prefabs, "Beam.prefab"), "GameObject:");

    const scenes = join(root, "Assets", "Scenes");
    mkdirSync(scenes, { recursive: true });
    writeFileSync(
      join(scenes, "Harbor.unity"),
      "Camera:\n  m_Enabled: 1\n  _gameConfig: {fileID: 11400000, guid: abc}",
    );
    return { root, configPath, servicePath };
  }

  it("names the service, its file and the line that registers it", () => {
    const { root, configPath, servicePath } = project("public class HarborModuleConfig : ModuleConfig {}");
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    guard.trackToolCall("file_write", { path: servicePath }, false);

    const prompt = guard.getPrompt() ?? "";

    expect(prompt).toContain("[STRADA SERVICE UNREGISTERED]");
    expect(prompt).toContain("BeamService");
    expect(prompt).toContain("BeamService.cs");
    expect(prompt).toContain("builder.RegisterService<IBeamService, BeamService>()");
    expect(prompt).toContain("ModuleConfig.Configure");
  });

  it("says nothing once the module config registers it", () => {
    const { root, configPath, servicePath } = project(
      [
        "public class HarborModuleConfig : ModuleConfig {",
        "  public override void Configure(IContainerBuilder builder) {",
        "    builder.RegisterService<IBeamService, BeamService>();",
        "  }",
        "}",
      ].join("\n"),
    );
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall("file_write", { path: configPath }, false);
    guard.trackToolCall("file_write", { path: servicePath }, false);

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA SERVICE UNREGISTERED]");
  });

  it("says nothing to a run that wrote no project code", () => {
    const { root } = project("public class HarborModuleConfig : ModuleConfig {}");
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });

    expect(guard.getPrompt() ?? "").not.toContain("[STRADA SERVICE UNREGISTERED]");
  });
});
