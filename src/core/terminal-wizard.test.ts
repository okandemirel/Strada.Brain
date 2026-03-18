import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWebSetupUpgradeShellScript,
  findAvailableSetupWizardPort,
  generateEnvContent,
  getPostSetupWebLaunchCommand,
  getRemainingResponseProviderChoices,
  getSuggestedNodeUpgradeCommand,
  nodeSupportsWebPortalBuild,
  validateUnityPath,
  resolveNvmDir,
} from "./terminal-wizard.js";

describe("generateEnvContent", () => {
  it("uses EMBEDDING_PROVIDER for Gemini and aligns dashboard port defaults", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      apiKey: "AIza-test-key",
      provider: "gemini",
      embeddingProvider: "gemini",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("EMBEDDING_PROVIDER=gemini");
    expect(content).not.toContain("RAG_EMBEDDING_PROVIDER=gemini");
    expect(content).toContain("DASHBOARD_PORT=3100");
  });

  it("supports a dedicated embedding provider key independent from the response chain", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      apiKey: "sk-proj-openai-key",
      provider: "openai",
      embeddingProvider: "gemini",
      embeddingApiKey: "AIza-gemini-key",
      channel: "web",
      language: "en",
    });

    expect(content).toContain('OPENAI_API_KEY="sk-proj-openai-key"');
    expect(content).toContain("PROVIDER_CHAIN=openai");
    expect(content).toContain('GEMINI_API_KEY="AIza-gemini-key"');
    expect(content).toContain("EMBEDDING_PROVIDER=gemini");
  });

  it("supports OpenAI ChatGPT/Codex subscription mode without writing an OpenAI API key", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      provider: "openai",
      openaiAuthMode: "chatgpt-subscription",
      embeddingProvider: "openai",
      embeddingApiKey: "sk-proj-openai-embed-key",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("OPENAI_AUTH_MODE=chatgpt-subscription");
    expect(content).toContain("PROVIDER_CHAIN=openai");
    expect(content).toContain('OPENAI_API_KEY="sk-proj-openai-embed-key"');
  });

  it("supports other response providers without falling back to Claude/Gemini-only logic", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      provider: "deepseek",
      apiKey: "sk-deepseek-key",
      embeddingProvider: "auto",
      channel: "cli",
      language: "en",
    });

    expect(content).toContain('DEEPSEEK_API_KEY="sk-deepseek-key"');
    expect(content).toContain("PROVIDER_CHAIN=deepseek");
  });

  it("supports Ollama as a keyless local provider", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      provider: "ollama",
      embeddingProvider: "ollama",
      channel: "cli",
      language: "en",
    });

    expect(content).toContain("PROVIDER_CHAIN=ollama");
    expect(content).toContain("EMBEDDING_PROVIDER=ollama");
    expect(content).not.toContain("OLLAMA_API_KEY");
  });

  it("supports a multi-provider response chain with independent embedding credentials", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      provider: "openai",
      providerChain: ["openai", "gemini", "qwen"],
      providerCredentials: {
        gemini: "AIza-gemini-response-key",
        qwen: "sk-qwen-key",
      },
      providerAuthModes: {
        openai: "chatgpt-subscription",
      },
      embeddingProvider: "openai",
      embeddingApiKey: "sk-proj-openai-embed-key",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("PROVIDER_CHAIN=openai,gemini,qwen");
    expect(content).toContain("OPENAI_AUTH_MODE=chatgpt-subscription");
    expect(content).toContain('GEMINI_API_KEY="AIza-gemini-response-key"');
    expect(content).toContain('QWEN_API_KEY="sk-qwen-key"');
    expect(content).toContain('OPENAI_API_KEY="sk-proj-openai-embed-key"');
  });
});

