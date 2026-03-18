import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../config/config.js";
import { collectDoctorReport } from "./setup-doctor.js";

describe("setup doctor", () => {
  const tmpDirs: string[] = [];

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

  function makeBuiltInstallRoot(): string {
    const dir = makeInstallRoot();
    fs.mkdirSync(path.join(dir, "dist", "channels", "web", "static"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "");
    fs.writeFileSync(path.join(dir, "dist", "channels", "web", "static", "index.html"), "");
    fs.writeFileSync(path.join(dir, ".env"), "UNITY_PROJECT_PATH=/tmp\n");
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

  it("fails when built artifacts are missing", () => {
    const installRoot = makeInstallRoot();
    const report = collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "error", error: "missing .env" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "build")?.status).toBe("fail");
  });

  it("fails when config is invalid", () => {
    const installRoot = makeBuiltInstallRoot();
    const report = collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "error", error: "bad config" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "config")?.detail).toContain("bad config");
  });

  it("passes when config and embeddings resolve cleanly", () => {
    const installRoot = makeBuiltInstallRoot();
    const report = collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "ok", value: makeConfig() },
    });

    expect(report.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "embeddings")?.status).toBe("pass");
  });
});
