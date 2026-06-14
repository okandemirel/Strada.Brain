#!/usr/bin/env node
/**
 * learning-eval.mjs — Self-learning + response-quality eval harness (SCAFFOLD)
 *
 * ⚠️  THIS IS A SCAFFOLD, NOT A PASSING TEST. It does not assert anything by
 *     default. It defines a dataset format, a scoring rubric, and a runner
 *     skeleton for two questions the regular test suite cannot answer:
 *
 *       (A) Self-learning effectiveness — do instincts learned from seeded
 *           errors on RUN 1 measurably improve behaviour on RUN 2?
 *       (B) Response quality — does a produced answer satisfy a rubric?
 *
 * HONESTY CONTRACT (read before extending this file):
 *   - Part (A) CAN be wired to real, local, in-process Strada.Brain learning
 *     code (LearningStorage + LearningPipeline + PatternMatcher) against a real
 *     local SQLite DB. That part is genuinely verifiable with NO network and NO
 *     credentials, and is the honest core of this harness. It is left as a
 *     TODO skeleton here because wiring it is a real implementation task, not a
 *     doc task — see WIRING NOTES below.
 *   - Part (B) REQUIRES a real LLM (chat completion) to generate answers and,
 *     ideally, a second LLM as a judge. That needs working provider
 *     credentials (OPENAI_API_KEY / a live subscription token / a running
 *     Ollama). It CANNOT run in CI and MUST NOT be faked. If creds are absent
 *     this harness SKIPS (B) and says so. It never fabricates a score.
 *   - COMPARATIVE claims ("Strada.Brain answers better than openclaw / hermes /
 *     <other assistant>") are explicitly OUT OF SCOPE and are NOT produced by
 *     this harness. A fair comparison needs: (1) the other systems actually
 *     running, (2) a shared, published benchmark dataset, (3) a pre-registered
 *     judging protocol, and (4) statistical treatment of variance. None of
 *     those exist in this repo, so no such claim can be asserted. This harness
 *     scores ONE system against an ABSOLUTE rubric — never against a rival.
 *
 * Usage (scaffold; will currently no-op the parts that need wiring/creds):
 *   node scripts/eval/learning-eval.mjs                 # auto-detect, skip what it can't run
 *   node scripts/eval/learning-eval.mjs --dataset path  # custom dataset (JSON, format below)
 *   node scripts/eval/learning-eval.mjs --quality       # also attempt Part (B) (needs creds)
 *   node scripts/eval/learning-eval.mjs --json          # machine-readable result on stdout
 *
 * Exit codes:
 *   0  ran what it could; any RUNNABLE check that ran, passed
 *   1  a check that actually ran produced a failing result
 *   2  bad invocation / unreadable dataset
 *   (SKIPPED checks never fail the run — they are reported as SKIPPED.)
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

// =============================================================================
// DATASET FORMAT
// =============================================================================
//
// A dataset is a JSON file: { "version": 1, "tasks": Task[] }.
//
// Each Task drives ONE eval scenario. The same task shape feeds both the
// self-learning check (A) and the response-quality check (B); fields irrelevant
// to a given check are ignored by that check.
//
//   Task = {
//     id: string,                 // stable unique id, e.g. "cs0006-readonly-struct"
//     title: string,              // human label
//     // --- self-learning (A) ---
//     seedError: {                // an error to "teach" on RUN 1
//       toolName: string,         // e.g. "dotnet_build"
//       errorCode?: string,       // e.g. "CS0006"
//       errorMessage: string,     // the raw error text the system would observe
//       input: object,            // tool input that produced it
//     },
//     fix: {                      // the resolution that should become an instinct
//       action: string,          // what to do next time (free text)
//       success: true,           // the fix worked
//     },
//     probe: {                    // RUN 2: the same/similar situation re-encountered
//       toolName: string,
//       errorCode?: string,
//       errorMessage: string,
//       input: object,
//     },
//     expectInstinct: {           // what RUN 2 should be able to recall
//       minConfidence?: number,   // default 0.0 (proposed) — just "exists & matches"
//       matchKind?: "error_fix" | "error_pattern" | "correction",
//     },
//     // --- response quality (B) ---
//     prompt?: string,            // user prompt to send to a REAL LLM
//     rubric?: RubricCriterion[], // see RUBRIC below; absolute, NOT comparative
//   }
//
// A tiny built-in dataset (DEFAULT_DATASET) is provided so the scaffold is
// runnable end-to-end without an external file. Replace/extend it via --dataset.

// =============================================================================
// SCORING RUBRIC (Part B — response quality, ABSOLUTE)
// =============================================================================
//
// Each RubricCriterion scores the produced answer on a fixed scale. Scores are
// ABSOLUTE ("does the answer meet this bar?"), never relative to another model.
// A criterion is one of:
//
//   { id, weight, kind: "must_contain", any: string[] }     // >=1 substring present (case-insensitive)
//   { id, weight, kind: "must_not_contain", all: string[] } // none of these present
//   { id, weight, kind: "regex", pattern: string }          // matches /pattern/i
//   { id, weight, kind: "judge", question: string }         // needs an LLM judge (Part B-judge)
//
// Deterministic kinds (must_contain / must_not_contain / regex) can be scored
// WITHOUT an LLM and are honest, cheap signals (e.g. "did it mention the
// Strada.Core API it was supposed to?", "did it avoid hallucinating a banned
// symbol?"). The "judge" kind needs a real LLM and is gated behind creds.
//
// Final quality score = sum(weight * criterionScore) / sum(weight), in [0,1].
// There is NO pass/fail threshold baked in here on purpose — a threshold is a
// product/policy decision, not something this scaffold should assert.

const RUBRIC_KINDS = ["must_contain", "must_not_contain", "regex", "judge"];

// =============================================================================
// BUILT-IN MINIMAL DATASET (so the scaffold is self-contained & runnable)
// =============================================================================

const DEFAULT_DATASET = {
  version: 1,
  tasks: [
    {
      id: "example-build-error",
      title: "Recurring build error should be recalled on second encounter",
      seedError: {
        toolName: "dotnet_build",
        errorCode: "CS0006",
        errorMessage: "error CS0006: Metadata file 'Strada.Core.dll' could not be found",
        input: { configuration: "Release" },
      },
      fix: {
        action: "Build Strada.Core first / restore project references before building dependents",
        success: true,
      },
      probe: {
        toolName: "dotnet_build",
        errorCode: "CS0006",
        errorMessage: "error CS0006: Metadata file 'Strada.Core.dll' could not be found",
        input: { configuration: "Debug" },
      },
      expectInstinct: { minConfidence: 0.0, matchKind: "error_fix" },
      prompt: "My Unity build fails with CS0006 metadata file 'Strada.Core.dll' could not be found. What do I do?",
      rubric: [
        { id: "mentions-core", weight: 2, kind: "must_contain", any: ["Strada.Core", "core", "reference", "restore"] },
        { id: "no-fabrication", weight: 1, kind: "must_not_contain", all: ["delete the engine", "reinstall Unity Hub entirely"] },
      ],
    },
  ],
};

// =============================================================================
// SMALL UTILITIES
// =============================================================================

function parseArgs(argv) {
  const args = { dataset: null, quality: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--quality") args.quality = true;
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return args;
}

function log(json, line) {
  if (!json) console.log(line);
}

async function loadDataset(path, json) {
  if (!path) return DEFAULT_DATASET;
  const abs = resolve(repoRoot, path);
  const raw = await readFile(abs, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error(`dataset ${abs} must be { version, tasks: [] }`);
  }
  for (const t of parsed.tasks) {
    if (!t.id) throw new Error("each task needs an id");
    for (const c of t.rubric ?? []) {
      if (!RUBRIC_KINDS.includes(c.kind)) {
        throw new Error(`task ${t.id}: unknown rubric kind ${c.kind}`);
      }
    }
  }
  log(json, `loaded dataset: ${parsed.tasks.length} task(s) from ${abs}`);
  return parsed;
}

/**
 * Detect whether a REAL LLM is reachable for Part (B). This only checks for the
 * PRESENCE of credentials/endpoints — it does not validate them and it does not
 * make a network call here. Part (B) itself, once wired, must surface real
 * provider errors rather than swallowing them.
 */
