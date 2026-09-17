#!/usr/bin/env node
/**
 * learning-eval.mjs — Strada.Brain learning ablation harness (plan item 6.3).
 *
 * The arms RUN. Each gets its own throwaway SQLite database created for this
 * invocation, so a cold arm is genuinely cold and a warm arm genuinely warm;
 * learning is switched on and off through production's own switch
 * (ErrorLearningHooks.enable/disable); and the probes are HELD OUT, so the warm
 * arm is asked to generalise rather than to remember what it was just told.
 *
 * It reports three measures, and one rule that outranks all three:
 *
 *   1. repeat-error reduction   — does a solved failure mode come back?
 *   2. harmful recall           — does recalled guidance make the result WORSE?
 *   3. cost per accepted result — what does one accepted result cost?
 *
 *   "SKIPPED" IS NOT "MEASURED". An arm that cannot run is reported as
 *   unmeasured and never folded into a pass.
 *
 * Exit codes:
 *   0  measured and good        — every requested measure ran, all within bounds
 *   1  measured and regressed   — something ran and came out worse than its bound
 *   2  bad invocation / unreadable dataset / the harness itself failed
 *   3  NOT MEASURED             — a requested arm or measure could not run
 *
 * Usage:
 *   node scripts/eval/learning-eval.mjs                  # ablation + answer quality (needs a provider)
 *   node scripts/eval/learning-eval.mjs --ablation-only   # ablation only; no provider needed
 *   node scripts/eval/learning-eval.mjs --dataset <path>  # a different pinned dataset
 *   node scripts/eval/learning-eval.mjs --json            # machine-readable result on stdout
 *   node scripts/eval/learning-eval.mjs --verify-can-fail # prove the gate fires (expects exit 1)
 *
 * HONESTY CONTRACT
 *   - Retrieval, storage, run-scoped credit and src/learning/ledger.ts are REAL.
 *   - Tool execution is SIMULATED by the dataset's pre-registered oracle; the
 *     ablation arm's cost is in attempts, never in currency. The answer-quality
 *     arm is the only arm that spends real tokens, and it says so.
 *   - No comparative claim about any other assistant is produced here. Scoring
 *     is against an ABSOLUTE rubric.
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EXIT,
  STATE,
  decideVerdict,
  runQualityArm,
  measureCostPerAccepted,
  measureHarmfulRecall,
  measureRepeatErrorReduction,
  renderReport,
  validateDataset,
} from "./learning-eval-core.mjs";
import { ARM_SPECS, makeWorkDir, measureEffectEnds, runArm } from "./learning-eval-arms.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const DEFAULT_DATASET_PATH = resolve(__dirname, "datasets", "learning-ablation.json");

// ─── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    dataset: null,
    json: false,
    ablationOnly: false,
    verifyCanFail: false,
    help: false,
    qualityModel: null,
    overrides: {},
  };
  const numeric = {
    "--min-repeat-reduction": "minRepeatErrorReduction",
    "--max-harmful-recall": "maxHarmfulRecallRate",
    "--max-cost-ratio": "maxCostRatio",
    "--min-quality-accept": "minQualityAccept",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--ablation-only") args.ablationOnly = true;
    // Kept from the previous scaffold's interface: the answer-quality arm is
    // requested by default now, so this only makes that explicit.
    else if (a === "--quality") args.ablationOnly = false;
    // The gate check is about the ablation arms; it must not spend provider
    // tokens to answer "does the harness fire".
    else if (a === "--verify-can-fail") {
      args.verifyCanFail = true;
      args.ablationOnly = true;
    }
    else if (a === "--quality-model") args.qualityModel = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else if (numeric[a] !== undefined) {
      const raw = Number(argv[++i]);
      if (!Number.isFinite(raw)) return { error: `${a} needs a number` };
      args.overrides[numeric[a]] = raw;
    } else return { error: `unknown argument: ${a}` };
  }
  return args;
}

const HELP = `learning-eval.mjs — learning ablation harness (plan 6.3)

  --dataset <path>          pinned dataset (default scripts/eval/datasets/learning-ablation.json)
  --ablation-only           run the ablation arms only; the answer-quality arm is
                            then NOT REQUESTED (and still reported as unmeasured)
  --quality                 explicitly request the answer-quality arm (the default)
  --verify-can-fail         run the ablation with the treatment arm's learning forced
                            off, so a working harness MUST report a regression
  --quality-model <name>    model for the answer-quality arm, overriding the
                            configured one (does NOT touch .env)
  --min-repeat-reduction N  override the dataset's threshold
  --max-harmful-recall N    override the dataset's threshold
  --max-cost-ratio N        override the dataset's threshold
  --min-quality-accept N    override the dataset's threshold
  --json                    machine-readable result on stdout

exit 0 measured and good · 1 measured and regressed · 2 bad invocation · 3 NOT measured`;

// ─── module loading: the harness reads src/, so it needs tsx ────────────────

const TSX_GUARD = "STRADA_LEARNING_EVAL_TSX";

async function loadFromSource(rel) {
  return import(new URL(`../../src/${rel}`, import.meta.url).href);
}

/**
 * The learning subsystem is TypeScript and dist/ can be stale (it had no
 * ledger.js while this was written), so the harness reads src/ under tsx. If
 * this process cannot load a .ts module it re-execs itself once with tsx
 * registered and forwards the child's exit code — the caller's `node
 * scripts/eval/learning-eval.mjs` keeps working either way.
 */
