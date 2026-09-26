#!/usr/bin/env node
/**
 * Live verification of the OpenCode provider against its real API.
 *
 * The unit suite drives every provider class against mocked fetches, so what
 * the real endpoint does with our requests was never verified. This script
 * makes three real calls through the project's own provider class
 * (OpencodeProvider, src/agents/providers/opencode.ts, built by the registry's
 * createProvider exactly as the app builds it), from the compiled dist/:
 *
 *   completion  one short non-streaming chat()
 *   stream      one chatStream(): text chunks must arrive and assemble into
 *               the text the call returns
 *   tool        a tool-call round trip: the model calls a trivial tool, gets
 *               a per-run random result back, and must answer with it
 *
 * Scope, by the maintainer's decision: OpenCode (Zen) only. No other
 * provider's key is read here, and the workflow maps no other secret.
 *
 * Model: OPENCODE_DEFAULT_MODEL when set (the app's own variable), else the
 * cheapest OpenCode model in the project's model catalog (HARDCODED_MODELS,
 * model-intelligence.ts), else the registry preset's default. Base URL:
 * OPENCODE_BASE_URL when set, else the preset's (OpenCode Zen). Every call is
 * capped at MAX_TOKENS output tokens.
 *
 * The key is never printed: every line this process writes, and the job
 * summary, pass through a redactor that removes its value and any
 * authorization header, and the environment is never echoed.
 *
 *   node scripts/ci/live-verify-providers.mjs
 *
 * Exit codes:
 *   0  every check PASSED — or OPENCODE_API_KEY is not set, which is reported
 *      as NOT RUN (a warning annotation under Actions), never as a pass
 *   1  a check FAILED
 *   2  bad invocation: dist/ is missing (run `npm run build`), or
 *      OPENCODE_BASE_URL is not an https URL
 */

import { randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const DIST = path.join(repoRoot, "dist");
const REQUIRED_DIST = [
  "agents/providers/provider-registry.js",
  "agents/providers/provider.interface.js",
  "agents/providers/model-intelligence.js",
  "utils/logger.js",
];

/** The one provider in scope, and the project's own variable names for it (.env.example). */
export const LIVE_PROVIDER = {
  name: "opencode",
  label: "OpenCode",
  keyEnv: "OPENCODE_API_KEY",
  modelEnv: "OPENCODE_DEFAULT_MODEL",
  baseUrlEnv: "OPENCODE_BASE_URL",
};

/**
 * Output cap per call. Low, but not so low that a reasoning model spends it
 * all thinking and returns nothing: the cap covers reasoning and answer alike.
 */
export const MAX_TOKENS = 1024;
export const CALL_TIMEOUT_MS = 120_000;

export const PROVIDER_CHECKS = [
  { id: "completion", title: "Completion (non-streaming)" },
  { id: "stream", title: "Streamed completion" },
  { id: "tool", title: "Tool-call round trip" },
];

export const PROBE_TOOL = {
  name: "get_verification_code",
  description: "Returns the verification code for a label.",
  input_schema: {
    type: "object",
    properties: { label: { type: "string", description: "Which code to return." } },
    required: ["label"],
  },
};

const SYSTEM_PROMPT = "You are a connectivity probe for an automated test. Follow the instruction exactly and keep every reply minimal.";

/* ------------------------------------------------------------------------- *
 * Redaction
 * ------------------------------------------------------------------------- */

/**
 * `text` with every secret value removed, raw or URL-encoded, and with the
 * values of authorization-style headers and `key=` query parameters removed
 * whatever they hold. Secrets shorter than 6 characters are not matched
 * literally: redacting every "a" would say nothing and ruin the output.
 */
export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  const values = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length >= 6))]
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("[REDACTED]");
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [REDACTED]")
    .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)[^\s"',;}]+/giu, "$1$2[REDACTED]")
    .replace(/([?&](?:api_?key|key|token)=)[^&\s"']+/giu, "$1[REDACTED]");
}

/**
 * Pass everything this process writes to stdout/stderr (console, the
 * project's logger, uncaught-error printing) through redactText.
 */
export function installOutputRedaction(secrets, streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (typeof chunk === "string") return write(redactText(chunk, secrets), ...rest);
      if (chunk instanceof Uint8Array) return write(Buffer.from(redactText(Buffer.from(chunk).toString("utf8"), secrets), "utf8"), ...rest);
      return write(chunk, ...rest);
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Configuration
 * ------------------------------------------------------------------------- */

const envValue = (env, name) => {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/**
 * The model the checks run on: the operator's override, else the cheapest
 * OpenCode model the project's catalog prices (blended input + output, among
 * models that call tools and stream), else the preset default. Returned bare:
 * OpencodeProvider strips the catalog's "opencode/" namespace before sending.
 */
export function chooseModel(env, catalogEntries, preset) {
  const override = envValue(env, LIVE_PROVIDER.modelEnv);
  if (override) return { model: override, source: `${LIVE_PROVIDER.modelEnv} override` };
  const priced = catalogEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.provider === LIVE_PROVIDER.name
      && entry.supportsToolCalling === true
      && entry.supportsStreaming === true
      && typeof entry.inputPricePerMillion === "number"
      && typeof entry.outputPricePerMillion === "number")
    .sort((a, b) => (a.entry.inputPricePerMillion + a.entry.outputPricePerMillion)
      - (b.entry.inputPricePerMillion + b.entry.outputPricePerMillion) || a.index - b.index);
  const cheapest = priced[0]?.entry;
  if (cheapest) {
    const bare = cheapest.id.startsWith("opencode/") ? cheapest.id.slice("opencode/".length) : cheapest.id;
    return {
      model: bare,
      source: `cheapest OpenCode model in the project's catalog ($${cheapest.inputPricePerMillion}/$${cheapest.outputPricePerMillion} per 1M in/out)`,
    };
  }
  if (preset?.defaultModel) return { model: preset.defaultModel, source: "the registry preset's default" };
  throw new Error("no OpenCode model: the catalog prices none and the registry has no preset");
}

/** The endpoint: OPENCODE_BASE_URL when set (https, or http on loopback for a local stub), else the preset. */
export function resolveBaseUrl(env, preset) {
  const override = envValue(env, LIVE_PROVIDER.baseUrlEnv);
  if (!override) {
    if (!preset?.baseUrl) throw new Error("the registry has no OpenCode preset base URL");
    return { baseUrl: preset.baseUrl, source: "the registry preset" };
  }
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`${LIVE_PROVIDER.baseUrlEnv} is not a URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // The key goes to this host in an Authorization header: never in clear text
  // over a network.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${LIVE_PROVIDER.baseUrlEnv} must be an https URL (http is accepted on loopback only)`);
  }
  return { baseUrl: override.replace(/\/+$/u, ""), source: LIVE_PROVIDER.baseUrlEnv };
}

/* ------------------------------------------------------------------------- *
 * The checks
 * ------------------------------------------------------------------------- */

/** The answer without the `<reasoning>` block the OpenAI-compatible base embeds before it. */
function visibleText(text) {
  return String(text ?? "").replace(/^\s*<reasoning>[\s\S]*?<\/reasoning>\s*/u, "");
}

const snippet = (text) => {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 80)}…` : flat);
};

const normalize = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();

function must(condition, message) {
  if (!condition) throw new Error(message);
}

const usage = (response) => `${response.usage?.inputTokens ?? "?"} in / ${response.usage?.outputTokens ?? "?"} out tokens`;

async function checkCompletion(provider, options) {
  const response = await provider.chat(SYSTEM_PROMPT, [{ role: "user", content: "Reply with exactly one word: pong" }], [], options());
  const text = visibleText(response.text);
  must(/\bpong\b/iu.test(text), `the reply does not say pong: ${snippet(text)} (stop ${response.stopReason})`);
  return `replied ${snippet(text)} (stop ${response.stopReason}; ${usage(response)})`;
}

async function checkStream(provider, options, supportsStreaming) {
  must(supportsStreaming(provider), `${provider.name} does not declare streaming`);
  const chunks = [];
  let activity = 0;
  const response = await provider.chatStream(
    SYSTEM_PROMPT,
    [{ role: "user", content: "Count from 1 to 5: the digits only, separated by single spaces." }],
    [],
    // An empty chunk is reasoning activity (it keeps a stall timer alive), not text.
    (chunk) => { if (chunk) chunks.push(chunk); else activity += 1; },
    options(),
  );
  must(chunks.length > 0, `no text chunk arrived (stop ${response.stopReason}; ${activity} reasoning chunks)`);
  const assembled = chunks.join("");
  must(/1\D+2\D+3\D+4\D+5/u.test(assembled), `the assembled chunks do not count 1 to 5: ${snippet(assembled)}`);
  must(normalize(response.text).endsWith(normalize(assembled)), `the returned text ${snippet(visibleText(response.text))} is not the assembled chunks ${snippet(assembled)}`);
  return `${chunks.length} text chunk(s)${activity > 0 ? ` and ${activity} reasoning` : ""} assembled into ${snippet(assembled)} (${usage(response)})`;
}

async function checkTool(provider, options, code) {
  const ask = {
    role: "user",
    content: `Call the ${PROBE_TOOL.name} tool with label "live-verify". Once you have its result, reply with the code only.`,
  };
  const first = await provider.chat(SYSTEM_PROMPT, [ask], [PROBE_TOOL], options());
  const call = first.toolCalls.find((toolCall) => toolCall.name === PROBE_TOOL.name);
  must(call !== undefined, `no ${PROBE_TOOL.name} call (stop ${first.stopReason}; text ${snippet(visibleText(first.text))})`);
  // The orchestrator's shapes (orchestrator-loop-shared.ts): the assistant turn
  // with its tool_calls, then one tool_result per call.
  const second = await provider.chat(
    SYSTEM_PROMPT,
    [
      ask,
      { role: "assistant", content: first.text, tool_calls: first.toolCalls },
      {
        role: "user",
        content: first.toolCalls.map((toolCall) => ({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: toolCall.id === call.id ? code : "not needed",
        })),
      },
    ],
    [PROBE_TOOL],
    options(),
  );
  const answer = visibleText(second.text);
  must(answer.includes(code), `the answer after the tool result does not carry its value ${code}: ${snippet(answer)} (stop ${second.stopReason})`);
  return `called ${PROBE_TOOL.name}(${JSON.stringify(call.input)}), answered ${snippet(answer)} with the tool's per-run value`;
}

