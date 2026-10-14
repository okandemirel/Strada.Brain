#!/usr/bin/env node
/**
 * export-campaign-fixture.mjs — write one campaign as a replay fixture
 * (GDD-drift plan W16a).
 *
 * The scope gate's replay tests judge a finished campaign again from what its
 * databases hold. In a measured campaign, milestones went green while their
 * lineage tips carried the system's own "task_stuck" stamp, and for one of
 * them the stamp sat only in the tip: the 500-character excerpt the campaign
 * kept never showed it. So the fixture keeps, per milestone, the stored record
 * (status, attempts, time-box escalations, bounce flags, excerpt) AND what the
 * newest task of its lineage said: its stamps counted over the WHOLE result,
 * the lines carrying a stamp or a system marker with one non-blank line of
 * context on each side, and its verification_json as data.
 *
 * What it leaves out, because the fixture is committed to a public repository:
 *   - the approved GDD's text (a GDD is the owner's design; it is named by
 *     sha256 and length instead), and any verbatim passage of it another
 *     field quotes, unless --include-gdd-text is given for a local,
 *     uncommitted fixture;
 *   - milestone prompts (their § references and sha256 are kept), the idea
 *     text, and the chat, user, conversation and project-root identities;
 *   - keys and tokens (production's redactSecretsDeep), the project root
 *     (absolute, real and home-relative spellings), home-directory paths and
 *     e-mail addresses. Whatever still matches a pattern afterwards stops the
 *     export (exit 1) instead of being written;
 *   - the GDD's requirement rows, which need plan W04's extractor; the
 *     fixture says so in `redaction.requirementRows`.
 *
 * An included GDD text (--include-gdd-text) is written as the approved bytes,
 * neither scrubbed nor scanned: it is the replay's input, not evidence.
 *
 * Both databases are opened read-only and never written.
 *
 * Usage:
 *   node scripts/eval/export-campaign-fixture.mjs --campaign <id> --memory-dir <dir> [--out <file>]
 *   node scripts/eval/export-campaign-fixture.mjs --campaign <id> --campaigns-db <path> --tasks-db <path>
 *   ... [--include-gdd-text]
 *
 * The committed fixture, tests/fixtures/campaigns/synthetic-campaign.json, is
 * this export of an invented campaign (tests/fixtures/campaigns/synthetic-campaign.ts)
 * — under tests/, because the build ships every tracked .json under src/. A
 * real campaign's export is never committed, however redacted: it describes a
 * private product. Kept as tests/fixtures/local/campaign-export.json
 * (gitignored), the replay tests run against it too.
 *
 * Exit codes: 0 written · 1 a secret or personal path survived redaction (nothing
 * written) · 2 bad invocation, unreadable database or unknown campaign.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const TSX_GUARD = "STRADA_CAMPAIGN_FIXTURE_TSX";

export const EXIT = Object.freeze({ WRITTEN: 0, LEAK: 1, USAGE: 2 });

/** The stamps the agent runtime writes when a run did not finish its work, or the provider stopped it. */
export const STAMP_KEYS = Object.freeze([
  "task_stuck",
  "max_steps_reached",
  "token_budget_exceeded",
  "provider_quota",
  "provider_abort",
]);
export const STAMP_LOCALES = Object.freeze(["en", "tr", "ja", "ko", "zh", "de", "es", "fr"]);

// The decoding spec of plan W01's systemStampsIn: fixed pieces of at least 40
// characters (15 in Chinese, Japanese and Korean), so worker prose that merely
// mentions being stuck is not counted as the system's stamp.
const COUNT_PIECES = Object.freeze({ minChars: 40, minCjkChars: 15 });
// Lines are KEPT on shorter pieces than they are counted on: a decoder that
// reads more than W01's spec must still find its evidence in the fixture.
const SELECT_PIECES = Object.freeze({ minChars: 20, minCjkChars: 8 });
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/u;
const CONTEXT_LINE_MAX = 300;
const TIP_ERROR_MAX = 1000;

