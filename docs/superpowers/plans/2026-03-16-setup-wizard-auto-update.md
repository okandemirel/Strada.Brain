# Setup Wizard & Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `strada` CLI command with terminal setup wizard and automatic self-updating system for all installation types.

**Architecture:** Terminal wizard uses Node.js built-in `readline` for zero-dependency interactive setup. Auto-updater detects installation method (npm-global/npm-local/git), checks npm registry or git remote daily, and applies updates during idle periods. A `ChannelActivityRegistry` tracks per-channel activity for idle detection and notification delivery.

**Tech Stack:** Node.js readline, child_process spawn (via execFileNoThrow pattern), Commander.js, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-setup-wizard-auto-update-design.md`

**Security Note:** All external process spawning MUST use `spawn` with array arguments or the project's `execFileNoThrow` utility (`src/utils/execFileNoThrow.ts`). Never use `exec()` with string concatenation.

---

## Chunk 1: Foundation — CLI Entry & Config Schema

### Task 1: Add bin field and rename Commander program

**Files:**
- Modify: `package.json:1-8`
- Modify: `src/index.ts:35-40`

- [ ] **Step 1: Add bin field to package.json**

In `package.json`, add after `"main": "dist/index.js"`:
```json
"bin": {
  "strada": "./dist/index.js",
  "strada-brain": "./dist/index.js"
}
```

- [ ] **Step 2: Verify shebang exists in src/index.ts**

Verify `#!/usr/bin/env node` is already the first line of `src/index.ts` (it should already exist). If missing, add it.

- [ ] **Step 3: Rename Commander program**

In `src/index.ts` line 38, change `.name("strada-brain")` to `.name("strada")`.

- [ ] **Step 4: Verify build works**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json src/index.ts
git commit -m "feat: add strada CLI bin field and rename commander program"
```

---

### Task 2: Add AUTO_UPDATE config schema

**Files:**
- Modify: `src/config/config.ts:32-150` (EnvVarName), `:409-533` (Config interface), `:583-790` (configSchema)
- Test: `src/tests/unit/auto-update-config.test.ts`

- [ ] **Step 1: Write failing test for config parsing**

Create `src/tests/unit/auto-update-config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfigCache } from "../../config/config.js";

describe("Auto-Update Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  it("should parse AUTO_UPDATE_ENABLED as boolean", () => {
    process.env["AUTO_UPDATE_ENABLED"] = "false";
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.enabled).toBe(false);
  });

  it("should default AUTO_UPDATE_ENABLED to true", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.enabled).toBe(true);
  });

  it("should parse AUTO_UPDATE_INTERVAL_HOURS as number", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_INTERVAL_HOURS"] = "12";
    const config = loadConfig();
    expect(config.autoUpdate.intervalHours).toBe(12);
  });

  it("should default AUTO_UPDATE_INTERVAL_HOURS to 24", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.intervalHours).toBe(24);
  });

  it("should parse AUTO_UPDATE_IDLE_TIMEOUT_MIN as number", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_IDLE_TIMEOUT_MIN"] = "10";
    const config = loadConfig();
    expect(config.autoUpdate.idleTimeoutMin).toBe(10);
  });

  it("should default AUTO_UPDATE_IDLE_TIMEOUT_MIN to 5", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.idleTimeoutMin).toBe(5);
  });

  it("should parse AUTO_UPDATE_CHANNEL as enum", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_CHANNEL"] = "latest";
    const config = loadConfig();
    expect(config.autoUpdate.channel).toBe("latest");
  });

  it("should default AUTO_UPDATE_CHANNEL to stable", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.channel).toBe("stable");
  });

  it("should reject invalid AUTO_UPDATE_CHANNEL", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_CHANNEL"] = "nightly";
    expect(() => loadConfig()).toThrow();
  });

  it("should parse AUTO_UPDATE_NOTIFY as boolean", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_NOTIFY"] = "false";
    const config = loadConfig();
    expect(config.autoUpdate.notify).toBe(false);
  });

  it("should parse AUTO_UPDATE_AUTO_RESTART as boolean", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_AUTO_RESTART"] = "false";
    const config = loadConfig();
    expect(config.autoUpdate.autoRestart).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/auto-update-config.test.ts`
Expected: FAIL — `autoUpdate` property does not exist on Config.

- [ ] **Step 3: Add env var names to EnvVarName union**

In `src/config/config.ts`, find the `EnvVarName` union type (around lines 32-150) and add:
```typescript
| "AUTO_UPDATE_ENABLED"
| "AUTO_UPDATE_INTERVAL_HOURS"
| "AUTO_UPDATE_IDLE_TIMEOUT_MIN"
| "AUTO_UPDATE_CHANNEL"
| "AUTO_UPDATE_NOTIFY"
| "AUTO_UPDATE_AUTO_RESTART"
```

- [ ] **Step 4: Add autoUpdate to Config interface**

In `src/config/config.ts`, add to the `Config` interface (around line 530):
```typescript
autoUpdate: {
  enabled: boolean;
  intervalHours: number;
  idleTimeoutMin: number;
  channel: "stable" | "latest";
  notify: boolean;
  autoRestart: boolean;
};
```

- [ ] **Step 5: Add Zod schema entries**

In `src/config/config.ts`, add to the `configSchema` (around line 790, before closing `}`):
```typescript
AUTO_UPDATE_ENABLED: boolFromString().default("true"),
AUTO_UPDATE_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
AUTO_UPDATE_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(5),
AUTO_UPDATE_CHANNEL: z.enum(["stable", "latest"]).default("stable"),
AUTO_UPDATE_NOTIFY: boolFromString().default("true"),
AUTO_UPDATE_AUTO_RESTART: boolFromString().default("true"),
```

- [ ] **Step 6: Map raw config to Config type**

In the `validateConfig` function (around line 980-1050), add mapping:
```typescript
autoUpdate: {
  enabled: raw.AUTO_UPDATE_ENABLED,
  intervalHours: raw.AUTO_UPDATE_INTERVAL_HOURS,
  idleTimeoutMin: raw.AUTO_UPDATE_IDLE_TIMEOUT_MIN,
  channel: raw.AUTO_UPDATE_CHANNEL,
  notify: raw.AUTO_UPDATE_NOTIFY,
  autoRestart: raw.AUTO_UPDATE_AUTO_RESTART,
},
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/tests/unit/auto-update-config.test.ts`
Expected: ALL PASS.

- [ ] **Step 8: Run existing tests for regression check**

Run: `npx vitest run src/tests/unit/ --reporter=verbose 2>&1 | tail -20`
Expected: No new failures.

- [ ] **Step 9: Commit**

```bash
git add src/config/config.ts src/tests/unit/auto-update-config.test.ts
git commit -m "feat: add AUTO_UPDATE config schema with Zod validation"
```

---

## Chunk 2: Terminal Setup Wizard

### Task 3: Create terminal wizard core

**Files:**
- Create: `src/core/terminal-wizard.ts`
- Test: `src/tests/unit/terminal-wizard.test.ts`

- [ ] **Step 1: Write failing tests for terminal wizard**

Create `src/tests/unit/terminal-wizard.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable, Writable } from "node:stream";