function detectLlmAvailability(env) {
  const reasons = [];
  if (env.OPENAI_API_KEY) reasons.push("OPENAI_API_KEY present");
  if (env.OPENAI_AUTH_MODE === "chatgpt-subscription" || env.OPENAI_AUTH_MODE === "subscription") {
    reasons.push("OpenAI subscription auth configured (chat-only; cannot do embeddings)");
  }
  if (env.ANTHROPIC_API_KEY) reasons.push("ANTHROPIC_API_KEY present");
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) reasons.push("Gemini API key present");
  if (env.OLLAMA_BASE_URL || env.OLLAMA_HOST) reasons.push("Ollama endpoint configured");
  return { available: reasons.length > 0, reasons };
}

// =============================================================================
// PART (A) — SELF-LEARNING EFFECTIVENESS  (in-process, real local SQLite)
// =============================================================================
//
// WIRING NOTES (this is the honest, verifiable-without-creds part):
//
//   The pieces already exist in src/learning (compiled to dist/learning):
//     - LearningStorage(dbPath)          → real better-sqlite3 store
//     - LearningPipeline(storage)        → observeToolUse(...), runDetectionBatch()
//     - PatternMatcher                   → findMatchingErrorPatterns(...)
//     - storage.getInstincts({ status, type, minConfidence })
//
//   To turn this skeleton into a genuine in-process eval (NO network, NO creds):
//     1. Import from the BUILT output, e.g.
//          const { LearningStorage, LearningPipeline, PatternMatcher } =
//            await import(new URL("../../dist/learning/index.js", import.meta.url));
//        (requires `npm run build` first; this is a .mjs script, not part of tsc).
//     2. RUN 1 ("teach"):
//          - new LearningStorage(tmpDbPath); storage.initialize();
//          - const pipeline = new LearningPipeline(storage); pipeline.start();
//          - for each task: feed task.seedError as a failing observation, then
//            task.fix as the successful resolution, then `await
//            pipeline.runDetectionBatch()` so an instinct is created.
//     3. RUN 2 ("probe"): with the SAME storage (or a fresh process pointed at
//          the same DB, to also exercise cross-session recall), present
//          task.probe and assert an instinct that satisfies task.expectInstinct
//          is RETRIEVED (via PatternMatcher / storage.getInstincts). The metric
//          is: fraction of tasks where RUN 2 recalls a matching instinct that
//          RUN 1 did not have. That delta IS the "did learning help" signal.
//     4. Use a throwaway temp DB (node:os.tmpdir) and delete it after.
//
//   Embedding caveat (must stay honest): instinct *semantic* recall uses
//   embeddings. In THIS deployment embeddings fall back to a hash vector
//   (no API key, Ollama off) — see docs/STATUS.md. Hash-fallback recall is
//   keyword/lexical, NOT semantic, so a probe with DIFFERENT wording may not
//   recall even when a human would say it should. The eval must therefore
//   report which embedding backend was active, and treat semantic-recall
//   results as INDICATIVE-ONLY under hash fallback. Do not claim semantic
//   learning works on the strength of lexical-match recall.