/** A system tag at the start of a line ("[VERIFIER FLAGS — …]", "[TESTS FAILING]") or the sanitizer's cut mark. */
const MARKER_RE = /^\s*(?:\[[A-Z][A-Z0-9 _/:-]*[A-Z0-9](?:\]|\s+—)|\.\.\. \(truncated\)\s*$)/;
/** secret-patterns.ts's TRUNCATION_MARKER, which it does not export. */
const STORED_CUT_MARK = "\n... (truncated)";

const SECTION_REF_RE = /§\s?(\d+(?:\.\d+)*)(?:\s?[–—-]\s?§?\s?(\d+(?:\.\d+)*))?/g;

/** Identity and design text; the rest of the campaign record is evidence. */
const OMITTED_CAMPAIGN_FIELDS = Object.freeze([
  "chatId",
  "channelType",
  "userId",
  "conversationId",
  "projectRoot",
  "ideaText",
  "gddText",
]);

// The same walk task-storage.ts's findLatestDescendant makes: the tip is the
// newest task of the lineage, whatever retry or resume minted it.
const LINEAGE_TIP_SQL = `
  WITH RECURSIVE lineage(id) AS (
    SELECT id FROM tasks WHERE id = ?
    UNION
    SELECT t.id FROM tasks t JOIN lineage l ON t.parent_id = l.id
  )
  SELECT * FROM tasks WHERE id IN (SELECT id FROM lineage)
  ORDER BY created_at DESC, updated_at DESC LIMIT 1
`;

const HELP = `export-campaign-fixture.mjs — a campaign as a replay fixture (plan W16a)

  --campaign <id>         the campaign to export (required)
  --memory-dir <dir>      directory holding campaigns.db and tasks.db (default: $MEMORY_DB_PATH)
  --campaigns-db <path>   campaigns.db, overriding --memory-dir
  --tasks-db <path>       tasks.db, overriding --memory-dir
  --out <file>            write the fixture here (default: stdout)
  --include-gdd-text      also write the approved GDD's text (local use; never commit it)

exit 0 written · 1 a secret survived redaction, nothing written · 2 bad invocation`;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Production's own templates and redaction, never copies of them. Plain node
 * cannot resolve src/'s .js specifiers onto .ts files, so main() re-execs
 * under tsx when this import fails.
 */
export async function loadProductionModules() {
  const [storage, messages, secrets] = await Promise.all([
    import(new URL("../../src/campaign/campaign-storage.ts", import.meta.url).href),
    import(new URL("../../src/agents/resilience-messages.ts", import.meta.url).href),
    import(new URL("../../src/security/secret-patterns.ts", import.meta.url).href),
  ]);
  return {
    CampaignStorage: storage.CampaignStorage,
    getResilienceMessage: messages.getResilienceMessage,
    redactSecretsDeep: secrets.redactSecretsDeep,
    applySecretPatterns: secrets.applySecretPatterns,
    DEFAULT_SECRET_PATTERNS: secrets.DEFAULT_SECRET_PATTERNS,
  };
}

/**
 * The fixed pieces of every locale's stamp templates: split at each {param}
 * and at sentence ends, short pieces dropped. A piece remembers its template
 * and position, so the two sentences of one stamp count once.
 */
export function stampPiecesOf(getResilienceMessage, { minChars, minCjkChars } = COUNT_PIECES) {
  const pieces = [];
  const seen = new Set();
  for (const key of STAMP_KEYS) {
    for (const locale of STAMP_LOCALES) {
      const template = getResilienceMessage(key, locale);
      // An unknown locale falls back to English: one template, one set of pieces.
      if (seen.has(template)) continue;
      seen.add(template);
      let index = 0;
      for (const part of template.split(/\{[^}]*\}/)) {
        for (const sentence of part.split(/(?<=[.!?。！？])\s*/u)) {
          const text = sentence.trim();
          if (text.length >= (CJK_RE.test(text) ? minCjkChars : minChars)) {
            pieces.push({ key, template, index: index++, text });
          }
        }
      }
    }
  }
  return pieces;
}