describe("findAvailableSetupWizardPort", () => {
  it("returns the preferred port when it is free", async () => {
    await expect(
      findAvailableSetupWizardPort(4100, 1, async () => true),
    ).resolves.toBe(4100);
  });

  it("falls forward when the preferred port is already in use", async () => {
    const busyPorts = new Set([4100, 4101]);
    const resolvedPort = await findAvailableSetupWizardPort(
      4100,
      5,
      async (port) => !busyPorts.has(port),
    );
    expect(resolvedPort).toBe(4102);
  });

  it("falls back to a secondary port list when the preferred range is exhausted", async () => {
    const resolvedPort = await findAvailableSetupWizardPort(
      4100,
      2,
      async (port) => port === 5050,
    );
    expect(resolvedPort).toBe(5050);
  });
});

describe("getRemainingResponseProviderChoices", () => {
  it("returns only providers that are not already in the response chain", () => {
    expect(getRemainingResponseProviderChoices(["claude", "gemini"])).not.toContain("claude");
    expect(getRemainingResponseProviderChoices(["claude", "gemini"])).not.toContain("gemini");
    expect(getRemainingResponseProviderChoices(["claude", "gemini"])).toContain("openai");
    expect(getRemainingResponseProviderChoices(["claude", "gemini"])).toContain("kimi");
  });
});

describe("nodeSupportsWebPortalBuild", () => {
  it("rejects Node versions below the web portal minimum", () => {
    expect(nodeSupportsWebPortalBuild("20.17.0")).toBe(false);
    expect(nodeSupportsWebPortalBuild("22.11.0")).toBe(false);
  });

  it("accepts supported Node LTS versions for the web portal", () => {
    expect(nodeSupportsWebPortalBuild("20.19.0")).toBe(true);
    expect(nodeSupportsWebPortalBuild("22.12.0")).toBe(true);
    expect(nodeSupportsWebPortalBuild("23.0.0")).toBe(true);
  });
});