/**
 * Run the three checks against one provider instance. Each runs on its own, so
 * a broken stream path cannot hide whether plain completion works. Every
 * detail is redacted with `secrets` before it is stored.
 */
export async function verifyProvider({
  createProvider,
  supportsStreaming,
  apiKey,
  model,
  baseUrl,
  secrets = [apiKey],
  maxTokens = MAX_TOKENS,
  timeoutMs = CALL_TIMEOUT_MS,
  code = String(randomInt(100_000, 1_000_000)),
}) {
  const results = PROVIDER_CHECKS.map((check) => ({ ...check, state: "not-run" }));
  let provider;
  try {
    provider = createProvider({ name: LIVE_PROVIDER.name, apiKey, model, baseUrl });
  } catch (err) {
    const detail = redactText(`could not build the provider: ${err instanceof Error ? err.message : String(err)}`, secrets);
    return results.map((check) => ({ ...check, state: "fail", detail }));
  }
  const options = () => ({ maxTokens, signal: AbortSignal.timeout(timeoutMs) });
  const runs = {
    completion: () => checkCompletion(provider, options),
    stream: () => checkStream(provider, options, supportsStreaming),
    tool: () => checkTool(provider, options, code),
  };
  for (const check of results) {
    try {
      check.detail = redactText(await runs[check.id](), secrets);
      check.state = "pass";
    } catch (err) {
      check.detail = redactText(err instanceof Error ? err.message : String(err), secrets);
      check.state = "fail";
    }
  }
  return results;
}

