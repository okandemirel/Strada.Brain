#!/usr/bin/env node
/**
 * Retrieval quality measurement.
 *
 * The timing benchmarks answer "is it fast". Nothing answered "does it find the
 * right thing", so any change to chunking, BM25 weighting, fusion or filtering
 * could improve latency while quietly making results worse, and the suite would
 * stay green. This closes that gap with the standard IR metrics.
 *
 * Ground truth is derived, never hand-labelled. The synthetic corpus declares
 * every method as `public void <Name>(int id, float delta)`, so for a query of
 * a method name the relevant chunks are exactly those whose text contains that
 * declaration. That makes the judgments objective, reproducible on any machine,
 * and immune to the drift that kills hand-labelled sets.
 *
 * It is NOT immune to the chunker. A relevant chunk is identified by its
 * chunkId, which is `sha256(path, offset, body)` — so changing how the chunker
 * splits a file silently rewrites every judgment, and the metrics then describe
 * a different question than the baseline they are compared against. That is why
 * the query set and a hash of its judgments are pinned in
 * `benchmarks/retrieval-queries.json`: a chunker change makes the hash move, and
 * the run says so instead of reporting a number nobody can compare.
 *
 * Usage:
 *   node scripts/bench/retrieval-quality.mjs            # measure and print
 *   node scripts/bench/retrieval-quality.mjs --record   # write baseline + pins
 *   node scripts/bench/retrieval-quality.mjs --check    # fail on regression
 *   node scripts/bench/retrieval-quality.mjs --check --fail-on-missing-metric
 *   node scripts/bench/retrieval-quality.mjs --check --require-baseline
 *
 * `--require-baseline` is accepted for symmetry with scripts/bench/gate.mjs,
 * where a missing baseline used to be a silent skip. HERE a missing baseline has
 * always been fatal, so the flag changes nothing — it just lets CI say what it
 * means with the same words at both gates.
 *
 * Requires: npm run build, and the corpus (npm run bench:corpus).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(ROOT, "benchmarks", "corpus", "unity-synth-v1-s");
const BASELINE = path.join(ROOT, "benchmarks", "retrieval-baseline.json");
/** The pinned query set + a hash of the judgments the chunker produced for it. */
const QUERIES = path.join(ROOT, "benchmarks", "retrieval-queries.json");
const DIST = path.join(ROOT, "dist");

/**
 * How far quality may drop before --check fails, in absolute metric points.
 *
 * Retrieval here is deterministic — same corpus, same index, same query set, no
 * sampling — so unlike the timing gate there is no measurement noise to absorb.
 * The tolerance exists only to allow rounding, which is why it is this tight:
 * any real movement is a real change and should be looked at.
 */
const TOLERANCE = 0.005;

const TOP_K = 10;
/** Queries are drawn deterministically, so a run is comparable to any other. */
const QUERY_COUNT = 60;

function loadCorpus() {
  if (!existsSync(CORPUS)) {
    console.error(`Corpus missing at ${CORPUS}\nRun: npm run bench:corpus`);
    process.exit(2);
  }
  const files = [];
  const scripts = path.join(CORPUS, "Assets", "Scripts");
  for (const name of readdirSync(scripts).sort()) {
    files.push({
      path: `Assets/Scripts/${name}`,
      content: readFileSync(path.join(scripts, name), "utf8"),
      lang: "csharp",
    });
  }
  const docs = path.join(CORPUS, "Docs");
  for (const name of readdirSync(docs).sort()) {
    files.push({
      path: `Docs/${name}`,
      content: readFileSync(path.join(docs, name), "utf8"),
      lang: "markdown",
    });
  }
  return files;
}

/**
 * Builds the query set and its relevance judgments.
 *
 * The generator draws method names from a 10x15 verb/noun vocabulary, so the
 * 150 distinct names each land in 10 to 38 of the ~450 files (median 20). That
 * is the right shape for measurement: ~20 relevant chunks among ~3,000 is a
 * task a retrieval engine can plausibly get wrong, unlike a unique class name
 * (trivial) or a term in every file (undiscriminating).
 *
 * A name declared in only one chunk is dropped — with a single answer the
 * metrics collapse to "did it rank first", which MRR already reports.
 */
