import { SystemCreateTool } from "./system-create.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool.interface.js";

describe("SystemCreateTool", () => {
  let tool: SystemCreateTool;
  let tempDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    tool = new SystemCreateTool();
    tempDir = mkdtempSync(join(tmpdir(), "strata-system-test-"));
    mkdirSync(join(tempDir, "Assets", "Systems"), { recursive: true });
    ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a valid SystemBase system", async () => {
    const result = await tool.execute(
      {
        name: "MovementSystem",
        path: "Assets/Systems/MovementSystem.cs",
        namespace: "Game.Systems",
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("System 'MovementSystem' created");

    const filePath = join(tempDir, "Assets/Systems/MovementSystem.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("public class MovementSystem : SystemBase");
    expect(code).toContain("namespace Game.Systems");
    expect(code).toContain("using Strada.Core.ECS;");
    expect(code).toContain("using Strada.Core.ECS.Core;");
    expect(code).toContain("public override void OnUpdate(float deltaTime)");
  });

  it("creates a valid JobSystemBase system with Burst and Jobs usings", async () => {
    const result = await tool.execute(
      {
        name: "PhysicsJob",
        path: "Assets/Systems/PhysicsJob.cs",
        namespace: "Game.Physics",
        base_class: "JobSystemBase",
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Base: JobSystemBase");

    const filePath = join(tempDir, "Assets/Systems/PhysicsJob.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("public class PhysicsJob : JobSystemBase");
    expect(code).toContain("using Unity.Burst;");
    expect(code).toContain("using Unity.Jobs;");
  });

  it("creates a valid SystemGroup without OnUpdate", async () => {
    const result = await tool.execute(
      {
        name: "CombatGroup",
        path: "Assets/Systems/CombatGroup.cs",
        namespace: "Game.Combat",
        base_class: "SystemGroup",
      },
      ctx
    );

    expect(result.isError).toBeUndefined();

    const filePath = join(tempDir, "Assets/Systems/CombatGroup.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("public class CombatGroup : SystemGroup");
    expect(code).not.toContain("OnUpdate");
    expect(code).toContain("Systems in this group execute in order");
  });

  it("generates query with World.Query and GetComponentRef calls", async () => {
    const result = await tool.execute(
      {
        name: "DamageSystem",
        path: "Assets/Systems/DamageSystem.cs",
        namespace: "Game.Combat",
        query_components: ["Health", "Armor"],
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Query: <Health, Armor>");

    const filePath = join(tempDir, "Assets/Systems/DamageSystem.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("World.Query<Health, Armor>()");
    expect(code).toContain("World.GetComponentRef<Health>(entity)");
    expect(code).toContain("World.GetComponentRef<Armor>(entity)");
  });

  it("generates constructor with DI fields and assignments for injected services", async () => {
    const result = await tool.execute(
      {
        name: "SpawnSystem",
        path: "Assets/Systems/SpawnSystem.cs",
        namespace: "Game.Spawning",
        inject_services: ["ICombatService", "IConfigService"],
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Injected: ICombatService, IConfigService");

    const filePath = join(tempDir, "Assets/Systems/SpawnSystem.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("private readonly ICombatService _combatService;");
    expect(code).toContain("private readonly IConfigService _configService;");
    expect(code).toContain("public SpawnSystem(ICombatService combatService, IConfigService configService)");
    expect(code).toContain("_combatService = combatService;");
    expect(code).toContain("_configService = configService;");
  });

  it("returns error for invalid system name", async () => {
    const result = await tool.execute(
      {
        name: "123Bad",
        path: "Assets/Systems/Bad.cs",
        namespace: "Game",
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid system name");
  });

  it("returns error for invalid namespace", async () => {
    const result = await tool.execute(
      {
        name: "ValidSystem",
        path: "Assets/Systems/ValidSystem.cs",
        namespace: "123.Bad.Namespace",
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid namespace");
  });

  it("returns error for invalid base_class", async () => {
    const result = await tool.execute(
      {
        name: "ValidSystem",
        path: "Assets/Systems/ValidSystem.cs",
        namespace: "Game",
        base_class: "NotAValidBase",
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("base_class must be one of");
    expect(result.content).toContain("SystemBase");
    expect(result.content).toContain("JobSystemBase");
    expect(result.content).toContain("SystemGroup");
  });

  it("returns error for invalid component name in query_components", async () => {
    const result = await tool.execute(
      {
        name: "BadQuerySystem",
        path: "Assets/Systems/BadQuerySystem.cs",
        namespace: "Game",
        query_components: ["ValidComponent", "123Invalid"],
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid component name");
    expect(result.content).toContain("123Invalid");
  });

  it("returns error for invalid service name in inject_services", async () => {
    const result = await tool.execute(
      {
        name: "BadServiceSystem",
        path: "Assets/Systems/BadServiceSystem.cs",
        namespace: "Game",
        inject_services: ["IValid", "not valid!"],
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid service name");
    expect(result.content).toContain("not valid!");
  });

  it("returns error in read-only mode", async () => {
    const readOnlyCtx: ToolContext = { ...ctx, readOnly: true };
    const result = await tool.execute(
      {
        name: "SomeSystem",
        path: "Assets/Systems/SomeSystem.cs",
        namespace: "Game",
      },
      readOnlyCtx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error when required fields are missing", async () => {
    const result = await tool.execute(
      { name: "", path: "", namespace: "" },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for path traversal attempts", async () => {
    const result = await tool.execute(
      {
        name: "EvilSystem",
        path: "../../etc/passwd",
        namespace: "Game",
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/[Pp]ath|[Dd]irectory/);
  });
});