async function runSelfLearningEval(_dataset, json) {
  log(json, "\n[A] self-learning effectiveness");
  log(json, "    status: SCAFFOLD — wiring to dist/learning is a TODO (see WIRING NOTES in this file).");
  log(json, "    when wired: runs fully in-process against a real local SQLite DB, NO network, NO creds.");
  log(json, "    metric: fraction of tasks where RUN 2 recalls a matching instinct RUN 1 lacked.");
  return {
    name: "self-learning",
    status: "SKIPPED",
    reason: "scaffold not yet wired to dist/learning",
    verifiableWithoutCreds: true,
  };
}

// =============================================================================
// PART (B) — RESPONSE QUALITY  (REQUIRES a real LLM; gated behind creds)
// =============================================================================

/** Score the deterministic (non-judge) rubric criteria for one answer. */
function scoreDeterministicRubric(answer, rubric) {
  const text = (answer ?? "").toLowerCase();
  let weighted = 0;
  let total = 0;
  const detail = [];
  for (const c of rubric ?? []) {
    if (c.kind === "judge") continue; // needs an LLM judge — handled separately
    const w = c.weight ?? 1;
    let pass = false;
    if (c.kind === "must_contain") {
      pass = (c.any ?? []).some((s) => text.includes(String(s).toLowerCase()));
    } else if (c.kind === "must_not_contain") {
      pass = !(c.all ?? []).some((s) => text.includes(String(s).toLowerCase()));
    } else if (c.kind === "regex") {
      pass = new RegExp(c.pattern, "i").test(answer ?? "");
    }
    weighted += pass ? w : 0;
    total += w;
    detail.push({ id: c.id, kind: c.kind, weight: w, pass });
  }
  return { score: total > 0 ? weighted / total : null, detail };
}