/**
 * Each stamp occurrence once. Consecutive pieces of the same template with
 * only whitespace between them are one stamp; a piece that starts the
 * template again is the next stamp, even right after the last one.
 */
export function findStamps(text, pieces) {
  const hits = [];
  for (const piece of pieces) {
    for (let at = text.indexOf(piece.text); at !== -1; at = text.indexOf(piece.text, at + piece.text.length)) {
      hits.push({ ...piece, start: at, end: at + piece.text.length });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const stamps = [];
  for (const hit of hits) {
    const last = stamps[stamps.length - 1];
    if (last && hit.start < last.end) continue;
    if (
      last &&
      last.template === hit.template &&
      hit.index > last.index &&
      text.slice(last.end, hit.start).trim() === ""
    ) {
      last.end = hit.end;
      last.index = hit.index;
      continue;
    }
    stamps.push({ key: hit.key, template: hit.template, index: hit.index, start: hit.start, end: hit.end });
  }
  return stamps;
}

/** Stamp counts by key, in STAMP_KEYS order; keys never stamped are absent. */
export function countStamps(text, pieces) {
  const counts = new Map();
  for (const stamp of findStamps(text ?? "", pieces)) counts.set(stamp.key, (counts.get(stamp.key) ?? 0) + 1);
  const out = {};
  for (const key of STAMP_KEYS) if (counts.has(key)) out[key] = counts.get(key);
  return out;
}

export function isMarkerLine(line) {
  return MARKER_RE.test(line);
}

/**
 * The tip's lines that carry a stamp or a system marker, each with the
 * nearest non-blank line on either side. Evidence lines stay whole; a context
 * line longer than CONTEXT_LINE_MAX is cut and says how long it was.
 */
export function reduceToEvidenceLines(text, selectPieces) {
  const lines = (text ?? "").split(/\r?\n/);
  const evidence = new Set();
  const keep = new Set();
  lines.forEach((line, i) => {
    if (!isMarkerLine(line) && !selectPieces.some((p) => line.includes(p.text))) return;
    evidence.add(i);
    keep.add(i);
    for (let j = i - 1; j >= 0; j--) if (lines[j].trim() !== "") { keep.add(j); break; }
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() !== "") { keep.add(j); break; }
  });
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => {
      const line = lines[i];
      if (evidence.has(i) || line.length <= CONTEXT_LINE_MAX) return { line: i + 1, text: line };
      return { line: i + 1, text: line.slice(0, CONTEXT_LINE_MAX), cutFrom: line.length };
    });
}

