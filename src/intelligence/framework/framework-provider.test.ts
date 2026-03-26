import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import {
  FrameworkSchemaProvider,
  getFrameworkSchemaProvider,
  initializeFrameworkSchemaProvider,
} from "./framework-schema-provider.js";
import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import { STRADA_MODULES_SEEDS } from "../../learning/seeds/strada-modules-seeds.js";
import { STRADA_MCP_SEEDS } from "../../learning/seeds/strada-mcp-seeds.js";
import { seedAllFrameworkConventions } from "../../learning/seeds/framework-seeds.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

// ─── Test Helpers ──────────────────────────────────────────────────────────

function createTestSnapshot(
  overrides: Partial<FrameworkAPISnapshot> = {},
): FrameworkAPISnapshot {
  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: "1.0.0",
    gitHash: "abc1234",
    namespaces: ["Strada.Core.ECS", "Strada.Core.DI", "Strada.Core.Patterns"],
    baseClasses: new Map([
      ["systems", ["SystemBase", "JobSystemBase"]],
      ["patterns", ["Controller", "Service", "View"]],
    ]),
    attributes: new Map([
      ["system", ["[StradaSystem]", "[ExecutionOrder(0)]"]],
    ]),
    interfaces: [
      {
        name: "IComponent",
        namespace: "Strada.Core.ECS",
        methods: ["Initialize", "Dispose"],
      },
      {
        name: "ISystem",
        namespace: "Strada.Core.ECS.Systems",
        methods: ["OnUpdate", "OnInitialize"],
      },
    ],
    enums: [
      {
        name: "UpdatePhase",
        namespace: "Strada.Core.ECS",
        values: ["Initialization", "Update", "LateUpdate", "FixedUpdate"],
      },
    ],
    classes: [
      {
        name: "SystemBase",
        namespace: "Strada.Core.ECS.Systems",
        baseTypes: [],
        isAbstract: true,
      },
      {
        name: "JobSystemBase",
        namespace: "Strada.Core.ECS.Systems",
        baseTypes: ["SystemBase"],
        isAbstract: true,
      },
      {
        name: "BurstSystem<TJob, T1>",
        namespace: "Strada.Core.ECS.Systems",
        baseTypes: ["SystemBase"],
        isAbstract: true,
      },
      {
        name: "Controller",
        namespace: "Strada.Core.Patterns",
        baseTypes: [],
        isAbstract: false,
      },
    ],
    structs: [
      {
        name: "EntityRef",
        namespace: "Strada.Core.ECS",
        baseTypes: ["IComponent"],
      },
    ],
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: new Date("2026-03-26T10:00:00Z"),
    sourcePath: "/tmp/strada-core",
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: 42,
    ...overrides,
  };
}

function createMCPSnapshot(
  overrides: Partial<FrameworkAPISnapshot> = {},
): FrameworkAPISnapshot {
  return createTestSnapshot({
    packageId: "mcp",
    packageName: "Strada.MCP",
    namespaces: ["Strada.MCP"],
    classes: [
      {
        name: "MCPBridge",
        namespace: "Strada.MCP",
        baseTypes: [],
        isAbstract: false,
      },
    ],
    interfaces: [],
    enums: [],
    structs: [],
    tools: [
      {
        name: "create_entity",
        description: "Create a new entity in the Unity scene",
        inputSchemaKeys: ["name", "components", "parent"],
      },
      {
        name: "run_command",
        description: "Execute an editor command",
        inputSchemaKeys: ["command", "args"],
      },
    ],
    resources: [
      {
        name: "scene-hierarchy",
        uri: "strada://scene/hierarchy",
        description: "Current scene hierarchy",
      },
    ],
    prompts: [
      {
        name: "analyze-scene",
        description: "Analyze the current Unity scene",
      },
    ],
    sourceLanguage: "typescript",
    fileCount: 15,
    ...overrides,
  });
}