/* ------------------------------------------------------------------------- *
 * The report: data in, text out, so the rules are unit-tested.
 *
 * run = { configured: boolean, model?, modelSource?, baseUrl?, checks: [...] }
 * ------------------------------------------------------------------------- */

export function notConfiguredRun() {
  return {
    configured: false,
    checks: PROVIDER_CHECKS.map((check) => ({ ...check, state: "not-run", detail: `${LIVE_PROVIDER.keyEnv} is not configured` })),
  };
}

export function summarizeRun(run) {
  const failed = run.checks.filter((check) => check.state === "fail").map((check) => check.id);
  const passed = run.checks.filter((check) => check.state === "pass").map((check) => check.id);
  const verdict = !run.configured
    ? `NOT RUN: ${LIVE_PROVIDER.keyEnv} is not configured`
    : failed.length > 0
      ? `FAILED: ${failed.join(", ")}`
      : passed.length === run.checks.length
        ? `PASS: ${passed.length}/${run.checks.length} checks`
        : `NOT RUN: ${run.checks.filter((check) => check.state !== "pass").map((check) => check.id).join(", ")}`;
  return { passed, failed, verdict };
}

/** 1 when a configured check failed or did not run; 0 when all passed, and when nothing was configured. */
export function exitCodeForRun(run) {
  if (!run.configured) return 0;
  return run.checks.every((check) => check.state === "pass") ? 0 : 1;
}

/** GitHub workflow commands: a warning when nothing ran, an error on a failure. */
export function annotationsFor(run) {
  const { verdict, failed } = summarizeRun(run);
  if (!run.configured) return [`::warning title=Live verify NOT RUN::${verdict}`];
  if (failed.length > 0) return [`::error title=Live verify FAILED::${verdict}`];
  return [];
}

const STATE_LABEL = { pass: "PASS", fail: "FAIL", "not-run": "NOT RUN" };

function describeTarget(run) {
  if (!run.configured) return [];
  return [
    `endpoint: ${run.baseUrl}`,
    `model: ${run.model} (${run.modelSource})`,
    `max tokens per call: ${run.maxTokens ?? MAX_TOKENS}`,
  ];
}

export function formatReport(run, secrets = []) {
  const width = Math.max(...run.checks.map((check) => check.id.length));
  const title = `Live verify: ${LIVE_PROVIDER.label} provider`;
  const lines = ["", title, "=".repeat(title.length), ...describeTarget(run), ""];
  for (const check of run.checks) {
    lines.push(`${check.id.padEnd(width)}  ${(STATE_LABEL[check.state] ?? check.state).padEnd(7)}  ${check.title}`);
    if (check.detail) lines.push(`${" ".repeat(width)}  ${check.detail.trim().split("\n").join(`\n${" ".repeat(width)}  `)}`);
  }
  lines.push("", `Verdict: ${summarizeRun(run).verdict}`);
  if (!run.configured) {
    lines.push(`Nothing was sent to any provider. Set the repository secret ${LIVE_PROVIDER.keyEnv} to run the checks.`);
  }
  lines.push("Scope: OpenCode only; the other providers are out of scope for this workflow.");
  return redactText(lines.join("\n"), secrets);
}

const cell = (text) => String(text ?? "").replace(/\|/gu, "\\|").replace(/\s*\n\s*/gu, " ");

