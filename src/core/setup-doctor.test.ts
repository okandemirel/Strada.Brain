import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import { collectDoctorReport } from "./setup-doctor.js";

const { preflightResponseProvidersMock } = vi.hoisted(() => ({
  preflightResponseProvidersMock: vi.fn().mockResolvedValue({
    passedProviderIds: ["gemini", "kimi"],
    failures: [],
  }),
}));

vi.mock("./response-provider-preflight.js", () => ({
  formatProviderPreflightFailures: (failures: Array<{ providerName: string; detail: string }>) =>
    failures.map((failure) => `${failure.providerName}: ${failure.detail}`).join(" "),
  preflightResponseProviders: preflightResponseProvidersMock,
}));

describe("setup doctor", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: ["gemini", "kimi"],
      failures: [],
    });
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {
        // Best-effort cleanup for temporary fixtures.
      }
    }
  });

  function makeInstallRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-doctor-"));
    tmpDirs.push(dir);
    return dir;
  }

  function createJwt(expSecondsFromNow: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    })).toString("base64url");
    return `${header}.${payload}.sig`;
  }

  function makeBuiltInstallRoot(): string {
    const dir = makeInstallRoot();
    fs.mkdirSync(path.join(dir, "dist", "channels", "web", "static"), { recursive: true });
    fs.mkdirSync(path.join(dir, "pentest", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "");
    fs.writeFileSync(path.join(dir, "dist", "channels", "web", "static", "index.html"), "");
    fs.writeFileSync(path.join(dir, ".env"), "UNITY_PROJECT_PATH=/tmp\n");
    for (const scriptName of [
      "run-all-tests.sh",
      "test-sast.sh",
      "test-path-traversal.sh",
      "test-command-injection.sh",
      "test-ssrf.sh",
    ]) {
      fs.writeFileSync(path.join(dir, "pentest", "scripts", scriptName), "#!/usr/bin/env bash\n");
    }
    return dir;
  }

  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
      openaiAuthMode: "api-key",
      openaiChatgptAuthFile: undefined,
      openaiSubscriptionAccessToken: undefined,
      openaiSubscriptionAccountId: undefined,
      deepseekApiKey: undefined,
      qwenApiKey: undefined,
      kimiApiKey: undefined,
      minimaxApiKey: undefined,
      groqApiKey: undefined,
      mistralApiKey: undefined,
      togetherApiKey: undefined,
      fireworksApiKey: undefined,
      geminiApiKey: "AIza-test",
      providerChain: "gemini,kimi",
      telegram: {} as Config["telegram"],
      discord: {} as Config["discord"],
      slack: {} as Config["slack"],
      whatsapp: {} as Config["whatsapp"],
      matrix: {} as Config["matrix"],
      irc: {} as Config["irc"],
      teams: {} as Config["teams"],
      security: {} as Config["security"],
      tasks: {} as Config["tasks"],
      unityProjectPath: "/Users/test/Game",
      strada: {} as Config["strada"],
      dashboard: { enabled: true, port: 3100 },
      websocketDashboard: { enabled: true, port: 3001 },
      prometheus: { enabled: false, port: 9090 },
      modelIntelligence: {
        enabled: true,
        refreshHours: 24,
        dbPath: ".strada-memory/model-intelligence.db",
        providerSourcesPath: "docs/provider-sources",
      },
      memory: {} as Config["memory"],
      rag: {
        enabled: true,
        provider: "auto",
        model: undefined,
        baseUrl: undefined,
        dimensions: undefined,
        contextMaxTokens: 4000,
      },
      streamingEnabled: true,
      shellEnabled: true,
      llmStreamInitialTimeoutMs: 30000,
      llmStreamStallTimeoutMs: 120000,
      rateLimit: {} as Config["rateLimit"],
      web: { port: 3000 },
      logLevel: "info",
      logFile: "strada.log",
      pluginDirs: [],
      bayesian: {} as Config["bayesian"],
      goalMaxDepth: 3,
      goalMaxRetries: 3,
      goalMaxFailures: 3,
      goalParallelExecution: true,
      goalMaxParallel: 3,
      goal: {} as Config["goal"],
      toolChain: {} as Config["toolChain"],
      crossSession: {} as Config["crossSession"],
      agentName: "Strada",
      language: "en",
      daemon: {} as Config["daemon"],
      reRetrieval: {} as Config["reRetrieval"],
      notification: {} as Config["notification"],
      quietHours: {} as Config["quietHours"],
      digest: {} as Config["digest"],
      agent: {} as Config["agent"],
      delegation: {} as Config["delegation"],
      deployment: {} as Config["deployment"],
      autonomousDefaultEnabled: false,
      autonomousDefaultHours: 4,
      routing: { preset: "balanced", phaseSwitching: true },
      consensus: { mode: "auto", threshold: 0.7, maxProviders: 2 },
      autoUpdate: {
        enabled: true,
        intervalHours: 24,
        idleTimeoutMin: 5,
        channel: "stable",
        notify: true,
        autoRestart: true,
      },
      ...overrides,
    } as Config;
  }

  it("fails when built artifacts are missing", async () => {
    const installRoot = makeInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "error", error: "missing .env" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "build")?.status).toBe("fail");
  });

  it("warns instead of failing when dist is missing for a prepared git checkout", async () => {
    const installRoot = makeInstallRoot();
    fs.writeFileSync(path.join(installRoot, "package.json"), "{}");
    fs.mkdirSync(path.join(installRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(installRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(installRoot, "src", "index.ts"), "export {};");
    fs.mkdirSync(path.join(installRoot, ".git"));

    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "error", error: "missing .env" },
    });

    expect(report.checks.find((check) => check.id === "build")?.status).toBe("warn");
  });

  it("fails when config is invalid", async () => {
    const installRoot = makeBuiltInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "error", error: "bad config" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "config")?.detail).toContain("bad config");
  });

  it("emits Windows-specific setup guidance when config is missing on Windows", async () => {
    const installRoot = makeInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      platform: "win32",
      configResult: { kind: "error", error: "missing .env" },
    });

    expect(report.checks.find((check) => check.id === "config")?.fix).toContain(".\\strada.ps1 setup --web");
    expect(report.checks.find((check) => check.id === "config")?.fix).toContain(".\\strada.ps1 setup --terminal");
  });

  it("passes when config and embeddings resolve cleanly", async () => {
    const installRoot = makeBuiltInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "ok", value: makeConfig() },
    });

    expect(report.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "embeddings")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "capability-truth")?.status).toBe("pass");
  });

  it("warns when deployment is enabled without runtime wiring", async () => {
    const installRoot = makeBuiltInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: {
        kind: "ok",
        value: makeConfig({
          deployment: {
            enabled: true,
            testCommand: "npm test",
            targetBranch: "main",
            requireCleanGit: true,
            testTimeoutMs: 60000,
            executionTimeoutMs: 600000,
            cooldownMinutes: 30,
            notificationUrgency: "medium",
          },
        }),
      },
    });

    expect(report.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "capability-truth")?.status).toBe("warn");
  });

  it("fails when the only OpenAI subscription worker has an expired local auth session", async () => {
    const installRoot = makeBuiltInstallRoot();
    const authDir = path.join(installRoot, ".codex");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: createJwt(-300), account_id: "acct_test" } }),
    );

    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "openai",
        providerName: "OpenAI",
        detail: "OpenAI ChatGPT/Codex subscription health probe failed. Sign in again or switch OpenAI to API-key mode.",
      }],
    });

    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: {
        kind: "ok",
        value: makeConfig({
          providerChain: "openai",
          openaiAuthMode: "chatgpt-subscription",
          openaiChatgptAuthFile: path.join(authDir, "auth.json"),
        }),
      },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "openai-subscription")?.status).toBe("fail");
  });
});