function buildQueries(chunksByFile) {
  const declaringChunks = new Map(); // method -> Set(chunkId)
  const DECL = /public void ([A-Za-z]+)\(int id, float delta\)/g;

  for (const { chunks } of chunksByFile) {
    for (const chunk of chunks) {
      for (const m of chunk.content.matchAll(DECL)) {
        const name = m[1];
        if (!declaringChunks.has(name)) declaringChunks.set(name, new Set());
        declaringChunks.get(name).add(chunk.chunkId);
      }
    }
  }

  const usable = [...declaringChunks.entries()]
    .filter(([, ids]) => ids.size >= 2)
    .sort(([a], [b]) => a.localeCompare(b)) // deterministic order
    .slice(0, QUERY_COUNT);

  // Two families, because they measure different things and a single blended
  // number would hide the interesting one.
  //
  //   exact  the identifier as written (`UpdateBuff`) — a sanity check on the
  //          index; if this is not near-perfect something is badly broken.
  //   split  the identifier as a developer actually types it (`Update Buff`).
  //          FTS5's unicode61 tokenizer splits on non-alphanumerics only, so
  //          `UpdateBuff` is ONE token and neither `update` nor `buff` matches
  //          it. This is the number that says whether code search works for a
  //          human rather than for an exact-symbol lookup.
  return {
    exact: usable.map(([name, ids]) => ({ query: name, relevant: ids })),
    split: usable.map(([name, ids]) => ({ query: splitIdentifier(name), relevant: ids })),
  };
}

