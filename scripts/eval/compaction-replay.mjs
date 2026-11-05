#!/usr/bin/env node
/**
 * compaction-replay.mjs — offline A/B of history compaction strategies:
 * today's pipeline (src/agents/session-compaction.ts) against the
 * threshold-cliff design (src/agents/compaction-replay/threshold-cliff.ts),
 * over recorded sessions, without touching the live loop.
 *
 * Every rewrite of the history breaks the provider's prefix cache, and a
 * cached token costs about a fiftieth of an uncached one, so fewer tokens can
 * cost more (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md).
 * For each strategy this prints the number of compaction events, the input
 * tokens sent, and the cost at cached and uncached prices. Caching is
 * simulated by byte-prefix matching.
 *
 * Two inputs:
 * - the daemon log (default). No store keeps message content, so the sessions
 *   are rebuilt from the "Provider call" and "Tool call" lines. Their sizes are
 *   real and their content is placeholder text. The report says so in its
 *   first line ("shape replay").
 * - --transcript <file>: recorded sessions with their content, in the format
 *   src/agents/compaction-replay/transcript.ts reads. The arms and the report
 *   are the same.
 *
 * Read-only: the log, its rotated archives and the transcript are only read.
 *
 * Exit codes: 0 the report was printed · 2 bad invocation, or no input at the
 * path · 3 not measured (no call could be replayed).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { defaultPaths, logFiles, parseLogTime } from "./north-star-scorecard.mjs";

export const EXIT = Object.freeze({ PRINTED: 0, USAGE: 2, NOT_MEASURED: 3 });

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..", "..");
const TSX_GUARD = "STRADA_COMPACTION_REPLAY_TSX";

/** trigger:floor:minimum reclaim, in conversation tokens. */
export const DEFAULT_CLIFF = "48000:16000:8000";
/** The worker provider's cached-to-uncached price ratio (the memory entry above). */
const DEFAULT_CACHED_RATIO = 1 / 50;

const HELP = `compaction-replay.mjs — compaction A/B, offline: current pipeline vs threshold cliff

Usage: node scripts/eval/compaction-replay.mjs [--log <path> | --transcript <file>] [options]

  --log <path>            the daemon log (default: LOG_FILE under the runtime home); rotated archives beside it are read too
  --transcript <file>     replay recorded sessions with their content instead of the log's shapes
  --since <time>          only log lines at or after this time ("2026-11-05 14:00:00", local, as the log writes it)
  --context-window <n>    the window the live decision plans against (default: the live default)
  --cliff <t:f[:m]>       a cliff arm: trigger t, floor f, minimum reclaim m, in conversation tokens
                          (repeatable; default ${DEFAULT_CLIFF}; m defaults to (t - f) / 4)
  --price-uncached <p>    price per million uncached input tokens (with --price-cached; default: relative units)
  --price-cached <p>      price per million cached input tokens
  --json                  print the report as JSON`;

const isPositiveInt = (v) => /^\d+$/.test(v) && Number(v) > 0;

/** "48000:16000[:8000]" as cliff options, or an error string. */
export function parseCliff(spec) {
  const parts = String(spec).split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) {
    return { error: `--cliff wants trigger:floor[:minReclaim] in tokens, not "${spec}"` };
  }
  const [triggerTokens, floorTokens, minReclaim] = parts.map(Number);
  if (!(triggerTokens > floorTokens)) return { error: `--cliff: the trigger must be above the floor, not "${spec}"` };
  const minReclaimTokens = minReclaim ?? Math.round((triggerTokens - floorTokens) / 4);
  return { cliff: { triggerTokens, floorTokens, minReclaimTokens } };
}

const VALUE_FLAGS = new Set(["--log", "--transcript", "--since", "--context-window", "--cliff", "--price-uncached", "--price-cached"]);

export function parseArgs(argv) {
  const args = { json: false, help: false, cliffSpecs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--cliff") args.cliffSpecs.push(v);
      else args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    } else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return validateArgs(args);
}

function validateArgs(args) {
  if (args.log !== undefined && args.transcript !== undefined) return { error: "--log and --transcript are exclusive" };
  if (args.since !== undefined && !Number.isFinite(parseLogTime(args.since))) return { error: `--since: not a time: ${args.since}` };
  if (args.contextWindow !== undefined && !isPositiveInt(args.contextWindow)) return { error: `--context-window: not a positive integer: ${args.contextWindow}` };
  if ((args.priceUncached === undefined) !== (args.priceCached === undefined)) return { error: "--price-uncached and --price-cached go together" };
  for (const flag of ["priceUncached", "priceCached"]) {
    if (args[flag] !== undefined && !(Number(args[flag]) >= 0)) return { error: `--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: not a price: ${args[flag]}` };
  }
  const cliffs = [];
  for (const spec of args.cliffSpecs.length > 0 ? args.cliffSpecs : [DEFAULT_CLIFF]) {
    const parsed = parseCliff(spec);
    if (parsed.error) return { error: parsed.error };
    cliffs.push(parsed.cliff);
  }
  return { ...args, cliffs };
}

