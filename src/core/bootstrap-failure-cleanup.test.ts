/**
 * H11 — bootstrap() mid-failure resource cleanup (integration)
 *
 * Drives the REAL `bootstrap()` far enough to allocate the first resources
 * (memoryManager / channel / providerManager from the provider runtime stage),
 * then forces the next stage (knowledge) to throw. Asserts that:
 *   1. bootstrap() rethrows the original error, and
 *   2. the already-allocated resources were torn down (no fd/timer/port leak).
 *
 * Teeth: revert the bootstrap() try/catch wrapper (or BootstrapDisposables) and
 * these spies are never called → the cleanup assertions fail.
 *
 * All heavy collaborators are mocked at the stage boundary so the test stays a
 * fast unit-level integration test (no real SQLite/servers/embeddings).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const {
  memoryShutdownSpy,
  channelDisconnectSpy,
  providerShutdownSpy,
  initializeKnowledgeStageMock,
  initializeProviderRuntimeStageMock,
} = vi.hoisted(() => ({
  memoryShutdownSpy: vi.fn(async () => ({ kind: "ok", value: undefined })),
  channelDisconnectSpy: vi.fn(async () => {}),
  providerShutdownSpy: vi.fn(),
  initializeKnowledgeStageMock: vi.fn(async () => {
    throw new Error("knowledge stage boom");
  }),
  initializeProviderRuntimeStageMock: vi.fn(async () => ({
    providerInit: { manager: { shutdown: providerShutdownSpy }, healthCheckPassed: true },
    memoryManager: { shutdown: memoryShutdownSpy },
    channel: { disconnect: channelDisconnectSpy },
    cachedEmbeddingProvider: null,
    embeddingStatus: {},
    startupNotices: [],
  })),
}));

// Mock the stage barrel so we control exactly where bootstrap throws. Every
// named export bootstrap.ts imports must exist; the ones after the knowledge
// stage are never reached (it throws) but are stubbed for safety.
vi.mock("./bootstrap-stages.js", () => ({
  initializeProviderRuntimeStage: initializeProviderRuntimeStageMock,
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

// Keep pre-stage setup deterministic and filesystem-free.
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
    coreInstalled: true,
    mcpInstalled: false,
    warnings: [],
    mcpPath: undefined,
    mcpVersion: undefined,
  })),
}));

vi.mock("../security/auth-hardened.js", () => ({
  configureAuthManager: vi.fn(),
}));

import { bootstrap } from "./bootstrap.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../config/config.js";
import type { BootstrapOptions } from "./bootstrap.js";

function makeOptions(): BootstrapOptions {
  const config = {
    unityProjectPath: "/tmp/strada-h11-failure-cleanup-test",
    logLevel: "error",
    logFile: undefined,
    memory: { dbPath: "/tmp/strada-h11-failure-cleanup-test-db" },
    security: { systemAuth: undefined, readOnlyMode: false, requireEditConfirmation: false },
    // bootSync:false skips the fire-and-forget framework sync IIFE (no real SQLite).
    strada: { frameworkSync: { bootSync: false } },
  } as unknown as Config;

  return { channelType: "cli", config, daemonMode: false };
}

describe("bootstrap() mid-failure cleanup (H11)", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-h11-failure-cleanup.log"); } catch { /* already initialized */ }
  });

  beforeEach(() => {
    memoryShutdownSpy.mockClear();
    channelDisconnectSpy.mockClear();
    providerShutdownSpy.mockClear();
    initializeKnowledgeStageMock.mockClear();
    initializeProviderRuntimeStageMock.mockClear();
  });

  it("rethrows the original bootstrap error", async () => {
    await expect(bootstrap(makeOptions())).rejects.toThrow("knowledge stage boom");
  });

  it("tears down resources allocated before the throw (no fd/timer/port leak)", async () => {
    await expect(bootstrap(makeOptions())).rejects.toThrow();

    // The provider stage ran and registered disposers; the knowledge stage threw.
    expect(initializeProviderRuntimeStageMock).toHaveBeenCalledTimes(1);
    expect(initializeKnowledgeStageMock).toHaveBeenCalledTimes(1);

    // Failure cleanup must have disposed everything allocated so far.
    expect(memoryShutdownSpy).toHaveBeenCalledTimes(1);
    expect(channelDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(providerShutdownSpy).toHaveBeenCalledTimes(1);
  });
});
