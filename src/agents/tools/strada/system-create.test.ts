import { SystemCreateTool } from "./system-create.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool.interface.js";
import { vi } from "vitest";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn(),
  isValidCSharpIdentifier: vi.fn(),
}));

import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";

describe("SystemCreateTool", () => {
  let tool: SystemCreateTool;
  let tempDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    tool = new SystemCreateTool();
    tempDir = mkdtempSync(join(tmpdir(), "strada-system-test-"));
    mkdirSync(join(tempDir, "Assets", "Systems"), { recursive: true });
    ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };

    // Default mock: return valid path based on the input path
    vi.mocked(validatePath).mockImplementation(async (_projectRoot: string, relPath: string) => {
      return { valid: true, fullPath: join(tempDir, relPath) };
    });

    // Default: all identifiers valid
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a valid SystemBase system with correct namespaces and lifecycle methods", async () => {
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
    expect(code).toContain("using Strada.Core.ECS.Systems;");
    expect(code).toContain("using Strada.Core.Modules;");
    expect(code).toContain("protected override void OnUpdate(float deltaTime)");
    expect(code).toContain("protected override void OnInitialize()");
    expect(code).toContain("protected override void OnDispose()");
    expect(code).toContain("[StradaSystem]");
    expect(code).toContain("[ExecutionOrder(0)]");
  });

  it("creates a compile-safe JobSystemBase system scaffold", async () => {
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
    expect(code).toContain("public class PhysicsJobSystem : JobSystemBase");
    expect(code).toContain("protected override JobHandle OnSchedule(float deltaTime, JobHandle dependency)");
    expect(code).toContain("protected override void OnCreate()");
    expect(code).toContain("protected override void OnDestroy()");
    expect(code).toContain("using Unity.Burst;");
    expect(code).toContain("using Unity.Jobs;");
    expect(code).toContain("using Strada.Core.ECS.Jobs;");
    expect(code).not.toContain("protected override void OnUpdate(float deltaTime)");
  });

  it("creates a scheduled JobSystemBase scaffold when query components are provided", async () => {
    const result = await tool.execute(
      {
        name: "PhysicsJob",
        path: "Assets/Systems/PhysicsJob.cs",
        namespace: "Game.Physics",
        base_class: "JobSystemBase",
        query_components: ["Position", "Velocity"],
      },
      ctx
    );

    expect(result.isError).toBeUndefined();

    const filePath = join(tempDir, "Assets/Systems/PhysicsJob.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("public struct PhysicsJobSystemJob : IJobComponent<Position, Velocity>");
    expect(code).toContain("ScheduleParallel<PhysicsJobSystemJob, Position, Velocity>");
    expect(code).toContain("public void Execute(int entity, ref Position position, ref Velocity velocity)");
  });

  it("creates a BurstSystem with generic variants", async () => {
    const result = await tool.execute(
      {
        name: "ParticleSystem",
        path: "Assets/Systems/ParticleSystem.cs",
        namespace: "Game.Particles",
        burst_component_count: 2,
        query_components: ["Position", "Velocity"],
      },
      ctx
    );

    expect(result.isError).toBeUndefined();

    const filePath = join(tempDir, "Assets/Systems/ParticleSystem.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("public class ParticleSystem : BurstSystem<ParticleSystemJob, Position, Velocity>");
    expect(code).toContain("[BurstCompile]");
    expect(code).toContain("public struct ParticleSystemJob : IJobComponent<Position, Velocity>");
    expect(code).toContain("protected override ParticleSystemJob CreateJob(float deltaTime)");
    expect(code).not.toContain("IJobParallelFor");
    expect(code).not.toContain("NativeArray");
  });

  it("generates query with ForEach delegate pattern", async () => {
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
    expect(code).toContain("ForEach<Health, Armor>((int entity, ref Health health, ref Armor armor)");
    expect(code).not.toContain("World.Query");
    expect(code).not.toContain("World.GetComponentRef");
    expect(code).not.toContain("foreach");
  });

  it("generates [Inject] attribute fields for injected services", async () => {
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
    expect(code).toContain("[Inject] private readonly ICombatService _combatService;");
    expect(code).toContain("[Inject] private readonly IConfigService _configService;");
    expect(code).toContain("using Strada.Core.DI.Attributes;");
    // Should NOT have constructor DI
    expect(code).not.toContain("public SpawnSystem(");
  });

  it("supports custom system_order", async () => {
    const result = await tool.execute(
      {
        name: "LateSystem",
        path: "Assets/Systems/LateSystem.cs",
        namespace: "Game",
        system_order: 100,
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    const filePath = join(tempDir, "Assets/Systems/LateSystem.cs");
    const code = readFileSync(filePath, "utf-8");
    expect(code).toContain("[ExecutionOrder(100)]");
  });

  it("returns error for invalid system name", async () => {
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(false);
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
    // First call (name) returns true, second call (namespace with allowDots) returns false
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
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
    // BurstSystemBase removed — only SystemBase and JobSystemBase are valid base classes
  });

  it("returns error for invalid component name in query_components", async () => {
    // Name valid, namespace valid, first component valid, second component invalid
    vi.mocked(isValidCSharpIdentifier)
      .mockReturnValue(true)
      .mockReturnValueOnce(true)   // name
      .mockReturnValueOnce(true)   // namespace
      .mockReturnValueOnce(true)   // ValidComponent
      .mockReturnValueOnce(false); // 123Invalid
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
    // Name valid, namespace valid, first service valid, second service invalid
    vi.mocked(isValidCSharpIdentifier)
      .mockReturnValue(true)
      .mockReturnValueOnce(true)   // name
      .mockReturnValueOnce(true)   // namespace
      .mockReturnValueOnce(true)   // IValid
      .mockReturnValueOnce(false); // not valid!
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
    vi.mocked(validatePath).mockResolvedValueOnce({ valid: false, fullPath: "", error: "Path resolves outside the project directory" });
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