async function runResponseQualityEval(dataset, opts, json) {
  log(json, "\n[B] response quality");

  const llm = detectLlmAvailability(process.env);
  if (!opts.quality) {
    log(json, "    status: SKIPPED — pass --quality to attempt it (needs a real LLM).");
    return { name: "response-quality", status: "SKIPPED", reason: "not requested (--quality)" };
  }
  if (!llm.available) {
    log(json, "    status: SKIPPED — no LLM credentials/endpoint detected.");
    log(json, "    A real chat provider is REQUIRED. Set OPENAI_API_KEY / GEMINI_API_KEY,");
    log(json, "    or run Ollama, or configure subscription auth. This scaffold will NOT");
    log(json, "    fabricate answers or scores.");
    return {
      name: "response-quality",
      status: "SKIPPED",
      reason: "no LLM credentials — cannot generate real answers (must not be faked)",
      verifiableWithoutCreds: false,
    };
  }

  // Credentials/endpoint detected. The deterministic rubric portion is honest
  // and runnable; the "judge" portion needs a second real LLM call. The actual
  // answer generation must call the real provider stack and is left as a TODO
  // so this scaffold never invents an answer.
  log(json, `    LLM signal: ${llm.reasons.join("; ")}`);
  log(json, "    status: SCAFFOLD — generation against the real provider stack is a TODO.");
  log(json, "    WIRING NOTES:");
  log(json, "      1. Boot the real provider/ProviderManager (or call the chat endpoint) to get an answer per task.prompt.");
  log(json, "      2. Score deterministic rubric criteria locally (scoreDeterministicRubric — already implemented).");
  log(json, "      3. For kind:'judge' criteria, call a SECOND real LLM as judge (separate model recommended).");
  log(json, "      4. Report per-task scores against the ABSOLUTE rubric. Do NOT compare to any other system.");

  // Demonstrate the deterministic scorer on a placeholder so the rubric path is
  // exercised, but mark the run SKIPPED because no REAL answer was produced.
  const tasksWithRubric = (dataset.tasks ?? []).filter((t) => Array.isArray(t.rubric) && t.prompt);
  log(json, `    rubric-ready tasks: ${tasksWithRubric.length} (would each need a real generated answer)`);

  return {
    name: "response-quality",
    status: "SKIPPED",
    reason: "real answer generation not wired (would call live LLM); rubric scorer is ready but had no real answer to score",
    verifiableWithoutCreds: false,
    rubricReadyTasks: tasksWithRubric.length,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    process.exit(2);
  }
  if (args.help) {
    console.log(
      "learning-eval.mjs (SCAFFOLD)\n" +
        "  --dataset <path>  JSON dataset { version, tasks: [] }\n" +
        "  --quality         attempt response-quality eval (needs a real LLM)\n" +
        "  --json            machine-readable result on stdout\n" +
        "See the header of this file for the honesty contract and dataset/rubric formats.",
    );
    process.exit(0);
  }

  let dataset;
  try {
    dataset = await loadDataset(args.dataset, args.json);
  } catch (err) {
    console.error(`failed to load dataset: ${err.message}`);
    process.exit(2);
  }

  log(args.json, "=".repeat(72));
  log(args.json, "Strada.Brain learning + response-quality eval harness (SCAFFOLD)");
  log(args.json, "This harness does NOT make comparative ('better than X') claims — by design.");
  log(args.json, "=".repeat(72));

  const results = [];
  results.push(await runSelfLearningEval(dataset, args.json));
  results.push(await runResponseQualityEval(dataset, args, args.json));

  const ran = results.filter((r) => r.status === "RAN");
  const failed = ran.filter((r) => r.pass === false);

  if (args.json) {
    console.log(JSON.stringify({ scaffold: true, results }, null, 2));
  } else {
    log(false, "\n" + "-".repeat(72));
    for (const r of results) {
      log(false, `  ${r.name.padEnd(20)} ${r.status}${r.reason ? "  (" + r.reason + ")" : ""}`);
    }
    log(false, "-".repeat(72));
    log(false, `ran: ${ran.length}, failed: ${failed.length}, skipped: ${results.length - ran.length}`);
    log(false, "NOTE: SKIPPED checks are NOT failures — they require wiring and/or real creds.");
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(2);
});