describe("resolveNvmDir", () => {
  it("detects nvm from the explicit environment override", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-nvm-home-"));
    const nvmDir = path.join(tempHome, "custom-nvm");
    mkdirSync(nvmDir, { recursive: true });
    writeFileSync(path.join(nvmDir, "nvm.sh"), "#!/bin/sh\n");

    try {
      expect(resolveNvmDir({ NVM_DIR: nvmDir }, tempHome)).toBe(nvmDir);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.nvm when available", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-nvm-home-"));
    const nvmDir = path.join(tempHome, ".nvm");
    mkdirSync(nvmDir, { recursive: true });
    writeFileSync(path.join(nvmDir, "nvm.sh"), "#!/bin/sh\n");

    try {
      expect(resolveNvmDir({}, tempHome)).toBe(nvmDir);
      expect(getSuggestedNodeUpgradeCommand({}, tempHome)).toBe(
        "nvm install 22 && nvm use --delete-prefix 22 --silent",
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("prefers reusing an installed Node 22 version when nvm already has one", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-nvm-home-"));
    const nvmDir = path.join(tempHome, ".nvm");
    mkdirSync(path.join(nvmDir, "versions", "node", "v22.22.1"), { recursive: true });
    writeFileSync(path.join(nvmDir, "nvm.sh"), "#!/bin/sh\n");

    try {
      expect(getSuggestedNodeUpgradeCommand({}, tempHome)).toBe(
        "nvm use --delete-prefix 22 --silent",
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("buildWebSetupUpgradeShellScript", () => {
  it("relaunches Strada web setup through the launcher after upgrading node", () => {
    const originalInstallRoot = process.env["STRADA_INSTALL_ROOT"];
    const originalSourceCheckout = process.env["STRADA_SOURCE_CHECKOUT"];
    const originalLauncherPath = process.env["STRADA_LAUNCHER_PATH"];
    process.env["STRADA_INSTALL_ROOT"] = "/Users/test/Strada.Brain";
    process.env["STRADA_SOURCE_CHECKOUT"] = "true";
    process.env["STRADA_LAUNCHER_PATH"] = "/Users/test/Strada.Brain/strada";

    try {
      const script = buildWebSetupUpgradeShellScript(
        "/Users/test/.nvm",
        "/Users/test/Strada.Brain",
        ["/Users/test/Strada.Brain/strada", "setup", "--web"],
      );

      expect(script).toContain("ORIGINAL_HOME=\"$HOME\"");
      expect(script).toContain("STRADA_TMP_HOME=$(mktemp -d");
      expect(script).toContain("export HOME=\"$STRADA_TMP_HOME\"");
      expect(script).toContain("grep -Evi '^\\s*(prefix|globalconfig)\\s*=' \"$ORIGINAL_HOME/.npmrc\" > \"$HOME/.npmrc\" || true");
      expect(script).toContain("unset NPM_CONFIG_PREFIX npm_config_prefix NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig NPM_CONFIG_USERCONFIG npm_config_userconfig");
      expect(script).toContain("export STRADA_INSTALL_ROOT='/Users/test/Strada.Brain'");
      expect(script).toContain("export STRADA_SOURCE_CHECKOUT='true'");
      expect(script).toContain("export STRADA_LAUNCHER_PATH='/Users/test/Strada.Brain/strada'");
      expect(script).toContain("nvm use --delete-prefix 'v");
      expect(script).toContain("if nvm ls 22 >/dev/null 2>&1; then");
      expect(script).toContain("nvm install 22");
      expect(script).toContain("nvm use --delete-prefix 22 --silent >/dev/null");
      expect(script).toContain("STRADA_NODE_PATH=\"$(nvm which 22)\"");
      expect(script).toContain("export PATH=\"$(dirname \"$STRADA_NODE_PATH\"):$PATH\"");
      expect(script).toContain("export HOME=\"$ORIGINAL_HOME\"");
      expect(script).toContain("cd '/Users/test/Strada.Brain'");
      expect(script).toContain("exec '/Users/test/Strada.Brain/strada' 'setup' '--web'");
    } finally {
      if (originalInstallRoot === undefined) delete process.env["STRADA_INSTALL_ROOT"];
      else process.env["STRADA_INSTALL_ROOT"] = originalInstallRoot;
      if (originalSourceCheckout === undefined) delete process.env["STRADA_SOURCE_CHECKOUT"];
      else process.env["STRADA_SOURCE_CHECKOUT"] = originalSourceCheckout;
      if (originalLauncherPath === undefined) delete process.env["STRADA_LAUNCHER_PATH"];
      else process.env["STRADA_LAUNCHER_PATH"] = originalLauncherPath;
    }
  });
});

describe("getPostSetupWebLaunchCommand", () => {
  it("prefers relaunching through the source launcher when available", () => {
    expect(getPostSetupWebLaunchCommand({
      STRADA_INSTALL_ROOT: "/Users/test/Strada.Brain",
      STRADA_LAUNCHER_PATH: "/Users/test/Strada.Brain/strada",
    })).toEqual({
      command: "/Users/test/Strada.Brain/strada",
      args: ["start", "--channel", "web"],
      cwd: "/Users/test/Strada.Brain",
    })
  })

  it("falls back to node execution when no launcher path exists", () => {
    const command = getPostSetupWebLaunchCommand({}, "/Users/test/Strada.Brain")
    expect(command.command).toBe("node")
    expect(command.args.at(-3)).toBe("start")
    expect(command.args.at(-2)).toBe("--channel")
    expect(command.args.at(-1)).toBe("web")
    expect(command.cwd).toBe("/Users/test/Strada.Brain")
  })
})

describe("validateUnityPath", () => {
  it("accepts temp paths when HOME resolves through a symlinked tmp directory", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-home-"));
    const projectDir = path.join(tempHome, "Projects", "MyGame");
    mkdirSync(projectDir, { recursive: true });

    try {
      expect(validateUnityPath(projectDir, tempHome)).toEqual({ valid: true });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
