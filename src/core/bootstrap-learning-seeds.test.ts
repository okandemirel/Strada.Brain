/**
 * The framework packages bootstrap detects reach the learning seeds.
 *
 * bootstrap() runs checkStradaDeps before the knowledge stage, logs "Strada.MCP
 * found", and then built the learning pipeline without telling it. Its seeding
 * only adds the Modules and MCP conventions when it is told they are installed,
 * so on every real boot they were never seeded.
 *
 * Drives the REAL bootstrap() to the knowledge stage, captures what it hands
 * that stage, then runs the real stage and the real initializeLearning against
 * a scratch learning.db.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { initializeKnowledgeStageMock, providerShutdownSpy } = vi.hoisted(() => ({
  providerShutdownSpy: vi.fn(),
  initializeKnowledgeStageMock: vi.fn(async (_params: unknown, _deps: unknown) => {
    throw new Error("stop after the knowledge stage is reached");
  }),
}));

vi.mock("./bootstrap-stages.js", () => ({
  initializeProviderRuntimeStage: vi.fn(async () => ({
    providerInit: { manager: { shutdown: providerShutdownSpy }, healthCheckPassed: true },
    memoryManager: { shutdown: vi.fn(async () => ({ kind: "ok", value: undefined })) },
    channel: { disconnect: vi.fn(async () => {}) },
    cachedEmbeddingProvider: null,
    embeddingStatus: {},
    startupNotices: [],
  })),
  initializeKnowledgeStage: initializeKnowledgeStageMock,
  finalizeChannelStartupStage: vi.fn(),
  initializeGoalContextStage: vi.fn(),
  initializeDaemonHeartbeatStage: vi.fn(),
  initializeDeploymentStage: vi.fn(),
  initializeMemoryConsolidationStage: vi.fn(),
  initializeMultiAgentDelegationStage: vi.fn(),
  initializeOpsMonitoringStage: vi.fn(),
  initializeRuntimeIntelligenceStage: vi.fn(),
  initializeRuntimeStateStage: vi.fn(),
  initializeSessionRuntimeStage: vi.fn(),
  initializeTaskRuntimeStage: vi.fn(),
  initializeSupervisorStage: vi.fn(),
  initializeToolChainStage: vi.fn(),
  initializeToolRegistryStage: vi.fn(),
  registerDashboardPostBootStage: vi.fn(),
}));

vi.mock("./runtime-unity-project.js", () => ({
  resolveRuntimeUnityProjectPath: vi.fn((p: string) => ({
    effectiveProjectPath: p,
    configuredProjectPath: p,
    detectedProjectPaths: [],
    source: "config",
    notice: undefined,
  })),
}));

// The project has every optional package installed.
vi.mock("../config/strada-deps.js", () => ({
  checkStradaDeps: vi.fn(() => ({
    coreInstalled: true,
    corePath: "/project/Packages/Strada.Core",
    modulesInstalled: true,
    modulesPath: "/project/Packages/Strada.Modules",
    mcpInstalled: true,
    mcpPath: "/project/Packages/Strada.MCP",
    mcpVersion: "1.0.0",
    warnings: [],
  })),
}));

vi.mock("../security/auth-hardened.js", () => ({
  configureAuthManager: vi.fn(),
}));

import { bootstrap } from "./bootstrap.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../config/config.js";
import type { KnowledgeStageDeps } from "./bootstrap-stages/bootstrap-stages-types.js";
import { STRADA_SEEDS } from "../learning/seeds/strada-core-seeds.js";
import { STRADA_MCP_SEEDS } from "../learning/seeds/strada-mcp-seeds.js";
import { STRADA_MODULES_SEEDS } from "../learning/seeds/strada-modules-seeds.js";

let dbDir: string | undefined;

function makeConfig(dbPath: string): Config {
  return {
    unityProjectPath: "/project",
    logLevel: "error",
    logFile: undefined,
    memory: { dbPath },
    security: { systemAuth: undefined, readOnlyMode: false, requireEditConfirmation: false },
    strada: { frameworkSync: { bootSync: false } },
    learningPipelineV2: {
      detectionWindowSize: 10,
      periodicExtractionInterval: 3_600_000,
      maxInstincts: 1000,
    },
  } as unknown as Config;
}

describe("bootstrap seeds the conventions of the framework packages it found", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-bootstrap-learning-seeds.log"); } catch { /* already initialized */ }
  });

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it("Modules and MCP seeds land in learning.db when the project has those packages", async () => {
    dbDir = mkdtempSync(join(tmpdir(), "bootstrap-learning-seeds-"));
    const config = makeConfig(dbDir);
    await expect(bootstrap({ channelType: "cli", config, daemonMode: false })).rejects.toThrow(
      "stop after the knowledge stage",
    );
    expect(initializeKnowledgeStageMock).toHaveBeenCalledTimes(1);
    const [params, deps] = initializeKnowledgeStageMock.mock.calls[0]! as unknown as [
      Parameters<typeof import("./bootstrap-stages/stage-knowledge.js").initializeKnowledgeStage>[0],
      KnowledgeStageDeps,
    ];

    const { initializeKnowledgeStage } = await vi.importActual<
      typeof import("./bootstrap-stages/stage-knowledge.js")
    >("./bootstrap-stages/stage-knowledge.js");
    const result = await initializeKnowledgeStage(params, {
      initializeRAG: async () => ({}),
      initializeLearning: deps.initializeLearning,
    });
    const { pipeline, storage, eventBus, learningQueue } = result.learningResult;
    try {
      expect(pipeline, "initializeLearning fell back to its degraded result").toBeDefined();
      const seeded = (pattern: string) => storage!.getInstinctByPattern(pattern, "global") !== null;
      // Core is seeded on every boot, so its rows prove the seeding pass ran.
      await vi.waitFor(() => expect(seeded(STRADA_SEEDS.at(-1)!.pattern), "core seeds").toBe(true));
      await vi.waitFor(() => {
        for (const seed of [...STRADA_MODULES_SEEDS, ...STRADA_MCP_SEEDS]) {
          expect(seeded(seed.pattern), seed.pattern).toBe(true);
        }
      });
    } finally {
      pipeline?.stop();
      await learningQueue?.shutdown();
      await eventBus?.shutdown();
      storage?.close();
    }
  });
});
