import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  SetupWizard,
  buildSetupAccessUrl,
  hasConfiguredEmbeddingCandidate,
  injectSetupModeMarker,
} from "./setup-wizard.js";

describe("SetupWizard path validation", () => {
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

  it("rejects repeated setup API calls and serves a handoff page once configuration has been saved", async () => {
    const wizard = new SetupWizard({ port: 0 });
    wizard.markBootstrapStarting();

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
});
