/**
 * The user's project gets a code vault at boot (core-bootstrap#3 /
 * vault-intelligence#3).
 *
 * Drives the REAL `bootstrap()` through its vault block, with the stages
 * around it mocked at the barrel (as bootstrap-failure-cleanup.test.ts does),
 * and reads the registry at the moment the dashboard is handed it — the same
 * registry vault_search, the orchestrator's "is this project indexed" hint and
 * the Edit/Write reindex hook resolve against. The tool-registry stage then
 * throws, so boot stops right after the block under test.
 *
 * SelfVault is stubbed to do exactly what the real one does first —
 * register `self:strada-brain` at the install root, synchronously — without
 * walking this checkout in the background. Vault classes are stubbed so no
 * SQLite file or watcher is opened.
 *
 * Teeth: gate the generic project-vault fallback on `registry.list().length
 * === 0` again and the default-config cases fail — SelfVault has always filled
 * the registry by then, so the project is never indexed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const STOP = "stop after the vault block";

const { seen, snapshot, initializeToolRegistryStageMock } = vi.hoisted(() => ({
  seen: { registry: undefined as undefined | import("../vault/vault-registry.js").VaultRegistry },
  snapshot: {
    ids: [] as string[],
    projectPath: undefined as string | undefined,
    /** Where the stubbed SelfVault roots itself; unset = the real install root. */
    selfRoot: undefined as string | undefined,
    ownerKind: undefined as string | undefined,
    ownerRoot: undefined as string | undefined,
  },
  initializeToolRegistryStageMock: vi.fn(),
}));

vi.mock("./bootstrap-stages.js", () => ({
  initializeProviderRuntimeStage: vi.fn(async () => ({
    providerInit: { manager: { shutdown: vi.fn() }, healthCheckPassed: true },
    memoryManager: undefined,
    channel: { disconnect: vi.fn(async () => {}) },
    // A provider in hand skips the hash-fallback cache under memory.dbPath.
    cachedEmbeddingProvider: {
      dimensions: 3,
      embed: vi.fn(async (texts: string[]) => ({ embeddings: texts.map(() => [0, 0, 0]) })),
      shutdown: vi.fn(),
    },
    embeddingStatus: {},
    startupNotices: [],
  })),
  initializeKnowledgeStage: vi.fn(async () => ({
    ragPipeline: undefined,
    learningResult: {},
    startupNotices: [],
  })),
  initializeOpsMonitoringStage: vi.fn(async () => ({
    dashboard: {
      stop: vi.fn(async () => {}),
      registerVaultFactory: vi.fn(),
      // Snapshot here: the failure teardown that follows empties the registry.
      registerVaultRegistry: vi.fn((registry: import("../vault/vault-registry.js").VaultRegistry) => {
        seen.registry = registry;
        snapshot.ids = registry.list().map((v) => `${v.id}@${v.kind}`);
        const owner = snapshot.projectPath ? registry.resolveVaultForPath(snapshot.projectPath) : undefined;
        snapshot.ownerKind = owner?.kind;
        snapshot.ownerRoot = owner?.rootPath;
      }),
    },
    stoppableServers: undefined,
    rateLimiter: undefined,
    metricsStorage: undefined,
    metricsRecorder: undefined,
  })),
  initializeRuntimeStateStage: vi.fn(() => ({
    identityManager: undefined,
    uptimeInterval: undefined,
    runtimeArtifactManager: undefined,
    instinctRetriever: undefined,
    trajectoryReplayRetriever: undefined,
  })),
  initializeToolRegistryStage: initializeToolRegistryStageMock,
  finalizeChannelStartupStage: vi.fn(),
  initializeGoalContextStage: vi.fn(),
  initializeDaemonHeartbeatStage: vi.fn(),
  initializeDeploymentStage: vi.fn(),
  initializeMemoryConsolidationStage: vi.fn(),
  initializeMultiAgentDelegationStage: vi.fn(),
  initializeRuntimeIntelligenceStage: vi.fn(),
  initializeSessionRuntimeStage: vi.fn(),
  initializeTaskRuntimeStage: vi.fn(),
  initializeSupervisorStage: vi.fn(),
  initializeToolChainStage: vi.fn(),
  registerDashboardPostBootStage: vi.fn(),
}));

vi.mock("../vault/unity-project-vault.js", () => {
  class UnityProjectVault {
    readonly kind: string = "unity-project";
    readonly id: string;
    readonly rootPath: string;
    constructor(deps: { id: string; rootPath: string }) {
      this.id = deps.id;
      this.rootPath = deps.rootPath;
    }
    async init(): Promise<void> {}
    async startWatch(): Promise<void> {}
    async stopWatch(): Promise<void> {}
    async dispose(): Promise<void> {}
    retrievalIsSemantic(): boolean { return false; }
  }
  return { UnityProjectVault };
});