export function formatStepSummary(run, secrets = []) {
  const lines = [`### Live verify: ${LIVE_PROVIDER.label} provider — ${summarizeRun(run).verdict}`, ""];
  if (!run.configured) {
    lines.push(`Nothing was sent to any provider. Set the repository secret \`${LIVE_PROVIDER.keyEnv}\` to run the checks.`, "");
  } else {
    lines.push(...describeTarget(run).map((line) => `- ${cell(line)}`), "");
  }
  lines.push("| Check | Result | Detail |", "|---|---|---|");
  for (const check of run.checks) {
    lines.push(`| ${cell(check.title)} | ${STATE_LABEL[check.state] ?? check.state} | ${cell(check.detail)} |`);
  }
  lines.push("", "Scope: OpenCode only; the other providers are out of scope for this workflow.");
  return `${redactText(lines.join("\n"), secrets)}\n`;
}

/* ------------------------------------------------------------------------- *
 * Side effects: the run itself.
 * ------------------------------------------------------------------------- */

async function importDist(rel) {
  return import(pathToFileURL(path.join(DIST, rel)).href);
}

function emit(run, secrets) {
  console.log(formatReport(run, secrets));
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const line of annotationsFor(run)) console.log(redactText(line, secrets));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(run, secrets));
  return exitCodeForRun(run);
}

async function main(argv) {
  if (argv.length > 0) {
    console.error(`live-verify-providers: unexpected argument ${argv[0]} (configuration comes from ${LIVE_PROVIDER.keyEnv}, ${LIVE_PROVIDER.modelEnv}, ${LIVE_PROVIDER.baseUrlEnv})`);
    return 2;
  }
  const apiKey = envValue(process.env, LIVE_PROVIDER.keyEnv);
  const secrets = apiKey ? [apiKey] : [];
  installOutputRedaction(secrets);

  for (const rel of REQUIRED_DIST) {
    if (!existsSync(path.join(DIST, rel))) {
      console.error(`live-verify-providers: dist/${rel} is missing; run \`npm run build\` first`);
      return 2;
    }
  }
  if (!apiKey) return emit(notConfiguredRun(), secrets);

  const registry = await importDist("agents/providers/provider-registry.js");
  const { supportsStreaming } = await importDist("agents/providers/provider.interface.js");
  const { HARDCODED_MODELS } = await importDist("agents/providers/model-intelligence.js");
  const { createLogger } = await importDist("utils/logger.js");
  const preset = registry.PROVIDER_PRESETS[LIVE_PROVIDER.name];

  let target;
  try {
    const endpoint = resolveBaseUrl(process.env, preset);
    const choice = chooseModel(process.env, [...HARDCODED_MODELS.values()], preset);
    target = { baseUrl: endpoint.baseUrl, model: choice.model, modelSource: choice.source };
  } catch (err) {
    console.error(`live-verify-providers: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // The providers log through the project's logger (redacting, like the app);
  // its file goes to a throwaway directory that is removed below.
  const logDir = mkdtempSync(path.join(tmpdir(), "strada-live-providers-"));
  const logger = createLogger(process.env.LIVE_VERIFY_LOG_LEVEL ?? "warn", path.join(logDir, "live-verify.log"));
  console.log(`live-verify-providers: ${LIVE_PROVIDER.label} at ${target.baseUrl}, model ${target.model} (${target.modelSource}), max tokens ${MAX_TOKENS}`);
  try {
    const checks = await verifyProvider({
      createProvider: registry.createProvider,
      supportsStreaming,
      apiKey,
      model: target.model,
      baseUrl: target.baseUrl,
      secrets,
    });
    return emit({ configured: true, baseUrl: target.baseUrl, model: target.model, modelSource: target.modelSource, maxTokens: MAX_TOKENS, checks }, secrets);
  } finally {
    logger.close();
    rmSync(logDir, { recursive: true, force: true });
  }
}

/* c8 ignore start — CLI wiring; the reporting and redaction rules are unit-tested */
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
  // A kept-alive socket must not hold the job open past its verdict.
  setTimeout(() => process.exit(), 5_000).unref();
}
/* c8 ignore stop */