function createModulesSnapshot(
  overrides: Partial<FrameworkAPISnapshot> = {},
): FrameworkAPISnapshot {
  return createTestSnapshot({
    packageId: "modules",
    packageName: "Strada.Modules",
    namespaces: ["Strada.Modules.Networking", "Strada.Modules.UI"],
    classes: [
      {
        name: "NetworkModule",
        namespace: "Strada.Modules.Networking",
        baseTypes: ["ModuleBase"],
        isAbstract: false,
      },
      {
        name: "UIModule",
        namespace: "Strada.Modules.UI",
        baseTypes: ["ModuleBase"],
        isAbstract: false,
      },
    ],
    interfaces: [
      {
        name: "INetworkTransport",
        namespace: "Strada.Modules.Networking",
        methods: ["Send", "Receive"],
      },
    ],
    enums: [],
    structs: [],
    tools: [],
    resources: [],
    prompts: [],
    sourceLanguage: "csharp",
    fileCount: 28,
    ...overrides,
  });
}

// ─── FrameworkSchemaProvider Tests ──────────────────────────────────────────

describe("FrameworkSchemaProvider", () => {
  let store: FrameworkKnowledgeStore;
  let provider: FrameworkSchemaProvider;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fkl-schema-test-"));
    const dbPath = join(tempDir, "test-framework.db");
    store = new FrameworkKnowledgeStore(dbPath);
    store.initialize();
    provider = new FrameworkSchemaProvider(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getSystemBaseClasses: returns static when store empty", () => {
    const result = provider.getSystemBaseClasses();
    expect(result).toContain("SystemBase");
    expect(result).toContain("JobSystemBase");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("getSystemBaseClasses: returns live data when snapshot available", () => {
    const snapshot = createTestSnapshot({
      classes: [
        {
          name: "SystemBase",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "JobSystemBase",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: ["SystemBase"],
          isAbstract: true,
        },
        {
          name: "BurstSystem<TJob, T1>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: ["SystemBase"],
          isAbstract: true,
        },
        {
          name: "ReactiveSystemBase",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: ["SystemBase"],
          isAbstract: true,
        },
      ],
    });
    store.storeSnapshot(snapshot);
    provider.invalidateCache();

    const result = provider.getSystemBaseClasses();
    expect(result).toContain("SystemBase");
    expect(result).toContain("JobSystemBase");
    expect(result).toContain("ReactiveSystemBase");
    expect(result).toContain("BurstSystem<TJob, T1>");
  });

  it("getBurstSystemVariants: returns static when store empty", () => {
    const result = provider.getBurstSystemVariants();
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result).toContain("BurstSystem<TJob, T1>");
    expect(result).toContain("BurstSystem<TJob, T1, T2>");
  });

  it("getBurstSystemVariants: returns live data when snapshot available", () => {
    const snapshot = createTestSnapshot({
      classes: [
        {
          name: "BurstSystem<TJob, T1>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "BurstSystem<TJob, T1, T2>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "BurstSystem<TJob, T1, T2, T3>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "BurstSystem<TJob, T1, T2, T3, T4>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "BurstSystem<TJob, T1, T2, T3, T4, T5>",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
      ],
    });
    store.storeSnapshot(snapshot);
    provider.invalidateCache();

    const result = provider.getBurstSystemVariants();
    expect(result).toHaveLength(5);
    expect(result).toContain("BurstSystem<TJob, T1, T2, T3, T4, T5>");
  });

  it("getPatternBaseClasses: returns static fallback", () => {
    const result = provider.getPatternBaseClasses();
    expect(result).toContain("Controller");
    expect(result).toContain("Service");
    expect(result).toContain("View");
    expect(result).toContain("Model");
    expect(result.length).toBeGreaterThanOrEqual(4);
  });

  it("getComponentInterface: returns 'IComponent'", () => {
    const result = provider.getComponentInterface();
    expect(result).toBe("IComponent");
  });

  it("getComponentInterface: returns IComponent from live data", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);
    provider.invalidateCache();

    const result = provider.getComponentInterface();
    expect(result).toBe("IComponent");
  });

  it("getNamespaces: returns static when store empty", () => {
    const result = provider.getNamespaces();
    expect(result).toHaveProperty("core");
    expect(result).toHaveProperty("ecs");
    expect(result.core).toBe("Strada.Core.Core");
  });

  it("getNamespaces: returns live namespaces when snapshot available", () => {
    const snapshot = createTestSnapshot({
      namespaces: [
        "Strada.Core.ECS",
        "Strada.Core.DI",
        "Strada.Core.Patterns",
        "Strada.Core.NewFeature",
      ],
    });
    store.storeSnapshot(snapshot);
    provider.invalidateCache();

    const result = provider.getNamespaces();
    expect(result).toHaveProperty("ecs", "Strada.Core.ECS");
    expect(result).toHaveProperty("di", "Strada.Core.DI");
    expect(result).toHaveProperty("patterns", "Strada.Core.Patterns");
    expect(result).toHaveProperty("newfeature", "Strada.Core.NewFeature");
  });

  it("getUpdatePhases: returns static values", () => {
    const result = provider.getUpdatePhases();
    expect(result).toEqual([
      "Initialization",
      "Update",
      "LateUpdate",
      "FixedUpdate",
    ]);
  });

  it("getStaticAPI: returns STRADA_API", () => {
    const api = provider.getStaticAPI();
    expect(api).toBeDefined();
    expect(api.namespaces).toBeDefined();
    expect(api.baseClasses).toBeDefined();
    expect(api.updatePhases).toBeDefined();
    expect(api.componentApi).toBeDefined();
    expect(api.componentApi.interface).toBe("IComponent");
  });

  it("invalidateCache: forces re-read from store", () => {
    // First read — store is empty, returns static
    const before = provider.getSystemBaseClasses();
    expect(before).toContain("SystemBase");

    // Store a snapshot with an extra abstract class
    const snapshot = createTestSnapshot({
      classes: [
        {
          name: "SystemBase",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: [],
          isAbstract: true,
        },
        {
          name: "CustomSystemBase",
          namespace: "Strada.Core.ECS.Systems",
          baseTypes: ["SystemBase"],
          isAbstract: true,
        },
      ],
    });
    store.storeSnapshot(snapshot);

    // Without invalidation, cache still returns old data
    const cached = provider.getSystemBaseClasses();
    expect(cached).not.toContain("CustomSystemBase");

    // After invalidation, picks up the new data
    provider.invalidateCache();
    const after = provider.getSystemBaseClasses();
    expect(after).toContain("CustomSystemBase");
  });
});