/** `UpdateBuff` -> `Update Buff`: how the same symbol gets typed into a search box. */
function splitIdentifier(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Binary-relevance nDCG: DCG over the ranking, divided by the ideal DCG. */
function ndcg(rankedIds, relevant, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    if (relevant.has(rankedIds[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * TRUE recall@k: of everything relevant, what fraction came back in the top k.
 *
 * The median query here has ~20 relevant chunks and k is 10, so this metric can
 * never reach 1.0 — which is exactly what makes it honest. Read it as "half the
 * answers is the ceiling at this k", not as a grade.
 */
function recall(rankedIds, relevant, k) {
  const hits = rankedIds.slice(0, k).filter((id) => relevant.has(id)).length;
  return relevant.size === 0 ? 0 : hits / relevant.size;
}

/**
 * CAPPED recall@k: divided by `min(|relevant|, k)` instead of `|relevant|`.
 *
 * This was the only recall reported, under the name `recall10`, and it reads as
 * a perfect score the moment the top k are all relevant — even when 10 of 20
 * relevant chunks were never returned. Useful (it isolates "did we fill the
 * page with relevant results" from "there are more answers than slots"), but
 * never on its own: a capped 1.0 beside a true 0.5 is the whole story.
 */
function recallCapped(rankedIds, relevant, k) {
  const hits = rankedIds.slice(0, k).filter((id) => relevant.has(id)).length;
  return relevant.size === 0 ? 0 : hits / Math.min(relevant.size, k);
}

function reciprocalRank(rankedIds, relevant) {
  const i = rankedIds.findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

/**
 * The identity of the measurement: which queries were asked, and which chunks
 * the chunker decided are the right answers.
 *
 * `queries` is the human-readable part (the strings, and how many chunks each
 * one is expected to match). `judgmentsHash` covers the chunk IDS themselves,
 * so it moves the moment the chunker splits a file differently — the drift that
 * would otherwise quietly redefine every metric.
 */
function groundTruthPins(families) {
  const lines = [];
  const queries = [];
  for (const [family, entries] of Object.entries(families)) {
    for (const { query, relevant } of entries) {
      const ids = [...relevant].sort();
      lines.push(`${family}\t${query}\t${ids.join(",")}`);
      queries.push({ family, query, relevantChunks: ids.length });
    }
  }
  return {
    queries,
    judgmentsHash: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32),
  };
}

/**
 * Compare this run's query set and judgments against the pinned ones.
 *
 * Returns a list of human-readable differences; empty means the run is asking
 * the same question the pins describe.
 */
function comparePins(pinned, current) {
  const problems = [];
  const pinnedQ = pinned.queries ?? [];
  const key = (q) => `${q.family}/${q.query}`;
  const pinnedKeys = pinnedQ.map(key).join("|");
  const currentKeys = current.queries.map(key).join("|");
  if (pinnedKeys !== currentKeys) {
    problems.push(
      `the QUERY SET changed: ${pinnedQ.length} pinned, ${current.queries.length} derived. ` +
      "The corpus generator or the query derivation moved; re-record deliberately.",
    );
    return problems;
  }
  if (pinned.judgmentsHash !== current.judgmentsHash) {
    const moved = current.queries.filter((q, i) => q.relevantChunks !== pinnedQ[i]?.relevantChunks);
    problems.push(
      `the GROUND TRUTH changed (judgments ${pinned.judgmentsHash} -> ${current.judgmentsHash}). ` +
      `The chunker now splits the corpus differently, so the relevant-chunk ids moved` +
      (moved.length > 0
        ? `, and ${moved.length} query/queries changed how many chunks they match (e.g. ` +
          moved.slice(0, 3).map((q) => `${q.family}/${q.query}: ${pinnedQ[current.queries.indexOf(q)]?.relevantChunks} -> ${q.relevantChunks}`).join("; ") + ")"
        : " (counts unchanged, boundaries moved)") +
      ". Every metric below answers a different question than the baseline. Re-record deliberately.",
    );
  }
  return problems;
}

// By file URL: import() of a bare absolute path fails on Windows
// (ERR_UNSUPPORTED_ESM_URL_SCHEME for "C:\\...").
const importDist = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);

async function measure() {
  const { chunkFile } = await importDist("vault/chunker.js");
  const { SqliteVaultStore } = await importDist("vault/sqlite-vault-store.js");
  const { createLogger } = await importDist("utils/logger.js");
  // MEASURE WHAT THE PRODUCT DOES: the vault builds its MATCH expression with
  // escapeFtsQuery, so a benchmark that hands searchFts a raw string measures a
  // path no user takes (plan 6.7).
  const { escapeFtsQuery } = await importDist("vault/fts-query.js");
  createLogger("error", "retrieval.log");

  const corpus = loadCorpus();
  const chunksByFile = corpus.map((file) => ({ file, chunks: chunkFile(file) }));

  const dir = mkdtempSync(path.join(tmpdir(), "strada-retr-"));
  const store = new SqliteVaultStore(path.join(dir, "index.db"));
  try {
    store.migrate();
    for (const { file, chunks } of chunksByFile) {
      store.upsertFile({
        path: file.path, blobHash: file.path, mtimeMs: 0,
        size: file.content.length, lang: file.lang,
        kind: file.lang === "markdown" ? "doc" : "source", indexedAt: 0,
      });
      for (const c of chunks) store.upsertChunk(c);
    }

    const families = buildQueries(chunksByFile);
    if (families.exact.length === 0) {
      console.error("No usable queries derived from the corpus — the generator's shape changed.");
      process.exit(2);
    }

    const scored = {};
    for (const [family, queries] of Object.entries(families)) {
      let sumNdcg = 0, sumRecall = 0, sumCapped = 0, sumRr = 0, zeroHit = 0;
      for (const { query, relevant } of queries) {
        const ranked = store.searchFts(escapeFtsQuery(query), TOP_K).map((h) => h.chunkId);
        sumNdcg += ndcg(ranked, relevant, TOP_K);
        sumRecall += recall(ranked, relevant, TOP_K);
        sumCapped += recallCapped(ranked, relevant, TOP_K);
        sumRr += reciprocalRank(ranked, relevant);
        if (!ranked.some((id) => relevant.has(id))) zeroHit++;
      }
      const n = queries.length;
      scored[family] = {
        // Rounded to the tolerance's precision so a recorded baseline is stable.
        ndcg10: Number((sumNdcg / n).toFixed(4)),
        // Both recalls, always. See recall()/recallCapped(): the capped number
        // alone read as a good run while half the answers were missing.
        recall10: Number((sumRecall / n).toFixed(4)),
        recallCapped10: Number((sumCapped / n).toFixed(4)),
        mrr: Number((sumRr / n).toFixed(4)),
        // The count that matters operationally: queries where the user sees
        // nothing relevant at all in the top 10.
        zeroHitQueries: zeroHit,
      };
    }

    return {
      corpus: "unity-synth-v1-s",
      chunks: chunksByFile.reduce((a, c) => a + c.chunks.length, 0),
      queries: families.exact.length,
      topK: TOP_K,
      /** Identity of the question these numbers answer — see checkPins(). */
      groundTruth: groundTruthPins(families),
      families: scored,
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const METRICS = [
  ["ndcg10", "nDCG@10"],
  ["recall10", "Recall@10"],
  ["recallCapped10", "Recall@10cap"],
  ["mrr", "MRR"],
];

const FAMILY_LABEL = {
  exact: "exact identifier   (UpdateBuff)",
  split: "as a human types it (Update Buff)",
};

function report(r) {
  console.log(`corpus ${r.corpus}: ${r.chunks} chunks, ${r.queries} queries per family, top-${r.topK}`);
  console.log(`judgments ${r.groundTruth.judgmentsHash} (chunker-derived; pinned in ${path.relative(ROOT, QUERIES)})`);
  for (const [family, m] of Object.entries(r.families)) {
    console.log(`\n  ${FAMILY_LABEL[family] ?? family}`);
    for (const [key, label] of METRICS) console.log(`    ${label.padEnd(13)} ${m[key].toFixed(4)}`);
    console.log(`    ${"zero-hit".padEnd(13)} ${m.zeroHitQueries} / ${r.queries} queries`);
  }
  console.log(
    "\n  Recall@10 is the true fraction of relevant chunks returned; Recall@10cap divides by\n" +
    "  min(relevant, 10), so it can read 1.0 while half the answers were never returned.",
  );
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const result = await measure();
report(result);

if (flag("--record")) {
  // The baseline carries only the IDENTITY of the ground truth (its hash); the
  // query list itself lives in the pin file, so the two do not duplicate 600
  // lines of JSON and a diff on either one says what it means.
  writeFileSync(
    BASELINE,
    JSON.stringify({ ...result, groundTruth: { judgmentsHash: result.groundTruth.judgmentsHash } }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    QUERIES,
    JSON.stringify(
      {
        _: "Pinned query set and the hash of the judgments the chunker derived for it. "
          + "A moved hash means the chunker changed what counts as a right answer, so the "
          + "metrics no longer answer the baseline's question. Re-record deliberately.",
        corpus: result.corpus,
        topK: result.topK,
        chunks: result.chunks,
        ...result.groundTruth,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nBaseline written to ${path.relative(ROOT, BASELINE)}`);
  console.log(`Query pins written to ${path.relative(ROOT, QUERIES)}`);
  process.exit(0);
}

if (flag("--check")) {
  // --require-baseline exists for CI: a gate that skips itself when its own
  // reference file is absent protects nothing, and the absence is silent.
  // (This gate has always failed on a missing baseline; the flag makes the
  // requirement explicit and keeps the two bench gates' vocabulary the same.)
  if (!existsSync(BASELINE)) {
    console.error(`\nNo baseline at ${path.relative(ROOT, BASELINE)} — run with --record first.`);
    process.exit(2);
  }
  if (!existsSync(QUERIES)) {
    console.error(
      `\nNo pinned query set at ${path.relative(ROOT, QUERIES)} — without it a chunker change ` +
      "silently rewrites the ground truth. Run with --record first.",
    );
    process.exit(2);
  }

  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const pinned = JSON.parse(readFileSync(QUERIES, "utf8"));
  const failures = [];

  // A different corpus or query set would make the comparison meaningless, so
  // treat that as a hard error rather than a quality regression.
  if (base.corpus !== result.corpus || base.queries !== result.queries) {
    console.error(
      `\nBaseline is not comparable: recorded ${base.corpus}/${base.queries} queries, ` +
      `measured ${result.corpus}/${result.queries}. Re-record deliberately.`,
    );
    process.exit(2);
  }

  // THE GROUND TRUTH ITSELF. Not a quality regression — a change in what is
  // being measured, which makes every comparison below meaningless.
  const pinProblems = comparePins(pinned, result.groundTruth);
  if (pinProblems.length > 0) {
    console.error(`\nThe measurement changed, not just the result:\n${pinProblems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(2);
  }
  if (base.groundTruth && base.groundTruth.judgmentsHash !== result.groundTruth.judgmentsHash) {
    console.error(
      `\nBaseline was recorded against different judgments ` +
      `(${base.groundTruth.judgmentsHash} vs ${result.groundTruth.judgmentsHash}). Re-record deliberately.`,
    );
    process.exit(2);
  }

  // A metric the baseline does not carry used to compare as NaN, and
  // `NaN < -TOLERANCE` is false — so adding a metric made it un-gated, silently,
  // for as long as nobody re-recorded. Say so; fail on it when asked to.
  const missingMetrics = [];

  for (const [family, m] of Object.entries(result.families)) {
    const b = base.families?.[family];
    if (!b) { failures.push(`family "${family}" is missing from the baseline`); continue; }
    for (const [key, label] of METRICS) {
      if (typeof b[key] !== "number") {
        missingMetrics.push(`${family}/${label} (measured ${m[key].toFixed(4)}, nothing recorded)`);
        continue;
      }
      const delta = m[key] - b[key];
      if (delta < -TOLERANCE) {
        failures.push(`${family}/${label} ${b[key].toFixed(4)} -> ${m[key].toFixed(4)} (${delta.toFixed(4)})`);
      }
    }
    if (typeof b.zeroHitQueries !== "number") {
      missingMetrics.push(`${family}/zero-hit (measured ${m.zeroHitQueries}, nothing recorded)`);
    } else if (m.zeroHitQueries > b.zeroHitQueries) {
      failures.push(`${family}/zero-hit ${b.zeroHitQueries} -> ${m.zeroHitQueries}`);
    }
  }

  if (missingMetrics.length > 0) {
    const how = flag("--fail-on-missing-metric")
      ? "failing, as --fail-on-missing-metric requires"
      : "NOT GATED (pass --fail-on-missing-metric to make this fatal)";
    const lines = missingMetrics.map((m) => `  ${m}`).join("\n");
    if (flag("--fail-on-missing-metric")) {
      failures.push(...missingMetrics.map((m) => `${m}: no baseline number to compare against`));
    }
    console.error(`\n${missingMetrics.length} metric(s) missing from the baseline — ${how}:\n${lines}`);
  }

  if (failures.length > 0) {
    console.error(`\nRetrieval quality regressed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nNo regression against the baseline (tolerance ${TOLERANCE}).`);
}
