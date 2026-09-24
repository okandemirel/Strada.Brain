import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as dotenvParse } from "dotenv";
import { describe, expect, it, vi } from "vitest";
import {
  buildWebSetupUpgradeShellScript,
  findAvailableSetupWizardPort,
  generateEnvContent,
  getRemainingResponseProviderChoices,
  launchWebSetupWizard,
  resolveNodeUpgradeStrategy,
  getSuggestedNodeUpgradeCommand,
  nodeSupportsWebPortalBuild,
  resolveNvmDir,
  getChannelCredentialFields,
  validateChannelCredentials,
  hasAutoEmbeddingCandidate,
  resolveRagSetup,
  TERMINAL_WIZARD_DEFAULT_ENV_KEYS,
  TERMINAL_WIZARD_OWNED_ENV_KEYS,
  terminalWizardOwnedEnvKeysFor,
  projectLocalMcpAwaitingTrust,
} from "./terminal-wizard.js";
import { SETUP_DEFAULT_ENV_KEYS } from "./setup-wizard.js";
import { persistSetup } from "./setup-env-persistence.js";

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

    expect(content).toContain("OPENAI_API_KEY='sk-proj-openai-key'");
    expect(content).toContain("PROVIDER_CHAIN=openai");
    expect(content).toContain("GEMINI_API_KEY='AIza-gemini-key'");
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
    expect(content).toContain("OPENAI_API_KEY='sk-proj-openai-embed-key'");
  });

  it("supports Claude subscription mode with a bearer auth token", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      provider: "claude",
      providerChain: ["claude"],
      providerCredentials: {
        claude: "claude-subscription-token-123456",
      },
      providerAuthModes: {
        claude: "claude-subscription",
      },
      embeddingProvider: "auto",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("ANTHROPIC_AUTH_MODE=claude-subscription");
    expect(content).toContain("ANTHROPIC_AUTH_TOKEN='claude-subscription-token-123456'");
    expect(content).toContain("PROVIDER_CHAIN=claude");
    expect(content).not.toContain("ANTHROPIC_API_KEY");
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

    expect(content).toContain("DEEPSEEK_API_KEY='sk-deepseek-key'");
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
    expect(content).toContain("GEMINI_API_KEY='AIza-gemini-response-key'");
    expect(content).toContain("QWEN_API_KEY='sk-qwen-key'");
    expect(content).toContain("OPENAI_API_KEY='sk-proj-openai-embed-key'");
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
      expect(getSuggestedNodeUpgradeCommand({}, tempHome, "darwin")).toBe(
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
      expect(getSuggestedNodeUpgradeCommand({}, tempHome, "darwin")).toBe(
        "nvm use --delete-prefix 22 --silent",
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("prefers nvm-windows before winget on Windows", () => {
    expect(resolveNodeUpgradeStrategy({}, "C:\\Users\\tester", "win32", (command) => command === "nvm")).toEqual({
      kind: "windows-nvm",
      suggestedCommand: "nvm install 22.12.0; nvm use 22.12.0",
    });
    expect(resolveNodeUpgradeStrategy({}, "C:\\Users\\tester", "win32", (command) => command === "winget")).toEqual({
      kind: "winget",
      suggestedCommand: "winget install OpenJS.NodeJS.LTS",
    });
  });
});

/**
 * Codex round 13 #36. `initializeRuntimeEnvironment` chdirs to the CONFIG root,
 * so on a packaged install — and, since STRADA_SOURCE_CHECKOUT became
 * three-state, inside a checkout whose operator chose the app-home layout —
 * `process.cwd()` is `~/.strada`. The wizard then looked for `web-portal/`
 * there and would have run `npm install --prefix web-portal` in the user's
 * state directory. Code comes from the INSTALL root; only runtime state lives
 * in the config root.
 */
describe("the wizard's portal assets come from the install root, not the cwd", () => {
  it("uses STRADA_INSTALL_ROOT rather than the process working directory", () => {
    const originalInstallRoot = process.env["STRADA_INSTALL_ROOT"];
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "strada-app-home-"));
    try {
      process.env["STRADA_INSTALL_ROOT"] = "/Users/test/Strada.Brain";
      process.chdir(elsewhere);
      // The default argument is the code root, which is not the cwd.
      const script = buildWebSetupUpgradeShellScript("/Users/test/.nvm");
      expect(script).toContain("cd '/Users/test/Strada.Brain'");
      expect(script).not.toContain(`cd '${elsewhere}'`);
    } finally {
      process.chdir(originalCwd);
      if (originalInstallRoot === undefined) delete process.env["STRADA_INSTALL_ROOT"];
      else process.env["STRADA_INSTALL_ROOT"] = originalInstallRoot;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("falls back to the module's own root when nothing is configured (guard)", () => {
    const originalInstallRoot = process.env["STRADA_INSTALL_ROOT"];
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "strada-app-home2-"));
    try {
      delete process.env["STRADA_INSTALL_ROOT"];
      process.chdir(elsewhere);
      const script = buildWebSetupUpgradeShellScript("/Users/test/.nvm");
      // This repository, because that is where this module lives.
      expect(script).toContain(`cd '${originalCwd}'`);
    } finally {
      process.chdir(originalCwd);
      if (originalInstallRoot !== undefined) process.env["STRADA_INSTALL_ROOT"] = originalInstallRoot;
      rmSync(elsewhere, { recursive: true, force: true });
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

describe("launchWebSetupWizard", () => {
  it("waits for setup completion before returning the wizard", async () => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const wizard = {
      listen: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: vi.fn(() => completion),
    } as any;
    const waitForUrlReady = vi.fn().mockResolvedValue(undefined);
    const openBrowserFn = vi.fn();
    const createWizard = vi.fn(async () => wizard);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      let settled = false;
      const launchPromise = launchWebSetupWizard({
        requestedPort: 4100,
        findPort: async () => 4100,
        createWizard,
        waitForUrlReady,
        openBrowserFn,
      }).then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      resolveCompletion();

      await expect(launchPromise).resolves.toBe(wizard);
      expect(wizard.listen).toHaveBeenCalledOnce();
      expect(wizard.waitForCompletion).toHaveBeenCalledOnce();
      expect(waitForUrlReady).toHaveBeenCalledWith(
        expect.stringContaining("http://127.0.0.1:4100/?strada-setup=1&t="),
      );
      expect(openBrowserFn).toHaveBeenCalledWith(
        expect.stringContaining("http://127.0.0.1:4100/?strada-setup=1&t="),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reuses the same handoff flow when setup falls to another port", async () => {
    const wizard = {
      listen: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
    } as any;
    const waitForUrlReady = vi.fn().mockResolvedValue(undefined);
    const openBrowserFn = vi.fn();
    const createWizard = vi.fn(async (port: number) => {
      expect(port).toBe(4102);
      return wizard;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(launchWebSetupWizard({
        requestedPort: 4100,
        findPort: async () => 4102,
        createWizard,
        waitForUrlReady,
        openBrowserFn,
      })).resolves.toBe(wizard);

      expect(waitForUrlReady).toHaveBeenCalledWith(
        expect.stringContaining("http://127.0.0.1:4102/?strada-setup=1&t="),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Port 4100 is already in use. Starting the setup wizard on http://127.0.0.1:4102/"),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});


/**
 * A channel without its token is not a channel; RAG follows what can embed
 * (plan 2.4 / audit 10.2 / D26; plan 2.5 / audit 10.7).
 */
describe("the terminal wizard's setup contract", () => {
  it("names what each channel must carry, and refuses a channel that carries none", () => {
    expect(getChannelCredentialFields("web")).toEqual([]);
    expect(getChannelCredentialFields("cli")).toEqual([]);
    expect(getChannelCredentialFields("telegram").map((f) => f.envKey)).toEqual([
      "TELEGRAM_BOT_TOKEN",
      "ALLOWED_TELEGRAM_USER_IDS",
    ]);
    expect(getChannelCredentialFields("nope")).toEqual([]);

    expect(validateChannelCredentials("web", {})).toEqual({ valid: true });
    const missing = validateChannelCredentials("telegram", {});
    expect(missing.valid).toBe(false);
    expect(missing.error).toContain("TELEGRAM_BOT_TOKEN");
    expect(missing.error).toContain("Nothing was written");
    // A blank token is no token.
    expect(validateChannelCredentials("telegram", { TELEGRAM_BOT_TOKEN: "   ", ALLOWED_TELEGRAM_USER_IDS: "1" }).valid).toBe(false);
    expect(validateChannelCredentials("telegram", { TELEGRAM_BOT_TOKEN: "123:ABC", ALLOWED_TELEGRAM_USER_IDS: "1" })).toEqual({ valid: true });
  });

  it("writes the channel's credentials it was given, and opencode's base URL", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      providerChain: ["opencode"],
      providerCredentials: { opencode: "sk-oc-123456789" },
      embeddingProvider: "ollama",
      channel: "telegram",
      channelCredentials: { TELEGRAM_BOT_TOKEN: "123:ABC", ALLOWED_TELEGRAM_USER_IDS: "42" },
      language: "en",
    });
    expect(content).toContain("DEFAULT_CHANNEL=telegram");
    expect(content).toContain("TELEGRAM_BOT_TOKEN='123:ABC'");
    expect(content).toContain("ALLOWED_TELEGRAM_USER_IDS='42'");
    expect(content).toContain("OPENCODE_BASE_URL=");
  });

  it("writes values dotenv reads back unchanged: Windows paths, quotes, # (COR-1)", () => {
    const content = generateEnvContent({
      unityProjectPath: "C:\\repos\\Game",
      providerChain: ["claude", "gemini"],
      providerCredentials: { claude: 'sk-ant-a"b', gemini: "AIza'x#y" },
      channel: "telegram",
      channelCredentials: { TELEGRAM_BOT_TOKEN: "123:A#B", ALLOWED_TELEGRAM_USER_IDS: "42" },
      language: "en",
    });
    const parsed = dotenvParse(content);
    expect(parsed.UNITY_PROJECT_PATH).toBe("C:\\repos\\Game");
    expect(parsed.ANTHROPIC_API_KEY).toBe('sk-ant-a"b');
    expect(parsed.GEMINI_API_KEY).toBe("AIza'x#y");
    expect(parsed.TELEGRAM_BOT_TOKEN).toBe("123:A#B");
  });

  it("RAG follows the embedding candidate: off with a reason when nothing can embed", () => {
    // Claude alone cannot embed, so RAG would index nothing (audit 10.7).
    const claudeOnly = resolveRagSetup({ providerChain: ["claude"], providerCredentials: { claude: "sk-ant-1" } });
    expect(claudeOnly.ragEnabled).toBe(false);
    expect(claudeOnly.reason).toBeTruthy();
    expect(hasAutoEmbeddingCandidate(["claude"], { claude: "sk-ant-1" })).toBe(false);

    // A chain with an embedding-capable provider enables it.
    expect(hasAutoEmbeddingCandidate(["claude", "gemini"], { gemini: "key" })).toBe(true);
    const withGemini = resolveRagSetup({ providerChain: ["claude", "gemini"], providerCredentials: { gemini: "key" } });
    expect(withGemini.ragEnabled).toBe(true);

    // Ollama embeds locally with no credential at all.
    expect(hasAutoEmbeddingCandidate(["ollama"], {})).toBe(true);
    expect(resolveRagSetup({ providerChain: ["ollama"], providerCredentials: {} }).ragEnabled).toBe(true);

    // An explicit choice without a key is refused rather than half-configured.
    const explicit = resolveRagSetup({ providerChain: ["claude"], providerCredentials: {}, embeddingProvider: "openai" });
    expect(explicit.ragEnabled).toBe(false);
    expect(explicit.embeddingProvider).toBe("auto");
  });

  it("a RAG-less chain says so in the file instead of leaving RAG on", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      providerChain: ["claude"],
      providerCredentials: { claude: "sk-ant-123456789" },
      channel: "web",
      language: "en",
    });
    expect(content).toContain("RAG_ENABLED=false");
    expect(content).toContain("# RAG stays off until an embedding-capable provider is configured");
  });
});

// ---------------------------------------------------------------------------
// Codex round 9 #16, through the CLI: `strada setup` must not delete a budget
// it never asked about.
// ---------------------------------------------------------------------------
describe("the terminal wizard states nothing about the budget", () => {
  it("does not own STRADA_BUDGET_DAILY_USD, so an existing limit survives a re-run", async () => {
    expect(TERMINAL_WIZARD_OWNED_ENV_KEYS.has("STRADA_BUDGET_DAILY_USD")).toBe(false);
    // …while everything the wizard does write is still owned, so a de-selected
    // provider key is still removed.
    expect(TERMINAL_WIZARD_OWNED_ENV_KEYS.has("PROVIDER_CHAIN")).toBe(true);
    expect(TERMINAL_WIZARD_OWNED_ENV_KEYS.has("KIMI_API_KEY")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "strada-cli-budget-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "STRADA_BUDGET_DAILY_USD=0\nKIMI_API_KEY=old\nDEEPSEEK_API_KEY=drop-me\n");
      // What a CLI run emits: a chain and its key, never a budget.
      const result = await persistSetup(envPath, ['PROVIDER_CHAIN="kimi"', 'KIMI_API_KEY="sk-new"'], {
        ownedKeys: TERMINAL_WIZARD_OWNED_ENV_KEYS,
        defaultKeys: SETUP_DEFAULT_ENV_KEYS,
      });
      // The freeze the person set is still there…
      expect(result.effective["STRADA_BUDGET_DAILY_USD"]).toBe("0");
      // …the emitted keys are replaced, and a key the wizard owns but no
      // longer emits is still removed.
      expect(result.effective["KIMI_API_KEY"]).toBe("sk-new");
      expect(result.effective["DEEPSEEK_API_KEY"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the terminal wizard owns only what it asks about (COR-2)", () => {
  const answers = {
    unityProjectPath: "/Users/test/MyGame",
    providerChain: ["kimi"],
    providerCredentials: { kimi: "sk-kimi-new" },
    embeddingProvider: "ollama",
    channel: "web",
    language: "en",
  };

  it("keeps the opt-outs, limits, preset, model picks and port it never asked about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-cli-owned-"));
    try {
      const envPath = join(dir, ".env");
      const existing = [
        "STRADA_DAEMON_ENABLED=false",
        "STRADA_DAEMON_DAILY_BUDGET=2",
        "AUTO_UPDATE_ENABLED=false",
        "AUTONOMOUS_DEFAULT_ENABLED=true",
        "SYSTEM_PRESET=budget",
        "CLAUDE_MODEL=claude-sonnet-5",
        "EMBEDDING_PROVIDER=ollama",
        "EMBEDDING_MODEL=bge-m3",
        "WEB_CHANNEL_PORT=4000",
        "DEEPSEEK_API_KEY=deselected",
        "TELEGRAM_BOT_TOKEN=deselected",
        "",
      ].join("\n");
      writeFileSync(envPath, existing);
      const content = generateEnvContent(answers);
      const result = await persistSetup(envPath, content.split("\n"), {
        ownedKeys: terminalWizardOwnedEnvKeysFor(dotenvParse(existing), dotenvParse(content)),
        defaultKeys: TERMINAL_WIZARD_DEFAULT_ENV_KEYS,
      });
      expect(result.effective).toMatchObject({
        STRADA_DAEMON_ENABLED: "false",
        STRADA_DAEMON_DAILY_BUDGET: "2",
        AUTO_UPDATE_ENABLED: "false",
        AUTONOMOUS_DEFAULT_ENABLED: "true",
        SYSTEM_PRESET: "budget",
        CLAUDE_MODEL: "claude-sonnet-5",
        EMBEDDING_MODEL: "bge-m3",
        WEB_CHANNEL_PORT: "4000",
        KIMI_API_KEY: "sk-kimi-new",
      });
      expect(result.removed.sort()).toEqual(["DEEPSEEK_API_KEY", "TELEGRAM_BOT_TOKEN"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every key it writes is one it owns or writes only when absent (guard)", () => {
    const content = generateEnvContent({ ...answers, channel: "telegram", channelCredentials: { TELEGRAM_BOT_TOKEN: "1:A", ALLOWED_TELEGRAM_USER_IDS: "1" } });
    for (const key of Object.keys(dotenvParse(content))) {
      expect(TERMINAL_WIZARD_OWNED_ENV_KEYS.has(key) || TERMINAL_WIZARD_DEFAULT_ENV_KEYS.has(key), key).toBe(true);
    }
  });

  it("drops an embedding model only when the embedding provider changes", () => {
    const generated = dotenvParse(generateEnvContent({ ...answers, providerChain: ["gemini"], providerCredentials: { gemini: "AIza-1" }, embeddingProvider: "gemini" }));
    expect(terminalWizardOwnedEnvKeysFor({ EMBEDDING_PROVIDER: "ollama" }, generated).has("EMBEDDING_MODEL")).toBe(true);
    expect(terminalWizardOwnedEnvKeysFor({ EMBEDDING_PROVIDER: "gemini" }, generated).has("EMBEDDING_MODEL")).toBe(false);
  });
});

describe("the terminal wizard asks before trusting a project-local Strada.MCP (COR-12)", () => {
  const base = {
    unityProjectPath: "/Users/test/MyGame",
    apiKey: "sk-proj-openai-key",
    provider: "openai",
    embeddingProvider: "openai",
    channel: "web",
    language: "en",
  };

  it("writes the operator's answer, and nothing when the question was not asked", () => {
    expect(generateEnvContent({ ...base, stradaMcpAllowProjectLocal: true })).toContain(
      "STRADA_MCP_ALLOW_PROJECT_LOCAL=true",
    );
    expect(generateEnvContent({ ...base, stradaMcpAllowProjectLocal: false })).toContain(
      "STRADA_MCP_ALLOW_PROJECT_LOCAL=false",
    );
    expect(generateEnvContent(base)).not.toContain("STRADA_MCP_ALLOW_PROJECT_LOCAL");
  });

  it("asks only for an installed copy inside the project that is not already trusted", () => {
    const root = mkdtempSync(join(tmpdir(), "strada-mcp-trust-"));
    try {
      const project = join(root, "Game");
      const inside = join(project, "Packages", "Submodules", "Strada.MCP");
      const outside = join(root, "Strada.MCP");
      mkdirSync(inside, { recursive: true });
      mkdirSync(outside, { recursive: true });

      expect(projectLocalMcpAwaitingTrust({ mcpInstalled: true, mcpPath: inside }, project, {})).toBe(inside);
      expect(projectLocalMcpAwaitingTrust({ mcpInstalled: true, mcpPath: outside }, project, {})).toBeNull();
      expect(projectLocalMcpAwaitingTrust({ mcpInstalled: false, mcpPath: null }, project, {})).toBeNull();
      expect(
        projectLocalMcpAwaitingTrust({ mcpInstalled: true, mcpPath: inside }, project, {
          STRADA_MCP_ALLOW_PROJECT_LOCAL: "true",
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
