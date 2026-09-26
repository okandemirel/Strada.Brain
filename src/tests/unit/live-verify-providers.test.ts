/**
 * Live verify: the OpenCode provider (scripts/ci/live-verify-providers.mjs).
 *
 * The script's real run needs the OpenCode API, which the unit suite never
 * reaches. What is tested here is what decides what a run MEANS and what it
 * PRINTS: the verdict, the exit code and the NOT RUN rule (a missing secret is
 * never a pass), the key redaction (a provider error that echoes the key must
 * not reach the log), the model and endpoint choice, and — against a local
 * stub of the OpenAI-compatible API — the whole script through the compiled
 * provider class.
 *
 * The module is a .mjs script loaded through a non-literal specifier so the type
 * checker does not try to resolve a JavaScript file that has no declarations.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HARDCODED_MODELS } from "../../agents/providers/model-intelligence.js";
import { PROVIDER_PRESETS } from "../../agents/providers/provider-registry.js";

type CheckState = "pass" | "fail" | "not-run";

interface Check {
  id: string;
  title: string;
  state: CheckState;
  detail?: string;
}

interface Run {
  configured: boolean;
  model?: string;
  modelSource?: string;
  baseUrl?: string;
  checks: Check[];
}

interface FakeProvider {
  name: string;
  capabilities: { streaming: boolean };
  chat: (...args: unknown[]) => Promise<unknown>;
  chatStream?: (...args: unknown[]) => Promise<unknown>;
}

interface ProvidersModule {
  LIVE_PROVIDER: { name: string; label: string; keyEnv: string; modelEnv: string; baseUrlEnv: string };
  MAX_TOKENS: number;
  PROVIDER_CHECKS: Array<{ id: string; title: string }>;
  redactText: (text: string, secrets?: string[]) => string;
  installOutputRedaction: (secrets: string[], streams: Array<{ write: (chunk: unknown, ...rest: unknown[]) => unknown }>) => void;
  chooseModel: (
    env: Record<string, string | undefined>,
    catalog: Array<Record<string, unknown>>,
    preset?: { defaultModel: string },
  ) => { model: string; source: string };
  resolveBaseUrl: (env: Record<string, string | undefined>, preset?: { baseUrl: string }) => { baseUrl: string; source: string };
  verifyProvider: (options: {
    createProvider: (config: Record<string, unknown>) => FakeProvider;
    supportsStreaming: (provider: FakeProvider) => boolean;
    apiKey: string;
    model: string;
    baseUrl: string;
    secrets?: string[];
    code?: string;
  }) => Promise<Check[]>;
  notConfiguredRun: () => Run;
  summarizeRun: (run: Run) => { passed: string[]; failed: string[]; verdict: string };
  exitCodeForRun: (run: Run) => number;
  annotationsFor: (run: Run) => string[];
  formatReport: (run: Run, secrets?: string[]) => string;
  formatStepSummary: (run: Run, secrets?: string[]) => string;
}

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "ci", "live-verify-providers.mjs");
const live = (await import(pathToFileURL(scriptPath).href)) as ProvidersModule;

// Not a real key: shaped like one so a pattern redactor alone would not be
// what saves it — the exact value has to be removed.
const KEY = "ocz-live-verify-TEST-4f9a1c2b7d3e8f60";

const configured = (states: CheckState[]): Run => ({
  configured: true,
  model: "glm-5.1",
  modelSource: "test",
  baseUrl: "https://opencode.example/v1",
  checks: live.PROVIDER_CHECKS.map((check, index) => ({ ...check, state: states[index]!, detail: `${check.id} detail` })),
});

describe("live verify providers: verdict, exit code and the NOT RUN rule", () => {
  it("without OPENCODE_API_KEY reports NOT RUN with a warning, exits 0, and never says pass", () => {
    const run = live.notConfiguredRun();
    expect(run.checks.every((check) => check.state === "not-run")).toBe(true);
    expect(live.summarizeRun(run).verdict).toBe("NOT RUN: OPENCODE_API_KEY is not configured");
    expect(live.exitCodeForRun(run)).toBe(0);
    expect(live.annotationsFor(run)).toEqual(["::warning title=Live verify NOT RUN::NOT RUN: OPENCODE_API_KEY is not configured"]);
    for (const text of [live.formatReport(run), live.formatStepSummary(run)]) {
      expect(text).toContain("NOT RUN: OPENCODE_API_KEY is not configured");
      expect(text, "a run with no secret must not read as a pass").not.toMatch(/pass/i);
    }
  });

  it("passes only when all three checks passed", () => {
    const run = configured(["pass", "pass", "pass"]);
    expect(live.summarizeRun(run).verdict).toBe("PASS: 3/3 checks");
    expect(live.exitCodeForRun(run)).toBe(0);
    expect(live.annotationsFor(run)).toEqual([]);
    expect(live.formatStepSummary(run)).toContain("| Tool-call round trip | PASS |");
  });

  it("fails the job when a configured check failed, and names it", () => {
    const run = configured(["pass", "fail", "pass"]);
    expect(live.summarizeRun(run).verdict).toBe("FAILED: stream");
    expect(live.exitCodeForRun(run)).toBe(1);
    expect(live.annotationsFor(run)).toEqual(["::error title=Live verify FAILED::FAILED: stream"]);
    expect(live.formatReport(run)).toContain("Verdict: FAILED: stream");
  });

  it("never exits 0 when a secret was set and a check did not run", () => {
    const run = configured(["pass", "pass", "not-run"]);
    expect(live.exitCodeForRun(run)).toBe(1);
    expect(live.summarizeRun(run).verdict).toBe("NOT RUN: tool");
  });
});

describe("live verify providers: the key never reaches the output", () => {
  const leaky = (message: string): FakeProvider => ({
    name: "OpenCode (Zen/Go)",
    capabilities: { streaming: true },
    chat: () => Promise.reject(new Error(message)),
    chatStream: () => Promise.reject(new Error(message)),
  });

  it("redacts a thrown provider error that contains the key before it is stored or printed", async () => {
    const message = `OpenCode (Zen/Go) API error 401: {"error":"invalid key ${KEY}"} (sent Authorization: Bearer ${KEY}, url https://x.example/v1?key=${encodeURIComponent(KEY)})`;
    const checks = await live.verifyProvider({
      createProvider: () => leaky(message),
      supportsStreaming: () => true,
      apiKey: KEY,
      model: "glm-5.1",
      baseUrl: "https://x.example/v1",
    });
    expect(checks.map((check) => check.state)).toEqual(["fail", "fail", "fail"]);
    const run: Run = { configured: true, model: "glm-5.1", modelSource: "test", baseUrl: "https://x.example/v1", checks };
    const printed = [
      ...checks.map((check) => check.detail ?? ""),
      live.formatReport(run, [KEY]),
      live.formatStepSummary(run, [KEY]),
      ...live.annotationsFor(run),
    ].join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(encodeURIComponent(KEY));
    expect(printed).toContain("[REDACTED]");
    // The error itself is still reported: redaction removes the key, not the reason.
    expect(checks[0]!.detail).toContain("API error 401");
  });

  it("redacts a key that surfaces while the provider is being built", async () => {
    const checks = await live.verifyProvider({
      createProvider: () => { throw new Error(`bad key ${KEY}`); },
      supportsStreaming: () => true,
      apiKey: KEY,
      model: "glm-5.1",
      baseUrl: "https://x.example/v1",
    });
    expect(checks.every((check) => check.state === "fail" && !check.detail!.includes(KEY))).toBe(true);
  });

  it("removes the value raw and URL-encoded, and any authorization header or key parameter", () => {
    const redact = (text: string): string => live.redactText(text, [KEY]);
    expect(redact(`key ${KEY} here`)).toBe("key [REDACTED] here");
    expect(redact(`q=${encodeURIComponent(KEY)}`)).toBe("q=[REDACTED]");
    // Headers are redacted whatever they hold, known secret or not.
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("x-api-key: someothervalue")).toBe("x-api-key: [REDACTED]");
    expect(redact('{"authorization":"tok_123456"}')).toBe('{"authorization":"[REDACTED]"}');
    expect(redact("GET /v1/models?key=AIzaSomething&x=1")).toBe("GET /v1/models?key=[REDACTED]&x=1");
    // Ordinary output is left alone, and a too-short "secret" is not a pattern.
    expect(live.redactText("counted 1 2 3 4 5", ["a"])).toBe("counted 1 2 3 4 5");
  });

  it("filters every write to the process streams, strings and buffers alike", () => {
    const captured: unknown[] = [];
    const stream = { write: (chunk: unknown): boolean => { captured.push(chunk); return true; } };
    live.installOutputRedaction([KEY], [stream]);
    stream.write(`logger line with ${KEY}\n`);
    stream.write(Buffer.from(`buffer with ${KEY}`));
    expect(String(captured[0])).toBe("logger line with [REDACTED]\n");
    expect(Buffer.isBuffer(captured[1])).toBe(true);
    expect(String(captured[1])).toBe("buffer with [REDACTED]");
  });
});

describe("live verify providers: scope, model and endpoint", () => {
  it("covers OpenCode only, with the variable names .env.example documents, and never an Anthropic key", () => {
    expect(live.LIVE_PROVIDER.name).toBe("opencode");
    const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    for (const name of [live.LIVE_PROVIDER.keyEnv, live.LIVE_PROVIDER.modelEnv, live.LIVE_PROVIDER.baseUrlEnv]) {
      expect(envExample, name).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
    }
    // Maintainer decision: the Anthropic key is never used for live tests.
    expect(fs.readFileSync(scriptPath, "utf8")).not.toMatch(/anthropic/i);
  });

  it("runs on the cheapest OpenCode model the project's catalog prices, sent bare", () => {
    const catalog = [...HARDCODED_MODELS.values()] as unknown as Array<Record<string, unknown>>;
    const opencode = [...HARDCODED_MODELS.values()].filter(
      (m) => m.provider === "opencode" && m.supportsToolCalling && m.supportsStreaming && m.inputPricePerMillion !== undefined,
    );
    expect(opencode.length, "the catalog prices no OpenCode model").toBeGreaterThan(0);
    const cheapest = Math.min(...opencode.map((m) => (m.inputPricePerMillion ?? 0) + (m.outputPricePerMillion ?? 0)));
    const chosen = live.chooseModel({}, catalog, PROVIDER_PRESETS["opencode"]);
    const entry = opencode.find((m) => m.id.replace(/^opencode\//, "") === chosen.model);
    expect(entry, `${chosen.model} is not an OpenCode catalog model`).toBeDefined();
    expect((entry!.inputPricePerMillion ?? 0) + (entry!.outputPricePerMillion ?? 0)).toBe(cheapest);
    expect(chosen.model).not.toMatch(/^opencode\//);
  });

  it("honours OPENCODE_DEFAULT_MODEL, and falls back to the preset default without a priced model", () => {
    expect(live.chooseModel({ OPENCODE_DEFAULT_MODEL: " qwen3.5-plus " }, [], undefined).model).toBe("qwen3.5-plus");
    expect(live.chooseModel({}, [], PROVIDER_PRESETS["opencode"])).toEqual({
      model: PROVIDER_PRESETS["opencode"]!.defaultModel,
      source: "the registry preset's default",
    });
  });

  it("targets OpenCode Zen by default and refuses to send the key over plain http to a remote host", () => {
    expect(live.resolveBaseUrl({}, PROVIDER_PRESETS["opencode"]).baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(live.resolveBaseUrl({ OPENCODE_BASE_URL: "https://opencode.ai/zen/go/v1/" }, undefined).baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(live.resolveBaseUrl({ OPENCODE_BASE_URL: "http://127.0.0.1:4010/v1" }, undefined).baseUrl).toBe("http://127.0.0.1:4010/v1");
    expect(() => live.resolveBaseUrl({ OPENCODE_BASE_URL: "http://opencode.example/v1" }, undefined)).toThrow(/https/);
    expect(() => live.resolveBaseUrl({ OPENCODE_BASE_URL: "not a url" }, undefined)).toThrow(/not a URL/);
  });
});

/* ------------------------------------------------------------------------- *
 * The whole script, against a local stub of the OpenAI-compatible API.
 * ------------------------------------------------------------------------- */

