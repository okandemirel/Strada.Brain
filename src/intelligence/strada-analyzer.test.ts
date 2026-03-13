import { describe, it, expect, vi, beforeEach } from "vitest";
import { StradaAnalyzer } from "./strada-analyzer.js";
import type { StradaProjectAnalysis } from "./strada-analyzer.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("glob", () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import { glob } from "glob";
import { readFile } from "node:fs/promises";

describe("StradaAnalyzer", () => {
  let analyzer: StradaAnalyzer;

  beforeEach(() => {
    analyzer = new StradaAnalyzer("/test/project");
  });

  it("finds modules from ModuleConfig base class", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/CombatModuleConfig.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
namespace Game.Combat
{
    public class CombatModuleConfig : ModuleConfig
    {
    }
}
`);
    const result = await analyzer.analyze();
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]!.name).toBe("Combat");
    expect(result.modules[0]!.className).toBe("CombatModuleConfig");
  });

  it("finds systems inheriting SystemBase", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/CombatSystem.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
namespace Game.Combat
{
    public class CombatSystem : SystemBase
    {
        public override void OnUpdate(float deltaTime) {}
    }
}
`);
    const result = await analyzer.analyze();
    expect(result.systems).toHaveLength(1);
    expect(result.systems[0]!.name).toBe("CombatSystem");
  });

  it("finds systems inheriting generic BurstSystem", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/MovementBurstSystem.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
namespace Game.Combat
{
    public class MovementBurstSystem : BurstSystem<MovementBurstSystemJob, PositionComponent, VelocityComponent>
    {
        protected override MovementBurstSystemJob CreateJob(float deltaTime) => default;
    }
}
`);
    const result = await analyzer.analyze();
    expect(result.systems).toHaveLength(1);
    expect(result.systems[0]!.name).toBe("MovementBurstSystem");
    expect(result.systems[0]!.baseClass).toContain("BurstSystem<MovementBurstSystemJob");
  });

  it("skips abstract systems", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/Base.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public abstract class BaseGameSystem : SystemBase
{
}
`);
    const result = await analyzer.analyze();
    expect(result.systems).toHaveLength(0);
  });

  it("finds components (IComponent structs)", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/Health.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public struct Health : IComponent
{
    public float Current;
}
`);
    const result = await analyzer.analyze();
    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.name).toBe("Health");
  });

  it("detects readonly components", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/Tag.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public readonly struct TagComponent : IComponent
{
}
`);
    const result = await analyzer.analyze();
    expect(result.components[0]!.isReadonly).toBe(true);
  });

  it("finds services (I-prefix interface implementations)", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/CombatService.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public class CombatService : ICombatService
{
}
`);
    const result = await analyzer.analyze();
    expect(result.services).toHaveLength(1);
    expect(result.services[0]!.interfaceName).toBe("ICombatService");
    expect(result.services[0]!.implementationName).toBe("CombatService");
  });

  it("finds mediators with EntityMediator<T>", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/PlayerMediator.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public class PlayerMediator : EntityMediator<PlayerView>
{
}
`);
    const result = await analyzer.analyze();
    expect(result.mediators).toHaveLength(1);
    expect(result.mediators[0]!.name).toBe("PlayerMediator");
    expect(result.mediators[0]!.viewType).toBe("PlayerView");
  });

  it("finds controllers with Controller<T>", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/GameController.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public class GameController : Controller<GameModel>
{
}
`);
    const result = await analyzer.analyze();
    expect(result.controllers).toHaveLength(1);
    expect(result.controllers[0]!.name).toBe("GameController");
    expect(result.controllers[0]!.modelType).toBe("GameModel");
  });

  it("scans event usage (Publish/Subscribe)", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/EventUser.cs"] as any);
    vi.mocked(readFile).mockResolvedValue(`
public class EventUser : SystemBase
{
    public override void OnUpdate(float dt)
    {
        eventBus.Publish<DamageEvent>(new DamageEvent());
        eventBus.Subscribe<HealthChangedEvent>(OnHealthChanged);
    }
}
`);
    const result = await analyzer.analyze();
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    const pubEvent = result.events.find((e) => e.eventType === "DamageEvent");
    expect(pubEvent?.action).toBe("publish");
    const subEvent = result.events.find((e) => e.eventType === "HealthChangedEvent");
    expect(subEvent?.action).toBe("subscribe");
  });

  it("skips files exceeding 1MB", async () => {
    vi.mocked(glob).mockResolvedValue(["/test/project/huge.cs"] as any);
    vi.mocked(readFile).mockResolvedValue("x".repeat(1024 * 1024 + 1));
    const result = await analyzer.analyze();
    expect(result.modules).toHaveLength(0);
    expect(result.systems).toHaveLength(0);
  });

  it("reports csFileCount", async () => {
    vi.mocked(glob).mockResolvedValue(["/a.cs", "/b.cs", "/c.cs"] as any);
    vi.mocked(readFile).mockResolvedValue("class A {}");
    const result = await analyzer.analyze();
    expect(result.csFileCount).toBe(3);
  });
});

describe("StradaAnalyzer.formatAnalysis", () => {
  it("formats analysis with all sections", () => {
    const analysis: StradaProjectAnalysis = {
      modules: [{ name: "Combat", className: "CombatModuleConfig", filePath: "Combat.cs", namespace: "Game", systems: [], services: [], dependencies: [], lineNumber: 1 }],
      systems: [{ name: "CombatSystem", filePath: "CombatSystem.cs", namespace: "Game", baseClass: "SystemBase", lineNumber: 5 }],
      components: [{ name: "Health", filePath: "Health.cs", namespace: "Game", isReadonly: false, lineNumber: 1 }],
      services: [{ interfaceName: "ICombatService", implementationName: "CombatService", interfaceFile: "", implementationFile: "CombatService.cs", namespace: "Game" }],
      mediators: [{ name: "PlayerMediator", viewType: "PlayerView", filePath: "PM.cs", namespace: "Game", lineNumber: 1 }],
      controllers: [{ name: "GameCtrl", modelType: "GameModel", filePath: "GC.cs", namespace: "Game", lineNumber: 1 }],
      events: [
        { eventType: "Damage", action: "publish", filePath: "A.cs", lineNumber: 10, className: "A" },
        { eventType: "Damage", action: "subscribe", filePath: "B.cs", lineNumber: 5, className: "B" },
      ],
      asmdefs: [{ name: "Game.Combat", filePath: "Game.Combat.asmdef", rootNamespace: "Game.Combat", references: ["Game.Core"] }],
      prefabs: [{ name: "Player", filePath: "Player.prefab", scriptGuids: ["abc123def456abc123def456abc123de"] }],
      scenes: [{ name: "MainScene", filePath: "MainScene.unity", rootObjectCount: 42 }],
      csFileCount: 50,
      analyzedAt: new Date("2026-01-15T10:00:00Z"),
    };

    const output = StradaAnalyzer.formatAnalysis(analysis);
    expect(output).toContain("Strada Project Analysis");
    expect(output).toContain("Modules (1)");
    expect(output).toContain("ECS Systems (1)");
    expect(output).toContain("ECS Components (1)");
    expect(output).toContain("DI Services (1)");
    expect(output).toContain("Entity Mediators (1)");
    expect(output).toContain("Controllers (1)");
    expect(output).toContain("Assembly Definitions (1)");
    expect(output).toContain("Game.Combat");
    expect(output).toContain("Namespace: Game.Combat");
    expect(output).toContain("References: Game.Core");
    expect(output).toContain("Prefabs (1)");
    expect(output).toContain("Player (1 scripts)");
    expect(output).toContain("Scenes (1)");
    expect(output).toContain("MainScene (42 root objects)");
    expect(output).toContain("EventBus Usage");
    expect(output).toContain("C# Files: 50");
  });

  it("handles empty analysis", () => {
    const analysis: StradaProjectAnalysis = {
      modules: [], systems: [], components: [], services: [],
      mediators: [], controllers: [], events: [], dependencies: [],
      asmdefs: [], prefabs: [], scenes: [],
      csFileCount: 0, analyzedAt: new Date(),
    };

    const output = StradaAnalyzer.formatAnalysis(analysis);
    expect(output).toContain("Strada Project Analysis");
    expect(output).toContain("C# Files: 0");
  });
});