/** "§2.7–§2.9", "§3.14": the sections a milestone prompt names, in order, once each. */
export function sectionRefsOf(prompt) {
  const refs = [];
  for (const m of (prompt ?? "").matchAll(SECTION_REF_RE)) {
    const ref = m[2] ? `§${m[1]}–§${m[2]}` : `§${m[1]}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

// ─── Redaction ──────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Any user's home, not only this machine's; the lookbehind leaves a project
// path such as "Assets/UI/home/" alone.
const GENERIC_HOME_RE = /(?<![\w.~-])(?:\/Users|\/home)\/[^/\s"'`]+|\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const spellingsOf = (path) =>
  [path, ...(path ? [safeRealpath(path)] : [])].filter((p, i, all) => p && p.length > 1 && all.indexOf(p) === i);

// The runtime also writes the project root home-relative (a "Judged from
// `~/…/<project>/Recordings/…`" line, measured), where neither the absolute
// spelling nor the home rule sees it: the owner's folders survived.
function projectSpellingsOf(projectRoot, home) {
  const spellings = spellingsOf(projectRoot);
  for (const p of [...spellings]) {
    for (const h of spellingsOf(home)) if (p.startsWith(`${h}/`)) spellings.push(`~${p.slice(h.length)}`);
  }
  return spellings.filter((p, i, all) => all.indexOf(p) === i);
}

// The project root first: its own path names the owner's folders, and once
// it is "<project>" the home rule has nothing of it left to half-redact.
function personalPatterns(home, projectRoot) {
  return [
    ...projectSpellingsOf(projectRoot, home).map((p) => ({
      kind: "projectPaths",
      re: new RegExp(escapeRe(p), "g"),
      replacement: "<project>",
    })),
    ...spellingsOf(home).map((h) => ({ kind: "homePaths", re: new RegExp(escapeRe(h), "g"), replacement: "~" })),
    { kind: "homePaths", re: GENERIC_HOME_RE, replacement: "~" },
    { kind: "emails", re: EMAIL_RE, replacement: "<email>" },
  ];
}

const GDD_WINDOW = 40;
const GDD_PASSAGE = "<GDD passage omitted>";

/**
 * Leaving the GDD's text out means its passages too: a structure finding
 * quotes it ("GDD says: …"), and so can an excerpt. Any run of at least
 * GDD_WINDOW characters found verbatim in the approved text, whitespace
 * aside, is replaced.
 */
function gddPassageScrubber(gddText) {
  if (!gddText) return undefined;
  const collapsed = gddText.replace(/\s+/g, " ");
  const windows = new Set();
  for (let i = 0; i + GDD_WINDOW <= collapsed.length; i++) windows.add(collapsed.slice(i, i + GDD_WINDOW));
  return (s) => {
    if (s.length < GDD_WINDOW) return { text: s, hits: 0 };
    let flat = "";
    const origin = [];
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) {
        if (flat.endsWith(" ")) continue;
        flat += " ";
      } else flat += s[i];
      origin.push(i);
    }
    const spans = [];
    for (let i = 0; i + GDD_WINDOW <= flat.length; i++) {
      if (!windows.has(flat.slice(i, i + GDD_WINDOW))) continue;
      const start = origin[i];
      const end = origin[i + GDD_WINDOW - 1] + 1;
      const last = spans[spans.length - 1];
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else spans.push({ start, end });
    }
    if (spans.length === 0) return { text: s, hits: 0 };
    let text = "";
    let at = 0;
    for (const { start, end } of spans) {
      text += s.slice(at, start) + GDD_PASSAGE;
      at = end;
    }
    return { text: text + s.slice(at), hits: spans.length };
  };
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function forEachString(value, fn) {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) value.forEach((v) => forEachString(v, fn));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => forEachString(v, fn));
}

/**
 * What in `value` would leak if written: production's secret patterns, the
 * home directory and any other user's, and e-mail addresses — one finding per
 * string and kind. Empty means clean.
 */
export function scanFixture(value, { applySecretPatterns, DEFAULT_SECRET_PATTERNS }, home = homedir(), projectRoot = undefined) {
  const findings = [];
  const personal = personalPatterns(home, projectRoot);
  forEachString(value, (s) => {
    const secrets = applySecretPatterns(s, DEFAULT_SECRET_PATTERNS, Number.POSITIVE_INFINITY);
    const names = Object.keys(secrets.stats.matchesByPattern);
    if (names.length > 0) findings.push({ kind: "secret", patterns: names });
    const kinds = new Set();
    for (const { kind, re } of personal) {
      re.lastIndex = 0;
      if (re.test(s)) kinds.add(kind);
    }
    for (const kind of kinds) findings.push({ kind });
  });
  return findings;
}

function redact(value, modules, { home, projectRoot, gddText }) {
  const before = scanFixture(value, modules, home, projectRoot);
  const counts = { secretsFound: 0, projectPaths: 0, homePaths: 0, emails: 0, ...(gddText ? { gddPassages: 0 } : {}) };
  for (const finding of before) counts[finding.kind === "secret" ? "secretsFound" : finding.kind] += 1;
  const personal = personalPatterns(home, projectRoot);
  const scrub = gddPassageScrubber(gddText);
  const redacted = mapStrings(modules.redactSecretsDeep(value), (s) => {
    let out = s;
    if (scrub) {
      const scrubbed = scrub(out);
      counts.gddPassages += scrubbed.hits;
      out = scrubbed.text;
    }
    for (const { re, replacement } of personal) out = out.replace(re, replacement);
    return out;
  });
  return { redacted, counts };
}