function reExecUnderTsx(argv) {
  const result = spawnSync(process.execPath, ["--import", "tsx", __filename, ...argv], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, [TSX_GUARD]: "1" },
  });
  if (result.error) {
    console.error(`failed to re-exec under tsx: ${result.error.message}`);
    return EXIT.USAGE;
  }
  return result.status ?? EXIT.USAGE;
}

async function loadLearning() {
  const [learning, ledger, retriever] = await Promise.all([
    loadFromSource("learning/index.ts"),
    loadFromSource("learning/ledger.ts"),
    loadFromSource("agents/instinct-retriever.ts"),
  ]);
  return {
    LearningStorage: learning.LearningStorage,
    LearningPipeline: learning.LearningPipeline,
    PatternMatcher: learning.PatternMatcher,
    ConfidenceScorer: learning.ConfidenceScorer,
    ErrorLearningHooks: learning.ErrorLearningHooks,
    InstinctRetriever: retriever.InstinctRetriever,
    ledger: {
      buildInstinctLedger: ledger.buildInstinctLedger,
      findSuspectGuidance: ledger.findSuspectGuidance,
      retireGuidance: ledger.retireGuidance,
    },
  };
}

// ─── the answer-quality arm (Part B) — gated on a real provider ─────────────

/**
 * Build a generate(system, prompt) backed by the REAL provider stack, or say
 * plainly why there is none. Nothing here fabricates an answer: no provider
 * means the arm is UNMEASURED, and the exit code says so.
 */
