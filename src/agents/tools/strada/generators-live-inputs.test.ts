/**
 * What the single-file generators are actually sent, and what they did with it.
 *
 * Measured live: every failed strada_create_system call carried
 * `burst_component_count: 0`. The model fills an optional number with
 * its zero value; the tool read 0 as "a BurstSystem with no components" and
 * refused the call, when the caller meant no BurstSystem at all.
 *
 * The same calls go to folders a module does not have yet (the guard refused a
 * missing parent, though the writer makes the chain itself), to a path with no
 * `.cs` (accepted, and written as a file Unity never compiles), and follow the
 * schema's own example paths — which named a layout create_module never makes.
 *
 * These run against the real path guard: the refusals were the guard's.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { SystemCreateTool } from "./system-create.js";
import { ComponentCreateTool } from "./component-create.js";
import { MediatorCreateTool } from "./mediator-create.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreLayout } from "./core-declaration-fixture.js";
import type { ITool } from "../tool.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "generators-live-"));
  installCoreLayout(root);
  return root;
}

const run = (tool: ITool, projectPath: string, input: Record<string, unknown>) =>
  tool.execute(input, { projectPath, workingDirectory: projectPath, readOnly: false } as never);

const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split("/")), "utf-8");

describe("an optional input the model fills with its zero value is absent", () => {
  it("burst_component_count: 0 makes a plain system, not a refusal", async () => {
    const root = project();
    const result = await run(new SystemCreateTool(), root, {
      name: "Drift",
      path: "Assets/Systems/DriftSystem.cs",
      namespace: "Game.Modules.Drift",
      base_class: "SystemBase",
      burst_component_count: 0,
      query_components: ["Heading"],
    });

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    const code = read(root, "Assets/Systems/DriftSystem.cs");
    expect(code).toContain("public class DriftSystem : SystemBase");
    expect(code).not.toContain("BurstSystem<");
  });

  it("burst_component_count: null and base_class: \"\" are absent too", async () => {
    const root = project();
    const result = await run(new SystemCreateTool(), root, {
      name: "Tide",
      path: "Assets/Systems/TideSystem.cs",
      namespace: "Game.Modules.Tide",
      base_class: "",
      burst_component_count: null,
      query_components: ["Current"],
    });

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, "Assets/Systems/TideSystem.cs")).toContain("public class TideSystem : SystemBase");
  });

  it("a real count is still held to its range and its components", async () => {
    const root = project();
    const outOfRange = await run(new SystemCreateTool(), root, {
      name: "Swarm", path: "Assets/Systems/SwarmSystem.cs", namespace: "Game",
      burst_component_count: 5, query_components: ["A", "B", "C", "D", "E"],
    });
    expect(outOfRange.isError).toBe(true);
    expect(outOfRange.content).toContain("between 1 and 4");

    const mismatched = await run(new SystemCreateTool(), root, {
      name: "Swarm", path: "Assets/Systems/SwarmSystem.cs", namespace: "Game",
      burst_component_count: 2, query_components: ["A"],
    });
    expect(mismatched.isError).toBe(true);
    expect(existsSync(join(root, "Assets", "Systems", "SwarmSystem.cs"))).toBe(false);
  });

  it("strada_create_module takes an empty path and namespace as its defaults", async () => {
    const root = project();
    const result = await run(new ModuleCreateTool(), root, { name: "Harbor", path: "", namespace: "" });

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, "Assets/Modules/HarborModule/Scripts/HarborModuleConfig.cs")).toContain(
      "namespace Game.Modules.Harbor",
    );
  });
});

// One call per generator, each writing into a module folder that does not exist yet.
const generators: Array<{ kind: string; tool: () => ITool; input: (path: string) => Record<string, unknown> }> = [
  {
    kind: "system",
    tool: () => new SystemCreateTool(),
    input: (path) => ({ name: "Orbit", path, namespace: "Game.Modules.Orbit", query_components: ["Radius"] }),
  },
  {
    kind: "component",
    tool: () => new ComponentCreateTool(),
    input: (path) => ({ name: "Orbit", path, namespace: "Game.Modules.Orbit", fields: [{ name: "Radius", type: "float" }] }),
  },
  {
    kind: "mediator",
    tool: () => new MediatorCreateTool(),
    input: (path) => ({ name: "Orbit", view_type: "OrbitView", path, namespace: "Game.Modules.Orbit" }),
  },
];

describe("a generator writes into folders that do not exist yet", () => {
  for (const g of generators) {
    it(`strada_create_${g.kind} creates the missing parent folders`, async () => {
      const root = project();
      const rel = `Assets/Modules/OrbitModule/Scripts/New/Orbit${g.kind}.cs`;
      const result = await run(g.tool(), root, g.input(rel));

      expect(result.isError, `refused: ${result.content}`).toBeFalsy();
      expect(existsSync(join(root, ...rel.split("/")))).toBe(true);
    });

    it(`strada_create_${g.kind} still refuses a path outside the project`, async () => {
      const root = project();
      const outside = mkdtempSync(join(os.tmpdir(), "generators-live-outside-"));
      const result = await run(g.tool(), root, g.input(join("..", basename(outside), "Deep", "Orbit.cs")));

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside the project/i);
      expect(existsSync(join(outside, "Deep"))).toBe(false);
    });
  }
});

describe("a generator writes C# only to a .cs file", () => {
  for (const g of generators) {
    it(`strada_create_${g.kind} refuses a path without .cs and writes nothing`, async () => {
      const root = project();
      mkdirSync(join(root, "Assets", "Scripts"), { recursive: true });
      const result = await run(g.tool(), root, g.input("Assets/Scripts/Orbit"));

      expect(result.isError).toBe(true);
      expect(result.content).toContain(".cs");
      expect(readdirSync(join(root, "Assets", "Scripts"))).toEqual([]);
    });
  }
});

describe("the schema's example path is one create_module makes", () => {
  // Each generator's example names a folder of a module create_module laid
  // down with that component selected, and a file named for the class the
  // tool generates from the example's own name.
  const examples: Array<{ tool: ITool; className: string }> = [
    { tool: new SystemCreateTool(), className: "DamageSystem" },
    { tool: new ComponentCreateTool(), className: "HealthComponent" },
    { tool: new MediatorCreateTool(), className: "EnemyMediator" },
  ];

  for (const ex of examples) {
    it(`${ex.tool.name}: path example`, async () => {
      const root = project();
      const made = await run(new ModuleCreateTool(), root, {
        name: "Combat",
        include_system: true,
        include_view: true,
      });
      expect(made.isError, `module refused: ${made.content}`).toBeFalsy();

      const schema = ex.tool.inputSchema as { properties: Record<string, { description?: string }> };
      const example = /e\.g\.,? '([^']+)'/.exec(schema.properties["path"]?.description ?? "")?.[1];
      expect(example, "the path description gives no example").toBeDefined();

      const folder = dirname(example!);
      expect(
        existsSync(join(root, ...folder.split("/"))),
        `${folder} is not a folder create_module made; it made: ${readdirSync(join(root, "Assets", "Modules", "CombatModule", "Scripts")).join(", ")}`,
      ).toBe(true);
      expect(basename(example!)).toBe(`${ex.className}.cs`);

      const ns = /e\.g\.,? '([^']+)'/.exec(schema.properties["namespace"]?.description ?? "")?.[1];
      expect(ns, "the namespace description gives no example").toBe("Game.Modules.Combat");
    });
  }
});