/** What survived redaction; the export writes nothing when this is thrown. */
export class FixtureLeakError extends Error {
  constructor(findings) {
    super(`${findings.length} pattern match(es) survived redaction — ${JSON.stringify(findings.slice(0, 5))}`);
    this.name = "FixtureLeakError";
    this.findings = findings;
  }
}

// ─── Fixture ────────────────────────────────────────────────────────────────

// The plan's fixture also lists the GDD's rows, but they come from the
// requirement extractor (plan W04), which this export predates. Saying so
// keeps a replay from reading their absence as "no rows".
const REQUIREMENT_ROWS_ABSENT = "not exported: rows need the requirement extractor (plan W04)";

function parseVerification(raw) {
  if (raw === null || raw === undefined || raw === "") return { verification: null };
  try {
    return { verification: JSON.parse(raw) };
  } catch {
    return { verification: null, verificationUnparsed: raw.slice(0, TIP_ERROR_MAX) };
  }
}

function tipOf(tasksDb, taskId, countPieces, selectPieces) {
  if (!taskId) return null;
  const row = tasksDb.prepare(LINEAGE_TIP_SQL).get(taskId);
  if (!row) return { id: taskId, missing: true };
  const result = row.result ?? "";
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at === null || row.completed_at === undefined ? {} : { completedAt: row.completed_at }),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    resultChars: result.length,
    resultSha256: sha256(result),
    // tasks.db holds results cut at 8192 characters (measured): a stamp past
    // the cut was never stored, so these counts are a lower bound.
    ...(result.endsWith(STORED_CUT_MARK) ? { resultCutInStorage: true } : {}),
    stamps: countStamps(result, countPieces),
    evidenceLines: reduceToEvidenceLines(result, selectPieces),
    ...parseVerification(row.verification_json),
    ...(row.error ? { error: row.error.slice(0, TIP_ERROR_MAX) } : {}),
  };
}

function milestoneOf(milestone, tasksDb, countPieces, selectPieces) {
  const { prompt, ...stored } = milestone;
  return {
    ...stored,
    sectionRefs: sectionRefsOf(prompt),
    promptChars: (prompt ?? "").length,
    promptSha256: sha256(prompt ?? ""),
    tip: tipOf(tasksDb, milestone.taskId, countPieces, selectPieces),
  };
}

/**
 * Build the fixture from open handles. `campaign` is production's own
 * reading of the row (CampaignStorage.get), so the replay sees the campaign
 * the manager saw.
 */
export function buildCampaignFixture({ campaign, tasksDb, modules, includeGddText = false, home = homedir() }) {
  const countPieces = stampPiecesOf(modules.getResilienceMessage, COUNT_PIECES);
  const selectPieces = stampPiecesOf(modules.getResilienceMessage, SELECT_PIECES);
  const kept = {};
  for (const [k, v] of Object.entries(campaign)) {
    if (k === "milestones" || OMITTED_CAMPAIGN_FIELDS.includes(k)) continue;
    kept[k] = v;
  }
  const gddText = campaign.gddText;
  const raw = {
    campaign: { ...kept, ...(campaign.projectRoot ? { projectName: basename(campaign.projectRoot) } : {}) },
    gdd:
      gddText === undefined
        ? null
        : {
            path: campaign.gddPath ?? null,
            chars: gddText.length,
            sha256: sha256(gddText),
            storedSha256: campaign.gddSha256 ?? null,
            revision: campaign.gddRevision ?? null,
          },
    milestones: (campaign.milestones ?? []).map((m) => milestoneOf(m, tasksDb, countPieces, selectPieces)),
  };
  // The scrub runs only when the text is left out; with it included there is nothing to hide.
  const { redacted, counts } = redact(raw, modules, {
    home,
    projectRoot: campaign.projectRoot,
    gddText: includeGddText ? undefined : gddText,
  });
  // Scanned with the project root: the CLI's own scan had no way to know it,
  // so a project path the redaction missed was written as clean.
  const leaks = scanFixture(redacted, modules, home, campaign.projectRoot);
  if (leaks.length > 0) throw new FixtureLeakError(leaks);
  // An included GDD is the replay's extraction input, so it stays the approved
  // bytes (its sha256 above); redacting an address inside it would change the rows.
  if (includeGddText && redacted.gdd) redacted.gdd.text = gddText;
  return {
    kind: "strada-campaign-replay-fixture",
    version: 1,
    exporter: "scripts/eval/export-campaign-fixture.mjs",
    stampMatcher: {
      keys: STAMP_KEYS,
      locales: STAMP_LOCALES,
      countPieces: COUNT_PIECES,
      selectPieces: SELECT_PIECES,
    },
    redaction: {
      gddText: includeGddText ? "included" : "omitted",
      prompts: "omitted; § references and sha256 kept",
      tipResults: "stamp and marker lines, each with one non-blank line of context; stamps counted over the whole result",
      requirementRows: REQUIREMENT_ROWS_ABSENT,
      omittedCampaignFields: OMITTED_CAMPAIGN_FIELDS,
      ...counts,
    },
    ...redacted,
  };
}