async function buildGenerator(modelOverride) {
  let config;
  let credentials;
  let order;
  let createProvider;
  try {
    const { loadConfigSafe } = await loadFromSource("config/config.ts");
    const { collectProviderCredentials, detectConfiguredResponseProviders } = await loadFromSource("core/provider-config.ts");
    ({ createProvider } = await loadFromSource("agents/providers/provider-registry.ts"));
    const { createLogger } = await loadFromSource("utils/logger.ts");
    const configResult = loadConfigSafe();
    if (configResult.kind === "err") {
      return { generate: null, reason: `config is invalid: ${configResult.error}` };
    }
    config = configResult.value;
    createLogger(process.env["LEARNING_EVAL_LOG_LEVEL"] ?? "error", config.logFile);
    credentials = collectProviderCredentials(config);
    order = config.providerChain
      ? config.providerChain.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : detectConfiguredResponseProviders(config);
  } catch (err) {
    return { generate: null, reason: `could not load the provider stack: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (const name of order) {
    const cred = credentials[name];
    const usable =
      name === "ollama" ||
      cred?.apiKey ||
      cred?.anthropicAuthToken ||
      cred?.openaiSubscriptionAccessToken ||
      cred?.openaiChatgptAuthFile ||
      cred?.openaiAuthMode === "chatgpt-subscription" ||
      cred?.anthropicAuthMode === "claude-subscription";
    if (!usable) continue;
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
        model: modelOverride ?? config.providerModels?.[name],
        baseUrl: name === "ollama" ? (config.ollamaBaseUrl ?? "http://localhost:11434") : undefined,
      });
    } catch {
      continue;
    }
    const generate = async (system, prompt) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await provider.chat(system, [{ role: "user", content: prompt }], [], {
          signal: controller.signal,
        });
        return {
          text: response?.text ?? "",
          tokens: (response?.usage?.inputTokens ?? 0) + (response?.usage?.outputTokens ?? 0),
        };
      } finally {
        clearTimeout(timer);
      }
    };
    return { generate, provider: `${provider.name}${modelOverride ? ` (model ${modelOverride})` : ""}`, reason: null };
  }

  return {
    generate: null,
    reason:
      `no usable provider credential among [${order.join(", ") || "none configured"}] — the answer-quality arm ` +
      `needs a real chat provider and will not be faked`,
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error(HELP);
    return EXIT.USAGE;
  }
  if (args.help) {
    console.log(HELP);
    return EXIT.MEASURED_GOOD;
  }

  let learning;
  try {
    learning = await loadLearning();
  } catch (err) {
    // Plain node cannot resolve src/'s .js specifiers onto .ts files (and older
    // node cannot read .ts at all). Re-exec once with tsx; the child has the
    // guard set, so a second failure is reported instead of looping.
    if (!process.env[TSX_GUARD]) return reExecUnderTsx(argv);
    console.error(`could not load src/learning: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return EXIT.USAGE;
  }

  let dataset;
  const datasetPath = args.dataset ? resolve(repoRoot, args.dataset) : DEFAULT_DATASET_PATH;
  try {
    dataset = validateDataset(JSON.parse(await readFile(datasetPath, "utf8")));
  } catch (err) {
    console.error(`dataset ${datasetPath}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.USAGE;
  }
  const thresholds = { ...dataset.thresholds, ...args.overrides };

  const work = makeWorkDir();
  const open = [];
  let result;
  try {
    const specs = args.verifyCanFail
      ? ARM_SPECS.map((s) => (s.name === "warm-learning-on" ? { ...s, learningEnabled: false } : s))
      : ARM_SPECS;

    const arms = [];
    let warmOn = null;
    for (const spec of specs) {
      const run = await runArm({ spec, dataset, learning, workDir: work.dir });
      arms.push(run.arm);
      if (run.storage) open.push(run.storage);
      if (spec.name === "warm-learning-on") warmOn = run;
    }

    // The ledger's own "did the effect end" number (plan 6.4), reused here.
    const effectEnds = measureEffectEnds({
      arm: warmOn?.arm,
      storage: warmOn?.storage,
      ledger: learning.ledger,
    });

    // The answer-quality arm. Requested unless --ablation-only; unmeasured
    // without a provider, and unmeasured is NOT a pass.
    const requested = [];
    let quality = null;
    if (args.ablationOnly) {
      requested.push({
        name: "answer-quality",
        state: STATE.UNMEASURED,
        reason: "not requested (--ablation-only); the exit code covers the ablation arms only",
        excludedFromExitCode: true,
      });
    } else {
      const gen = await buildGenerator(args.qualityModel);
      if (!gen.generate) {
        requested.push({ name: "answer-quality", state: STATE.UNMEASURED, reason: gen.reason });
      } else {
        const retriever =
          warmOn?.matcher && warmOn?.storage
            ? new learning.InstinctRetriever(warmOn.matcher, { storage: warmOn.storage })
            : null;
        quality = await runQualityArm({ dataset, generate: gen.generate, retriever, thresholds });
        requested.push({
          name: "answer-quality",
          state: quality.state,
          reason:
            quality.state === STATE.UNMEASURED
              ? `${gen.provider}: ${quality.reason}`
              : `${quality.compared} prompt(s) answered twice by ${gen.provider} and scored against the pinned rubric`,
        });
      }
    }

    const measures = [
      measureRepeatErrorReduction(arms, thresholds),
      measureHarmfulRecall(arms, thresholds, quality),
      measureCostPerAccepted(arms, thresholds, quality),
    ];
    if (effectEnds.state === STATE.REGRESSED) measures.push(effectEnds);

    const verdict = decideVerdict({
      measures,
      arms,
      requested: requested.filter((r) => r.excludedFromExitCode !== true),
    });

    result = {
      harness: "learning-eval 6.3",
      dataset: datasetPath,
      thresholds,
      embedding: "lexical only (no embedder wired in this harness) — semantic recall is NOT measured here",
      arms,
      measures,
      ledger: effectEnds,
      requested,
      quality,
      ...verdict,
    };

    if (args.verifyCanFail) {
      const ok = verdict.exitCode === EXIT.MEASURED_REGRESSED;
      console.log(renderReport(result));
      console.log(
        `\n--verify-can-fail: the treatment arm ran with learning OFF, so the harness must report a regression. ` +
          `It reported ${verdict.verdict} (exit ${verdict.exitCode}) — ${ok ? "the gate fires" : "THE GATE IS BROKEN"}.`,
      );
      return ok ? EXIT.MEASURED_REGRESSED : EXIT.USAGE;
    }

    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderReport(result));
    return verdict.exitCode;
  } finally {
    for (const storage of open) {
      try {
        storage.close();
      } catch {
        /* a close failure must not change the verdict */
      }
    }
    work.cleanup();
  }
}

// Only run when this file IS the entry point, so a test can import the module
// without the harness executing and calling process.exit underneath it.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? String(err));
      process.exit(EXIT.USAGE);
    });
}

export { main, parseArgs, buildGenerator };