interface Seen {
  authorization?: string;
  session?: string;
  model?: string;
  maxTokens?: number;
  stream: boolean;
  tools: number;
  toolResult?: string;
}

interface ChatBody {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  messages?: Array<{ role: string; content?: string | null }>;
}

/** Answers like the real endpoint would for the three checks; `reject` answers 401 and echoes the key. */
function startStub(mode: "ok" | "reject"): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as ChatBody;
      const toolResult = body.messages?.find((m) => m.role === "tool")?.content ?? undefined;
      const authorization = req.headers["authorization"];
      seen.push({
        authorization,
        session: req.headers["x-opencode-session"] as string | undefined,
        model: body.model,
        maxTokens: body.max_tokens,
        stream: body.stream === true,
        tools: body.tools?.length ?? 0,
        toolResult: toolResult ?? undefined,
      });
      if (mode === "reject" || req.url !== "/v1/chat/completions") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Invalid API key: ${String(authorization).replace(/^Bearer /, "")}` } }));
        return;
      }
      const usage = { prompt_tokens: 12, completion_tokens: 3 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["1", " 2", " 3", " 4", " 5"]) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const message = toolResult !== undefined
        ? { role: "assistant", content: `The code is ${toolResult}.` }
        : (body.tools?.length ?? 0) > 0
          ? {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_verification_code", arguments: '{"label":"live-verify"}' } }],
            }
          : { role: "assistant", content: "pong" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stub",
        choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }],
        usage,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the script without blocking this process (the stub answers from here). */
function runScript(env: Record<string, string>): Promise<{ code: number | null; output: string; summary: string }> {
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-live-providers-test-"));
  temps.push(summaryDir);
  const summaryFile = path.join(summaryDir, "summary.md");
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // The caller's own OpenCode settings must not steer the run under test.
    if (value !== undefined && !name.startsWith("OPENCODE")) base[name] = value;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...base, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("close", (code) => {
      resolve({ code, output, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "" });
    });
  });
}

describe("live verify providers: the script end to end, against a local stub", () => {
  const distEntry = path.join(repoRoot, "dist", "agents", "providers", "opencode.js");
  // FAILS rather than skips without dist/, like the backup.sh test: CI builds
  // before it tests, and a skip would hide a reordered workflow.
  const requireDist = (): void => {
    expect(fs.existsSync(distEntry), `${distEntry} is missing: run \`npm run build\` before this test`).toBe(true);
  };

  it("passes all three checks through the compiled OpenCode provider, with the cap and the key it was given", async () => {
    requireDist();
    const stub = await startStub("ok");
    try {
      const result = await runScript({ OPENCODE_API_KEY: KEY, OPENCODE_BASE_URL: stub.url });
      expect(result.output).toContain("Verdict: PASS: 3/3 checks");
      expect(result.code).toBe(0);
      // The report says which model ran and why, not just that something did.
      expect(result.output).toMatch(/model: \S+ \(cheapest OpenCode model in the project's catalog/);
      expect(result.summary).toContain("PASS: 3/3 checks");
      // What reached the endpoint: the key, OpenCode's session header, the
      // chosen model bare, the output cap on every call, a stream, and the
      // per-run tool result echoed back as the answer.
      const expectedModel = live.chooseModel({}, [...HARDCODED_MODELS.values()] as unknown as Array<Record<string, unknown>>, PROVIDER_PRESETS["opencode"]).model;
      expect(stub.seen.length).toBe(4);
      for (const request of stub.seen) {
        expect(request.authorization).toBe(`Bearer ${KEY}`);
        expect(request.session).toBeTruthy();
        expect(request.model).toBe(expectedModel);
        expect(request.maxTokens).toBe(live.MAX_TOKENS);
      }
      expect(stub.seen.filter((request) => request.stream).length).toBe(1);
      expect(stub.seen.filter((request) => request.tools > 0).length).toBe(2);
      expect(stub.seen.find((request) => request.toolResult !== undefined)?.toolResult).toMatch(/^\d{6}$/);
      expect(result.output + result.summary).not.toContain(KEY);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("fails with exit 1 when the endpoint rejects the key, and never prints the key it echoed", async () => {
    requireDist();
    const stub = await startStub("reject");
    try {
      const result = await runScript({ OPENCODE_API_KEY: KEY, OPENCODE_BASE_URL: stub.url });
      expect(result.code).toBe(1);
      expect(result.output).toContain("Verdict: FAILED: completion, stream, tool");
      expect(result.output).toContain("::error title=Live verify FAILED::");
      expect(result.output).toContain("401");
      expect(result.output + result.summary).not.toContain(KEY);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("without the secret sends nothing, warns NOT RUN and exits 0", async () => {
    requireDist();
    const stub = await startStub("ok");
    try {
      const result = await runScript({ OPENCODE_BASE_URL: stub.url });
      expect(result.code).toBe(0);
      expect(result.output).toContain("::warning title=Live verify NOT RUN::NOT RUN: OPENCODE_API_KEY is not configured");
      expect(result.summary).toContain("NOT RUN: OPENCODE_API_KEY is not configured");
      expect(result.summary).not.toMatch(/pass/i);
      expect(stub.seen).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 60_000);
});