describe("TerminalWizard", () => {
  let outputData: string;

  beforeEach(() => {
    outputData = "";
  });

  describe("validateUnityPath", () => {
    it("should reject empty path", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("should reject relative path", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath("relative/path");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("absolute");
    });

    it("should reject path outside home directory", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath("/etc/passwd");
      expect(result.valid).toBe(false);
    });

    it("should accept valid absolute path inside home directory", async () => {
      const os = await import("node:os");
      const homedir = os.homedir();
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath(homedir);
      expect(result.valid).toBe(true);
    });
  });

  describe("sanitizeEnvValue", () => {
    it("should strip newlines and carriage returns", async () => {
      const { sanitizeEnvValue } = await import("../../core/terminal-wizard.js");
      expect(sanitizeEnvValue("hello\nworld\r")).toBe("helloworld");
    });

    it("should trim whitespace", async () => {
      const { sanitizeEnvValue } = await import("../../core/terminal-wizard.js");
      expect(sanitizeEnvValue("  value  ")).toBe("value");
    });
  });

  describe("generateEnvContent", () => {
    it("should generate valid .env content with required fields", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "sk-test-123",
        provider: "claude",
        channel: "web",
        language: "en",
      });
      expect(content).toContain("UNITY_PROJECT_PATH=/Users/test/MyGame");
      expect(content).toContain("ANTHROPIC_API_KEY=sk-test-123");
      expect(content).toContain("DEFAULT_CHANNEL=web");
      expect(content).toContain("LANGUAGE_PREFERENCE=en");
      expect(content).toContain("STREAMING_ENABLED=true");
    });

    it("should detect OpenAI key format", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "sk-proj-abc123",
        provider: "openai",
        channel: "web",
        language: "en",
      });
      expect(content).toContain("OPENAI_API_KEY=sk-proj-abc123");
    });

    it("should detect Gemini key format", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "AIza-test",
        provider: "gemini",
        channel: "web",
        language: "en",
      });
      expect(content).toContain("GEMINI_API_KEY=AIza-test");
    });
  });

  describe("detectProvider", () => {
    it("should detect Claude from sk-ant- prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("sk-ant-api03-test")).toBe("claude");
    });

    it("should detect OpenAI from sk-proj- prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("sk-proj-abc")).toBe("openai");
    });

    it("should detect Gemini from AIza prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("AIzaSy-test")).toBe("gemini");
    });

    it("should default to claude for unknown format", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("unknown-key")).toBe("claude");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/terminal-wizard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement terminal wizard**

