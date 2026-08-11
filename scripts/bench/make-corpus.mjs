#!/usr/bin/env node
/**
 * Deterministic benchmark corpus generator.
 *
 * Benchmarks are only comparable if the input is byte-identical every time, on
 * every machine. This synthesizes a Unity-shaped C# corpus from a fixed seed —
 * no network, no repository checkout, no dependency on whatever happens to be
 * on disk.
 *
 * Usage:
 *   node scripts/bench/make-corpus.mjs [--size S|M|L] [--out <dir>] [--check]
 *
 * `--check` regenerates into a temp dir and compares the content hash against
 * the manifest, so CI can prove the corpus is reproducible before trusting any
 * timing measured against it.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = path.join(ROOT, "benchmarks", "corpus", "unity-synth-v1");

/** Sizes chosen so S runs in a per-PR job and L still fits in memory. */
const SIZES = { S: 500, M: 2000, L: 8000 };

/** xorshift32 — tiny, deterministic, and identical across Node versions
 *  (Math.random is neither seedable nor stable, so it cannot be used here). */
function makeRng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

const NOUNS = ["Player", "Inventory", "Enemy", "Quest", "Weapon", "Damping", "Spawner",
  "Camera", "Audio", "Save", "Network", "Pool", "Grid", "Path", "Buff"];
const VERBS = ["Update", "Apply", "Resolve", "Compute", "Reset", "Spawn", "Despawn",
  "Serialize", "Validate", "Tick"];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

/** One MonoBehaviour-shaped file with a realistic method/field mix. */
function makeCsFile(rng, index) {
  const cls = `${pick(rng, NOUNS)}${pick(rng, NOUNS)}${index}`;
  const methods = 3 + Math.floor(rng() * 8);
  const lines = [
    "using UnityEngine;",
    "using System.Collections.Generic;",
    "",
    "namespace Strada.Generated {",
    `    /// <summary>${pick(rng, VERBS)} the ${pick(rng, NOUNS).toLowerCase()} state.</summary>`,
    `    public class ${cls} : MonoBehaviour {`,
    `        [SerializeField] private float ${pick(rng, NOUNS).toLowerCase()}Damping = ${(rng() * 2).toFixed(3)}f;`,
    `        private readonly List<int> _pending = new List<int>();`,
    "",
  ];
  for (let m = 0; m < methods; m++) {
    const name = `${pick(rng, VERBS)}${pick(rng, NOUNS)}`;
    lines.push(`        public void ${name}(int id, float delta) {`);
    lines.push(`            // ${pick(rng, VERBS).toLowerCase()} ${pick(rng, NOUNS).toLowerCase()} for id ${"{id}"}`);
    lines.push(`            if (delta > ${(rng()).toFixed(3)}f) { _pending.Add(id); }`);
    lines.push(`            ${pick(rng, NOUNS).toLowerCase()}Damping = Mathf.Lerp(${pick(rng, NOUNS).toLowerCase()}Damping, delta, 0.5f);`);
    lines.push("        }");
    lines.push("");
  }
  lines.push("    }", "}", "");
  return { name: `${cls}.cs`, content: lines.join("\n") };
}

/** A handful of markdown docs, so retrieval has a non-code language to filter against. */
function makeMdFile(rng, index) {
  return {
    name: `doc-${index}.md`,
    content: [
      `# ${pick(rng, NOUNS)} notes ${index}`,
      "",
      `The ${pick(rng, NOUNS).toLowerCase()} system applies damping when the ${pick(rng, NOUNS).toLowerCase()} updates.`,
      `See also: ${pick(rng, VERBS).toLowerCase()} and ${pick(rng, VERBS).toLowerCase()}.`,
      "",
    ].join("\n"),
  };
}

function generate(outDir, fileCount, seed = 0x5747A11) {
  rmSync(outDir, { recursive: true, force: true });
  const scripts = path.join(outDir, "Assets", "Scripts");
  const docs = path.join(outDir, "Docs");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(docs, { recursive: true });

  const rng = makeRng(seed);
  const hash = createHash("sha256");
  const mdCount = Math.max(5, Math.floor(fileCount * 0.05));

  for (let i = 0; i < fileCount - mdCount; i++) {
    const f = makeCsFile(rng, i);
    writeFileSync(path.join(scripts, f.name), f.content, "utf8");
    hash.update(f.name).update(f.content);
  }
  for (let i = 0; i < mdCount; i++) {
    const f = makeMdFile(rng, i);
    writeFileSync(path.join(docs, f.name), f.content, "utf8");
    hash.update(f.name).update(f.content);
  }
  return hash.digest("hex");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const size = String(arg("--size", "S")).toUpperCase();
if (!SIZES[size]) {
  console.error(`unknown --size ${size} (expected one of ${Object.keys(SIZES).join(", ")})`);
  process.exit(2);
}
const fileCount = SIZES[size];
const check = argv.includes("--check");
const outDir = arg("--out", `${DEFAULT_OUT}-${size.toLowerCase()}`);
const manifestPath = path.join(ROOT, "benchmarks", "corpus", "manifest.json");

if (check) {
  const tmp = path.join(tmpdir(), `strada-corpus-check-${size}`);
  const got = generate(tmp, fileCount);
  rmSync(tmp, { recursive: true, force: true });
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  const want = manifest[size]?.sha256;
  if (!want) {
    console.error(`[bench] no recorded hash for size ${size}; run without --check first`);
    process.exit(1);
  }
  if (want !== got) {
    console.error(`[bench] corpus is NOT reproducible for size ${size}\n  expected ${want}\n  got      ${got}`);
    process.exit(1);
  }
  console.log(`[bench] corpus ${size} reproducible (${got.slice(0, 12)}…)`);
  process.exit(0);
}

const sha256 = generate(outDir, fileCount);
mkdirSync(path.dirname(manifestPath), { recursive: true });
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
manifest[size] = { files: fileCount, sha256, outDir: path.relative(ROOT, outDir) };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[bench] generated ${fileCount} files → ${path.relative(ROOT, outDir)} (sha256 ${sha256.slice(0, 12)}…)`);
