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
 * Usage:
 *   node scripts/bench/retrieval-quality.mjs            # measure and print
 *   node scripts/bench/retrieval-quality.mjs --record   # write the baseline
 *   node scripts/bench/retrieval-quality.mjs --check    # fail on regression
 *
 * Requires: npm run build, and the corpus (npm run bench:corpus).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(ROOT, "benchmarks", "corpus", "unity-synth-v1-s");
const BASELINE = path.join(ROOT, "benchmarks", "retrieval-baseline.json");
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

function recall(rankedIds, relevant, k) {
  const hits = rankedIds.slice(0, k).filter((id) => relevant.has(id)).length;
  return relevant.size === 0 ? 0 : hits / Math.min(relevant.size, k);
}

function reciprocalRank(rankedIds, relevant) {
  const i = rankedIds.findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

async function measure() {
  const { chunkFile } = await import(path.join(DIST, "vault/chunker.js"));
  const { SqliteVaultStore } = await import(path.join(DIST, "vault/sqlite-vault-store.js"));
  const { createLogger } = await import(path.join(DIST, "utils/logger.js"));
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
      let sumNdcg = 0, sumRecall = 0, sumRr = 0, zeroHit = 0;
      for (const { query, relevant } of queries) {
        const ranked = store.searchFts(query, TOP_K).map((h) => h.chunkId);
        sumNdcg += ndcg(ranked, relevant, TOP_K);
        sumRecall += recall(ranked, relevant, TOP_K);
        sumRr += reciprocalRank(ranked, relevant);
        if (!ranked.some((id) => relevant.has(id))) zeroHit++;
      }
      const n = queries.length;
      scored[family] = {
        // Rounded to the tolerance's precision so a recorded baseline is stable.
        ndcg10: Number((sumNdcg / n).toFixed(4)),
        recall10: Number((sumRecall / n).toFixed(4)),
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
  ["mrr", "MRR"],
];

const FAMILY_LABEL = {
  exact: "exact identifier   (UpdateBuff)",
  split: "as a human types it (Update Buff)",
};

function report(r) {
  console.log(`corpus ${r.corpus}: ${r.chunks} chunks, ${r.queries} queries per family, top-${r.topK}`);
  for (const [family, m] of Object.entries(r.families)) {
    console.log(`\n  ${FAMILY_LABEL[family] ?? family}`);
    for (const [key, label] of METRICS) console.log(`    ${label.padEnd(12)} ${m[key].toFixed(4)}`);
    console.log(`    ${"zero-hit".padEnd(12)} ${m.zeroHitQueries} / ${r.queries} queries`);
  }
}

const argv = process.argv.slice(2);
const result = await measure();
report(result);

if (argv.includes("--record")) {
  writeFileSync(BASELINE, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`\nBaseline written to ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

if (argv.includes("--check")) {
  if (!existsSync(BASELINE)) {
    console.error(`\nNo baseline at ${path.relative(ROOT, BASELINE)} — run with --record first.`);
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
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

  for (const [family, m] of Object.entries(result.families)) {
    const b = base.families?.[family];
    if (!b) { failures.push(`family "${family}" is missing from the baseline`); continue; }
    for (const [key, label] of METRICS) {
      const delta = m[key] - b[key];
      if (delta < -TOLERANCE) {
        failures.push(`${family}/${label} ${b[key].toFixed(4)} -> ${m[key].toFixed(4)} (${delta.toFixed(4)})`);
      }
    }
    if (m.zeroHitQueries > b.zeroHitQueries) {
      failures.push(`${family}/zero-hit ${b.zeroHitQueries} -> ${m.zeroHitQueries}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nRetrieval quality regressed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nNo regression against the baseline (tolerance ${TOLERANCE}).`);
}