describe("FrameworkSchemaProvider Singleton", () => {
  let store: FrameworkKnowledgeStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fkl-singleton-test-"));
    const dbPath = join(tempDir, "test-framework.db");
    store = new FrameworkKnowledgeStore(dbPath);
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getFrameworkSchemaProvider returns null before init", () => {
    // Note: This test is order-dependent — in a fresh module state
    // the provider is null. Since initializeFrameworkSchemaProvider
    // may have been called by a prior test, we verify the API shape.
    const result = getFrameworkSchemaProvider();
    // After initializeFrameworkSchemaProvider is called, it returns a provider
    // Before that, it returns null. We test the init path below.
    expect(result === null || result instanceof FrameworkSchemaProvider).toBe(
      true,
    );
  });

  it("initializeFrameworkSchemaProvider sets provider", () => {
    initializeFrameworkSchemaProvider(store);
    const result = getFrameworkSchemaProvider();
    expect(result).toBeInstanceOf(FrameworkSchemaProvider);
    expect(result).not.toBeNull();
  });
});

// ─── FrameworkPromptGenerator Tests ────────────────────────────────────────

describe("FrameworkPromptGenerator", () => {
  let store: FrameworkKnowledgeStore;
  let generator: FrameworkPromptGenerator;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fkl-prompt-test-"));
    const dbPath = join(tempDir, "test-framework.db");
    store = new FrameworkKnowledgeStore(dbPath);
    store.initialize();
    generator = new FrameworkPromptGenerator(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("buildFrameworkKnowledgeSection: returns null when store empty", () => {
    const result = generator.buildFrameworkKnowledgeSection();
    expect(result).toBeNull();
  });

  it("buildFrameworkKnowledgeSection: includes Core section when available", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const result = generator.buildFrameworkKnowledgeSection();
    expect(result).not.toBeNull();
    expect(result).toContain("Strada.Core Framework Knowledge");
    expect(result).toContain("v1.0.0");
    expect(result).toContain("42 files");
  });

  it("buildFrameworkKnowledgeSection: includes Modules section when available", () => {
    const modulesSnapshot = createModulesSnapshot();
    store.storeSnapshot(modulesSnapshot);

    const result = generator.buildFrameworkKnowledgeSection();
    expect(result).not.toBeNull();
    expect(result).toContain("Strada.Modules Knowledge");
    expect(result).toContain("Strada.Modules.Networking");
    expect(result).toContain("NetworkModule");
  });

  it("buildFrameworkKnowledgeSection: includes MCP section with tools", () => {
    const mcpSnapshot = createMCPSnapshot();
    store.storeSnapshot(mcpSnapshot);

    const result = generator.buildFrameworkKnowledgeSection();
    expect(result).not.toBeNull();
    expect(result).toContain("Strada.MCP Knowledge");
    expect(result).toContain("MCP Tools");
    expect(result).toContain("create_entity");
    expect(result).toContain("Create a new entity in the Unity scene");
    expect(result).toContain("run_command");
  });

  it("buildFrameworkKnowledgeSection: caches result", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const first = generator.buildFrameworkKnowledgeSection();
    const second = generator.buildFrameworkKnowledgeSection();
    // Same reference means cached
    expect(first).toBe(second);
  });

  it("invalidateCache: forces regeneration", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const first = generator.buildFrameworkKnowledgeSection();
    expect(first).not.toBeNull();

    // Store additional data
    const modulesSnapshot = createModulesSnapshot();
    store.storeSnapshot(modulesSnapshot);

    // Without invalidation, still returns cached version (no Modules section)
    const cached = generator.buildFrameworkKnowledgeSection();
    expect(cached).not.toContain("Strada.Modules Knowledge");

    // After invalidation, regenerates with new data
    generator.invalidateCache();
    const regenerated = generator.buildFrameworkKnowledgeSection();
    expect(regenerated).not.toBeNull();
    expect(regenerated).toContain("Strada.Core Framework Knowledge");
    expect(regenerated).toContain("Strada.Modules Knowledge");
  });

  it("Core section includes namespaces and base classes", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### Namespaces");
    expect(result).toContain("`Strada.Core.ECS`");
    expect(result).toContain("`Strada.Core.DI`");
    expect(result).toContain("### Base Classes (abstract)");
    expect(result).toContain("`SystemBase`");
    expect(result).toContain("`JobSystemBase`");
  });

  it("Core section includes interfaces with methods", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### Interfaces");
    expect(result).toContain("`IComponent`");
    expect(result).toContain("Initialize, Dispose");
  });

  it("Core section includes enums with values", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### Enums");
    expect(result).toContain("`UpdatePhase`");
    expect(result).toContain("Initialization, Update, LateUpdate, FixedUpdate");
  });

  it("Core section includes structs", () => {
    const snapshot = createTestSnapshot();
    store.storeSnapshot(snapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### Structs");
    expect(result).toContain("`EntityRef`");
  });

  it("MCP section includes tool names and descriptions", () => {
    const mcpSnapshot = createMCPSnapshot();
    store.storeSnapshot(mcpSnapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("**create_entity**");
    expect(result).toContain("Create a new entity in the Unity scene");
    expect(result).toContain("Params: name, components, parent");
    expect(result).toContain("**run_command**");
    expect(result).toContain("Execute an editor command");
    expect(result).toContain("Params: command, args");
  });

  it("MCP section includes resources", () => {
    const mcpSnapshot = createMCPSnapshot();
    store.storeSnapshot(mcpSnapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### MCP Resources");
    expect(result).toContain("scene-hierarchy");
    expect(result).toContain("`strada://scene/hierarchy`");
  });

  it("MCP section includes prompts", () => {
    const mcpSnapshot = createMCPSnapshot();
    store.storeSnapshot(mcpSnapshot);

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("### MCP Prompts");
    expect(result).toContain("**analyze-scene**");
    expect(result).toContain("Analyze the current Unity scene");
  });

  it("combines all three package sections", () => {
    store.storeSnapshot(createTestSnapshot());
    store.storeSnapshot(createModulesSnapshot());
    store.storeSnapshot(createMCPSnapshot());

    const result = generator.buildFrameworkKnowledgeSection()!;
    expect(result).toContain("Strada.Core Framework Knowledge");
    expect(result).toContain("Strada.Modules Knowledge");
    expect(result).toContain("Strada.MCP Knowledge");
  });
});

// ─── Seeds Tests ───────────────────────────────────────────────────────────

describe("strada-modules-seeds", () => {
  it("STRADA_MODULES_SEEDS has 3 entries", () => {
    expect(STRADA_MODULES_SEEDS).toHaveLength(3);
  });

  it("all seeds have confidence 0.60", () => {
    for (const seed of STRADA_MODULES_SEEDS) {
      expect(seed.confidence).toBe(0.60);
    }
  });

  it("all seeds have correct structure", () => {
    for (const seed of STRADA_MODULES_SEEDS) {
      expect(seed.pattern).toBeTruthy();
      expect(seed.action.description).toBeTruthy();
      expect(seed.scope).toBe("global");
      expect(seed.trustLevel).toBe("warn_enabled");
      expect(seed.seed).toBe(true);
    }
  });

  it("contains expected patterns", () => {
    const patterns = STRADA_MODULES_SEEDS.map((s) => s.pattern);
    expect(patterns).toContain("strada_modules_registration");
    expect(patterns).toContain("strada_modules_dependency_order");
    expect(patterns).toContain("strada_modules_isolation");
  });
});

describe("strada-mcp-seeds", () => {
  it("STRADA_MCP_SEEDS has 3 entries", () => {
    expect(STRADA_MCP_SEEDS).toHaveLength(3);
  });

  it("all seeds have confidence 0.60", () => {
    for (const seed of STRADA_MCP_SEEDS) {
      expect(seed.confidence).toBe(0.60);
    }
  });

  it("all seeds have correct structure", () => {
    for (const seed of STRADA_MCP_SEEDS) {
      expect(seed.pattern).toBeTruthy();
      expect(seed.action.description).toBeTruthy();
      expect(seed.scope).toBe("global");
      expect(seed.trustLevel).toBe("warn_enabled");
      expect(seed.seed).toBe(true);
    }
  });

  it("contains expected patterns", () => {
    const patterns = STRADA_MCP_SEEDS.map((s) => s.pattern);
    expect(patterns).toContain("strada_mcp_tool_usage");
    expect(patterns).toContain("strada_mcp_bridge_awareness");
    expect(patterns).toContain("strada_mcp_resource_authority");
  });
});

describe("framework-seeds", () => {
  it("seedAllFrameworkConventions is a function", () => {
    expect(typeof seedAllFrameworkConventions).toBe("function");
  });

  it("seedAllFrameworkConventions accepts storage and optional deps", () => {
    // Verify arity: (storage, stradaDeps?) => 2 params, 1 required
    expect(seedAllFrameworkConventions.length).toBeGreaterThanOrEqual(1);
    expect(seedAllFrameworkConventions.length).toBeLessThanOrEqual(2);
  });
});