Create `src/core/terminal-wizard.ts`:
```typescript
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const MAX_RETRIES = 3;

export interface WizardAnswers {
  unityProjectPath: string;
  apiKey: string;
  provider: string;
  channel: string;
  language: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateUnityPath(inputPath: string): ValidationResult {
  if (!inputPath || inputPath.trim() === "") {
    return { valid: false, error: "Path cannot be empty." };
  }

  const trimmed = inputPath.trim();

  if (!path.isAbsolute(trimmed)) {
    return { valid: false, error: "Path must be absolute (e.g. /Users/you/MyGame)." };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(trimmed);
  } catch {
    return { valid: false, error: `Path does not exist: ${trimmed}` };
  }

  const homedir = os.homedir();
  if (!resolved.startsWith(homedir)) {
    return { valid: false, error: `Path must be inside your home directory (${homedir}).` };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return { valid: false, error: "Path must be a directory." };
  }

  return { valid: true };
}

export function sanitizeEnvValue(value: string): string {
  return String(value).replace(/[\r\n]/g, "").trim();
}

export function detectProvider(apiKey: string): string {
  if (apiKey.startsWith("sk-ant-")) return "claude";
  if (apiKey.startsWith("sk-proj-") || apiKey.startsWith("sk-")) return "openai";
  if (apiKey.startsWith("AIza")) return "gemini";
  return "claude";
}

export function generateEnvContent(answers: WizardAnswers): string {
  const lines: string[] = [
    "# Strada Brain Configuration",
    `# Generated by strada setup on ${new Date().toISOString()}`,
    "",
  ];

  lines.push(`UNITY_PROJECT_PATH=${sanitizeEnvValue(answers.unityProjectPath)}`);
  lines.push("");

  const provider = answers.provider;
  if (provider === "claude") {
    lines.push(`ANTHROPIC_API_KEY=${sanitizeEnvValue(answers.apiKey)}`);
    lines.push("PROVIDER_CHAIN=claude");
  } else if (provider === "openai") {
    lines.push(`OPENAI_API_KEY=${sanitizeEnvValue(answers.apiKey)}`);
    lines.push("PROVIDER_CHAIN=openai");
  } else if (provider === "gemini") {
    lines.push(`GEMINI_API_KEY=${sanitizeEnvValue(answers.apiKey)}`);
    lines.push("PROVIDER_CHAIN=gemini");
    lines.push("RAG_EMBEDDING_PROVIDER=gemini");
  }
  lines.push("");

  lines.push(`DEFAULT_CHANNEL=${sanitizeEnvValue(answers.channel)}`);
  lines.push(`LANGUAGE_PREFERENCE=${sanitizeEnvValue(answers.language)}`);
  lines.push("");

  lines.push("STREAMING_ENABLED=true");
  lines.push("REQUIRE_EDIT_CONFIRMATION=true");
  lines.push("DASHBOARD_ENABLED=true");
  lines.push("MULTI_AGENT_ENABLED=true");
  lines.push("LOG_LEVEL=info");
  lines.push("WEB_CHANNEL_PORT=3000");
  lines.push("DASHBOARD_PORT=3001");
  lines.push("");

  return lines.join("\n") + "\n";
}

async function askWithRetry(
  rl: readline.Interface,
  question: string,
  validate: (input: string) => ValidationResult,
  retries = MAX_RETRIES,
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const answer = await rl.question(question);
    const result = validate(answer);
    if (result.valid) return answer.trim();
    console.error(`  ✗ ${result.error}`);
    if (i < retries - 1) console.log("  Please try again.");
  }
  throw new Error("Maximum retries exceeded.");
}

function openBrowser(url: string): void {
  const platform = process.platform;

  let proc;
  if (platform === "darwin") {
    proc = spawn("open", [url], { stdio: "ignore", detached: true });
  } else if (platform === "win32") {
    proc = spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true });
  } else {
    proc = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  }

  proc.on("error", () => {
    console.log(`\n  Could not open browser automatically.`);
    console.log(`  Please open: ${url}\n`);
  });
  proc.unref();
}

