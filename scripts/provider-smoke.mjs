#!/usr/bin/env node
/**
 * Provider smoke test — ONE real minimal completion through the live provider chain.
 *
 * This is a LIVE-VERIFICATION harness. It proves nothing on its own: it only
 * makes verification POSSIBLE with the operator's REAL credentials. Run it on the
 * machine/environment that holds the secrets, after `npm run build`.
 *
 * What it does:
 *   1. Loads config the same way the app does (loadConfigSafe → auto-loads .env).
 *   2. Resolves the configured provider order:
 *        - PROVIDER_CHAIN if set (e.g. "claude,kimi,ollama"),
 *        - otherwise auto-detected from the API keys / subscription auth present.
 *   3. Walks that order and attempts ONE tiny chat() per provider, stopping at the
 *      FIRST provider that answers. So at most one tiny call per provider, and it
 *      short-circuits on the first success.
 *   4. Prints which provider answered, the model, and a snippet of the reply.
 *
 * Safety:
 *   - Sends a single ~6-token prompt with no tools and a tight token cap.
 *   - If NO credentials are configured, it SKIPS (exit 0) instead of crashing.
 *   - Reuses the real production wiring (collectProviderCredentials,
 *     createProvider, detectConfiguredResponseProviders) — it does NOT invent APIs.
 *
 * Usage:
 *   npm run build
 *   node scripts/provider-smoke.mjs            # try the whole configured order
 *   node scripts/provider-smoke.mjs --provider kimi   # force a single provider
 *   node scripts/provider-smoke.mjs --list      # only print what is configured, make no call
 *
 * Exit codes:
 *   0  success (a provider answered) OR clean skip (nothing configured)
 *   1  a provider was configured but the live call failed (real failure)
 *   2  the build is missing or config is invalid (run `npm run build` / fix .env)
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST = path.join(ROOT_DIR, "dist");

// --- parse the few flags we accept -----------------------------------------
const argv = process.argv.slice(2);
function flagValue(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}
const forcedProvider = flagValue("--provider");
const listOnly = argv.includes("--list");

// --- guard: dist must be built ----------------------------------------------
const requiredCompiled = [
  "config/config.js",
  "core/provider-config.js",
  "agents/providers/provider-registry.js",
];
for (const rel of requiredCompiled) {
  if (!existsSync(path.join(DIST, rel))) {
    console.error(`[smoke] Missing compiled file: dist/${rel}`);
    console.error("[smoke] Run `npm run build` first, then re-run this script.");
    process.exit(2);
  }
}

// --- import the REAL production wiring from the compiled output -------------
const { loadConfigSafe } = await import(path.join(DIST, "config/config.js"));
const { collectProviderCredentials, detectConfiguredResponseProviders } = await import(
  path.join(DIST, "core/provider-config.js")
);
const { createProvider } = await import(path.join(DIST, "agents/providers/provider-registry.js"));
const { createLogger } = await import(path.join(DIST, "utils/logger.js"));

// loadConfigSafe() internally runs dotenv against the resolved .env path, so any
// secrets in .env are already in process.env by the time this returns.
const configResult = loadConfigSafe();
if (configResult.kind === "err") {
  console.error(`[smoke] Config is invalid: ${configResult.error}`);
  console.error("[smoke] Fix .env (or run `node dist/index.js doctor`) and re-run.");
  process.exit(2);
}
const config = configResult.value;

// Providers call getLogger() during chat(); initialize the singleton exactly like
// the app does (bootstrap). Keep it quiet by default so the smoke output is clean.
createLogger(process.env["SMOKE_LOG_LEVEL"] ?? "error", config.logFile);

const credentials = collectProviderCredentials(config);

// --- resolve the order of providers to try ----------------------------------
// Honour an explicit PROVIDER_CHAIN exactly as the app does, otherwise fall back
// to the same auto-detection the response path uses.
function resolveOrder() {
  if (forcedProvider) {
    return [forcedProvider.trim().toLowerCase()];
  }
  if (config.providerChain) {
    const seen = new Set();
    const names = [];
    for (const raw of config.providerChain.split(",")) {
      const n = raw.trim().toLowerCase();
      if (n && !seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    }
    if (names.length > 0) return names;
  }
  return detectConfiguredResponseProviders(config);
}

const order = resolveOrder();

if (order.length === 0) {
  console.log("[smoke] SKIP — no AI provider credentials are configured.");
  console.log("[smoke] Set at least one of: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN,");
  console.log("[smoke]   OPENAI_API_KEY (or ChatGPT subscription vars), KIMI_API_KEY,");
  console.log("[smoke]   OPENCODE_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, or PROVIDER_CHAIN=ollama.");
  process.exit(0);
}

console.log(`[smoke] Configured provider order: ${order.join(" → ")}`);

if (listOnly) {
  console.log("[smoke] --list: not making any call.");
  process.exit(0);
}

// --- the single tiny round-trip ---------------------------------------------
const SYSTEM_PROMPT = "You are a connectivity probe. Answer in one short word.";
const MESSAGES = [{ role: "user", content: "Reply with the single word: pong" }];
const TOOLS = [];
const PER_PROVIDER_TIMEOUT_MS = 30_000;

function snippet(text) {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

let answered = false;
let lastError;

for (const name of order) {
  // Ollama is local and needs no API key; everything else needs a usable credential.
  const cred = credentials[name];
  if (
    name !== "ollama" &&
    !(
      cred?.apiKey ||
      cred?.anthropicAuthToken ||
      cred?.openaiSubscriptionAccessToken ||
      cred?.openaiChatgptAuthFile ||
      cred?.openaiAuthMode === "chatgpt-subscription" ||
      cred?.anthropicAuthMode === "claude-subscription"
    )
  ) {
    console.log(`[smoke] ${name}: no usable credential — skipping.`);
    continue;
  }

  let provider;
  try {
    provider = createProvider({
      name,
      apiKey: cred?.apiKey,
      anthropicAuthMode: cred?.anthropicAuthMode,
      anthropicAuthToken: cred?.anthropicAuthToken,
      openaiAuthMode: cred?.openaiAuthMode,
      openaiChatgptAuthFile: cred?.openaiChatgptAuthFile,
      openaiSubscriptionAccessToken: cred?.openaiSubscriptionAccessToken,
      openaiSubscriptionAccountId: cred?.openaiSubscriptionAccountId,
      model: config.providerModels?.[name],
      baseUrl: name === "ollama" ? (config.ollamaBaseUrl ?? "http://localhost:11434") : undefined,
    });
  } catch (err) {
    lastError = err;
    console.log(`[smoke] ${name}: could not build provider — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_PROVIDER_TIMEOUT_MS);
  try {
    process.stdout.write(`[smoke] ${name} (${provider.name}): calling… `);
    const response = await provider.chat(SYSTEM_PROMPT, MESSAGES, TOOLS, { signal: controller.signal });
    clearTimeout(timer);
    console.log("OK");
    console.log(`[smoke] ✅ ANSWERED BY: ${provider.name}`);
    console.log(`[smoke]    reply: "${snippet(response?.text)}"`);
    if (response?.usage) {
      console.log(
        `[smoke]    tokens: in=${response.usage.inputTokens ?? "?"} out=${response.usage.outputTokens ?? "?"}`,
      );
    }
    answered = true;
    break;
  } catch (err) {
    clearTimeout(timer);
    lastError = err;
    console.log("FAIL");
    console.log(`[smoke]    ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    // fall through to the next provider in the order
  }
}

if (answered) {
  process.exit(0);
}

console.error("[smoke] ❌ No configured provider answered.");
if (lastError) {
  console.error(`[smoke]    last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
console.error("[smoke]    Check the credentials/network for the providers listed above.");
process.exit(1);
