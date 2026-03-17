import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_PATH = join(ROOT, "scripts", "release", "mock-kimi-hook.mjs");
const PAOR_RECOVERY_PROMPT =
  "Run the PAOR recovery smoke: let the initial approach fail, then replan and create Assets/paor-proof.txt with exact content 'paor ok'.";
const PROVIDER_FALLBACK_PROMPT = "Run the provider fallback smoke and say exactly: provider fallback ok.";

function findPattern(output, pattern, fromIndex) {
  const slice = output.slice(fromIndex);
  if (typeof pattern === "string") {
    const index = slice.indexOf(pattern);
    return index >= 0 ? fromIndex + index : -1;
  }
  const match = slice.match(pattern);
  if (!match || match.index === undefined) {
    return -1;
  }
  return fromIndex + match.index;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CliSession {
  constructor(args, env) {
    this.output = "";
    this.child = spawn(
      process.execPath,
      ["--import", HOOK_PATH, "--import", "tsx", "src/index.ts", ...args],
      {
        cwd: ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const append = (chunk) => {
      this.output += chunk.toString("utf8");
    };

    this.child.stdout.on("data", append);
    this.child.stderr.on("data", append);
  }

  async waitFor(pattern, { timeoutMs = 20_000, fromIndex = 0 } = {}) {
    const existing = findPattern(this.output, pattern, fromIndex);
    if (existing >= 0) {
      return this.output.slice(fromIndex, existing + 1);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${String(pattern)}.\n\nOutput:\n${this.output.slice(fromIndex)}`));
      }, timeoutMs);

      const onData = () => {
        const matchIndex = findPattern(this.output, pattern, fromIndex);
        if (matchIndex >= 0) {
          cleanup();
          resolve(this.output.slice(fromIndex, matchIndex + 1));
        }
      };

      const onExit = (code, signal) => {
        cleanup();
        reject(
          new Error(
            `Process exited before pattern ${String(pattern)} appeared (code=${String(code)}, signal=${String(signal)}).\n\nOutput:\n${this.output.slice(fromIndex)}`,
          ),
        );
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.child.stdout.off("data", onData);
        this.child.stderr.off("data", onData);
        this.child.off("exit", onExit);
      };

      this.child.stdout.on("data", onData);
      this.child.stderr.on("data", onData);
      this.child.on("exit", onExit);
    });
  }

  sendLine(line) {
    this.child.stdin.write(`${line}\n`);
  }

  async waitForExit(timeoutMs = 15_000) {
    if (this.child.exitCode !== null) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Process did not exit within ${timeoutMs}ms.\n\nOutput:\n${this.output}`));
      }, timeoutMs);

      const onExit = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.child.off("exit", onExit);
      };

      this.child.on("exit", onExit);
    });
  }

  async close() {
    if (this.child.exitCode !== null) {
      return;
    }
    this.sendLine("quit");
    try {
      await this.waitForExit(15_000);
    } catch (error) {
      this.child.kill("SIGINT");
      await this.waitForExit(10_000).catch(() => {
        throw error;
      });
    }
  }
}

async function ensureFile(path) {
  await access(path, fsConstants.F_OK);
}

