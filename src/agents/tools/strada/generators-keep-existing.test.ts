/**
 * A generator lays down stubs; it must never lay one over code that is there.
 *
 * Measured (audit tools#0): a module folder already held an implemented
 * Scripts/Systems/BoardSystem.cs and Scripts/Services/BoardService.cs but no
 * ModuleConfig.cs and no .asmdef. The conformance gate said "Create them
 * (strada_create_module produces both)"; the agent called strada_create_module
 * with the module's own name, every template path was truncated to a stub, and
 * the tool answered "Module 'Board' created successfully!". The same held for
 * strada_create_system, _component and _mediator on any existing path.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { SystemCreateTool } from "./system-create.js";
import { ComponentCreateTool } from "./component-create.js";
import { MediatorCreateTool } from "./mediator-create.js";
import { installCoreDeclaration } from "./core-declaration-fixture.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const MODULE = "Assets/Modules/BoardModule";

function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "generators-keep-"));
  installCoreDeclaration(root);
  return root;
}

function put(root: string, rel: string, content: string): void {
  const target = join(root, ...rel.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split("/")), "utf-8");

describe("strada_create_module in a module that already holds code", () => {
  it("keeps the implemented files and creates only what is missing", async () => {
    const root = project();
    put(root, `${MODULE}/Scripts/Systems/BoardSystem.cs`, "class BoardSystem { void Swap() {} }");
    put(root, `${MODULE}/Scripts/Services/BoardService.cs`, "class BoardService { int Score; }");

    const result = await new ModuleCreateTool().execute({ name: "BoardModule" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, `${MODULE}/Scripts/Systems/BoardSystem.cs`)).toContain("Swap()");
    expect(read(root, `${MODULE}/Scripts/Services/BoardService.cs`)).toContain("int Score;");
    // What the gate asked for is now there.
    expect(existsSync(join(root, MODULE, "Board.asmdef"))).toBe(true);
    expect(read(root, `${MODULE}/Scripts/BoardModuleConfig.cs`)).toContain("class BoardModuleConfig");

    // And the report says which files were kept, instead of calling them created.
    expect(result.content).not.toContain("created successfully");
    expect(result.content).toMatch(/kept/i);
    expect(result.content).toContain(`${MODULE}/Scripts/Systems/BoardSystem.cs`);
    const meta = result.metadata as { createdFiles: string[]; keptFiles: string[] };
    expect(meta.keptFiles).toEqual(
      expect.arrayContaining([
        `${MODULE}/Scripts/Systems/BoardSystem.cs`,
        `${MODULE}/Scripts/Services/BoardService.cs`,
      ]),
    );
    expect(meta.createdFiles).not.toContain(`${MODULE}/Scripts/Systems/BoardSystem.cs`);
  });

  // The service pair is one unit: Strada.Core constrains
  // RegisterService<TInterface, TImplementation> with
  // `where TImplementation : class, TInterface`, so a stub half generated next
  // to a hand-written half either duplicates a type or fails that constraint.
  // Measured: a kept `class BoardService { int Score; }` got a stub
  // IBoardService.cs beside it and a config registering the two together.
  it("creates neither half of the service pair when the service is already there", async () => {
    const root = project();
    put(root, `${MODULE}/Scripts/Services/BoardService.cs`, "class BoardService { int Score; }");

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(root, MODULE, "Scripts", "Services", "IBoardService.cs"))).toBe(false);
    expect(read(root, `${MODULE}/Scripts/Services/BoardService.cs`)).toBe("class BoardService { int Score; }");
    // The config it did create registers nothing it did not create, and the
    // result says the registration is left to the author.
    expect(read(root, `${MODULE}/Scripts/BoardModuleConfig.cs`)).not.toContain("RegisterService");
    expect(result.content).toContain("RegisterService<IBoardService, BoardService>");
    expect(result.content).toMatch(/not registered/);
    const meta = result.metadata as { createdFiles: string[]; keptFiles: string[] };
    expect(meta.createdFiles.some((f) => /Service\.cs$/.test(f))).toBe(false);
  });

  it("finds the interface where the framework's own layout files it", async () => {
    // Strada.Core declares ServiceInterface's folder as Scripts/Interfaces; a
    // module laid out that way already declares IBoardService, and a second
    // one in Scripts/Services is a duplicate type in the same namespace.
    const root = project();
    put(
      root,
      `${MODULE}/Scripts/Interfaces/IBoardService.cs`,
      "namespace Game.Modules.Board { public interface IBoardService { void Reset(); } }",
    );

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(root, MODULE, "Scripts", "Services", "IBoardService.cs"))).toBe(false);
    expect(existsSync(join(root, MODULE, "Scripts", "Services", "BoardService.cs"))).toBe(false);
    expect(read(root, `${MODULE}/Scripts/BoardModuleConfig.cs`)).not.toContain("RegisterService");
    expect(result.content).toContain(`${MODULE}/Scripts/Interfaces/IBoardService.cs`);
  });

  it("does not generate a system the module already declares under another file name", async () => {
    const root = project();
    put(
      root,
      `${MODULE}/Scripts/Systems/Gameplay/Systems.cs`,
      "namespace Game.Modules.Board { public sealed class BoardSystem : SystemBase { } }",
    );

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(root, MODULE, "Scripts", "Systems", "BoardSystem.cs"))).toBe(false);
    expect(result.content).toContain(`${MODULE}/Scripts/Systems/Gameplay/Systems.cs`);
  });

  it("still creates and registers the whole pair in a fresh module", async () => {
    const root = project();

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, `${MODULE}/Scripts/Services/IBoardService.cs`)).toContain("interface IBoardService");
    expect(read(root, `${MODULE}/Scripts/Services/BoardService.cs`)).toContain("class BoardService");
    expect(read(root, `${MODULE}/Scripts/BoardModuleConfig.cs`)).toContain(
      "RegisterService<IBoardService, BoardService>",
    );
  });

  it("points the test assemblies at the module assembly it kept", async () => {
    // A kept root .asmdef named something else is the module's assembly; test
    // assemblies referencing Game.Modules.Board reference nothing.
    const root = project();
    put(root, `${MODULE}/GridQuest.Board.asmdef`, JSON.stringify({ name: "GridQuest.Board" }));

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    const runtime = readdirSync(join(root, MODULE, "Tests", "Runtime")).filter((f) => f.endsWith(".asmdef"));
    expect(runtime).toEqual(["GridQuest.Board.Tests.asmdef"]);
    const asmdef = JSON.parse(read(root, `${MODULE}/Tests/Runtime/GridQuest.Board.Tests.asmdef`)) as {
      name: string;
      references: string[];
    };
    expect(asmdef.name).toBe("GridQuest.Board.Tests");
    expect(asmdef.references).toContain("GridQuest.Board");
    expect(asmdef.references).not.toContain("Game.Modules.Board");
  });

  it("keeps a test assembly the Tests folder already has above the mode folder", async () => {
    // Tests/Runtime compiles into the nearest .asmdef above it; a second one
    // claiming the same assembly name is a duplicate assembly.
    const root = project();
    put(root, `${MODULE}/Tests/Game.Modules.Board.Tests.asmdef`, JSON.stringify({ name: "Game.Modules.Board.Tests" }));

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(root, MODULE, "Tests", "Runtime", "Game.Modules.Board.Tests.asmdef"))).toBe(false);
    expect(result.content).toContain(`${MODULE}/Tests/Game.Modules.Board.Tests.asmdef`);
  });

  it("keeps a hand-written ModuleConfig wherever in the module it sits", async () => {
    // A second <Name>ModuleConfig class is a duplicate definition: the module
    // stops compiling, which is no better than losing the first one.
    const root = project();
    put(root, `${MODULE}/BoardModuleConfig.cs`, "class BoardModuleConfig { /* mine */ }");

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(root, MODULE, "Scripts", "BoardModuleConfig.cs"))).toBe(false);
    expect(read(root, `${MODULE}/BoardModuleConfig.cs`)).toContain("/* mine */");
    expect(result.content).toContain(`${MODULE}/BoardModuleConfig.cs`);
  });

  it("keeps an assembly the module root already has under another name", async () => {
    // Unity allows one .asmdef per folder; a second one stops every assembly
    // in the project from compiling.
    const root = project();
    put(root, `${MODULE}/Game.Modules.Board.asmdef`, '{ "name": "Game.Modules.Board" }');

    const result = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(readdirSync(join(root, MODULE)).filter((f) => f.endsWith(".asmdef"))).toEqual([
      "Game.Modules.Board.asmdef",
    ]);
    expect(result.content).toContain(`${MODULE}/Game.Modules.Board.asmdef`);
  });

  it("overwrites nothing when the whole module is already there", async () => {
    const root = project();
    const first = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);
    expect(first.isError, `refused: ${first.content}`).toBeFalsy();
    put(root, `${MODULE}/Scripts/BoardModuleConfig.cs`, "// edited by hand");

    const again = await new ModuleCreateTool().execute({ name: "Board" }, { projectPath: root } as never);

    expect(again.isError, `refused: ${again.content}`).toBeFalsy();
    expect(read(root, `${MODULE}/Scripts/BoardModuleConfig.cs`)).toBe("// edited by hand");
    expect((again.metadata as { createdFiles: string[] }).createdFiles).toEqual([]);
    expect(again.content).not.toContain("created successfully");
  });
});