vi.mock("./bootstrap-stages/stage-knowledge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bootstrap-stages/stage-knowledge.js")>();
  const { UnityProjectVault } = await import("../vault/unity-project-vault.js");
  return {
    ...actual,
    initSelfVaultFromBootstrap: vi.fn(async (input: {
      config: { vault?: { self?: { enabled?: boolean } } };
      vaultRegistry: import("../vault/vault-registry.js").VaultRegistry;
      repoRoot: string;
    }) => {
      if (input.config.vault?.self?.enabled === false) return undefined;
      const vault = Object.assign(
        new UnityProjectVault({ id: "self:strada-brain", rootPath: snapshot.selfRoot ?? input.repoRoot } as never),
        { kind: "self" },
      );
      input.vaultRegistry.register(vault as never);
      return { vault, ready: Promise.resolve(true) };
    }),
  };
});

vi.mock("./runtime-unity-project.js", () => ({
  resolveRuntimeUnityProjectPath: vi.fn((p: string) => ({
    effectiveProjectPath: p,
    configuredProjectPath: p,
    detectedProjectPaths: [],
    source: "config",
    notice: undefined,
  })),
}));

vi.mock("../config/strada-deps.js", () => ({
  checkStradaDeps: vi.fn(() => ({
    coreInstalled: false,
    modulesInstalled: false,
    mcpInstalled: false,
    warnings: [],
  })),
}));

vi.mock("../security/auth-hardened.js", () => ({
  configureAuthManager: vi.fn(),
}));

import { bootstrap } from "./bootstrap.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../config/config.js";

let root: string;

function bootWith(projectPath: string, vault: Record<string, unknown> | undefined) {
  snapshot.projectPath = projectPath;
  const config = {
    unityProjectPath: projectPath,
    logLevel: "error",
    logFile: join(root, "boot.log"),
    memory: { dbPath: join(root, "db") },
    security: { systemAuth: undefined, readOnlyMode: false, requireEditConfirmation: false },
    strada: { frameworkSync: { bootSync: false } },
    vault,
  } as unknown as Config;
  return bootstrap({ channelType: "cli", config, daemonMode: false });
}

function makeUnityProject(dir: string): void {
  mkdirSync(join(dir, "Assets"), { recursive: true });
  mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
  mkdirSync(join(dir, "Packages"), { recursive: true });
  writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
  writeFileSync(join(dir, "Packages", "manifest.json"), "{}\n");
}

describe("bootstrap registers a code vault for the configured project", () => {
  beforeAll(() => {
    try { createLogger("error", join(tmpdir(), "strada-bootstrap-project-vault.log")); } catch { /* already initialized */ }
  });

  beforeEach(() => {
    // tmpdir() is /var/... on macOS while the registry compares realpaths
    // (/private/var/...), so the ownership check sees both spellings.
    root = mkdtempSync(join(tmpdir(), "strada-project-vault-"));
    mkdirSync(join(root, "db"), { recursive: true });
    snapshot.ids = [];
    snapshot.selfRoot = undefined;
    snapshot.ownerKind = undefined;
    snapshot.ownerRoot = undefined;
    seen.registry = undefined;
    initializeToolRegistryStageMock.mockReset();
    initializeToolRegistryStageMock.mockImplementation(async () => {
      throw new Error(STOP);
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes the project with the default vault config, though SelfVault registered first", async () => {
    const project = join(root, "Game");
    mkdirSync(project, { recursive: true });

    // Default config: vault.enabled=false, vault.self.enabled=true.
    await expect(bootWith(project, { enabled: false, self: { enabled: true } })).rejects.toThrow(STOP);

    expect(seen.registry).toBeDefined();
    expect(snapshot.ids).toContain("self:strada-brain@self");
    expect(snapshot.ownerKind).toBe("unity-project");
    expect(snapshot.ownerRoot).toBe(project);
  });

  it("indexes a project Unity discovery rejected (vault.enabled=true, not scaffolded yet)", async () => {
    const project = join(root, "NotYetUnity");
    mkdirSync(project, { recursive: true });

    await expect(bootWith(project, { enabled: true, self: { enabled: true } })).rejects.toThrow(STOP);

    expect(snapshot.ownerKind).toBe("unity-project");
    expect(snapshot.ownerRoot).toBe(project);
  });

  it("adds no second vault over a project Unity discovery already indexed", async () => {
    const project = join(root, "UnityGame");
    makeUnityProject(project);

    await expect(bootWith(project, { enabled: true, self: { enabled: true } })).rejects.toThrow(STOP);

    const projectVaults = snapshot.ids.filter((id) => id.endsWith("@unity-project"));
    expect(projectVaults).toHaveLength(1);
    expect(projectVaults[0]).toMatch(/^unity:/);
    expect(snapshot.ownerRoot).toBe(project);
  });

  it("adds no second whole-tree vault when the self vault is rooted at the project", async () => {
    // Pointing Brain at its own checkout: SelfVault already curates that tree,
    // and a second vault over it re-watches dist/ and benchmarks/ (the reason
    // the framework block filters Strada.Brain out too).
    const project = join(root, "Strada.Brain");
    mkdirSync(project, { recursive: true });
    snapshot.selfRoot = project;

    await expect(bootWith(project, { enabled: false, self: { enabled: true } })).rejects.toThrow(STOP);

    expect(snapshot.ownerKind).toBe("self");
    expect(snapshot.ids.filter((id) => id.startsWith("generic:"))).toEqual([]);
  });
});