/** Open both databases read-only, build the fixture, close them. */
export async function exportCampaignFixture({
  campaignsDbPath,
  tasksDbPath,
  campaignId,
  includeGddText = false,
  home = homedir(),
  modules,
}) {
  const mods = modules ?? (await loadProductionModules());
  const campaigns = new mods.CampaignStorage(campaignsDbPath, { readOnly: true });
  let tasksDb;
  try {
    const campaign = campaigns.get(campaignId);
    if (!campaign) throw new Error(`campaign ${campaignId} is not in ${campaignsDbPath}`);
    tasksDb = new Database(tasksDbPath, { readonly: true, fileMustExist: true });
    tasksDb.pragma("busy_timeout = 5000");
    return buildCampaignFixture({ campaign, tasksDb, modules: mods, includeGddText, home });
  } finally {
    tasksDb?.close();
    campaigns.close();
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { campaign: null, memoryDir: null, campaignsDb: null, tasksDb: null, out: null, includeGddText: false, help: false };
  const valued = { "--campaign": "campaign", "--memory-dir": "memoryDir", "--campaigns-db": "campaignsDb", "--tasks-db": "tasksDb", "--out": "out" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued[a] !== undefined) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      args[valued[a]] = v;
    } else if (a === "--include-gdd-text") args.includeGddText = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (args.help) return args;
  if (!args.campaign) return { error: "--campaign is required" };
  const memoryDir = args.memoryDir ?? process.env.MEMORY_DB_PATH ?? null;
  args.campaignsDb ??= memoryDir ? join(memoryDir, "campaigns.db") : null;
  args.tasksDb ??= memoryDir ? join(memoryDir, "tasks.db") : null;
  if (!args.campaignsDb || !args.tasksDb) return { error: "name the databases: --memory-dir, or --campaigns-db and --tasks-db" };
  return args;
}

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

export async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error(HELP);
    return EXIT.USAGE;
  }
  if (args.help) {
    console.log(HELP);
    return EXIT.WRITTEN;
  }

  let modules;
  try {
    modules = await loadProductionModules();
  } catch (err) {
    if (!process.env[TSX_GUARD]) return reExecUnderTsx(argv);
    console.error(`production modules could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.USAGE;
  }

  let fixture;
  try {
    fixture = await exportCampaignFixture({
      campaignsDbPath: resolve(args.campaignsDb),
      tasksDbPath: resolve(args.tasksDb),
      campaignId: args.campaign,
      includeGddText: args.includeGddText,
      modules,
    });
  } catch (err) {
    if (err instanceof FixtureLeakError) {
      console.error(`refusing to write: ${err.message}`);
      return EXIT.LEAK;
    }
    console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.USAGE;
  }

  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), json);
    console.error(`wrote ${args.out} (${json.length} bytes, ${fixture.milestones.length} milestones)`);
  } else {
    process.stdout.write(json);
  }
  return EXIT.WRITTEN;
}

// Node runs the entry module from its realpath while argv[1] keeps the path as
// typed: compared as strings, a symlinked directory on the way skipped main().
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? String(err));
      process.exit(EXIT.USAGE);
    });
}