describe("the single-file generators on a path that exists", () => {
  const existing = "// real code — do not replace";

  const cases: Array<{ tool: string; run: (root: string, path: string) => Promise<{ isError?: boolean; content: string }> }> = [
    {
      tool: "strada_create_system",
      run: (root, path) =>
        new SystemCreateTool().execute(
          { name: "BoardSystem", path, namespace: "Game.Modules.Board" },
          { projectPath: root, workingDirectory: root, readOnly: false },
        ),
    },
    {
      tool: "strada_create_component",
      run: (root, path) =>
        new ComponentCreateTool().execute(
          { name: "Cell", path, namespace: "Game.Modules.Board", fields: [{ name: "X", type: "int" }] },
          { projectPath: root, workingDirectory: root, readOnly: false },
        ),
    },
    {
      tool: "strada_create_mediator",
      run: (root, path) =>
        new MediatorCreateTool().execute(
          { name: "CellMediator", view_type: "CellView", path, namespace: "Game.Modules.Board" },
          { projectPath: root, workingDirectory: root, readOnly: false },
        ),
    },
  ];

  for (const { tool, run } of cases) {
    it(`${tool} leaves the file as it was and does not report it created`, async () => {
      const root = project();
      const path = `${MODULE}/Scripts/Systems/Existing.cs`;
      put(root, path, existing);

      const result = await run(root, path);

      expect(read(root, path)).toBe(existing);
      expect(result.isError).toBe(true);
      expect(result.content).not.toMatch(/created at/);
      expect(result.content).toMatch(/already exists/);
    });

    it(`${tool} still creates a file that is not there`, async () => {
      const root = project();
      const path = `${MODULE}/Scripts/Systems/Fresh.cs`;
      mkdirSync(join(root, MODULE, "Scripts", "Systems"), { recursive: true });

      const result = await run(root, path);

      expect(result.isError, `refused: ${result.content}`).toBeFalsy();
      expect(result.content).toMatch(/created at/);
      expect(read(root, path)).toContain("namespace Game.Modules.Board");
    });
  }
});
