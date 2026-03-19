import fs from "node:fs";
import os from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { preflightResponseProvidersMock } = vi.hoisted(() => ({
  preflightResponseProvidersMock: vi.fn().mockResolvedValue({
    passedProviderIds: ["kimi"],
    failures: [],
  }),
}));

vi.mock("./response-provider-preflight.js", () => ({
  preflightResponseProviders: preflightResponseProvidersMock,
}));

import {
  SetupWizard,
  buildSetupEnvLines,
  buildSetupAccessUrl,
  hasConfiguredEmbeddingCandidate,
  injectSetupModeMarker,
} from "./setup-wizard.js";

describe("SetupWizard path validation", () => {
  const originalCwd = process.cwd();
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: ["kimi"],
      failures: [],
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
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
    }).validateProjectPathForSave("/tmp");

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

    expect(disabledLines.some((line) => line.includes("AUTONOMOUS_DEFAULT_"))).toBe(false);
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
    expect(page.read().body).toContain('http-equiv="refresh" content="1;url=/"');
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

  it("saves configuration with provider warnings instead of rejecting the setup", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);

    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    const config = {
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    };

    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).readBody = async () => JSON.stringify(config);

    const saveResponse = makeResponse();
    await (wizard as unknown as {
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).handleSaveConfig({}, saveResponse.response);

    expect(saveResponse.read().statusCode).toBe(200);
    expect(JSON.parse(saveResponse.read().body)).toEqual({
      success: true,
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });

    const envContent = fs.readFileSync(path.join(tempCwd, ".env"), "utf-8");
    expect(envContent).toContain('PROVIDER_CHAIN="kimi"');
    expect(envContent).toContain('KIMI_API_KEY="sk-kimi"');
  });

  it("preserves provider warnings across setup bootstrap status transitions", async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "strada-setup-wizard-"));
    tmpDirs.push(tempCwd);
    process.chdir(tempCwd);

    preflightResponseProvidersMock.mockResolvedValue({
      passedProviderIds: [],
      failures: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });

    const wizard = new SetupWizard({ port: 0 });
    (wizard as unknown as {
      readBody: (req: unknown) => Promise<string>;
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).readBody = async () => JSON.stringify({
      UNITY_PROJECT_PATH: homedir(),
      PROVIDER_CHAIN: "kimi",
      KIMI_API_KEY: "sk-kimi",
      RAG_ENABLED: "false",
    });

    const saveResponse = makeResponse();
    await (wizard as unknown as {
      handleSaveConfig: (req: unknown, res: unknown) => Promise<void>;
    }).handleSaveConfig({}, saveResponse.response);

    wizard.markBootstrapStarting("Strada is starting the main web app.");

    const status = makeResponse();
    await (wizard as unknown as {
      handleRequest: (req: { url: string; method: string; headers?: Record<string, string> }, res: unknown) => Promise<void>;
    }).handleRequest({ url: "/api/setup/status", method: "GET" }, status.response);

    expect(JSON.parse(status.read().body)).toEqual({
      state: "booting",
      detail: "Strada is starting the main web app.",
      providerWarnings: [{
        providerId: "kimi",
        providerName: "Kimi (Moonshot)",
        detail: "Kimi (Moonshot) health check failed. Verify the credential and network access.",
      }],
    });
  });
});
