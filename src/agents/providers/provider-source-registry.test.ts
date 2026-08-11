import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLogger } from "../../utils/logger.js";
import {
  extractProviderOfficialSignals,
  loadProviderSourceRegistry,
  resolveDefaultRegistryPath,
  DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH,
} from "./provider-source-registry.js";

describe("provider-source-registry — packaged-install path resolution", () => {
  const originalCwd = process.cwd();
  beforeAll(() => {
    createLogger("error", "test.log");
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("ships the registry file beside the module", () => {
    expect(existsSync(resolveDefaultRegistryPath())).toBe(true);
  });

  it("loads the registry when cwd is NOT the repo root", () => {
    // The old default resolved "src/agents/providers/provider-sources.json"
    // against process.cwd(), so an installed user running from their own
    // project got an empty registry and silently lost provider enrichment.
    process.chdir(tmpdir());
    const reg = loadProviderSourceRegistry();
    expect(Object.keys(reg.providers).length).toBeGreaterThan(0);
  });

  it("treats the legacy repo-relative default as 'use the shipped file'", () => {
    process.chdir(tmpdir());
    const reg = loadProviderSourceRegistry(DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH);
    expect(Object.keys(reg.providers).length).toBeGreaterThan(0);
  });

  it("still honors an explicit path relative to cwd", () => {
    const reg = loadProviderSourceRegistry("does/not/exist.json");
    expect(reg.providers).toEqual({});
  });
});

describe("provider-source-registry", () => {
  it("extracts MiniMax model ids and feature lines from official source text", () => {
    const signals = extractProviderOfficialSignals(
      "minimax",
      {
        url: "https://platform.minimaxi.com/docs/api-reference/api-overview",
        label: "MiniMax API overview",
        kind: "html",
      },
      `
        <h1>MiniMax API</h1>
        <p>文本生成接口使用 MiniMax-M2.7，MiniMax-M2.7-highspeed。</p>
        <p>模型可以生成对话内容、工具调用，并支持流式输出。</p>
      `,
    );

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model",
          value: "MiniMax-M2.7",
        }),
        expect.objectContaining({
          kind: "model",
          value: "MiniMax-M2.7-highspeed",
        }),
      ]),
    );
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "feature",
          tags: expect.arrayContaining(["tool-calling", "streaming"]),
        }),
      ]),
    );
  });
});