export async function runTerminalWizard(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on("close", () => {
    console.log("\n\nSetup cancelled.");
    process.exit(0);
  });

  try {
    console.log("\n🦉 Strada Brain Setup");
    console.log("━".repeat(30));
    console.log("");

    console.log("? Setup method:");
    console.log("  1) Terminal (quick setup)");
    console.log("  2) Web Browser (full setup)");
    const method = await rl.question("  Choose [1/2] (default: 1): ");

    if (method.trim() === "2") {
      rl.close();
      const port = process.env["SETUP_WIZARD_PORT"]
        ? parseInt(process.env["SETUP_WIZARD_PORT"], 10)
        : 3000;
      const { SetupWizard } = await import("./setup-wizard.js");
      const wizard = new SetupWizard(port);
      const url = `http://localhost:${port}/setup`;
      console.log(`\n🌐 Opening setup at ${url}...`);
      console.log(`   (Open this URL in your browser if it didn't open automatically)\n`);
      openBrowser(url);
      await wizard.start();
      return;
    }

    console.log("");

    const unityPath = await askWithRetry(
      rl,
      "? Unity project path: ",
      validateUnityPath,
    );

    const apiKey = await askWithRetry(
      rl,
      "? AI Provider API key (Claude/OpenAI/Gemini): ",
      (input) => {
        if (!input || input.trim().length < 8) {
          return { valid: false, error: "API key seems too short." };
        }
        return { valid: true };
      },
    );

    const provider = detectProvider(apiKey.trim());

    const channelAnswer = await rl.question("? Default channel (web): ");
    const channel = channelAnswer.trim() || "web";

    const langAnswer = await rl.question("? Language (en): ");
    const language = langAnswer.trim() || "en";

    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const overwrite = await rl.question("\n⚠ .env already exists. Overwrite? [y/N]: ");
      if (overwrite.trim().toLowerCase() !== "y") {
        console.log("\nSetup cancelled. Existing .env preserved.");
        rl.close();
        return;
      }
    }

    const envContent = generateEnvContent({
      unityProjectPath: unityPath,
      apiKey: apiKey.trim(),
      provider,
      channel,
      language,
    });

    fs.writeFileSync(envPath, envContent, "utf-8");

    console.log(`\n✅ .env created! Run \`strada start\` to begin.\n`);
    rl.close();
  } catch (err) {
    rl.close();
    if ((err as Error).message === "Maximum retries exceeded.") {
      console.error("\nToo many invalid attempts. Please try again.");
      process.exit(1);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/unit/terminal-wizard.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/terminal-wizard.ts src/tests/unit/terminal-wizard.test.ts
git commit -m "feat: add terminal setup wizard with readline-based interactive flow"
```

---

### Task 4: Wire setup command into CLI

**Files:**
- Modify: `src/index.ts:42-135` (command definitions), `:144-196` (startApp)

- [ ] **Step 1: Add setup command to index.ts**

After the existing command definitions (around line 135):
```typescript
program
  .command("setup")
  .description("Interactive setup wizard for first-time configuration")
  .action(async () => {
    const { runTerminalWizard } = await import("./core/terminal-wizard.js");
    await runTerminalWizard();
  });
```

- [ ] **Step 2: Update start command error message**

In `startApp()` where config validation fails (around line 151), add setup hint:
```typescript
console.warn(`Config invalid: ${configResult.error}. Run 'strada setup' to configure.`);
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire strada setup command into CLI entry point"
```

---

## Chunk 3: Channel Activity Registry

### Task 5: Create ChannelActivityRegistry

**Files:**
- Create: `src/core/channel-activity-registry.ts`
- Test: `src/tests/unit/channel-activity-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tests/unit/channel-activity-registry.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("ChannelActivityRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should record activity and return last activity time", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    const now = Date.now();
    vi.setSystemTime(now);
    registry.recordActivity("web", "chat-1");
    expect(registry.getLastActivityTime()).toBe(now);
  });

  it("should return 0 when no activity recorded", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    expect(registry.getLastActivityTime()).toBe(0);
  });

  it("should track multiple channels independently", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(2000);
    registry.recordActivity("telegram", "tg-123");
    expect(registry.getLastActivityTime()).toBe(2000);
    expect(registry.getActiveChatIds()).toEqual([
      { channelName: "web", chatId: "chat-1", lastActivity: 1000 },
      { channelName: "telegram", chatId: "tg-123", lastActivity: 2000 },
    ]);
  });

  it("should update existing chat activity time", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(5000);
    registry.recordActivity("web", "chat-1");
    const chats = registry.getActiveChatIds();
    expect(chats).toHaveLength(1);
    expect(chats[0].lastActivity).toBe(5000);
  });

  it("should detect idle state based on timeout", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(1000 + 4 * 60 * 1000);
    expect(registry.isIdle(5)).toBe(false);
    vi.setSystemTime(1000 + 6 * 60 * 1000);
    expect(registry.isIdle(5)).toBe(true);
  });

  it("should be idle when no activity ever recorded", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    expect(registry.isIdle(5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/channel-activity-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChannelActivityRegistry**

Create `src/core/channel-activity-registry.ts`:
```typescript
export interface ChatActivity {
  channelName: string;
  chatId: string;
  lastActivity: number;
}

export class ChannelActivityRegistry {
  private readonly activities = new Map<string, ChatActivity>();

  recordActivity(channelName: string, chatId: string): void {
    const key = `${channelName}:${chatId}`;
    this.activities.set(key, {
      channelName,
      chatId,
      lastActivity: Date.now(),
    });
  }

  getLastActivityTime(): number {
    let latest = 0;
    for (const activity of this.activities.values()) {
      if (activity.lastActivity > latest) {
        latest = activity.lastActivity;
      }
    }
    return latest;
  }

  getActiveChatIds(): ChatActivity[] {
    return Array.from(this.activities.values());
  }

  isIdle(timeoutMinutes: number): boolean {
    const lastActivity = this.getLastActivityTime();
    if (lastActivity === 0) return true;
    const elapsed = Date.now() - lastActivity;
    return elapsed > timeoutMinutes * 60 * 1000;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/unit/channel-activity-registry.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/channel-activity-registry.ts src/tests/unit/channel-activity-registry.test.ts
git commit -m "feat: add ChannelActivityRegistry for idle detection and notification"
```

---

### Task 6: Add hasRunningTasks to BackgroundExecutor

**Files:**
- Modify: `src/tasks/background-executor.ts:110-112`
- Test: `src/tests/unit/background-executor-idle.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/unit/background-executor-idle.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("BackgroundExecutor.hasRunningTasks", () => {
  it("should return false when no tasks running or queued", async () => {
    const { BackgroundExecutor } = await import(
      "../../tasks/background-executor.js"
    );
    const executor = new BackgroundExecutor({
      orchestrator: { run: async () => ({}) } as any,
      concurrencyLimit: 2,
    });
    expect(executor.hasRunningTasks()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/background-executor-idle.test.ts`
Expected: FAIL — `hasRunningTasks` is not a function.

- [ ] **Step 3: Add hasRunningTasks method**

In `src/tasks/background-executor.ts`, after the `setTaskManager` method (around line 112):
```typescript
hasRunningTasks(): boolean {
  return this.running > 0 || this.queue.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/unit/background-executor-idle.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/background-executor.ts src/tests/unit/background-executor-idle.test.ts
git commit -m "feat: add hasRunningTasks() to BackgroundExecutor for idle detection"
```

---

## Chunk 4: Auto-Updater Core

### Task 7: Create AutoUpdater — install detection, version check, lockfile, update

**Files:**
- Create: `src/core/auto-updater.ts`
- Test: `src/tests/unit/auto-updater.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tests/unit/auto-updater.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("AutoUpdater", () => {
  const originalCwd = process.cwd;
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.cwd = originalCwd;
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-test-"));
    tmpDirs.push(dir);
    process.cwd = () => dir;
    return dir;
  }

  describe("detectInstallMethod", () => {
    it("should detect git when .git directory exists", async () => {
      const dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.detectInstallMethod()).toBe("git");
    });

    it("should detect npm-local when no .git and node_modules exists", async () => {
      const dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, "node_modules"));
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.detectInstallMethod()).toBe("npm-local");
    });

    it("should detect npm-global when no .git and no node_modules", async () => {
      makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.detectInstallMethod()).toBe("npm-global");
    });
  });

  describe("parseVersionFromOutput", () => {
    it("should parse semver from npm view output", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.parseVersionFromOutput("1.2.3\n")).toBe("1.2.3");
      expect(AutoUpdater.parseVersionFromOutput("  0.2.0 \n")).toBe("0.2.0");
    });

    it("should return null for invalid output", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.parseVersionFromOutput("npm ERR!")).toBeNull();
      expect(AutoUpdater.parseVersionFromOutput("")).toBeNull();
    });
  });

  describe("isNewerVersion", () => {
    it("should correctly compare semver versions", async () => {
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.2.0")).toBe(true);
      expect(AutoUpdater.isNewerVersion("0.2.0", "0.1.0")).toBe(false);
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.1.0")).toBe(false);
      expect(AutoUpdater.isNewerVersion("1.0.0", "2.0.0")).toBe(true);
      expect(AutoUpdater.isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    });
  });

  describe("lockfile", () => {
    it("should acquire and release lock", async () => {
      const dir = makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());

      expect(updater.acquireLock()).toBe(true);
      const lockPath = path.join(dir, ".strada-update.lock");
      expect(fs.existsSync(lockPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(content.pid).toBe(process.pid);
      expect(content.timestamp).toBeDefined();

      updater.releaseLock();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("should not acquire lock when held by live process", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      // Current PID is alive
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.acquireLock()).toBe(false);
    });

    it("should detect stale lock from dead process", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() }));

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    });

    it("should detect stale lock older than 30 minutes", async () => {
      const dir = makeTmpDir();
      const lockPath = path.join(dir, ".strada-update.lock");
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        timestamp: Date.now() - 31 * 60 * 1000,
      }));

      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    });
  });

  describe("shutdown", () => {
    it("should shutdown cleanly without errors", async () => {
      makeTmpDir();
      const { AutoUpdater } = await import("../../core/auto-updater.js");
      const updater = new AutoUpdater(mockConfig(), mockRegistry(), mockExecutor());
      expect(() => updater.shutdown()).not.toThrow();
    });
  });
});

function mockConfig() {
  return {
    autoUpdate: {
      enabled: true, intervalHours: 24, idleTimeoutMin: 5,
      channel: "stable" as const, notify: true, autoRestart: true,
    },
  };
}

function mockRegistry() {
  return {
    isIdle: () => true,
    getActiveChatIds: () => [],
    getLastActivityTime: () => 0,
    recordActivity: () => {},
  };
}

function mockExecutor() {
  return { hasRunningTasks: () => false };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/auto-updater.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AutoUpdater class**

Create `src/core/auto-updater.ts`:
```typescript
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";

const VERSION_CHECK_TIMEOUT = 30_000;
const UPDATE_TIMEOUT = 5 * 60 * 1000;
const STALE_LOCK_MAX_AGE = 30 * 60 * 1000;

export type InstallMethod = "npm-global" | "npm-local" | "git";

export interface AutoUpdateConfig {
  enabled: boolean;
  intervalHours: number;
  idleTimeoutMin: number;
  channel: "stable" | "latest";
  notify: boolean;
  autoRestart: boolean;
}

interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
}

interface BackgroundExecutorLike {
  hasRunningTasks(): boolean;
}

interface LockContent {
  pid: number;
  timestamp: number;
}

export class AutoUpdater {
  private readonly config: AutoUpdateConfig;
  private readonly registry: ChannelActivityRegistry;
  private readonly executor: BackgroundExecutorLike;
  private installMethod: InstallMethod | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pendingVersion: string | null = null;
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private notifyFn: ((msg: string) => void) | null = null;

  constructor(
    config: { autoUpdate: AutoUpdateConfig },
    registry: ChannelActivityRegistry,
    executor: BackgroundExecutorLike,
  ) {
    this.config = config.autoUpdate;
    this.registry = registry;
    this.executor = executor;
  }

  setNotifyFn(fn: (msg: string) => void): void {
    this.notifyFn = fn;
  }

  detectInstallMethod(): InstallMethod {
    if (this.installMethod) return this.installMethod;

    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, ".git"))) {
      this.installMethod = "git";
    } else if (fs.existsSync(path.join(cwd, "node_modules"))) {
      this.installMethod = "npm-local";
    } else {
      this.installMethod = "npm-global";
    }

    return this.installMethod;
  }

  static parseVersionFromOutput(output: string): string | null {
    const trimmed = output.trim();
    if (/^\d+\.\d+\.\d+/.test(trimmed)) {
      return trimmed.split(/\s/)[0];
    }
    return null;
  }

  static isNewerVersion(current: string, remote: string): boolean {
    const [cMajor, cMinor, cPatch] = current.split(".").map(Number);
    const [rMajor, rMinor, rPatch] = remote.split(".").map(Number);
    if (rMajor !== cMajor) return rMajor > cMajor;
    if (rMinor !== cMinor) return rMinor > cMinor;
    return rPatch > cPatch;
  }

  getCurrentVersion(): string {
    try {
      const pkgPath = path.join(process.cwd(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return pkg.version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  private spawnWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdoutData = "";
      let stderrData = "";

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
      }, timeoutMs);

      proc.stdout.on("data", (data: Buffer) => { stdoutData += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderrData += data.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdoutData);
        else reject(new Error(`${cmd} exited with code ${code}: ${stderrData}`));
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async checkForUpdate(): Promise<UpdateCheckResult> {
    const currentVersion = this.getCurrentVersion();
    const method = this.detectInstallMethod();

    try {
      if (method === "git") {
        await this.spawnWithTimeout("git", ["fetch", "origin", "main"], VERSION_CHECK_TIMEOUT);
        const localRev = (await this.spawnWithTimeout("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT)).trim();
        const remoteRev = (await this.spawnWithTimeout("git", ["rev-parse", "origin/main"], VERSION_CHECK_TIMEOUT)).trim();
        return { available: localRev !== remoteRev, currentVersion, latestVersion: remoteRev.substring(0, 8) };
      } else {
        const distTag = this.config.channel === "latest" ? "latest" : "stable";
        const output = await this.spawnWithTimeout("npm", ["view", `strada-brain@${distTag}`, "version"], VERSION_CHECK_TIMEOUT);
        const remoteVersion = AutoUpdater.parseVersionFromOutput(output);
        if (!remoteVersion) return { available: false, currentVersion, latestVersion: null };
        return { available: AutoUpdater.isNewerVersion(currentVersion, remoteVersion), currentVersion, latestVersion: remoteVersion };
      }
    } catch {
      return { available: false, currentVersion, latestVersion: null };
    }
  }

  async performUpdate(): Promise<boolean> {
    if (!this.acquireLock()) return false;

    try {
      const method = this.detectInstallMethod();

      if (method === "git") {
        const prePullSha = (await this.spawnWithTimeout("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT)).trim();
        try {
          await this.spawnWithTimeout("git", ["pull", "origin", "main"], UPDATE_TIMEOUT);
          await this.spawnWithTimeout("npm", ["run", "build"], UPDATE_TIMEOUT);
        } catch (buildErr) {
          try { await this.spawnWithTimeout("git", ["reset", "--hard", prePullSha], VERSION_CHECK_TIMEOUT); } catch {}
          throw buildErr;
        }
      } else if (method === "npm-global") {
        const tag = this.config.channel;
        await this.spawnWithTimeout("npm", ["install", "-g", `strada-brain@${tag}`], UPDATE_TIMEOUT);
      } else {
        const tag = this.config.channel;
        await this.spawnWithTimeout("npm", ["install", `strada-brain@${tag}`], UPDATE_TIMEOUT);
      }

      return true;
    } finally {
      this.releaseLock();
    }
  }

  private getLockPath(): string {
    return path.join(process.cwd(), ".strada-update.lock");
  }

  acquireLock(): boolean {
    const lockPath = this.getLockPath();

    if (fs.existsSync(lockPath)) {
      try {
        const content: LockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));

        if (Date.now() - content.timestamp > STALE_LOCK_MAX_AGE) {
          fs.unlinkSync(lockPath);
        } else {
          try {
            process.kill(content.pid, 0);
            return false;
          } catch {
            fs.unlinkSync(lockPath);
          }
        }
      } catch {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8");
    return true;
  }

  releaseLock(): void {
    try {
      const lockPath = this.getLockPath();
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {}
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;
    this.detectInstallMethod();
    this.runUpdateCheck().catch(() => {});
  }

  scheduleChecks(): void {
    if (!this.config.enabled) return;
    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
    this.intervalHandle = setInterval(() => { this.runUpdateCheck().catch(() => {}); }, intervalMs);
    if (this.intervalHandle.unref) this.intervalHandle.unref();
  }

  private async runUpdateCheck(): Promise<void> {
    const result = await this.checkForUpdate();
    if (!result.available || !result.latestVersion) return;

    this.pendingVersion = result.latestVersion;

    if (this.config.notify && this.notifyFn) {
      this.notifyFn(`🔄 Strada Brain ${result.latestVersion} available. Will update when idle.`);
    }

    this.startIdleMonitoring();
  }

  private startIdleMonitoring(): void {
    if (this.idleCheckHandle) return;

    this.idleCheckHandle = setInterval(async () => {
      const isIdle = this.registry.isIdle(this.config.idleTimeoutMin) && !this.executor.hasRunningTasks();
      if (!isIdle) return;

      if (this.idleCheckHandle) {
        clearInterval(this.idleCheckHandle);
        this.idleCheckHandle = null;
      }

      try {
        const success = await this.performUpdate();
        if (success && this.config.notify && this.notifyFn) {
          if (this.config.autoRestart) {
            this.notifyFn(`✅ Updated to ${this.pendingVersion}. Restarting...`);
            setTimeout(() => process.exit(0), 2000);
          } else {
            this.notifyFn(`✅ Updated to ${this.pendingVersion}. Please restart with \`strada start\`.`);
          }
        }
      } catch (err) {
        if (this.notifyFn) {
          this.notifyFn(`❌ Update failed: ${(err as Error).message}. Will retry next check.`);
        }
      }

      this.pendingVersion = null;
    }, 30_000);

    if (this.idleCheckHandle.unref) this.idleCheckHandle.unref();
  }

  shutdown(): void {
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null; }
    if (this.idleCheckHandle) { clearInterval(this.idleCheckHandle); this.idleCheckHandle = null; }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/unit/auto-updater.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/auto-updater.ts src/tests/unit/auto-updater.test.ts
git commit -m "feat: add AutoUpdater with install detection, version check, and lockfile"
```

---

## Chunk 5: Bootstrap Integration & CLI Commands

### Task 8: Wire AutoUpdater into bootstrap and add CLI commands

**Files:**
- Modify: `src/core/bootstrap.ts:126-135` (BootstrapResult), `:219-228` (init), `:2189-2294` (shutdown)
- Modify: `src/index.ts` (update/version commands)

- [ ] **Step 1: Add imports to bootstrap.ts**

At the top of `src/core/bootstrap.ts`:
```typescript
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { AutoUpdater } from "./auto-updater.js";
```

- [ ] **Step 2: Add to BootstrapResult interface**

In `BootstrapResult` interface (around line 133):
```typescript
activityRegistry?: ChannelActivityRegistry;
autoUpdater?: AutoUpdater;
```

- [ ] **Step 3: Initialize registry and updater after channel creation**

After channel initialization (around line 228):
```typescript
const activityRegistry = new ChannelActivityRegistry();

let autoUpdater: AutoUpdater | undefined;
if (config.autoUpdate.enabled) {
  autoUpdater = new AutoUpdater(config, activityRegistry, backgroundExecutor);
  autoUpdater.setNotifyFn((msg: string) => {
    const chats = activityRegistry.getActiveChatIds();
    for (const { chatId } of chats) {
      channel.sendMarkdown(chatId, msg).catch(() => {});
    }
  });
  await autoUpdater.init();
  autoUpdater.scheduleChecks();
}
```

- [ ] **Step 4: Wire activityRegistry into message handler**

Find the `channel.onMessage(...)` callback setup. Inside it, add:
```typescript
activityRegistry.recordActivity(channelType, msg.chatId);
```

- [ ] **Step 5: Add shutdown for AutoUpdater**

In `createShutdownHandler()` (around line 2189), add before existing steps:
```typescript
if (autoUpdater) autoUpdater.shutdown();
```

- [ ] **Step 6: Include in BootstrapResult return**

Add to the return object:
```typescript
activityRegistry,
autoUpdater,
```

- [ ] **Step 7: Add update and version commands to CLI**

In `src/index.ts`, after the `setup` command:
```typescript
program
  .command("update")
  .description("Check for and apply updates")
  .option("--check", "Only check for updates, do not apply")
  .action(async (opts) => {
    const { AutoUpdater } = await import("./core/auto-updater.js");
    const { ChannelActivityRegistry } = await import("./core/channel-activity-registry.js");
    const { loadConfigSafe } = await import("./config/config.js");

    // Load user config, fall back to defaults if config is invalid
    const configResult = loadConfigSafe();
    const autoUpdateConfig = configResult.kind === "ok"
      ? { autoUpdate: configResult.value.autoUpdate }
      : { autoUpdate: { enabled: true, intervalHours: 24, idleTimeoutMin: 5, channel: "stable" as const, notify: false, autoRestart: false } };

    const updater = new AutoUpdater(autoUpdateConfig, new ChannelActivityRegistry(), { hasRunningTasks: () => false });
    const result = await updater.checkForUpdate();

    if (!result.available) {
      console.log(`✅ Strada Brain is up to date (v${result.currentVersion}).`);
      return;
    }

    console.log(`🔄 Update available: v${result.currentVersion} → v${result.latestVersion}`);
    if (opts.check) return;

    console.log("Updating...");
    try {
      await updater.performUpdate();
      console.log("✅ Updated successfully! Please restart with `strada start`.");
    } catch (err) {
      console.error(`❌ Update failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("version")
  .description("Show version and update status")
  .action(async () => {
    const { AutoUpdater } = await import("./core/auto-updater.js");
    const { ChannelActivityRegistry } = await import("./core/channel-activity-registry.js");
    const { loadConfigSafe } = await import("./config/config.js");

    const configResult = loadConfigSafe();
    const autoUpdateConfig = configResult.kind === "ok"
      ? { autoUpdate: configResult.value.autoUpdate }
      : { autoUpdate: { enabled: true, intervalHours: 24, idleTimeoutMin: 5, channel: "stable" as const, notify: false, autoRestart: false } };

    const updater = new AutoUpdater(autoUpdateConfig, new ChannelActivityRegistry(), { hasRunningTasks: () => false });
    const currentVersion = updater.getCurrentVersion();
    const method = updater.detectInstallMethod();

    console.log(`Strada Brain v${currentVersion}`);
    console.log(`Install method: ${method}`);
    console.log(`Update channel: ${autoUpdateConfig.autoUpdate.channel}`);

    try {
      const result = await updater.checkForUpdate();
      if (result.available) console.log(`Update available: v${result.latestVersion}`);
      else console.log("Up to date.");
    } catch {
      console.log("Could not check for updates.");
    }
  });
```

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/core/bootstrap.ts src/index.ts
git commit -m "feat: integrate AutoUpdater into bootstrap and add update/version CLI commands"
```

---

## Chunk 6: Integration Tests

### Task 9: Integration tests for terminal wizard and auto-updater

**Files:**
- Create: `src/tests/integration/setup-wizard-cli.test.ts`
- Create: `src/tests/integration/auto-updater-flow.test.ts`

- [ ] **Step 1: Write terminal wizard integration tests**

Create `src/tests/integration/setup-wizard-cli.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  validateUnityPath,
  sanitizeEnvValue,
  generateEnvContent,
  detectProvider,
} from "../../core/terminal-wizard.js";

describe("Terminal Wizard Integration", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  it("should generate valid .env and write it to disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-wizard-"));
    tmpDirs.push(tmpDir);
    const content = generateEnvContent({
      unityProjectPath: os.homedir(),
      apiKey: "sk-ant-test-key",
      provider: "claude",
      channel: "web",
      language: "tr",
    });
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, content, "utf-8");
    const written = fs.readFileSync(envPath, "utf-8");
    expect(written).toContain("UNITY_PROJECT_PATH=");
    expect(written).toContain("ANTHROPIC_API_KEY=sk-ant-test-key");
    expect(written).toContain("LANGUAGE_PREFERENCE=tr");
    expect(written).toContain("STREAMING_ENABLED=true");
  });

  it("should detect all provider types correctly", () => {
    expect(detectProvider("sk-ant-api03-test")).toBe("claude");
    expect(detectProvider("sk-proj-abc123")).toBe("openai");
    expect(detectProvider("AIzaSy-test")).toBe("gemini");
    expect(detectProvider("unknown-key")).toBe("claude");
  });

  it("should sanitize env values for injection prevention", () => {
    expect(sanitizeEnvValue("value\nINJECTED=true")).toBe("valueINJECTED=true");
    expect(sanitizeEnvValue("value\r\nATTACK=1")).toBe("valueATTACK=1");
    expect(sanitizeEnvValue("  padded  ")).toBe("padded");
  });

  it("should validate unity path security constraints", () => {
    expect(validateUnityPath("").valid).toBe(false);
    expect(validateUnityPath("./relative").valid).toBe(false);
    expect(validateUnityPath("/etc/shadow").valid).toBe(false);
    expect(validateUnityPath(os.homedir()).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Write auto-updater integration tests**

Create `src/tests/integration/auto-updater-flow.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AutoUpdater } from "../../core/auto-updater.js";
import { ChannelActivityRegistry } from "../../core/channel-activity-registry.js";

describe("AutoUpdater Integration", () => {
  const tmpDirs: string[] = [];
  const originalCwd = process.cwd;

  afterEach(() => {
    process.cwd = originalCwd;
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-"));
    tmpDirs.push(dir);
    process.cwd = () => dir;
    return dir;
  }

  const mockAutoUpdateConfig = {
    autoUpdate: { enabled: true, intervalHours: 24, idleTimeoutMin: 5, channel: "stable" as const, notify: true, autoRestart: true },
  };

  it("should complete full lockfile lifecycle", () => {
    makeTmpDir();
    const registry = new ChannelActivityRegistry();
    const updater = new AutoUpdater(mockAutoUpdateConfig, registry, { hasRunningTasks: () => false });

    expect(updater.acquireLock()).toBe(true);
    expect(updater.acquireLock()).toBe(false); // same PID, within 30min
    updater.releaseLock();
    expect(updater.acquireLock()).toBe(true);
    updater.releaseLock();
  });

  it("should integrate ChannelActivityRegistry for idle detection", () => {
    const registry = new ChannelActivityRegistry();
    expect(registry.isIdle(5)).toBe(true);
    registry.recordActivity("web", "chat-1");
    expect(registry.isIdle(5)).toBe(false);
    const chats = registry.getActiveChatIds();
    expect(chats).toHaveLength(1);
    expect(chats[0].channelName).toBe("web");
  });

  it("should shutdown cleanly without errors", () => {
    makeTmpDir();
    const registry = new ChannelActivityRegistry();
    const updater = new AutoUpdater(mockAutoUpdateConfig, registry, { hasRunningTasks: () => false });
    expect(() => updater.shutdown()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run all new tests**

Run: `npx vitest run src/tests/integration/setup-wizard-cli.test.ts src/tests/integration/auto-updater-flow.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Run full test suite for regression check**

Run: `npx vitest run 2>&1 | tail -30`
Expected: No new failures.

- [ ] **Step 5: Commit**

```bash
git add src/tests/integration/setup-wizard-cli.test.ts src/tests/integration/auto-updater-flow.test.ts
git commit -m "test: add integration tests for terminal wizard and auto-updater"
```

---

## Chunk 7: Final Verification & Mandatory Reviews

### Task 10: Build verification and mandatory reviews

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds with zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new).

- [ ] **Step 3: Run /simplify**

Review all new/modified files for code quality, DRY, unnecessary complexity.

- [ ] **Step 4: Run /security-review**

Review all new/modified files for security vulnerabilities (path traversal, injection, etc.).

- [ ] **Step 5: Run /code-review:code-review**

Full code review of all changes since the spec commit.

- [ ] **Step 6: Fix any issues found by reviews**

Apply fixes, re-run tests, commit fixes.

- [ ] **Step 7: Final commit and push**

Push all changes to remote.
