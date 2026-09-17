import fs from "node:fs";
import os from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  preflightResponseProvidersMock,
  installStradaMcpSubmoduleMock,
  installStradaDepMock,
  isClaudeCliAvailableMock,
  getClaudeInstallHintMock,
  startClaudeLoginMock,
} = vi.hoisted(() => ({
  preflightResponseProvidersMock: vi.fn().mockResolvedValue({
    passedProviderIds: ["kimi"],
    failures: [],
  }),
  installStradaMcpSubmoduleMock: vi.fn(),
  installStradaDepMock: vi.fn(),
  isClaudeCliAvailableMock: vi.fn(),
  getClaudeInstallHintMock: vi.fn(() => "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, then sign in again."),
  startClaudeLoginMock: vi.fn(),
}));

vi.mock("./response-provider-preflight.js", () => ({
  preflightResponseProviders: preflightResponseProvidersMock,
  formatProviderPreflightFailures: (
    failures: Array<{ providerName: string; detail: string }>,
  ) => failures.map((f) => `${f.providerName}: ${f.detail}`).join(" "),
}));

vi.mock("../config/strada-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/strada-deps.js")>();
  return {
    ...actual,
    installStradaMcpSubmodule: installStradaMcpSubmoduleMock,
    installStradaDep: installStradaDepMock,
  };
});

