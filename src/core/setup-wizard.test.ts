import fs from "node:fs";
import os from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { preflightResponseProvidersMock, installStradaMcpSubmoduleMock, installStradaDepMock } = vi.hoisted(() => ({
  preflightResponseProvidersMock: vi.fn().mockResolvedValue({
    passedProviderIds: ["kimi"],
    failures: [],
  }),
  installStradaMcpSubmoduleMock: vi.fn(),
  installStradaDepMock: vi.fn(),
}));

vi.mock("./response-provider-preflight.js", () => ({
  preflightResponseProviders: preflightResponseProvidersMock,
}));

vi.mock("../config/strada-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/strada-deps.js")>();
  return {
    ...actual,
    installStradaMcpSubmodule: installStradaMcpSubmoduleMock,
    installStradaDep: installStradaDepMock,
  };
});

import {
  SetupWizard,
  buildSetupEnvLines,
  buildSetupAccessUrl,
  buildSetupReadyUrl,
  hasConfiguredEmbeddingCandidate,
  injectSetupModeMarker,
} from "./setup-wizard.js";

describe("SetupWizard path validation", () => {
  const originalCwd = process.cwd();
  const originalInstallRoot = process.env["STRADA_INSTALL_ROOT"];
  const originalSourceCheckout = process.env["STRADA_SOURCE_CHECKOUT"];
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: ["kimi"],
      failures: [],
    });
    installStradaMcpSubmoduleMock.mockReset();
    installStradaDepMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalInstallRoot === undefined) {
      delete process.env["STRADA_INSTALL_ROOT"];
    } else {
      process.env["STRADA_INSTALL_ROOT"] = originalInstallRoot;
    }
    if (originalSourceCheckout === undefined) {
      delete process.env["STRADA_SOURCE_CHECKOUT"];
    } else {
      process.env["STRADA_SOURCE_CHECKOUT"] = originalSourceCheckout;
    }
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for temporary fixtures.
      }
    }
    tmpDirs.length = 0;
  });

  const makeResponse = () => {
    let statusCode = 0;
    let body = "";
    return {
      response: {
        writeHead: (status: number) => {
          statusCode = status;
          return undefined;
        },
        end: (chunk?: string | Buffer) => {
          body = typeof chunk === "string" ? chunk : chunk?.toString("utf-8") ?? "";
          return undefined;
        },
      },
      read: () => ({ statusCode, body }),
    };
  };

  const saveWizard = async (
    wizard: SetupWizard,
    config: Record<string, string> = {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    },
  ) => {
    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).readBody = async () => JSON.stringify(config);

    const response = makeResponse();
    await (wizard as unknown as {
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).handleSaveConfig({}, response.response);
    return response;
  };

  it("re-validates the project path during save using the resolved home-directory path", async () => {
    const wizard = new SetupWizard();

    const result = await (wizard as unknown as {
      validateProjectPathForSave: (
        rawPath: string,
      ) => Promise<{ valid: true; resolved: string } | { valid: false; error: string }>;
    }).validateProjectPathForSave(homedir());

    expect(result).toEqual({ valid: true, resolved: homedir() });
  });

  it("rejects project paths outside the home directory at save time", async () => {
    const wizard = new SetupWizard();

    const result = await (wizard as unknown as {
      validateProjectPathForSave: (
        rawPath: string,
      ) => Promise<{ valid: true; resolved: string } | { valid: false; error: string }>;
    }).validateProjectPathForSave(process.platform === "win32" ? "C:\\Windows" : "/tmp");

    expect(result).toEqual({
      valid: false,
      error: "Path must be inside your home directory",
    });
  });

  it("detects when RAG lacks an embedding-capable provider", () => {
    expect(hasConfiguredEmbeddingCandidate({
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
    })).toBe(false);

    expect(hasConfiguredEmbeddingCandidate({
      PROVIDER_CHAIN: "kimi,gemini",
      KIMI_API_KEY: "sk-kimi",
      GEMINI_API_KEY: "gem-key",
    })).toBe(true);

    expect(hasConfiguredEmbeddingCandidate({
      EMBEDDING_PROVIDER: "openai",
      OPENAI_AUTH_MODE: "chatgpt-subscription",
    })).toBe(false);

    expect(hasConfiguredEmbeddingCandidate({
      EMBEDDING_PROVIDER: "ollama",
    })).toBe(true);
  });

  it("injects setup mode into the shared portal html", () => {
    const html = injectSetupModeMarker("<html><head></head><body></body></html>");
    expect(html).toContain('meta name="strada-setup"');
  });

  it("prefers a DOM marker on the root element when one exists", () => {
    const html = injectSetupModeMarker('<html><head></head><body><div id="root"></div></body></html>');
    expect(html).toContain('data-strada-setup="1"');
  });

  it("builds a cache-busted setup access url that explicitly enables setup mode", () => {
    expect(buildSetupAccessUrl(3000, 12345)).toBe("http://127.0.0.1:3000/?strada-setup=1&t=12345");
  });

  it("builds a canonical ready url for the target web app", () => {
    expect(buildSetupReadyUrl(3000)).toBe("http://127.0.0.1:3000/");
  });

  it("writes autonomy defaults only when setup enabled autonomy", () => {
    const enabledLines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
      AUTONOMOUS_DEFAULT_ENABLED: "true",
      AUTONOMOUS_DEFAULT_HOURS: "48",
    }, homedir(), 3000);

    expect(enabledLines).toContain("AUTONOMOUS_DEFAULT_ENABLED=true");
    expect(enabledLines).toContain("AUTONOMOUS_DEFAULT_HOURS=48");

    const disabledLines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
      AUTONOMOUS_DEFAULT_HOURS: "48",
    }, homedir(), 3000);

    expect(disabledLines).toContain("AUTONOMOUS_DEFAULT_ENABLED=false");
    expect(disabledLines.some((line) => line.includes("AUTONOMOUS_DEFAULT_HOURS"))).toBe(false);
  });

  it("writes provider model defaults from presets and explicit overrides", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude,gemini",
      SYSTEM_PRESET: "balanced",
      ANTHROPIC_API_KEY: "sk-ant",
      GEMINI_API_KEY: "sk-gem",
      OPENAI_MODEL: "gpt-5.4",
    }, homedir(), 3000);

    expect(lines).toContain('CLAUDE_MODEL="claude-sonnet-4-6-20250514"');
    expect(lines).toContain('DEEPSEEK_MODEL="deepseek-chat"');
    expect(lines).toContain('GEMINI_MODEL="gemini-3-flash-preview"');
    expect(lines).toContain('OPENAI_MODEL="gpt-5.4"');
  });

  it("writes Claude subscription env lines when setup selects bearer auth", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude",
      ANTHROPIC_AUTH_MODE: "claude-subscription",
      ANTHROPIC_AUTH_TOKEN: "claude-subscription-token-123456",
    }, homedir(), 3000);

    expect(lines).toContain('ANTHROPIC_AUTH_MODE="claude-subscription"');
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN="claude-subscription-token-123456"');
    expect(lines).not.toContain("ANTHROPIC_API_KEY");
  });

  it("rejects unsupported curated model selections during setup save", async () => {
    const wizard = new SetupWizard({ port: 0 });
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "openai",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_MODEL: "definitely-not-a-real-openai-model",
      RAG_ENABLED: "false",
    });

    expect(response.read().statusCode).toBe(400);
    expect(JSON.parse(response.read().body)).toEqual({
      success: false,
      error: "Unsupported OPENAI_MODEL selection",
    });
  });

  it("rejects repeated setup API calls and serves a handoff page once configuration has been saved", async () => {
    const wizard = new SetupWizard({ port: 0 });
    wizard.markBootstrapStarting();

    const csrf = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/api/setup/csrf", method: "GET" }, csrf.response);
    expect(csrf.read().statusCode).toBe(409);
    expect(JSON.parse(csrf.read().body)).toMatchObject({ handoff: true });

    const page = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/?strada-setup=1", method: "GET" }, page.response);
    expect(page.read().statusCode).toBe(200);
    expect(page.read().body).toContain("Configuration saved");
    expect(page.read().body).toContain('http-equiv="refresh" content="1;url=http://127.0.0.1:0/"');
  });

  it("exposes explicit setup bootstrap status and allows retry after failure", async () => {
    const wizard = new SetupWizard({ port: 0 });
    wizard.markBootstrapFailed("OpenAI preflight failed.");

    const status = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/api/setup/status", method: "GET" }, status.response);
    expect(JSON.parse(status.read().body)).toEqual({
      state: "failed",
      detail: "OpenAI preflight failed.",
    });

    const retryPage = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/?strada-setup=1&retry=1", method: "GET" }, retryPage.response);
    expect(retryPage.read().statusCode).toBe(200);
    expect(retryPage.read().body).toContain('data-strada-setup="1"');
  });

  it("saves configuration with provider warnings and exposes post-setup bootstrap data", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      LANGUAGE_PREFERENCE: "tr",
      RAG_ENABLED: "false",
      AUTONOMOUS_DEFAULT_ENABLED: "true",
      AUTONOMOUS_DEFAULT_HOURS: "48",
    });

    expect(saveResponse.read().statusCode).toBe(200);
    expect(JSON.parse(saveResponse.read().body)).toEqual({
      success: true,
      readyUrl: "http://127.0.0.1:0/",
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
      postSetupBootstrap: {
        language: "tr",
        autonomy: {
          enabled: true,
          hours: 48,
        },
      },
    });

    expect(wizard.getPendingPostSetupBootstrap()).toEqual({
      language: "tr",
      autonomy: {
        enabled: true,
        hours: 48,
      },
    });

    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    expect(envContent).toContain('PROVIDER_CHAIN="kimi"');
    expect(envContent).toContain('KIMI_API_KEY="sk-kimi"');
    expect(envContent).toContain("AUTONOMOUS_DEFAULT_ENABLED=true");
    expect(envContent).toContain("AUTONOMOUS_DEFAULT_HOURS=48");
    expect(envContent).toContain("MULTI_AGENT_ENABLED=true");
    expect(envContent).toContain("TASK_DELEGATION_ENABLED=true");
  });

  it("resolves setup completion even when waiting starts after save", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    const wizard = new SetupWizard({ port: 0 });
    await saveWizard(wizard);

    await expect(wizard.waitForCompletion()).resolves.toBeUndefined();
  });

  it("resolves all setup waiters before and after save", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    const wizard = new SetupWizard({ port: 0 });
    const earlyWait = wizard.waitForCompletion();

    await saveWizard(wizard);

    await expect(Promise.all([
      earlyWait,
      wizard.waitForCompletion(),
      wizard.waitForCompletion(),
    ])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("preserves provider warnings across setup bootstrap status transitions", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const completion = wizard.waitForCompletion();
    await saveWizard(wizard);
    await completion;

    wizard.markBootstrapStarting("Strada is starting the main web app.");

    const status = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/api/setup/status", method: "GET" }, status.response);

    expect(JSON.parse(status.read().body)).toEqual({
      state: "booting",
      detail: "Strada is starting the main web app.",
      readyUrl: "http://127.0.0.1:0/",
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
      postSetupBootstrap: {
        language: "en",
      },
    });
  });

  it("installs Strada.MCP through the setup API for a Unity project", async () => {
    const wizard = new SetupWizard({ port: 0 });
    const unityProjectDir = fs.mkdtempSync(path.join(homedir(), "strada-setup-mcp-"));
    tmpDirs.push(unityProjectDir);
    fs.mkdirSync(path.join(unityProjectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(unityProjectDir, "ProjectSettings"), { recursive: true });
    fs.mkdirSync(path.join(unityProjectDir, "Packages"), { recursive: true });
    fs.writeFileSync(
      path.join(unityProjectDir, "Packages", "manifest.json"),
      JSON.stringify({ dependencies: {} }),
      "utf-8",
    );

    installStradaMcpSubmoduleMock.mockImplementation(async (projectPath: string, target: "assets" | "packages") => {
      const submodulePath = target === "packages"
        ? path.join(projectPath, "Packages", "Submodules", "Strada.MCP")
        : path.join(projectPath, "Assets", "Strada.MCP");
      fs.mkdirSync(submodulePath, { recursive: true });
      fs.writeFileSync(
        path.join(submodulePath, "package.json"),
        JSON.stringify({ name: "strada-mcp", version: "9.9.9" }),
        "utf-8",
      );
      return {
        kind: "ok" as const,
        value: {
          target,
          submodulePath,
          unityPackagePath: path.join(submodulePath, "unity-package", "com.strada.mcp"),
          manifestPath: path.join(projectPath, "Packages", "manifest.json"),
          manifestDependency: target === "packages"
            ? "file:Submodules/Strada.MCP/unity-package/com.strada.mcp"
            : "file:../Assets/Strada.MCP/unity-package/com.strada.mcp",
          npmInstallRan: true,
        },
      };
    });

    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).readBody = async () => JSON.stringify({
      projectPath: unityProjectDir,
      target: "packages",
    });

    const response = makeResponse();
    await (wizard as unknown as {
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: "/api/setup/install-mcp",
      method: "POST",
      headers: {
        "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken,
      },
    }, response.response);

    expect(response.read().statusCode).toBe(200);
    expect(JSON.parse(response.read().body)).toMatchObject({
      success: true,
      isUnityProject: true,
      stradaDeps: {
        mcpInstalled: true,
        mcpVersion: "9.9.9",
      },
      install: {
        target: "packages",
        npmInstallRan: true,
      },
    });
    expect(installStradaMcpSubmoduleMock).toHaveBeenCalledWith(
      unityProjectDir,
      "packages",
      expect.objectContaining({
        mcpPath: process.env["STRADA_MCP_PATH"],
        mcpRepoUrl: process.env["STRADA_MCP_REPO_URL"],
      }),
    );
  });

  it("installs Strada Core through the setup install-dep API", async () => {
    const wizard = new SetupWizard({ port: 0 });
    const unityProjectDir = fs.mkdtempSync(path.join(homedir(), "strada-setup-dep-"));
    tmpDirs.push(unityProjectDir);
    fs.mkdirSync(path.join(unityProjectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(unityProjectDir, "ProjectSettings"), { recursive: true });
    fs.mkdirSync(path.join(unityProjectDir, "Packages"), { recursive: true });

    const installedPath = path.join(unityProjectDir, "Packages", "Submodules", "Strada.Core");
    installStradaDepMock.mockResolvedValue({
      kind: "ok" as const,
      value: installedPath,
    });

    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
    }).readBody = async () => JSON.stringify({
      projectPath: unityProjectDir,
      package: "core",
    });

    const response = makeResponse();
    await (wizard as unknown as {
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: "/api/setup/install-dep",
      method: "POST",
      headers: {
        "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken,
      },
    }, response.response);

    expect(response.read().statusCode).toBe(200);
    expect(JSON.parse(response.read().body)).toMatchObject({
      success: true,
      installedPath,
      isUnityProject: true,
    });
    expect(installStradaDepMock).toHaveBeenCalledWith(
      unityProjectDir,
      "core",
      expect.objectContaining({
        coreRepoUrl: process.env["STRADA_CORE_REPO_URL"],
        modulesRepoUrl: process.env["STRADA_MODULES_REPO_URL"],
      }),
    );
  });

  it("rejects install-dep with invalid package name", async () => {
    const wizard = new SetupWizard({ port: 0 });

    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
    }).readBody = async () => JSON.stringify({
      projectPath: homedir(),
      package: "invalid",
    });

    const response = makeResponse();
    await (wizard as unknown as {
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: "/api/setup/install-dep",
      method: "POST",
      headers: {
        "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken,
      },
    }, response.response);

    expect(response.read().statusCode).toBe(400);
    expect(JSON.parse(response.read().body)).toMatchObject({
      success: false,
      error: "Invalid package: must be 'core' or 'modules'",
    });
  });
});
