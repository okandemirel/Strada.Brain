/**
 * Plan 2.2 (audit 10.3 / D26-D27): ONE provider-chain readiness policy for
 * setup save, `strada doctor` and boot. The same preflight result must yield
 * the same verdict — and the same "degraded" warning — on all three surfaces.
 */
import fs from "node:fs";
import os from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import type * as winston from "winston";

// ---------------------------------------------------------------------------
// Mocks — boot needs the same seams bootstrap-providers.test.ts uses; setup
// and doctor only need the preflight seam. All three see ONE preflight result.
// ---------------------------------------------------------------------------

vi.mock("../agents/providers/claude.js", () => ({
  ClaudeProvider: vi.fn().mockImplementation(function () {
    return { name: "claude", healthCheck: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock("../agents/providers/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/providers/provider-registry.js")>();
  return {
    ...actual,
    buildProviderChain: () => ({ name: "chain-provider", healthCheck: vi.fn().mockResolvedValue(true) }),
  };
});

vi.mock("../agents/providers/provider-manager.js", () => ({
  ProviderManager: vi.fn().mockImplementation(function () {
    return {
      setOllamaVerified: vi.fn(),
      setModelCatalog: vi.fn(),
      refreshModelCatalog: vi.fn().mockResolvedValue({ modelsUpdated: 0, source: "cache", errors: [] }),
      listAvailable: vi.fn().mockReturnValue([]),
    };
  }),
}));

vi.mock("../rag/embeddings/embedding-cache.js", () => ({
  CachedEmbeddingProvider: vi.fn().mockImplementation(function () {
    return { initialize: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("../rag/embeddings/embedding-resolver.js", () => ({
  resolveEmbeddingProvider: () => undefined,
  collectApiKeys: () => ({}),
  describeEmbeddingResolutionFailure: () => "no embedding provider",
}));

vi.mock("./provider-config.js", () => ({
  collectProviderCredentials: () => ({}),
  detectConfiguredResponseProviders: () => [],
  hasConfiguredAnthropicSubscription: () => false,
  hasConfiguredOpenAISubscription: () => false,
  normalizeProviderNames: (chain: string | undefined) =>
    (chain ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  hasUsableProviderConfig: () => true,
}));

vi.mock("../config/strada-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/strada-deps.js")>();
  return {
    ...actual,
    checkStradaDeps: () => ({
      coreInstalled: false,
      corePath: null,
      modulesInstalled: false,
      modulesPath: null,
      mcpInstalled: false,
      mcpPath: null,
      mcpVersion: null,
      warnings: [],
    }),
  };
});

const { preflightMock } = vi.hoisted(() => ({ preflightMock: vi.fn() }));
vi.mock("./response-provider-preflight.js", () => ({
  preflightResponseProviders: preflightMock,
  formatProviderPreflightFailures: (failures: Array<{ providerName: string; detail: string }>) =>
    failures.map((failure) => `${failure.providerName}: ${failure.detail}`).join(" "),
}));

import { evaluateChainReadiness } from "./chain-readiness.js";
import { initializeAIProvider } from "./bootstrap-providers.js";
import { collectDoctorReport } from "./setup-doctor.js";
import { SetupWizard } from "./setup-wizard.js";

const PRIMARY_DOWN_FALLBACK_UP = {
  passedProviderIds: ["kimi"],
  failures: [{
    providerId: "openai",
    providerName: "OpenAI",
    detail: "OpenAI health check failed. Verify the configured API key or subscription session.",
  }],
};

const NOTHING_UP = {
  passedProviderIds: [],
  failures: [
    { providerId: "openai", providerName: "OpenAI", detail: "HTTP 429" },
    { providerId: "kimi", providerName: "Kimi", detail: "invalid key" },
  ],
};

function makeLogger(): winston.Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    openaiApiKey: "sk-openai",
    kimiApiKey: "sk-kimi",
    openaiAuthMode: "api-key",
    providerChain: "openai,kimi",
    providerModels: {},
    providerBaseUrls: {},
    memory: { dbPath: path.join(os.tmpdir(), "strada-chain-readiness-memory") } as Config["memory"],
    rag: { enabled: false, provider: "auto", contextMaxTokens: 4000 } as Config["rag"],
    web: { port: 3000 },
    language: "en",
    dashboard: { enabled: true, port: 3100 },
    websocketDashboard: { enabled: false, port: 3001 },
    prometheus: { enabled: false, port: 9090 },
    autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest", notify: true, autoRestart: true },
    telegram: {} as Config["telegram"],
    discord: {} as Config["discord"],
    slack: {} as Config["slack"],
    teams: {} as Config["teams"],
    agent: { enabled: false } as Config["agent"],
    delegation: { enabled: false } as Config["delegation"],
    vault: { enabled: false } as Config["vault"],
    streamingEnabled: true,
    daemon: {} as Config["daemon"],
    deployment: {} as Config["deployment"],
    security: {} as Config["security"],
    strada: {} as Config["strada"],
    ...overrides,
  } as Config;
}

describe("evaluateChainReadiness", () => {
  it("is ready when every provider passed", () => {
    const verdict = evaluateChainReadiness({ passedProviderIds: ["openai", "kimi"], failures: [] }, { requestedProviderIds: ["openai", "kimi"] });
    expect(verdict).toMatchObject({ state: "ready", primaryFailed: false, activeProviderId: "openai", warning: null, error: null });
  });

  it("is degraded, naming the demoted primary, when a fallback carries the chain", () => {
    const verdict = evaluateChainReadiness(PRIMARY_DOWN_FALLBACK_UP, { requestedProviderIds: ["openai", "kimi"] });
    expect(verdict.state).toBe("degraded");
    expect(verdict.primaryFailed).toBe(true);
    expect(verdict.activeProviderId).toBe("kimi");
    expect(verdict.warning).toBe(
      'Primary AI provider "openai" failed preflight; running on "kimi" instead. OpenAI: OpenAI health check failed. Verify the configured API key or subscription session.',
    );
  });

  it("is degraded without a primary demotion when only a fallback failed", () => {
    const verdict = evaluateChainReadiness(
      { passedProviderIds: ["openai"], failures: [{ providerId: "kimi", providerName: "Kimi", detail: "bad key" }] },
      { requestedProviderIds: ["openai", "kimi"] },
    );
    expect(verdict).toMatchObject({ state: "degraded", primaryFailed: false, activeProviderId: "openai" });
    expect(verdict.warning).toBe("Some configured AI providers failed preflight and were skipped: Kimi: bad key");
  });

  it("is unavailable when nothing passed", () => {
    const verdict = evaluateChainReadiness(NOTHING_UP, { requestedProviderIds: ["openai", "kimi"] });
    expect(verdict).toMatchObject({ state: "unavailable", activeProviderId: null, warning: null });
    expect(verdict.error).toBe("Configured AI providers failed preflight. OpenAI: HTTP 429 Kimi: invalid key");
  });
});

describe("one readiness verdict through setup, doctor and boot (2.2 / D26-D27)", () => {
  const originalCwd = process.cwd();
  const originalInstallRoot = process.env["STRADA_INSTALL_ROOT"];
  const originalSourceCheckout = process.env["STRADA_SOURCE_CHECKOUT"];
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalInstallRoot === undefined) delete process.env["STRADA_INSTALL_ROOT"];
    else process.env["STRADA_INSTALL_ROOT"] = originalInstallRoot;
    if (originalSourceCheckout === undefined) delete process.env["STRADA_SOURCE_CHECKOUT"];
    else process.env["STRADA_SOURCE_CHECKOUT"] = originalSourceCheckout;
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-chain-readiness-"));
    tmpDirs.push(dir);
    process.chdir(dir);
    process.env["STRADA_INSTALL_ROOT"] = dir;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    return dir;
  }

  async function saveThroughSetup(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const wizard = new SetupWizard({ port: 0 });
    const target = wizard as unknown as {
      readBody: () => Promise<string>;
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    };
    target.readBody = async () => JSON.stringify({
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "openai,kimi",
      OPENAI_API_KEY: "sk-openai",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });
    let statusCode = 0;
    let raw = "";
    const res = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => { raw = chunk ?? ""; },
    };
    await target.handleSaveConfig({}, res);
    return { statusCode, body: JSON.parse(raw) as Record<string, unknown> };
  }

  it("a failed primary with a healthy fallback is the same degraded verdict and warning everywhere", async () => {
    const root = makeTempRoot();
    preflightMock.mockResolvedValue(PRIMARY_DOWN_FALLBACK_UP);
    const expected = evaluateChainReadiness(PRIMARY_DOWN_FALLBACK_UP, { requestedProviderIds: ["openai", "kimi"] });
    expect(expected.state).toBe("degraded");

    // Setup: saves (used to refuse when the primary failed) and returns the verdict.
    const setup = await saveThroughSetup();
    expect(setup.statusCode).toBe(200);
    expect(setup.body.readiness).toEqual(expected);
    expect(setup.body.providerWarnings).toEqual(PRIMARY_DOWN_FALLBACK_UP.failures);

    // Doctor: WARN (used to be FAIL) carrying the same verdict and warning text.
    const report = await collectDoctorReport({
      installRoot: root,
      configRoot: root,
      configResult: { kind: "ok", value: makeConfig() },
    });
    const providerCheck = report.checks.find((check) => check.id === "providers");
    expect(providerCheck?.status).toBe("warn");
    expect(providerCheck?.readiness).toEqual(expected);
    expect(providerCheck?.detail).toContain(expected.warning!);

    // Boot: runs on the fallback, prints the same warning, exposes the same verdict.
    const logger = makeLogger();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));
    const boot = await initializeAIProvider(makeConfig(), logger);
    expect(boot.chainReadiness).toEqual(expected);
    expect(boot.notices).toContain(expected.warning);
  });

  it("nothing healthy is unavailable on all three surfaces", async () => {
    const root = makeTempRoot();
    preflightMock.mockResolvedValue(NOTHING_UP);
    const expected = evaluateChainReadiness(NOTHING_UP, { requestedProviderIds: ["openai", "kimi"] });

    const setup = await saveThroughSetup();
    expect(setup.statusCode).toBe(400);
    expect(setup.body.readiness).toEqual(expected);

    // Setup refused to write, so give the doctor a file to find; the config
    // it evaluates is the injected one.
    fs.writeFileSync(path.join(root, ".env"), "PROVIDER_CHAIN=openai,kimi\n");

    const report = await collectDoctorReport({
      installRoot: root,
      configRoot: root,
      configResult: { kind: "ok", value: makeConfig() },
    });
    const providerCheck = report.checks.find((check) => check.id === "providers");
    expect(providerCheck?.status).toBe("fail");
    expect(providerCheck?.readiness).toEqual(expected);
    expect(providerCheck?.detail).toContain(expected.error!);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));
    await expect(initializeAIProvider(makeConfig(), makeLogger())).rejects.toMatchObject({
      code: "NO_HEALTHY_AI_PROVIDER",
    });
  });
});
