import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import { collectDoctorReport } from "./setup-doctor.js";
import { SUPPORTED_UNITY_VERSIONS } from "../config/strada-deps.js";

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

/**
 * A Unity 6 project that satisfies every REQUIRED row of the supported project
 * matrix (plan 6.10): the layout, a readable ProjectVersion.txt inside the
 * supported range, and a git checkout. The doctor now judges the configured
 * project, so the fixture config has to point at a real one — "/Users/test/Game"
 * (what this suite used before) is exactly the case the matrix fails.
 */
function makeSupportedUnityProject(
  version: string = SUPPORTED_UNITY_VERSIONS.tested[0]!,
): { projectPath: string; editorPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-doctor-project-"));
  fs.mkdirSync(path.join(dir, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ProjectSettings"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Packages"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Packages", "manifest.json"), JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(
    path.join(dir, "ProjectSettings", "ProjectVersion.txt"),
    `m_EditorVersion: ${version}\n`,
  );
  const editorPath = path.join(dir, "Unity");
  fs.writeFileSync(editorPath, "#!/bin/sh\n");
  return { projectPath: dir, editorPath };
}

describe("setup doctor", () => {
  const tmpDirs: string[] = [];
  const supportedProject = makeSupportedUnityProject();

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
      teams: {} as Config["teams"],
      security: {} as Config["security"],
      tasks: {} as Config["tasks"],
      interaction: {
        mode: "silent-first",
        heartbeatAfterMs: 120000,
        heartbeatIntervalMs: 300000,
        escalationPolicy: "hard-blockers-only",
      },
      unityProjectPath: supportedProject.projectPath,
      strada: { unityEditorPath: supportedProject.editorPath } as Config["strada"],
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
        intervalHours: 6,
        idleTimeoutMin: 5,
        channel: "latest",
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

    expect(report.checks.find((check) => check.id === "embeddings")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "capability-truth")?.status).toBe("pass");
    // The only non-pass check is the supported project matrix: this fixture is a
    // valid Unity 6 project with no Strada.Core and no Strada.MCP, which the
    // matrix now says out loud instead of reporting a clean bill of health
    // (plan 6.10). Asserting the exact set keeps this test as strict as the
    // `status === "pass"` it replaced.
    expect(report.checks.filter((check) => check.status !== "pass").map((check) => check.id))
      .toEqual(["project-matrix"]);
    expect(report.status).toBe("warn");
  });

  it("does not report an enabled Supervisor Brain as a truthfulness gap (audited 2026-09-02)", async () => {
    // `doctor` reads static config; it never boots, so it never constructs a
    // SupervisorBrain. Omitting the flag left the snapshot's "construction was
    // not reported" branch — truth `declared-only` — which the capability
    // health summary lists under "still need truthfulness work". Every user
    // with SUPERVISOR_ENABLED=true got that warning on a healthy install.
    const installRoot = makeBuiltInstallRoot();
    const report = await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: {
        kind: "ok",
        value: makeConfig({
          supervisor: {
            enabled: true,
            complexityThreshold: 5,
            maxParallelNodes: 4,
            nodeTimeoutMs: 600000,
            verificationMode: "cross-provider",
            verificationBudgetPct: 20,
            triageProvider: "gemini",
            maxFailureBudget: 3,
            diversityCap: 2,
          } as Config["supervisor"],
        }),
      },
    });

    const capabilityTruth = report.checks.find((check) => check.id === "capability-truth");
    expect(capabilityTruth?.detail ?? "").not.toContain("Supervisor Brain");
    expect(capabilityTruth?.status).toBe("pass");
    // Same as above: the project matrix is the only warning on this fixture.
    expect(report.checks.filter((check) => check.status !== "pass").map((check) => check.id))
      .toEqual(["project-matrix"]);
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

  it("preflights response workers with the configured OpenCode model and base URL (audit 10.4 / D28)", async () => {
    // The doctor passed providerModels (which config.ts already fills for
    // opencode) but never providerBaseUrls, so a user's OPENCODE_BASE_URL was
    // ignored and the probe hit the default endpoint.
    const installRoot = makeBuiltInstallRoot();
    preflightResponseProvidersMock.mockResolvedValue({ passedProviderIds: ["opencode"], failures: [] });

    await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: {
        kind: "ok",
        value: makeConfig({
          providerChain: "opencode",
          opencodeApiKey: "sk-opencode",
          providerModels: { opencode: "vendor/chosen-model" },
          providerBaseUrls: { opencode: "https://opencode.example.test/v1" },
        }),
      },
    });

    expect(preflightResponseProvidersMock).toHaveBeenCalledTimes(1);
    const [names, , models, baseUrls] = preflightResponseProvidersMock.mock.calls[0]!;
    expect(names).toEqual(["opencode"]);
    expect(models).toEqual({ opencode: "vendor/chosen-model" });
    expect(baseUrls).toEqual({ opencode: "https://opencode.example.test/v1" });
  });

  /**
   * Supported project matrix in the doctor (plan 6.10). The doctor used to say
   * nothing about the project it was pointed at: an unsupported Unity version, a
   * directory that is not a Unity project, and an unreadable ProjectVersion.txt
   * all produced the same clean report and failed vaguely later.
   */
  describe("supported project matrix check", () => {
    async function matrixCheck(configOverrides: Partial<Config> = {}) {
      const installRoot = makeBuiltInstallRoot();
      const report = await collectDoctorReport({
        installRoot,
        configRoot: installRoot,
        configResult: { kind: "ok", value: makeConfig(configOverrides) },
      });
      const check = report.checks.find((candidate) => candidate.id === "project-matrix");
      expect(check, "project-matrix check").toBeDefined();
      return { report, check: check! };
    }

    it("fails and names the unsupported Unity version instead of failing vaguely", async () => {
      const old = makeSupportedUnityProject("2022.3.1f1");
      tmpDirs.push(old.projectPath);
      const { report, check } = await matrixCheck({ unityProjectPath: old.projectPath });

      expect(check.status).toBe("fail");
      expect(check.detail).toContain("2022.3.1f1");
      expect(check.detail).toContain(SUPPORTED_UNITY_VERSIONS.minInclusive);
      expect(check.fix ?? "").toContain("Upgrade the Unity project");
      expect(report.status).toBe("fail");
    });

    it("fails and names the missing layout paths when the project path is not a Unity project", async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "strada-doctor-empty-"));
      tmpDirs.push(empty);
      const { check } = await matrixCheck({ unityProjectPath: empty });

      expect(check.status).toBe("fail");
      expect(check.detail).toContain("ProjectSettings/ProjectVersion.txt");
      expect(check.detail).toContain("not a git checkout");
    });

    it("warns rather than passing when the Unity version could not be determined", async () => {
      const project = makeSupportedUnityProject();
      tmpDirs.push(project.projectPath);
      // The file is there (so the layout row stays ok) but says nothing about a
      // version — the case that must warn instead of passing.
      fs.writeFileSync(
        path.join(project.projectPath, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersionWithRevision: (abcdef123456)\n",
      );
      const { check } = await matrixCheck({
        unityProjectPath: project.projectPath,
        strada: { unityEditorPath: project.editorPath } as Config["strada"],
      });

      expect(check.status).toBe("warn");
      expect(check.status).not.toBe("pass");
      expect(check.detail).toContain("NOT checked, not passed");
    });

    it("always carries the not-measured second-machine row, which is the item's own measure", async () => {
      const { check } = await matrixCheck();

      expect(check.detail).toContain("NOT MEASURED — Another machine satisfies this matrix");
      expect(check.matrix?.notMeasured).toContain("Another machine satisfies this matrix");
      // Nothing in the detail may claim the other machine is fine.
      expect(check.matrix?.rows.find((row) => row.id === "second-machine")?.status)
        .toBe("not-measured");
    });

    it("reports the Unity editor binary as not determined when no path is configured", async () => {
      // Empty, not "whatever this machine happens to export": the row's point is
      // that an unconfigured editor is undetermined, not assumed present.
      vi.stubEnv("STRADA_UNITY_BIN", "");
      try {
        const { check } = await matrixCheck({ strada: {} as Config["strada"] });

        expect(check.matrix?.rows.find((row) => row.id === "unity-editor-binary")?.status)
          .toBe("unknown");
        expect(check.status).toBe("warn");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("passes no base URLs to preflight when the config declares none (guard)", async () => {
    const installRoot = makeBuiltInstallRoot();
    await collectDoctorReport({
      installRoot,
      configRoot: installRoot,
      configResult: { kind: "ok", value: makeConfig({ providerChain: "gemini,kimi" }) },
    });
    const [, , , baseUrls] = preflightResponseProvidersMock.mock.calls[0]!;
    expect(baseUrls).toBeUndefined();
  });

  /**
   * Plan 6.8's first-run rehearsal found this by running the CLI in a throwaway
   * home: with a `.env` present but INVALID, the doctor died with
   * `TypeError: Cannot read properties of undefined (reading 'language')` — it
   * crashed exactly when a new developer needed it to say what was wrong.
   *
   * The cause was a spelling: `loadConfigSafe` fails with `kind: "err"`, this file
   * declared `"error"` and cast, so the failure matched neither branch and fell
   * through to the success path.
   */
  describe("the doctor on a configuration it cannot load (plan 6.8)", () => {
    it("reports the validation failure instead of crashing, whichever spelling the failure carries", async () => {
      const installRoot = makeBuiltInstallRoot();
      for (const kind of ["err", "error"] as const) {
        const report = await collectDoctorReport({
          installRoot,
          configRoot: installRoot,
          configResult: { kind, error: "Invalid configuration:\n  - anthropicApiKey: At least one AI provider API key is required (or use Ollama)" } as never,
        });
        const config = report.checks.find((check) => check.id === "config");
        expect(config?.status, kind).toBe("fail");
        expect(config?.detail, kind).toContain("At least one AI provider API key");
        expect(config?.fix, kind).toMatch(/setup/);
        // And the report is still a report: the crash took the whole thing down.
        expect(report.checks.length, kind).toBeGreaterThan(1);
        expect(report.status, kind).toBe("fail");
      }
    });
  });
});