// Mock the Claude CLI login driver so the /api/setup/claude/* routes are
// deterministic regardless of whether the `claude` CLI is installed locally.
vi.mock("../common/claude-cli-login.js", () => ({
  isClaudeCliAvailable: isClaudeCliAvailableMock,
  getClaudeInstallHint: getClaudeInstallHintMock,
  startClaudeLogin: startClaudeLoginMock,
}));

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

  it("accepts project paths outside the home directory at save time", async () => {
    const wizard = new SetupWizard();

    const rawPath = process.platform === "win32" ? "C:\\Windows" : "/tmp";

    const result = await (wizard as unknown as {
      validateProjectPathForSave: (
        rawPath: string,
      ) => Promise<{ valid: true; resolved: string } | { valid: false; error: string }>;
    }).validateProjectPathForSave(rawPath);

    expect(result.valid).toBe(true);
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

  it("serves an absolute cross-port ready url when the web channel runs on a different port than the wizard", async () => {
    // Regression: index.ts must hand markBootstrapReady the absolute web-channel
    // URL (buildSetupReadyUrl(config.web.port)) instead of a relative "/", or the
    // browser's refresh redirect would point back at the now-closed wizard port.
    const wizard = new SetupWizard({ port: 0 });
    const webChannelReadyUrl = buildSetupReadyUrl(4321);
    wizard.markBootstrapStarting("Strada is starting the main web app.");
    wizard.markBootstrapReady(webChannelReadyUrl);

    const status = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/api/setup/status", method: "GET" }, status.response);

    const parsed = JSON.parse(status.read().body) as { state: string; readyUrl: string };
    expect(parsed.state).toBe("ready");
    expect(parsed.readyUrl).toBe(webChannelReadyUrl);
    expect(parsed.readyUrl).toBe("http://127.0.0.1:4321/");
    expect(parsed.readyUrl).not.toBe("/");
  });

  it("writes EMBEDDING_MODEL when provided with explicit provider", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "ollama",
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "bge-m3",
    }, homedir(), 3000);

    expect(lines).toContain('EMBEDDING_PROVIDER="ollama"');
    expect(lines).toContain('EMBEDDING_MODEL="bge-m3"');
  });

  it("writes STRADA_DAEMON_ENABLED=true explicitly when the key is untouched or true (audit 10.1 / 10.6 / D25)", () => {
    // The handoff reloads .env with dotenv override, which can overwrite a
    // stale process.env value but never delete one — so an omitted key left a
    // previous "false" in force after the user re-enabled autonomy.
    const untouched = buildSetupEnvLines({ PROVIDER_CHAIN: "kimi", KIMI_API_KEY: "sk" }, homedir(), 3000);
    expect(untouched).toContain("STRADA_DAEMON_ENABLED=true");
    const explicit = buildSetupEnvLines({ PROVIDER_CHAIN: "kimi", KIMI_API_KEY: "sk", STRADA_DAEMON_ENABLED: "true" }, homedir(), 3000);
    expect(explicit).toContain("STRADA_DAEMON_ENABLED=true");
    expect(explicit.filter((l) => l.startsWith("STRADA_DAEMON_ENABLED="))).toHaveLength(1);
  });

  it("writes STRADA_DAEMON_ENABLED=false for an explicit opt-out (guard)", () => {
    const lines = buildSetupEnvLines({ PROVIDER_CHAIN: "kimi", KIMI_API_KEY: "sk", STRADA_DAEMON_ENABLED: "false" }, homedir(), 3000);
    expect(lines).toContain("STRADA_DAEMON_ENABLED=false");
    expect(lines).not.toContain("STRADA_DAEMON_ENABLED=true");
  });

  it("omits EMBEDDING_MODEL when provider is auto", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
      GEMINI_API_KEY: "sk-gem",
      EMBEDDING_MODEL: "ignored-because-auto",
    }, homedir(), 3000);

    expect(lines.some((line) => line.startsWith("EMBEDDING_MODEL="))).toBe(false);
  });

  it("persists OPENCODE_BASE_URL and OPENCODE_DEFAULT_MODEL alongside the API key", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "opencode",
      OPENCODE_API_KEY: "sk-oc-test",
      OPENCODE_BASE_URL: "https://opencode.ai/zen/v1",
      OPENCODE_DEFAULT_MODEL: "opencode-go-1",
    }, homedir(), 3000);

    expect(lines).toContain('OPENCODE_API_KEY="sk-oc-test"');
    expect(lines).toContain('OPENCODE_BASE_URL="https://opencode.ai/zen/v1"');
    expect(lines).toContain('OPENCODE_DEFAULT_MODEL="opencode-go-1"');
    // opencode must NOT appear in KNOWN_PROVIDER_MODEL_ORDER so no stale preset default leaks through
    expect(lines.some((l) => /^OPENCODE_MODEL=/.test(l))).toBe(false);
  });

  it("omits OPENCODE_DEFAULT_MODEL when the value contains unsafe characters", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "opencode",
      OPENCODE_API_KEY: "sk-oc-test",
      OPENCODE_DEFAULT_MODEL: "bad model; rm -rf /",
    }, homedir(), 3000);

    expect(lines.some((l) => /^OPENCODE_DEFAULT_MODEL=/.test(l))).toBe(false);
  });

  it("enables the Codebase Memory Vault by default during setup", () => {
    const lines = buildSetupEnvLines({
      PROVIDER_CHAIN: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
    }, homedir(), 3000);

    expect(lines).toContain("STRADA_VAULT_ENABLED=true");
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

    expect(lines).toContain('CLAUDE_MODEL="claude-sonnet-5"');
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

  it("rejects EMBEDDING_MODEL values with unsafe characters during setup save", async () => {
    const wizard = new SetupWizard({ port: 0 });
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "ollama",
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "bad value; rm -rf /",
    });

    expect(response.read().statusCode).toBe(400);
    expect(JSON.parse(response.read().body)).toEqual({
      success: false,
      error: "Invalid EMBEDDING_MODEL value",
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

  it("requires CSRF for setup path validation reads", async () => {
    const wizard = new SetupWizard({ port: 0 });

    const missing = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: `/api/setup/validate-path?path=${encodeURIComponent(homedir())}`,
      method: "GET",
      headers: {},
    }, missing.response);
    expect(missing.read().statusCode).toBe(403);

    const ok = makeResponse();
    await (wizard as unknown as {
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: `/api/setup/validate-path?path=${encodeURIComponent(homedir())}`,
      method: "GET",
      headers: {
        "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken,
      },
    }, ok.response);
    expect(ok.read().statusCode).toBe(200);
    expect(JSON.parse(ok.read().body)).toMatchObject({ valid: true });
  });

  it("requires CSRF for setup directory browsing reads", async () => {
    const wizard = new SetupWizard({ port: 0 });

    const missing = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: `/api/setup/browse?path=${encodeURIComponent(homedir())}`,
      method: "GET",
      headers: {},
    }, missing.response);
    expect(missing.read().statusCode).toBe(403);

    const ok = makeResponse();
    await (wizard as unknown as {
      csrfToken: string;
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({
      url: `/api/setup/browse?path=${encodeURIComponent(homedir())}`,
      method: "GET",
      headers: {
        "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken,
      },
    }, ok.response);
    expect(ok.read().statusCode).toBe(200);
    expect(JSON.parse(ok.read().body)).toMatchObject({ path: homedir() });
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

    // Primary (kimi) passes preflight; a fallback (deepseek) fails -> non-blocking warning.
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: ["kimi"],
      failures: [{
        providerId: "deepseek",
        providerName: "DeepSeek",
        detail: "DeepSeek health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi,deepseek",
      KIMI_API_KEY: "sk-kimi",
      DEEPSEEK_API_KEY: "sk-deepseek",
      LANGUAGE_PREFERENCE: "tr",
      RAG_ENABLED: "false",
      AUTONOMOUS_DEFAULT_ENABLED: "true",
      AUTONOMOUS_DEFAULT_HOURS: "48",
    });

    expect(saveResponse.read().statusCode).toBe(200);
    const saveBody = JSON.parse(saveResponse.read().body);
    expect(saveBody).toMatchObject({
      success: true,
      readyUrl: "http://127.0.0.1:0/",
      providerWarnings: [{
        providerId: "deepseek",
        providerName: "DeepSeek",
        detail: "DeepSeek health check failed. Verify the credential and network access.",
      }],
      postSetupBootstrap: {
        language: "tr",
        autonomy: {
          enabled: true,
          hours: 48,
        },
      },
    });
    // Plan 2.1 / 2.2: the response carries the shared readiness verdict and
    // the effective config read back from disk (secrets reduced to a marker).
    expect(saveBody.readiness.state).toBe("degraded");
    expect(saveBody.effectiveConfig.KIMI_API_KEY).toBe("<set>");
    expect(saveBody.effectiveConfig.PROVIDER_CHAIN).toBe("kimi,deepseek");

    expect(wizard.getPendingPostSetupBootstrap()).toEqual({
      language: "tr",
      autonomy: {
        enabled: true,
        hours: 48,
      },
    });

    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    expect(envContent).toContain('PROVIDER_CHAIN="kimi,deepseek"');
    expect(envContent).toContain('KIMI_API_KEY="sk-kimi"');
    expect(envContent).toContain('DEEPSEEK_API_KEY="sk-deepseek"');
    expect(envContent).toContain("AUTONOMOUS_DEFAULT_ENABLED=true");
    expect(envContent).toContain("AUTONOMOUS_DEFAULT_HOURS=48");
    expect(envContent).toContain("MULTI_AGENT_ENABLED=true");
    expect(envContent).toContain("TASK_DELEGATION_ENABLED=true");
  });

  it("preflights OpenCode with the saved OPENCODE_DEFAULT_MODEL and OPENCODE_BASE_URL (audit 10.4 / D28)", async () => {
    // OpenCode is absent from KNOWN_PROVIDER_MODEL_ORDER, so until now the
    // preflight probed the provider's built-in default model on the default
    // endpoint — not what the user just configured.
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    preflightResponseProvidersMock.mockResolvedValue({ passedProviderIds: ["opencode"], failures: [] });

    const wizard = new SetupWizard({ port: 0 });
    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "opencode",
      OPENCODE_API_KEY: "sk-opencode",
      OPENCODE_DEFAULT_MODEL: "vendor/chosen-model",
      OPENCODE_BASE_URL: "https://opencode.example.test/v1",
      RAG_ENABLED: "false",
    });
    expect(saveResponse.read().statusCode).toBe(200);

    expect(preflightResponseProvidersMock).toHaveBeenCalledTimes(1);
    const [names, , models, baseUrls] = preflightResponseProvidersMock.mock.calls[0]!;
    expect(names).toEqual(["opencode"]);
    expect(models).toEqual(expect.objectContaining({ opencode: "vendor/chosen-model" }));
    expect(baseUrls).toEqual({ opencode: "https://opencode.example.test/v1" });
  });

  it("passes no OpenCode endpoint to preflight when OpenCode is not configured (guard)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    preflightResponseProvidersMock.mockResolvedValue({ passedProviderIds: ["kimi"], failures: [] });

    const wizard = new SetupWizard({ port: 0 });
    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });
    expect(saveResponse.read().statusCode).toBe(200);
    const [, , models, baseUrls] = preflightResponseProvidersMock.mock.calls[0]!;
    expect(models).not.toHaveProperty("opencode");
    expect(baseUrls ?? {}).toEqual({});
  });

  it("carries an existing STRADA_DAEMON_ENABLED=false over when the client omits the key, and reports it on /api/setup/existing (Codex review of 0-A.25)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    fs.writeFileSync(path.join(tempCwd, ".env"), "UNITY_PROJECT_PATH=/tmp/x\nSTRADA_DAEMON_ENABLED=false\n");
    preflightResponseProvidersMock.mockResolvedValue({ passedProviderIds: ["kimi"], failures: [] });

    const wizard = new SetupWizard({ port: 0 });
    const existing = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest(
      { url: "/api/setup/existing", method: "GET", headers: { "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken } },
      existing.response,
    );
    expect(JSON.parse(existing.read().body)).toEqual({ daemonEnabled: false });

    // The request does not mention the key at all: the opt-out must survive.
    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });
    expect(saveResponse.read().statusCode).toBe(200);
    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    expect(envContent).toContain("STRADA_DAEMON_ENABLED=false");
    expect(envContent).not.toContain("STRADA_DAEMON_ENABLED=true");
  });

  it("reports null on /api/setup/existing and writes the default (on) when nothing set the key (guard)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    delete process.env["STRADA_DAEMON_ENABLED"];
    preflightResponseProvidersMock.mockResolvedValue({ passedProviderIds: ["kimi"], failures: [] });

    const wizard = new SetupWizard({ port: 0 });
    const existing = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest(
      { url: "/api/setup/existing", method: "GET", headers: { "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken } },
      existing.response,
    );
    expect(JSON.parse(existing.read().body)).toEqual({ daemonEnabled: null });

    const saveResponse = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });
    expect(saveResponse.read().statusCode).toBe(200);
    expect(fs.readFileSync(path.join(tempCwd, ".env"), "utf-8")).toContain("STRADA_DAEMON_ENABLED=true");
  });

  it("blocks saving when the only response provider fails preflight (no false success)", async () => {
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "openai",
        providerName: "OpenAI",
        detail: 'The configured model "gpt-4.1-mini" is not accepted by the ChatGPT/Codex subscription endpoint (HTTP 400). Set the OpenAI model to a Codex-supported one (such as gpt-5.4) or switch OpenAI to API-key mode.',
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "openai",
      OPENAI_AUTH_MODE: "chatgpt-subscription",
      OPENAI_MODEL: "gpt-4.1-mini",
      RAG_ENABLED: "false",
    });

    expect(response.read().statusCode).toBe(400);
    const body = JSON.parse(response.read().body);
    expect(body.success).toBe(false);
    expect(body.error).toContain("gpt-4.1-mini");
    expect(body.error).not.toMatch(/sign in again/i);
  });

  // ---------------------------------------------------------------------------
  // Plan 2.1 (audit 10.1b / D24, D29, D30): typed setup persistence merges
  // into the existing .env; every submitted field is written and read back.
  // ---------------------------------------------------------------------------

  it("keeps a key a person added by hand when Save merges into the existing .env (2.1 / D29)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    fs.writeFileSync(
      path.join(tempCwd, ".env"),
      [
        "# my notes",
        "UNITY_PROJECT_PATH=/tmp/old",
        "MY_CUSTOM_WEBHOOK_URL=https://hooks.example/abc",
        "LOG_LEVEL=debug",
        "DEEPSEEK_API_KEY=sk-stale",
        "",
      ].join("\n"),
    );

    const wizard = new SetupWizard({ port: 0 });
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });
    expect(response.read().statusCode).toBe(200);
    const body = JSON.parse(response.read().body);

    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    // Hand-added key and comment survive; the hand-edited default is kept.
    expect(envContent).toContain("MY_CUSTOM_WEBHOOK_URL=https://hooks.example/abc");
    expect(envContent).toContain("# my notes");
    expect(envContent).toContain("LOG_LEVEL=debug");
    expect(envContent).not.toContain("LOG_LEVEL=info");
    // Wizard-owned keys are rewritten in place / removed when de-selected.
    expect(envContent).toContain(`UNITY_PROJECT_PATH="${homedir()}"`);
    expect(envContent).not.toContain("UNITY_PROJECT_PATH=/tmp/old");
    expect(envContent).not.toContain("DEEPSEEK_API_KEY");
    // And the response shows the effective file, not the request — but a key
    // the wizard does not own is reported as PRESENT, never by value: the
    // readback used to return a hand-added DATABASE_URL with its password
    // (Codex round 8 #11).
    expect(body.effectiveConfig.MY_CUSTOM_WEBHOOK_URL).toBe("<set>");
    // LOG_LEVEL is a key the wizard writes itself, so its value is shown.
    expect(body.effectiveConfig.LOG_LEVEL).toBe("debug");
    expect(JSON.stringify(body)).not.toContain("hooks.example");
    expect(body.preservedKeys).toEqual(expect.arrayContaining(["MY_CUSTOM_WEBHOOK_URL", "LOG_LEVEL"]));
    // …and a wizard-owned, non-secret key is still shown as it stands.
    expect(body.effectiveConfig.UNITY_PROJECT_PATH).toBe(homedir());
  });

  it("writes a submitted daemon budget and Obsidian fields and reads them back (2.1 / D24)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    const wizard = new SetupWizard({ port: 0 });
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
      STRADA_DAEMON_ENABLED: "true",
      STRADA_DAEMON_DAILY_BUDGET: "2.5",
      OBSIDIAN_ENABLED: "true",
      OBSIDIAN_VAULT_PATH: "/Users/me/Vault",
      OBSIDIAN_API_KEY: "obs-key",
    });
    expect(response.read().statusCode).toBe(200);
    const body = JSON.parse(response.read().body);

    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    expect(envContent).toContain("STRADA_DAEMON_DAILY_BUDGET=2.5");
    expect(envContent).toContain("OBSIDIAN_ENABLED=true");
    expect(envContent).toContain('OBSIDIAN_VAULT_PATH="/Users/me/Vault"');
    expect(envContent).toContain('OBSIDIAN_API_KEY="obs-key"');
    expect(body.effectiveConfig.STRADA_DAEMON_DAILY_BUDGET).toBe("2.5");
    expect(body.effectiveConfig.OBSIDIAN_VAULT_PATH).toBe("/Users/me/Vault");
    expect(body.effectiveConfig.OBSIDIAN_API_KEY).toBe("<set>");
  });

  it("writes a global budget of 0 as zero and shows it as zero unless unlimited was chosen (2.1 / D30)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    const zero = await saveWizard(new SetupWizard({ port: 0 }), {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
      STRADA_BUDGET_DAILY_USD: "0",
    });
    expect(zero.read().statusCode).toBe(200);
    const zeroBody = JSON.parse(zero.read().body);
    expect(fs.readFileSync(path.join(tempCwd, ".env"), "utf-8")).toContain("STRADA_BUDGET_DAILY_USD=0");
    expect(zeroBody.effectiveBudget).toEqual({ dailyUsd: 0, unlimited: false, display: "$0.00" });

    const unlimited = await saveWizard(new SetupWizard({ port: 0 }), {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
      STRADA_BUDGET_DAILY_USD: "0",
      _budgetUnlimited: "true",
    });
    expect(unlimited.read().statusCode).toBe(200);
    const unlimitedBody = JSON.parse(unlimited.read().body);
    expect(fs.readFileSync(path.join(tempCwd, ".env"), "utf-8")).not.toContain("STRADA_BUDGET_DAILY_USD");
    expect(unlimitedBody.effectiveBudget).toEqual({ dailyUsd: null, unlimited: true, display: "unlimited" });
  });

  it("refuses an unusable budget instead of silently dropping it (2.1 guard)", async () => {
    const response = await saveWizard(new SetupWizard({ port: 0 }), {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
      STRADA_BUDGET_DAILY_USD: "lots",
    });
    expect(response.read().statusCode).toBe(400);
    expect(JSON.parse(response.read().body).error).toContain("STRADA_BUDGET_DAILY_USD");
  });

  // ---------------------------------------------------------------------------
  // Plan 2.3 (audit 10.5 / E-missed #1): an id from the wizard's own live
  // listing is accepted at Save.
  // ---------------------------------------------------------------------------

  it("accepts a model id that came from the same live listing the wizard offered (2.3)", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);
    process.env["STRADA_INSTALL_ROOT"] = tempCwd;
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";

    const wizard = new SetupWizard({ port: 0 });
    const liveOnlyId = "gpt-99-live-preview";
    (wizard as unknown as {
      createProbeProvider: (config: { name: string }) => { listModels?: () => Promise<string[]> };
    }).createProbeProvider = () => ({ listModels: async () => [liveOnlyId] });

    // The wizard serves the live listing through its own probe route ...
    const probe = makeResponse();
    const probeTarget = wizard as unknown as {
      readBody: () => Promise<string>;
      handleSetupProviderModelsProbe: (req: unknown, res: unknown) => Promise<void>;
    };
    probeTarget.readBody = async () => JSON.stringify({ provider: "openai", key: "sk-x" });
    await probeTarget.handleSetupProviderModelsProbe({}, probe.response);
    expect(JSON.parse(probe.read().body)).toEqual({
      providers: [{ name: "openai", models: [liveOnlyId] }],
    });

    // ... and Save accepts what it offered, even though the curated catalog
    // does not know the id.
    const response = await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "openai",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_MODEL: liveOnlyId,
      RAG_ENABLED: "false",
    });
    expect(response.read().statusCode).toBe(200);
    expect(JSON.parse(response.read().body).effectiveConfig.OPENAI_MODEL).toBe(liveOnlyId);

    // A fresh wizard that never served the id still refuses it (guard).
    const stranger = await saveWizard(new SetupWizard({ port: 0 }), {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "openai",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_MODEL: liveOnlyId,
      RAG_ENABLED: "false",
    });
    expect(stranger.read().statusCode).toBe(400);
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

    // Primary (kimi) passes preflight; a fallback (deepseek) fails -> non-blocking warning.
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: ["kimi"],
      failures: [{
        providerId: "deepseek",
        providerName: "DeepSeek",
        detail: "DeepSeek health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const completion = wizard.waitForCompletion();
    await saveWizard(wizard, {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi,deepseek",
      KIMI_API_KEY: "sk-kimi",
      DEEPSEEK_API_KEY: "sk-deepseek",
      RAG_ENABLED: "false",
    });
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
        providerId: "deepseek",
        providerName: "DeepSeek",
        detail: "DeepSeek health check failed. Verify the credential and network access.",
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

  describe("GET /api/providers/models during setup", () => {
    // The warm GET sources provider keys from process.env, so snapshot + clear
    // them around each test to keep assertions deterministic regardless of the
    // ambient environment (e.g. CI secrets).
    const GET_ENV_KEYS = [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
      "QWEN_API_KEY", "KIMI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
      "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "MINIMAX_API_KEY", "OPENCODE_API_KEY",
      "OPENCODE_BASE_URL",
    ];
    beforeEach(() => {
      // Stub the provider key vars empty so assertions are deterministic
      // regardless of the ambient environment (e.g. CI secrets).
      for (const k of GET_ENV_KEYS) vi.stubEnv(k, "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns 200 with an empty providers array when no key is configured (never 503)", async () => {
      const wizard = new SetupWizard({ port: 0 });

      const response = makeResponse();
      await (wizard as unknown as {
        handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
      }).handleRequest({ url: "/api/providers/models", method: "GET" }, response.response);

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
    });

    it("still returns 503 for other /api/providers/* GET routes during setup", async () => {
      const wizard = new SetupWizard({ port: 0 });

      const response = makeResponse();
      await (wizard as unknown as {
        handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
      }).handleRequest({ url: "/api/providers/available", method: "GET" }, response.response);

      expect(response.read().statusCode).toBe(503);
    });

    it("IGNORES a key passed via the query param and never probes (key-in-URL is deprecated)", async () => {
      const wizard = new SetupWizard({ port: 0 });

      // The query-param key path is removed for security (keys leak into access
      // logs / Referer). The GET handler must NOT call the probe seam at all.
      let probeCalled = false;
      (wizard as unknown as {
        createProbeProvider: (config: { name: string; apiKey?: string }) => {
          listModels?: () => Promise<string[]>;
        };
      }).createProbeProvider = () => {
        probeCalled = true;
        return { listModels: async () => ["gpt-5.4", "gpt-5.4-mini"] };
      };

      const response = makeResponse();
      await (wizard as unknown as {
        handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
      }).handleRequest(
        { url: "/api/providers/models?provider=openai&key=sk-probe", method: "GET" },
        response.response,
      );

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
      expect(probeCalled).toBe(false);
    });

    it("warms live models from a provider key already present in the environment", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-env");
      const wizard = new SetupWizard({ port: 0 });

      (wizard as unknown as {
        createProbeProvider: (config: { name: string; apiKey?: string; baseUrl?: string }) => {
          listModels?: () => Promise<string[]>;
        };
      }).createProbeProvider = (config) => {
        expect(config.name).toBe("openai");
        return { listModels: async () => ["gpt-5.4", "gpt-5.4-mini"] };
      };

      const response = makeResponse();
      await (wizard as unknown as {
        handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
      }).handleRequest({ url: "/api/providers/models", method: "GET" }, response.response);

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({
        providers: [{ name: "openai", models: ["gpt-5.4", "gpt-5.4-mini"] }],
      });
    });
  });

  describe("POST /api/providers/models during setup", () => {
    const postProviderModels = async (
      wizard: SetupWizard,
      body: unknown,
    ) => {
      (wizard as unknown as {
        readBody: (req: unknown) => Promise<string>;
      }).readBody = async () => (typeof body === "string" ? body : JSON.stringify(body));

      const response = makeResponse();
      await (wizard as unknown as {
        handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
      }).handleRequest({ url: "/api/providers/models", method: "POST" }, response.response);
      return response;
    };

    it("probes live models when a key is supplied in the JSON body", async () => {
      const wizard = new SetupWizard({ port: 0 });

      (wizard as unknown as {
        createProbeProvider: (config: { name: string; apiKey?: string; baseUrl?: string }) => {
          listModels?: () => Promise<string[]>;
        };
      }).createProbeProvider = (config) => {
        expect(config.name).toBe("openai");
        expect(config.apiKey).toBe("sk-x");
        return { listModels: async () => ["gpt-5.4", "gpt-5.4-mini"] };
      };

      const response = await postProviderModels(wizard, { provider: "openai", key: "sk-x" });

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({
        providers: [{ name: "openai", models: ["gpt-5.4", "gpt-5.4-mini"] }],
      });
    });

    it("threads a baseUrl from the body to the probe (OpenCode Zen/Go)", async () => {
      const wizard = new SetupWizard({ port: 0 });

      let receivedBaseUrl: string | undefined;
      (wizard as unknown as {
        createProbeProvider: (config: { name: string; apiKey?: string; baseUrl?: string }) => {
          listModels?: () => Promise<string[]>;
        };
      }).createProbeProvider = (config) => {
        receivedBaseUrl = config.baseUrl;
        expect(config.name).toBe("opencode");
        return { listModels: async () => ["go-1"] };
      };

      const response = await postProviderModels(wizard, {
        provider: "opencode",
        key: "sk-zen",
        baseUrl: "https://opencode.ai/zen/v1",
      });

      expect(response.read().statusCode).toBe(200);
      expect(receivedBaseUrl).toBe("https://opencode.ai/zen/v1");
      expect(JSON.parse(response.read().body)).toEqual({
        providers: [{ name: "opencode", models: ["go-1"] }],
      });
    });

    it("returns 200 empty for a missing key", async () => {
      const wizard = new SetupWizard({ port: 0 });

      let probeCalled = false;
      (wizard as unknown as {
        createProbeProvider: () => { listModels?: () => Promise<string[]> };
      }).createProbeProvider = () => {
        probeCalled = true;
        return { listModels: async () => ["x"] };
      };

      const response = await postProviderModels(wizard, { provider: "openai" });

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
      expect(probeCalled).toBe(false);
    });

    it("returns 200 empty for an unknown provider", async () => {
      const wizard = new SetupWizard({ port: 0 });

      let probeCalled = false;
      (wizard as unknown as {
        createProbeProvider: () => { listModels?: () => Promise<string[]> };
      }).createProbeProvider = () => {
        probeCalled = true;
        return { listModels: async () => ["x"] };
      };

      const response = await postProviderModels(wizard, { provider: "not-a-real-provider", key: "sk-x" });

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
      expect(probeCalled).toBe(false);
    });

    it("returns 200 empty when the probe throws (never crashes setup)", async () => {
      const wizard = new SetupWizard({ port: 0 });

      (wizard as unknown as {
        createProbeProvider: () => { listModels?: () => Promise<string[]> };
      }).createProbeProvider = () => {
        throw new Error("boom");
      };

      const response = await postProviderModels(wizard, { provider: "openai", key: "sk-x" });

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
    });

    it("returns 200 empty for malformed/empty JSON (never crashes setup)", async () => {
      const wizard = new SetupWizard({ port: 0 });

      let probeCalled = false;
      (wizard as unknown as {
        createProbeProvider: () => { listModels?: () => Promise<string[]> };
      }).createProbeProvider = () => {
        probeCalled = true;
        return { listModels: async () => ["x"] };
      };

      const response = await postProviderModels(wizard, "{ this is not json");

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toEqual({ providers: [] });
      expect(probeCalled).toBe(false);
    });
  });

  describe("Claude subscription routes (mirror OpenAI)", () => {
    beforeEach(() => {
      isClaudeCliAvailableMock.mockReset();
      startClaudeLoginMock.mockReset();
      getClaudeInstallHintMock.mockClear();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const callRoute = async (
      wizard: SetupWizard,
      url: string,
      method: string,
      withCsrf: boolean,
    ) => {
      const response = makeResponse();
      await (wizard as unknown as {
        csrfToken: string;
        handleRequest: (
          req: { url: string; method: string; headers?: Record<string, string> },
          res: unknown,
        ) => Promise<void>;
      }).handleRequest(
        {
          url,
          method,
          headers: withCsrf ? { "x-csrf-token": (wizard as unknown as { csrfToken: string }).csrfToken } : {},
        },
        response.response,
      );
      return response;
    };

    it("GET /api/setup/claude/status reports ok via inspectClaudeSubscriptionAuth + CLI availability, never echoing the token", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-secret-token");
      isClaudeCliAvailableMock.mockReturnValue(true);
      const wizard = new SetupWizard({ port: 0 });

      const response = await callRoute(wizard, "/api/setup/claude/status", "GET", true);

      expect(response.read().statusCode).toBe(200);
      const body = JSON.parse(response.read().body) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.claudeAvailable).toBe(true);
      // Security: the token must NEVER be echoed back to the browser.
      expect(response.read().body).not.toContain("sk-ant-secret-token");
      expect(body).not.toHaveProperty("authToken");
    });

    it("GET /api/setup/claude/status reports not-ok when no auth token is present", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
      isClaudeCliAvailableMock.mockReturnValue(false);
      const wizard = new SetupWizard({ port: 0 });

      const response = await callRoute(wizard, "/api/setup/claude/status", "GET", true);

      expect(response.read().statusCode).toBe(200);
      const body = JSON.parse(response.read().body) as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.issue).toBeTruthy();
      expect(body.claudeAvailable).toBe(false);
    });

    it("GET /api/setup/claude/status requires the CSRF token", async () => {
      const wizard = new SetupWizard({ port: 0 });
      const response = await callRoute(wizard, "/api/setup/claude/status", "GET", false);
      expect(response.read().statusCode).toBe(403);
    });

    it("POST /api/setup/claude/signin starts `claude auth login` and returns the auth URL", async () => {
      isClaudeCliAvailableMock.mockReturnValue(true);
      startClaudeLoginMock.mockResolvedValue({ started: true, url: "https://claude.ai/oauth?code=abc" });
      const wizard = new SetupWizard({ port: 0 });

      const response = await callRoute(wizard, "/api/setup/claude/signin", "POST", true);

      expect(response.read().statusCode).toBe(200);
      expect(JSON.parse(response.read().body)).toMatchObject({
        started: true,
        claudeAvailable: true,
        url: "https://claude.ai/oauth?code=abc",
        error: null,
      });
      expect(startClaudeLoginMock).toHaveBeenCalledTimes(1);
    });

    it("POST /api/setup/claude/signin returns an install hint when the CLI is missing", async () => {
      isClaudeCliAvailableMock.mockReturnValue(false);
      const wizard = new SetupWizard({ port: 0 });

      const response = await callRoute(wizard, "/api/setup/claude/signin", "POST", true);

      expect(response.read().statusCode).toBe(200);
      const body = JSON.parse(response.read().body) as Record<string, unknown>;
      expect(body.started).toBe(false);
      expect(body.claudeAvailable).toBe(false);
      expect(String(body.error)).toContain("@anthropic-ai/claude-code");
      expect(startClaudeLoginMock).not.toHaveBeenCalled();
    });

    it("POST /api/setup/claude/signin requires the CSRF token", async () => {
      const wizard = new SetupWizard({ port: 0 });
      const response = await callRoute(wizard, "/api/setup/claude/signin", "POST", false);
      expect(response.read().statusCode).toBe(403);
    });
  });
});