async function createSmokeProject(projectDir) {
  await mkdir(join(projectDir, "Assets"), { recursive: true });
  await mkdir(join(projectDir, "Packages", "com.strada.core"), { recursive: true });
  await mkdir(join(projectDir, "ProjectSettings"), { recursive: true });
  await writeFile(
    join(projectDir, "Packages", "manifest.json"),
    JSON.stringify({
      dependencies: {
        "com.strada.core": "file:com.strada.core",
      },
    }, null, 2),
  );
  await writeFile(
    join(projectDir, "Packages", "com.strada.core", "package.json"),
    JSON.stringify({
      name: "com.strada.core",
      version: "0.0.0-smoke",
    }, null, 2),
  );
  await writeFile(
    join(projectDir, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.0.67f1\n",
  );
}

function buildBaseEnv(memoryDir, projectDir) {
  return {
    ...process.env,
    UNITY_PROJECT_PATH: projectDir,
    MEMORY_DB_PATH: memoryDir,
    STRADA_MOCK_LOG_PATH: join(memoryDir, "mock-provider.log"),
    PROVIDER_CHAIN: "kimi",
    KIMI_API_KEY: "smoke-kimi-key",
    STREAMING_ENABLED: "false",
    RAG_ENABLED: "false",
    DASHBOARD_ENABLED: "false",
    ENABLE_WEBSOCKET_DASHBOARD: "false",
    ENABLE_PROMETHEUS: "false",
    LOG_LEVEL: "error",
  };
}

async function runInteractiveMemorySmoke(memoryDir, projectDir) {
  console.log("1. Interactive memory smoke");
  const session = new CliSession(["cli"], {
    ...buildBaseEnv(memoryDir, projectDir),
    READ_ONLY_MODE: "true",
    REQUIRE_EDIT_CONFIRMATION: "true",
  });

  try {
    await session.waitFor(/you> /);

    let cursor = session.output.length;
    session.sendLine("My name is CodexTester");
    await session.waitFor("Nice to meet you, CodexTester.", { fromIndex: cursor, timeoutMs: 20_000 });
    await session.waitFor(/you> /, { fromIndex: cursor, timeoutMs: 20_000 });
  } finally {
    await session.close();
  }

  const recallSession = new CliSession(["cli"], {
    ...buildBaseEnv(memoryDir, projectDir),
    READ_ONLY_MODE: "true",
    REQUIRE_EDIT_CONFIRMATION: "true",
  });

  try {
    await recallSession.waitFor(/you> /);

    const cursor = recallSession.output.length;
    recallSession.sendLine("What is my name?");
    await recallSession.waitFor("Your name is CodexTester.", { fromIndex: cursor, timeoutMs: 20_000 });
    await recallSession.waitFor(/you> /, { fromIndex: cursor, timeoutMs: 20_000 });
  } finally {
    await recallSession.close();
  }

  const memoryDbPath = join(memoryDir, "agentdb", "memory.db");
  await ensureFile(memoryDbPath);
  const db = new Database(memoryDbPath, { readonly: true });
  const row = db.prepare("SELECT display_name FROM user_profiles WHERE chat_id = ?").get("cli-local");
  db.close();
  assert.equal(row?.display_name, "CodexTester", "interactive CLI should persist the captured display name");
}

async function runProviderFallbackSmoke(memoryDir, projectDir) {
  console.log("2. Routed provider fallback smoke");
  const session = new CliSession(["cli"], {
    ...buildBaseEnv(memoryDir, projectDir),
    PROVIDER_CHAIN: "qwen,kimi",
    QWEN_API_KEY: "smoke-qwen-key",
    READ_ONLY_MODE: "true",
    REQUIRE_EDIT_CONFIRMATION: "true",
  });

  try {
    await session.waitFor(/you> /);

    const cursor = session.output.length;
    session.sendLine(PROVIDER_FALLBACK_PROMPT);
    await session.waitFor("provider fallback ok", {
      fromIndex: cursor,
      timeoutMs: 30_000,
    });

    const output = session.output.slice(cursor).toLowerCase();
    assert(
      !output.includes("could not connect to the ai provider"),
      "preferred provider fallback smoke should recover instead of surfacing a network failure",
    );
  } finally {
    await session.close();
  }

  const logPath = join(memoryDir, "mock-provider.log");
  const entries = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const failedKimiAttempt = entries.some((entry) =>
    entry.type === "chat-failure" &&
    typeof entry.url === "string" &&
    entry.url.includes("api.kimi.com") &&
    entry.lastUserText === PROVIDER_FALLBACK_PROMPT,
  );
  const successfulQwenFallback = entries.some((entry) =>
    entry.type === "chat" &&
    typeof entry.url === "string" &&
    entry.url.includes("dashscope-intl.aliyuncs.com") &&
    entry.lastUserText === PROVIDER_FALLBACK_PROMPT &&
    entry.response?.choices?.[0]?.message?.content === "provider fallback ok",
  );

  assert(failedKimiAttempt, "provider fallback smoke should force the routed provider to fail");
  assert(successfulQwenFallback, "provider fallback smoke should fall back to Qwen after the routed provider failure");
}

async function runDaemonSmoke(memoryDir, projectDir) {
  console.log("3. Daemon autonomy, delegation, multi-agent and metrics smoke");
  const session = new CliSession(["start", "--channel", "cli", "--daemon"], {
    ...buildBaseEnv(memoryDir, projectDir),
    READ_ONLY_MODE: "false",
    REQUIRE_EDIT_CONFIRMATION: "true",
    STRADA_DAEMON_DAILY_BUDGET: "1",
    TASK_DELEGATION_ENABLED: "true",
    DELEGATION_TIER_CHEAP: "kimi:kimi-for-coding",
    DELEGATION_TIER_STANDARD: "kimi:kimi-for-coding",
    DELEGATION_TIER_PREMIUM: "kimi:kimi-for-coding",
  });

  try {
    await session.waitFor(/you> /, { timeoutMs: 20_000 });

    let cursor = session.output.length;
    session.sendLine("/autonomous on 1");
    await session.waitFor("Autonomous mode enabled for 1 hours.", { fromIndex: cursor, timeoutMs: 20_000 });

    cursor = session.output.length;
    session.sendLine("Use file_write to create Assets/autonomy-proof.txt with exact content 'autonomy ok'. Do not ask for confirmation.");
    await session.waitFor("Autonomy write completed.", { fromIndex: cursor, timeoutMs: 30_000 });
    const autonomyOutput = session.output.slice(cursor);
    assert(!autonomyOutput.includes("Choice:"), "autonomous background write should not request interactive confirmation");

    cursor = session.output.length;
    session.sendLine("Delegate a brief release-risk analysis to a sub-agent and return the delegated conclusion.");
    await session.waitFor("Delegation complete. Sub-agent analysis: release risk looks low for this smoke scenario.", {
      fromIndex: cursor,
      timeoutMs: 30_000,
    });

    cursor = session.output.length;
    session.sendLine(PAOR_RECOVERY_PROMPT);
    await session.waitFor("PAOR recovery completed after replanning.", {
      fromIndex: cursor,
      timeoutMs: 40_000,
    });
  } finally {
    await session.close();
  }

  const autonomyFile = join(projectDir, "Assets", "autonomy-proof.txt");
  await ensureFile(autonomyFile);
  assert.equal(
    await readFile(autonomyFile, "utf8"),
    "autonomy ok\n",
    "autonomy smoke should create the requested file without confirmation",
  );

  const paorFile = join(projectDir, "Assets", "paor-proof.txt");
  await ensureFile(paorFile);
  assert.equal(
    await readFile(paorFile, "utf8"),
    "paor ok\n",
    "PAOR smoke should recover from the failed first approach and write the proof file",
  );

  const daemonDb = new Database(join(memoryDir, "daemon.db"), { readonly: true });
  const agentRow = daemonDb.prepare(
    "SELECT id, key, status, memory_entry_count FROM agents WHERE key = ?",
  ).get("cli:cli-local");
  const delegationStats = daemonDb.prepare(
    "SELECT COUNT(*) AS count FROM delegation_log WHERE status = 'completed'",
  ).get();
  daemonDb.close();

  assert(agentRow?.id, "daemon mode should register the CLI agent");
  assert.equal(agentRow.status, "active", "CLI agent should remain active after smoke run");
  assert(agentRow.memory_entry_count >= 0, "agent registry row should include memory_entry_count");
  assert(delegationStats.count >= 1, "delegation smoke should write at least one completed delegation_log row");

  const agentMemoryDb = join(memoryDir, "agents", agentRow.id, "memory.db");
  await ensureFile(agentMemoryDb);

  const learningDb = new Database(join(memoryDir, "learning.db"), { readonly: true });
  const metricsRows = learningDb.prepare(`
    SELECT task_type, completion_status, paor_iterations, tool_call_count
    FROM task_metrics
    WHERE session_id = ?
    ORDER BY completed_at DESC
  `).all("cli-local");
  const paorMetric = learningDb.prepare(`
    SELECT completion_status, paor_iterations, tool_call_count
    FROM task_metrics
    WHERE session_id = ?
      AND task_type = 'background'
      AND task_description = ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get("cli-local", PAOR_RECOVERY_PROMPT);
  learningDb.close();

  const backgroundRows = metricsRows.filter((row) => row.task_type === "background");
  assert(backgroundRows.length >= 3, "daemon smoke should record background task metrics");
  assert(
    backgroundRows.every((row) => row.completion_status === "success"),
    "daemon smoke background tasks should complete successfully",
  );
  assert(
    backgroundRows.some((row) => row.tool_call_count >= 1),
    "daemon smoke should record tool-calling background work",
  );
  assert(
    backgroundRows.some((row) => row.paor_iterations >= 1),
    "daemon smoke should record PAOR iterations for at least one background task",
  );
  assert(paorMetric, "PAOR recovery smoke should record a dedicated background metric row");
  assert.equal(paorMetric.completion_status, "success", "PAOR recovery smoke should finish successfully");
  assert(
    paorMetric.paor_iterations >= 2,
    "PAOR recovery smoke should record multiple PAOR iterations after replanning",
  );
  assert(
    paorMetric.tool_call_count >= 2,
    "PAOR recovery smoke should record both the failed initial tool call and the recovery tool call",
  );
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "strada-release-smoke-"));
  const projectDir = join(tempRoot, "unity-project");
  const memoryDir = join(tempRoot, "memory");

  await mkdir(projectDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await createSmokeProject(projectDir);

  try {
    await runInteractiveMemorySmoke(memoryDir, projectDir);
    await wait(200);
    await runProviderFallbackSmoke(memoryDir, projectDir);
    await wait(200);
    await runDaemonSmoke(memoryDir, projectDir);
    console.log("4. Release smoke passed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