/** Every line of the log and its archives, oldest first; a file that cannot be read is named. */
export function readLogLines(path) {
  const files = [];
  const lines = [];
  for (const file of logFiles(path)) {
    try {
      const text = file.gz ? gunzipSync(readFileSync(file.path)).toString("utf8") : readFileSync(file.path, "utf8");
      for (const line of text.split("\n")) lines.push(line);
      files.push({ path: file.path, cause: null });
    } catch (err) {
      files.push({ path: file.path, cause: err instanceof Error ? err.message : String(err) });
    }
  }
  return { files, lines };
}

async function loadReplay() {
  const load = (name) => import(new URL(`../../src/agents/compaction-replay/${name}.ts`, import.meta.url).href);
  const [skeleton, transcript, replay, report, compaction] = await Promise.all([
    load("log-skeleton"),
    load("transcript"),
    load("replay"),
    load("report"),
    import(new URL("../../src/agents/session-compaction.ts", import.meta.url).href),
  ]);
  return { ...skeleton, ...transcript, ...replay, ...report, DEFAULT_CONTEXT_WINDOW: compaction.DEFAULT_CONTEXT_WINDOW };
}

/**
 * Plain node cannot resolve src/'s .js specifiers onto .ts files, so the
 * harness re-execs itself once under tsx and forwards the child's exit code.
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

const k = (tokens) => (tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens));

export function armsFor(cliffs) {
  return [
    { name: "append-only (reference)", kind: "append-only" },
    { name: "current (session-compaction.ts)", kind: "current" },
    ...cliffs.map((c) => ({ name: `cliff ${k(c.triggerTokens)}->${k(c.floorTokens)}, min ${k(c.minReclaimTokens)}`, kind: "cliff", cliff: c })),
  ];
}

function priceOf(args) {
  if (args.priceUncached === undefined) {
    return { priceUncached: 1, priceCached: DEFAULT_CACHED_RATIO, priceNote: "relative (1 = one uncached token; a cached one costs 1/50)" };
  }
  return {
    priceUncached: Number(args.priceUncached) / 1e6,
    priceCached: Number(args.priceCached) / 1e6,
    priceNote: `${args.priceUncached} / ${args.priceCached} per million tokens (uncached / cached)`,
  };
}

/** The sessions to replay, from the transcript or the log, or a usage error. */
function readInput(args, m) {
  if (args.transcript !== undefined) {
    if (!existsSync(args.transcript)) return { error: `no transcript at ${args.transcript}` };
    let sessions;
    try {
      sessions = m.parseTranscript(JSON.parse(readFileSync(args.transcript, "utf8")));
    } catch (err) {
      return { error: `${args.transcript}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { source: "transcript", inputs: [args.transcript], sessions };
  }
  const log = args.log ?? defaultPaths().log;
  if (!existsSync(log)) return { error: `no daemon log at ${log} (--log names another)` };
  const { files, lines } = readLogLines(log);
  for (const f of files) if (f.cause) console.error(`could not read ${f.path}: ${f.cause}`);
  const sinceMs = args.since === undefined ? undefined : parseLogTime(args.since);
  const accept = sinceMs === undefined ? undefined : (entry) => parseLogTime(entry.timestamp) >= sinceMs;
  const { sessions, stats } = m.buildSkeleton(lines, accept);
  return { source: "shape", inputs: files.filter((f) => !f.cause).map((f) => f.path), sessions, skeleton: stats };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error(HELP);
    return EXIT.USAGE;
  }
  if (args.help) {
    console.log(HELP);
    return EXIT.PRINTED;
  }
  let m;
  try {
    m = await loadReplay();
  } catch (err) {
    if (!process.env[TSX_GUARD]) return reExecUnderTsx(argv);
    console.error(`NOT MEASURED: the replay modules could not be loaded — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.NOT_MEASURED;
  }
  const input = readInput(args, m);
  if (input.error) {
    console.error(input.error);
    return EXIT.USAGE;
  }
  const contextWindow = args.contextWindow === undefined ? m.DEFAULT_CONTEXT_WINDOW : Number(args.contextWindow);
  const { priceNote, ...prices } = priceOf(args);
  const arms = armsFor(args.cliffs).map((arm) => m.replayArm(arm, input.sessions, { contextWindow, ...prices }));
  const report = {
    source: input.source,
    inputs: input.inputs,
    contextWindow,
    priceNote,
    arms,
    fidelity: m.replayFidelity(input.sessions),
    churn: m.headChurn(input.sessions),
    ...(input.skeleton ? { skeleton: input.skeleton } : {}),
  };
  process.stdout.write(args.json ? `${JSON.stringify({ ...report, notMeasured: m.NOT_MEASURED }, null, 2)}\n` : `${m.formatReport(report)}\n`);
  if ((arms[0]?.calls ?? 0) > 0) return EXIT.PRINTED;
  console.error("NOT MEASURED: no call could be replayed from this input");
  return EXIT.NOT_MEASURED;
}

// Node runs the entry module from its realpath while argv[1] keeps the path as
// typed: compare both resolved, or a symlinked checkout skips main().
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = EXIT.USAGE;
    },
  );
}
