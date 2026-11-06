#!/usr/bin/env node
/**
 * cache-hit-report.mjs — how much of each kind of provider call's input the
 * provider served from its prefix cache, read from the daemon log.
 *
 * On the worker's provider a cached input token costs about a fiftieth of an
 * uncached one, so whether a history compaction saves money or spends it
 * depends on the hit rate, and no one knew it
 * (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md).
 * Every model call writes one "Provider call" line (provider-call-log.ts,
 * fallback-chain.ts) with its label, provider and input tokens, and since
 * 75167cd2 the cached share of them. This adds them up per label and provider.
 *
 * What it measures, and what it leaves out:
 * - Hit rate = cached input tokens / input tokens, over the calls whose line
 *   reported input tokens. Failed calls carry no usage and are not read.
 * - A line without `cachedInputTokens` counts as zero cached, and is counted
 *   on its own. Since 2026-11-06 the OpenAI-compatible parsers write a miss
 *   the provider reports as `cachedInputTokens: 0`, with `cacheField` naming
 *   the provider's field, so a group of misses rates 0%. A group where no line
 *   carries the field has no rate ("not measured"): its provider sent no cache
 *   field, or its lines predate that change, when a miss also left no field
 *   (and lines written before 75167cd2 never carry it).
 * - The agent loop's "turn" line and the fallback chain's "streaming"/"chat"
 *   line can describe the same call, so no total is summed across labels.
 *
 * Read-only: the log and its rotated archives are only read.
 *
 * Usage:
 *   node scripts/eval/cache-hit-report.mjs [--log <path>] [--since <time>] [--json]
 *
 * Exit codes: 0 the report was printed (whatever it says) · 2 bad invocation
 * or no log at the path.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { defaultPaths, logFiles, parseLogTime } from "./north-star-scorecard.mjs";

export const EXIT = Object.freeze({ PRINTED: 0, USAGE: 2 });

const PROVIDER_CALL = "Provider call";

const HELP = `cache-hit-report.mjs — prefix-cache hit rate per call type, from the daemon log

Usage: node scripts/eval/cache-hit-report.mjs [--log <path>] [--since <time>] [--json]

  --log <path>    the daemon log (default: LOG_FILE under the runtime home); rotated archives beside it are read too
  --since <time>  only calls logged at or after this time ("2026-11-05 14:00:00", local, as the log writes it)
  --json          print the report as JSON`;

export function parseArgs(argv) {
  const args = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log" || a === "--since") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      args[a.slice(2)] = v;
    } else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (args.since !== undefined && !Number.isFinite(parseLogTime(args.since))) {
    return { error: `--since: not a time: ${args.since}` };
  }
  return args;
}

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Every successful provider call in the log and its archives, oldest first,
 * at or after `sinceMs` when one is given. A file that cannot be read is
 * named, not skipped.
 */
export function readProviderCalls(path, sinceMs) {
  const files = [];
  const calls = [];
  for (const file of logFiles(path)) {
    let text;
    try {
      text = file.gz ? gunzipSync(readFileSync(file.path)).toString("utf8") : readFileSync(file.path, "utf8");
    } catch (err) {
      files.push({ path: file.path, cause: err instanceof Error ? err.message : String(err) });
      continue;
    }
    files.push({ path: file.path, cause: null });
    for (const line of text.split("\n")) {
      if (!line.startsWith("{") || !line.includes(`"${PROVIDER_CALL}"`)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.message !== PROVIDER_CALL) continue;
      if (sinceMs !== undefined && !(parseLogTime(entry.timestamp) >= sinceMs)) continue;
      calls.push({
        label: typeof entry.label === "string" ? entry.label : "(no label)",
        provider: typeof entry.provider === "string" ? entry.provider : "(no provider)",
        inputTokens: isCount(entry.inputTokens) ? entry.inputTokens : undefined,
        cachedInputTokens: isCount(entry.cachedInputTokens) ? entry.cachedInputTokens : undefined,
        cacheField: typeof entry.cacheField === "string" ? entry.cacheField : undefined,
      });
    }
  }
  return { files, calls };
}

/**
 * The calls grouped by label and provider, with each group's hit rate (null
 * when not measured) and the provider field names its cache shares came in.
 */
export function cacheHitReport(calls) {
  const groups = new Map();
  for (const call of calls) {
    const key = `${call.label}\u0000${call.provider}`;
    let g = groups.get(key);
    if (!g) {
      g = { label: call.label, provider: call.provider, calls: 0, withUsage: 0, withCacheField: 0, inputTokens: 0, cachedInputTokens: 0, cacheFields: new Set() };
      groups.set(key, g);
    }
    g.calls++;
    if (call.inputTokens === undefined) continue;
    g.withUsage++;
    g.inputTokens += call.inputTokens;
    if (call.cachedInputTokens === undefined) continue;
    g.withCacheField++;
    g.cachedInputTokens += call.cachedInputTokens;
    if (call.cacheField !== undefined) g.cacheFields.add(call.cacheField);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      cacheFields: [...g.cacheFields].sort(),
      hitRate: g.withCacheField > 0 && g.inputTokens > 0 ? g.cachedInputTokens / g.inputTokens : null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || b.inputTokens - a.inputTokens);
}

const NOTES = [
  "hit rate = cached / input tokens over the calls that reported usage; a call without the cache field counts as 0 cached.",
  "not measured = no call in the group carried cachedInputTokens: the provider sent no cache field, or the lines predate 2026-11-06, when a miss left none either.",
  "cache field = the provider's own field name(s) the cached share came in; - when no line named one.",
  '"turn" and the fallback chain\'s "streaming"/"chat" lines can describe the same call: do not add rows across labels.',
];

export function formatReport({ log, since, files, groups }) {
  const n = (v) => v.toLocaleString("en-US");
  const out = [`Prefix-cache hit rate by call type — ${log}${since ? ` · since ${since}` : ""}`];
  for (const f of files) if (f.cause) out.push(`could not read ${f.path}: ${f.cause}`);
  if (groups.length === 0) {
    out.push(`no "${PROVIDER_CALL}" line in ${files.length} file(s) read`);
    return out.join("\n");
  }
  const header = ["label", "provider", "calls", "with usage", "with cache field", "input tokens", "cached tokens", "hit rate", "cache field"];
  const rows = groups.map((g) => [
    g.label,
    g.provider,
    n(g.calls),
    n(g.withUsage),
    n(g.withCacheField),
    n(g.inputTokens),
    n(g.cachedInputTokens),
    g.hitRate === null ? "not measured" : `${(100 * g.hitRate).toFixed(1)}%`,
    g.cacheFields.length === 0 ? "-" : g.cacheFields.join(", "),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const text = new Set([0, 1, header.length - 1]);
  const render = (cells) => cells.map((c, i) => (text.has(i) ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd();
  out.push("", render(header), ...rows.map(render), "", ...NOTES);
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
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
  const log = args.log ?? defaultPaths().log;
  if (!existsSync(log)) {
    console.error(`no daemon log at ${log} (--log names another)`);
    return EXIT.USAGE;
  }
  const { files, calls } = readProviderCalls(log, args.since === undefined ? undefined : parseLogTime(args.since));
  const report = { log, since: args.since ?? null, files, groups: cacheHitReport(calls) };
  process.stdout.write(args.json ? `${JSON.stringify({ ...report, notes: NOTES }, null, 2)}\n` : `${formatReport(report)}\n`);
  return EXIT.PRINTED;
}

// Node runs the entry module from its realpath while argv[1] keeps the path as
// typed: compare both resolved, or a symlinked checkout skips main().
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectExecution()) process.exitCode = main();
