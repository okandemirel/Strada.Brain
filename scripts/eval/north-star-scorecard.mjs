#!/usr/bin/env node
/**
 * north-star-scorecard.mjs — the north star's ten rungs and the proof run's
 * criteria, measured from the databases and a project tree (roadmap WP-0.2).
 *
 * The rungs ("one prompt or GDD → a finished game that follows Strada's
 * patterns", cut into ten steps) used to be measured by hand-run scratch
 * scripts whose numbers lived only in a report. This prints each one as
 * `pass`, `fail` or `not measured: <cause>`, with the numbers it read and
 * where it read them, so a live run can be scored the same way every time.
 *
 * How a verdict is reached: every rung is a list of checks, each true, false
 * or not measured. Any false check fails the rung. Otherwise any check that
 * could not be measured makes the rung "not measured", naming why. Only a
 * rung whose every check held passes. So a missing source never becomes a
 * pass, and a source that could not be read never hides a failure the
 * readable ones already show. A mechanism that does not exist yet (no store
 * for it) is a failure, not "not measured": the point of the rung is that the
 * system records it.
 *
 * Read-only: every database is opened with SQLite's read-only flag and
 * query_only (a WAL database with no -wal/-shm beside it is read from a copy
 * in memory, so not even those appear); the project tree and the log are only
 * read. It is safe on a live home while the daemon runs.
 *
 * Usage:
 *   node scripts/eval/north-star-scorecard.mjs --project <unity project> [--json]
 *   ... [--home <dir>] [--memory-dir <dir>] [--campaigns-db <p>] [--tasks-db <p>]
 *   ... [--learning-db <p>] [--vault <index.db>]... [--upstream <dir>] [--log <p>]
 *   ... [--campaign <id>] [--brain-root <dir>]
 *
 * Exit codes: 0 the scorecard was printed (whatever it says) · 2 bad
 * invocation or an unknown --campaign.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..", "..");

export const EXIT = Object.freeze({ MEASURED: 0, USAGE: 2 });
export const VERDICT = Object.freeze({ PASS: "pass", FAIL: "fail", NOT_MEASURED: "not-measured" });

export const RUNG_TITLES = Object.freeze([
  "Brain boots on HEAD with Unity tools",
  "One sentence starts a campaign",
  "The GDD becomes checkable rows, each owned by a milestone",
  "The plan follows the GDD's MVP and maps rows to framework constructs",
  "A milestone is green only when its own rows pass checks the system owns",
  "Code follows Strada.Core patterns, with no parallel implementations",
  "Ready modules (Strada.Modules) are used",
  "The delivered game is playable through real input",
  "A lesson from sprint N changes sprint N+1",
  "It runs unmanned to delivery",
]);

export const CRITERION_TITLES = Object.freeze({
  A: "Unmanned",
  B: "Ledger",
  C: "Plan",
  D: "Green per milestone",
  E: "Playable",
  F: "Strada conformance",
  G: "Project settings",
  H: "Assumptions",
  I: "Art and audio",
  J: "Learning",
  K: "Retrieval",
  L: "Negative controls",
});

// ─── verdicts ───────────────────────────────────────────────────────────────

const pass = (text) => ({ ok: true, text });
const fail = (text) => ({ ok: false, text });
const unmeasured = (text) => ({ ok: null, text });

export function verdictOf(checks) {
  if (checks.length === 0) return { verdict: VERDICT.NOT_MEASURED, cause: "nothing was measured" };
  if (checks.some((c) => c.ok === false)) return { verdict: VERDICT.FAIL, cause: null };
  const open = checks.filter((c) => c.ok === null);
  if (open.length > 0) return { verdict: VERDICT.NOT_MEASURED, cause: open.map((c) => c.text).join("; ") };
  return { verdict: VERDICT.PASS, cause: null };
}

function item(id, title, checks, { notes = [], measured = {} } = {}) {
  return { id, title, ...verdictOf(checks), checks, notes, measured };
}

/** One check that stands for a whole item when its source could not be read. */
function blocked(id, title, cause) {
  return item(id, title, [unmeasured(cause)]);
}

// ─── small helpers ──────────────────────────────────────────────────────────

const message = (err) => (err instanceof Error ? err.message : String(err));
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pct = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "n/a");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// An empty table's min() is NULL, and Number(null) is 0: 1970 is not a date anything happened.
const isoOf = (ms) => (ms !== null && ms !== undefined && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : "unknown");

function parseJson(raw) {
  if (typeof raw !== "string") return { error: "not text" };
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { error: message(err) };
  }
}

function readText(path, limit) {
  try {
    if (limit === undefined) return readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(limit);
      return buf.subarray(0, readSync(fd, buf, 0, limit, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readHeader(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(100);
    return buf.subarray(0, readSync(fd, buf, 0, 100, 0));
  } finally {
    closeSync(fd);
  }
}

function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// ─── databases ──────────────────────────────────────────────────────────────

export function openReadOnly(label, path) {
  if (!path) return { label, path: null, db: null, cause: `no ${label} path was given` };
  const abs = resolve(path);
  if (!existsSync(abs)) return { label, path: abs, db: null, cause: `${label} not found at ${abs}` };
  try {
    // A reader that opens a WAL database creates its -wal and -shm and leaves
    // them behind. With neither there, every committed page is in the main
    // file, so a copy in memory reads the same data and creates nothing. With
    // them there (a live daemon's), the file is read the way every SQLite
    // reader reads it: through them, never writing the database itself.
    const walMode = readHeader(abs)[18] === 2;
    const sidecars = existsSync(`${abs}-wal`) || existsSync(`${abs}-shm`);
    let db;
    if (walMode && !sidecars) {
      const bytes = readFileSync(abs);
      bytes[18] = 1;
      bytes[19] = 1;
      db = new Database(bytes, { readonly: true });
    } else {
      db = new Database(abs, { readonly: true, fileMustExist: true });
    }
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 5000");
    // A file that is not a database fails here, not halfway through a rung.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return { label, path: abs, db, cause: null };
  } catch (err) {
    return { label, path: abs, db: null, cause: `${label} at ${abs} could not be opened read-only: ${message(err)}` };
  }
}

const hasTable = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name) !== undefined;

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function countOf(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

// ─── campaigns.db ───────────────────────────────────────────────────────────

const OUT_OF_SCOPE_STATUSES = new Set(["excluded", "waived"]);
// Disclosed, never gating (scope-types.ts REQUIREMENT_KINDS).
const UNGATED_KINDS = new Set(["aspiration", "judgement"]);

export const inScope = (row) => !OUT_OF_SCOPE_STATUSES.has(row.status) && !UNGATED_KINDS.has(row.kind);

// `owner` only, as production reads it (scope-report.ts ownedRows/queuedRows):
// absent means queued. `ownership` is history that reownLedger keeps across a
// replan whose new plan reuses the ids m1…mN, so its last entry can name a
// milestone of the current plan for a row nobody owns.
const ownerOf = (row) => (typeof row.owner === "string" && row.owner !== "" ? row.owner : null);

function toCampaign(row) {
  const ms = parseJson(row.milestones_json ?? "[]");
  const milestones = Array.isArray(ms.value) ? ms.value.filter(isRecord) : [];
  let ledger = null;
  let ledgerState = "absent";
  if (typeof row.requirements_json === "string" && row.requirements_json.trim() !== "") {
    const parsed = parseJson(row.requirements_json);
    if (isRecord(parsed.value) && Array.isArray(parsed.value.rows)) {
      ledger = { ...parsed.value, rows: parsed.value.rows.filter(isRecord) };
      ledgerState = "readable";
    } else {
      ledgerState = "unreadable";
    }
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    projectRoot: row.project_root,
    state: row.state,
    ideaText: typeof row.idea_text === "string" && row.idea_text.trim() !== "" ? row.idea_text : null,
    gddPath: row.gdd_path ?? null,
    milestones,
    milestonesUnreadable: !Array.isArray(ms.value),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deliveryReported: Number(row.delivery_reported ?? 0) === 1,
    scopeGateSince: row.scope_gate_since ?? null,
    ledger,
    ledgerState,
  };
}

function readCampaignStore(src, campaignFilter) {
  const db = src.db;
  if (!hasTable(db, "campaigns")) return { cause: `${src.path} has no campaigns table` };
  const columns = columnsOf(db, "campaigns");
  const all = db.prepare("SELECT * FROM campaigns ORDER BY created_at, id").all().map(toCampaign);
  const campaigns = campaignFilter ? all.filter((c) => c.id === campaignFilter) : all;
  const judgements = hasTable(db, "campaign_judgements")
    ? db
        .prepare("SELECT campaign_id, milestone_id, at, mode, green, basis, revision, input_json FROM campaign_judgements ORDER BY seq")
        .all()
        .map((r) => ({
          campaignId: r.campaign_id,
          milestoneId: r.milestone_id,
          at: Number(r.at),
          mode: r.mode,
          green: Number(r.green) === 1,
          basis: r.basis ?? null,
          revision: r.revision,
          input: parseJson(r.input_json).value,
        }))
    : null;
  const acceptance = hasTable(db, "campaign_acceptance")
    ? db
        .prepare("SELECT campaign_id, milestone_id, path, meta_json FROM campaign_acceptance ORDER BY campaign_id, path")
        .all()
        .map((r) => ({ campaignId: r.campaign_id, milestoneId: r.milestone_id, path: r.path, meta: parseJson(r.meta_json).value }))
    : null;
  return {
    all,
    campaigns,
    judgements,
    acceptance,
    hasLedgerColumn: columns.has("requirements_json"),
    hasAssumptionStore: columns.has("assumptions_json") || hasTable(db, "campaign_assumptions"),
  };
}

/** Whether the scope gate, in mode `on`, judged this milestone green on a proven basis. */
function gateProof(store, campaign, milestone) {
  if (!store.judgements) return { proven: false, why: "no campaign_judgements table" };
  const latestOn = store.judgements.filter((j) => j.campaignId === campaign.id && j.milestoneId === milestone.id && j.mode === "on").at(-1);
  if (!latestOn) return { proven: false, why: "never judged in mode on" };
  if (!latestOn.green) return { proven: false, why: "its latest on-mode judgement is red" };
  if (latestOn.basis !== "proven") return { proven: false, why: `green on a ${latestOn.basis ?? "unrecorded"} basis` };
  return { proven: true, judgement: latestOn };
}

const greenMilestones = (campaign) => campaign.milestones.filter((m) => m.status === "green");

/** Owner messages in the campaign's chat between its start and `endMs`, or why they cannot be counted. */
function ownerMessages(tasksSrc, campaign, endMs) {
  if (!tasksSrc?.db) return unmeasured(`owner messages: ${tasksSrc?.cause ?? "tasks.db was not read"}`);
  const db = tasksSrc.db;
  if (!hasTable(db, "tasks")) return unmeasured(`owner messages: ${tasksSrc.path} has no tasks table`);
  if (!columnsOf(db, "tasks").has("campaign_id")) {
    return unmeasured("owner messages: tasks.db has no campaign_id column, so the campaign's own tasks cannot be told from the owner's");
  }
  const linked = countOf(db, "SELECT count(*) FROM tasks WHERE campaign_id = ?", campaign.id);
  if (linked === 0) {
    // Sprint tasks written before tasks carried their campaign look exactly
    // like messages the owner typed; counting them would invent interventions.
    return unmeasured(`owner messages: no task in tasks.db is linked to ${campaign.id}, so its sprint tasks cannot be told from the owner's messages`);
  }
  const owner = countOf(
    db,
    `SELECT count(*) FROM tasks WHERE chat_id = ? AND parent_id IS NULL AND campaign_id IS NULL
       AND COALESCE(origin, 'user') = 'user' AND created_at > ? AND created_at <= ?`,
    campaign.chatId,
    campaign.createdAt,
    endMs,
  );
  const text = `${plural(owner, "owner message")} in the campaign's chat between its start and ${isoOf(endMs)} (${linked} tasks linked to it)`;
  return owner === 0 ? pass(text) : fail(text);
}

// ─── learning.db ────────────────────────────────────────────────────────────

function readLearning(src) {
  const db = src.db;
  const out = { tables: {} };
  const has = (t) => (out.tables[t] = hasTable(db, t));
  // Raw rows older than the retention period are folded into a per-day rollup
  // and deleted (metrics-storage.ts FND-23), so both are read.
  out.retrievals = has("retrieval_metrics")
    ? db.prepare("SELECT count(*) AS n, COALESCE(sum(insights_returned > 0), 0) AS anything, min(recorded_at) AS first, max(recorded_at) AS last FROM retrieval_metrics").get()
    : { n: 0, anything: 0, first: null, last: null };
  out.rollup = has("retrieval_metrics_rollup")
    ? db.prepare("SELECT COALESCE(sum(retrievals), 0) AS n, COALESCE(sum(insights_returned_sum), 0) AS insights FROM retrieval_metrics_rollup").get()
    : { n: 0, insights: 0 };
  out.exposures = has("instinct_exposure_log") ? countOf(db, "SELECT count(*) FROM instinct_exposure_log") : 0;
  // A lesson changes a LATER run: the instinct existed before it was shown,
  // and the run it was shown to is not the one that minted it. Only a recorded
  // origin can say that; an exposure whose lesson has none (no production code
  // writes origin_session_id) is counted apart, never as a later run.
  out.laterExposures = 0;
  out.unprovenancedExposures = 0;
  if (out.tables.instinct_exposure_log && has("instincts")) {
    out.laterExposures = countOf(
      db,
      `SELECT count(*) FROM instinct_exposure_log e JOIN instincts i ON i.id = e.instinct_id
         WHERE i.created_at < e.shown_at AND i.origin_session_id IS NOT NULL AND i.origin_session_id <> e.session_id`,
    );
    out.unprovenancedExposures = countOf(
      db,
      `SELECT count(*) FROM instinct_exposure_log e LEFT JOIN instincts i ON i.id = e.instinct_id
         WHERE i.id IS NULL OR i.origin_session_id IS NULL`,
    );
  }
  out.credits = has("instinct_credit_log") ? countOf(db, "SELECT count(*) FROM instinct_credit_log") : 0;
  out.instincts = has("instincts") ? countOf(db, "SELECT count(*) FROM instincts") : 0;
  out.milestoneLessons = out.tables.instincts
    ? countOf(db, "SELECT count(*) FROM instincts WHERE tags LIKE '%milestone%' OR tags LIKE '%campaign%'")
    : 0;
  out.tools = {};
  out.toolWindow = { first: null, last: null };
  if (has("observations")) {
    for (const r of db
      .prepare(
        `SELECT tool_name, count(*) AS calls, COALESCE(sum(success = 1), 0) AS ok FROM observations
           WHERE tool_name IN ('unity_build_player', 'unity_run_player', 'unity_playthrough') GROUP BY tool_name`,
      )
      .all()) {
      out.tools[r.tool_name] = { calls: Number(r.calls), ok: Number(r.ok) };
    }
    out.toolWindow = db.prepare("SELECT min(timestamp) AS first, max(timestamp) AS last, count(*) AS n FROM observations").get();
  }
  return out;
}

// ─── daemon log ─────────────────────────────────────────────────────────────

// bootstrap.ts writes BOOT_STARTED first on every boot; tool-registry.ts then
// writes MCP_LOADED, or one of MCP_NOT_LOADED, or nothing at all when no
// install was found; stage-finalization.ts closes the boot with BOOT_REPORT.
const BOOT_STARTED = "Bootstrapping Strada Brain";
const MCP_LOADED = "Loaded Strada.MCP tools into main toolchain";
const MCP_NOT_LOADED = new Set(["Failed to load Strada.MCP tools", "Refused to load Strada.MCP from inside the Unity project"]);
const BOOT_REPORT = "Boot report";
const LOG_MESSAGES = new Set([BOOT_STARTED, MCP_LOADED, ...MCP_NOT_LOADED, BOOT_REPORT]);

function parseLogTime(raw) {
  if (typeof raw !== "string") return NaN;
  // The logger writes local wall time without a zone ("2026-09-18 03:19:59").
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(" ", "T") : raw;
  return Date.parse(local);
}

/**
 * The log and the archives the logger rotated it into, oldest first. The file
 * transport is tailable with zipped archives (logger.ts): <name>1<ext>.gz is
 * the newest archive and the highest number the oldest.
 */
function logFiles(path) {
  const ext = extname(path);
  const base = basename(path, ext);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const archive = new RegExp(`^${escape(base)}(\\d+)${escape(ext)}(\\.gz)?$`);
  let names = [];
  try {
    names = readdirSync(dirname(path));
  } catch {
    /* no directory: no archives */
  }
  const archives = names
    .map((name) => ({ name, m: archive.exec(name) }))
    .filter((a) => a.m)
    .map((a) => ({ path: join(dirname(path), a.name), n: Number(a.m[1]), gz: a.m[2] !== undefined }))
    .sort((a, b) => b.n - a.n);
  return [...archives, { path, n: 0, gz: false }];
}

function readLog(path) {
  if (!existsSync(path)) return { cause: `daemon log not found at ${path}` };
  const files = [];
  const boots = [];
  let boot = null;
  for (const file of logFiles(path)) {
    let text;
    try {
      text = file.gz ? gunzipSync(readFileSync(file.path)).toString("utf8") : readFileSync(file.path, "utf8");
    } catch (err) {
      files.push({ path: file.path, cause: message(err) });
      continue;
    }
    files.push({ path: file.path, cause: null });
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      const parsed = parseJson(line.trim());
      const entry = parsed.value;
      if (!isRecord(entry) || !LOG_MESSAGES.has(entry.message)) continue;
      if (entry.message === BOOT_STARTED) {
        boot = { at: entry.timestamp ?? null, file: files.length - 1, loads: [], refusals: [], reported: false };
        boots.push(boot);
      } else if (boot === null) {
        // The boot it belongs to rotated out of the oldest archive.
        continue;
      } else if (entry.message === MCP_LOADED) boot.loads.push(entry);
      else if (entry.message === BOOT_REPORT) boot.reported = true;
      else boot.refusals.push(entry);
    }
  }
  return { files, boots };
}

/** Why rung 1 cannot name the newest boot, or null when it can. */
function newestBootUnknown(log, logPath) {
  const newest = log.boots.at(-1);
  // A file that could not be read and is newer than the newest boot read may hold a newer one.
  const after = log.files.filter((f, i) => f.cause && (newest === undefined || i > newest.file));
  if (after.length > 0) return `the newest boot may be in ${after.map((f) => `${f.path}, which could not be read (${f.cause})`).join("; ")}`;
  if (newest === undefined) return `no boot marker ("${BOOT_STARTED}") in ${logPath} or its rotated archives`;
  return null;
}

function headCommitMs(brainRoot) {
  try {
    const out = execFileSync("git", ["-C", brainRoot, "log", "-1", "--format=%ct"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const s = Number(out.trim());
    return Number.isFinite(s) && s > 0 ? { ms: s * 1000 } : { cause: `git printed no commit time for ${brainRoot}` };
  } catch (err) {
    return { cause: `HEAD of ${brainRoot} could not be read (${message(err).split("\n")[0]})` };
  }
}

// ─── project tree ───────────────────────────────────────────────────────────

// Same exclusions as the core-fidelity census, plus the system's own
// acceptance tests (scope-types.ts ACCEPTANCE_DIR): game code is what the
// workers wrote for the game.
const NON_GAME_DIRS = new Set(["Tests", "Test", "Editor", "Strada.Generated", "Plugins", "StradaAcceptance"]);
const REGISTRATION_EXCLUDED_DIRS = new Set(["Tests", "Test", "Editor", "StradaAcceptance"]);
const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "UserSettings", ".git", "node_modules", ".strada"]);
const AUDIO_EXT = /\.(wav|ogg|mp3|aif|aiff|flac)$/i;
const YAML_EXT = /\.(unity|prefab|asset|controller|overrideController|playable|mixer)$/i;
const FRAMEWORK_DIR = /^(?:Strada\.(Core|Modules|MCP)|com\.strada\.(core|modules|mcp))$/i;

function frameworkKind(name) {
  const m = FRAMEWORK_DIR.exec(name);
  return m ? (m[1] ?? m[2]).toLowerCase() : null;
}

/**
 * Whether a path under Assets sits in a framework copy (Assets/Strada.MCP, as
 * strada-deps.ts can install it, or a Modules copy): the framework's files are
 * not the game's, and its own Strada.Modules references must not pass rung 7.
 */
const inFrameworkCopy = (assetsRel) => assetsRel.split(sep).slice(0, -1).some((d) => frameworkKind(d) !== null);

function walkFiles(root, skip = SKIP_DIRS) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

/**
 * C# with comments removed and string/char literals emptied, so a brace, a
 * "Strada.Core" or a `//` inside a literal or a comment is not read as code.
 * A comment-only method body is empty: a TODO is not an implementation.
 */
export function stripCSharp(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    const verbatim = (c === "@" && d === '"') || (((c === "$" && d === "@") || (c === "@" && d === "$")) && src[i + 2] === '"');
    if (verbatim) {
      i += c === "@" && d === '"' ? 2 : 3;
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') i += 2;
        else if (src[i] === '"') break;
        else i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === '"' || (c === "$" && d === '"')) {
      i += c === "$" ? 2 : 1;
      while (i < n && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && j - i < 12 && src[j] !== "'" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (src[j] === "'") {
        out += "''";
        i = j + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** The text between the brace at or after `from` and its match. */
function blockAfter(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The declaration text in front of a `class` keyword: modifiers and attributes. */
function declarationPrefix(src, classIndex) {
  let i = classIndex - 1;
  let depth = 0;
  while (i >= 0) {
    const ch = src[i];
    if (ch === "]") depth++;
    else if (ch === "[") depth--;
    else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
    i--;
  }
  return src.slice(i + 1, classIndex);
}

const SYSTEM_RE = /\bclass\s+([A-Za-z_]\w*)(?:\s*<[^>{]*>)?\s*:\s*(?:[\w.]+\.)?(?:SystemBase|JobSystemBase|BurstSystem)\b/g;
const SERVICE_RE = /\bclass\s+([A-Za-z_]\w*)(?:\s*<[^>{]*>)?\s*:\s*(?:[\w.]+\.)?(?:Service|TickableService|FixedTickableService|OrderedService)\b/g;
const MODULE_CONFIG_RE = /\bclass\s+([A-Za-z_]\w*)\s*:\s*(?:[\w.]+\.)?ModuleConfig\b/g;
const TYPE_DECL_RE = /\b(?:class|struct|interface|enum)\s+([A-Za-z_]\w*)/g;
const FIND_OBJECT_RE =
  /\b(?:FindObjectOfType|FindFirstObjectByType|FindAnyObjectByType|FindObjectsOfType|FindObjectsByType|GameObject\s*\.\s*(?:FindGameObjectsWithTag|FindGameObjectWithTag|FindWithTag|Find))\b/g;
const NEW_SERVICE_RE = /\bnew\s+(?:[\w.]+\.)?([A-Za-z_]\w*Service)\s*\(/g;
const REGISTER_CALL_RE = /\bRegister\w*\s*(?:<([^;(){}]*)>)?\s*\(([^;]*)/g;
const HAND_ROLLED_SCREEN_RE = /^I?\w*Screen(?:Manager|Service|Navigator|Router|Switcher|Stack|Controller)$/;

function moduleOf(assetsRel) {
  const parts = assetsRel.split(sep);
  return parts[0] === "Modules" && parts.length > 2 ? parts[1] : parts[0];
}

function guidOfMeta(path) {
  const text = readText(`${path}.meta`, 600);
  const m = text && /^guid:\s*([0-9a-f]{32})/m.exec(text);
  return m ? m[1] : null;
}

/** Strada.Core patterns in the game's own code (the core-fidelity census, made repeatable). */
export function scanGameCode(assets) {
  const files = walkFiles(assets).filter((f) => f.endsWith(".cs"));
  const game = [];
  const registered = new Set();
  const autoRegistered = new Set();
  for (const file of files) {
    const rel = relative(assets, file);
    if (inFrameworkCopy(rel)) continue;
    const dirs = rel.split(sep).slice(0, -1);
    const raw = readText(file);
    if (raw === null) continue;
    const src = stripCSharp(raw);
    if (!dirs.some((d) => REGISTRATION_EXCLUDED_DIRS.has(d))) {
      for (const m of src.matchAll(REGISTER_CALL_RE)) {
        for (const id of (m[1] ?? "").matchAll(/[A-Za-z_]\w*/g)) registered.add(id[0]);
        for (const t of m[2].matchAll(/\b(?:typeof\s*\(|new\s+)\s*([\w.]+)/g)) registered.add(t[1].split(".").at(-1));
      }
    }
    if (dirs.some((d) => NON_GAME_DIRS.has(d))) continue;
    game.push({ rel, module: moduleOf(rel), src });
  }

  const typeModules = new Map();
  const systems = [];
  const services = [];
  const moduleConfigs = [];
  const findObject = [];
  const newService = [];
  const reflectionBootstrap = [];
  const modulesRefs = [];
  const screenTypes = [];
  let withoutCore = 0;
  let targetFrameRate60 = 0;
  for (const f of game) {
    const { src, rel } = f;
    if (!/\bStrada\.Core\b/.test(src)) withoutCore++;
    if (/\bStrada\.Modules\b/.test(src)) modulesRefs.push(rel);
    if (/\bApplication\s*\.\s*targetFrameRate\s*=\s*60\b/.test(src)) targetFrameRate60++;
    // The bootstrap bypass: a static entry point that reaches into
    // GameBootstrapper by reflection instead of a scene's configured one.
    if (/\[\s*RuntimeInitializeOnLoadMethod\b/.test(src) && /\bGameBootstrapper\b/.test(src) && /\bBindingFlags\b|\.\s*GetField\s*\(/.test(src)) {
      reflectionBootstrap.push(rel);
    }
    for (const m of src.matchAll(TYPE_DECL_RE)) {
      // `where T : class` followed by another constraint clause.
      if (m[1] === "where" || m[1] === "new") continue;
      const set = typeModules.get(m[1]) ?? new Set();
      set.add(f.module);
      typeModules.set(m[1], set);
      if (HAND_ROLLED_SCREEN_RE.test(m[1])) screenTypes.push(m[1]);
    }
    for (const m of src.matchAll(SYSTEM_RE)) {
      const body = blockAfter(src, m.index + m[0].length) ?? "";
      const onUpdate = /\bvoid\s+OnUpdate\s*\([^)]*\)\s*\{/.exec(body);
      const updateBody = onUpdate ? blockAfter(body, onUpdate.index + onUpdate[0].length - 1) : null;
      systems.push({ name: m[1], file: rel, hasOnUpdate: onUpdate !== null, emptyOnUpdate: updateBody !== null && updateBody.trim() === "" });
    }
    for (const m of src.matchAll(SERVICE_RE)) {
      const prefix = declarationPrefix(src, m.index);
      if (/\babstract\b/.test(prefix)) continue;
      if (/\[\s*(?:[\w.]+\.)?AutoRegister\w*/.test(prefix)) autoRegistered.add(m[1]);
      services.push({ name: m[1], file: rel });
    }
    for (const m of src.matchAll(MODULE_CONFIG_RE)) moduleConfigs.push({ name: m[1], file: rel });
    const finds = [...src.matchAll(FIND_OBJECT_RE)].length;
    if (finds > 0) findObject.push({ file: rel, calls: finds });
    for (const m of src.matchAll(NEW_SERVICE_RE)) newService.push({ file: rel, type: m[1] });
  }
  const duplicates = [...typeModules.entries()]
    .filter(([, mods]) => mods.size > 1)
    .map(([name, mods]) => ({ name, modules: [...mods].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unregisteredServices = services.filter((s) => !registered.has(s.name) && !autoRegistered.has(s.name));
  return {
    gameFiles: game.length,
    withoutCore,
    duplicates,
    systems,
    emptyOnUpdate: systems.filter((s) => s.emptyOnUpdate),
    services,
    unregisteredServices,
    moduleConfigs,
    findObject,
    newService,
    reflectionBootstrap,
    modulesRefs,
    screenTypes: [...new Set(screenTypes)].sort(),
    targetFrameRate60,
  };
}

function buildScenes(project) {
  const text = readText(join(project, "ProjectSettings", "EditorBuildSettings.asset"));
  if (text === null) return null;
  return [...text.matchAll(/-\s*enabled:\s*(\d)\s*\n\s*path:\s*(\S+)/g)].map((m) => ({ enabled: m[1] === "1", path: m[2] }));
}

/**
 * Which ModuleConfig subclasses a shipped scene's bootstrapper actually lists
 * (Core's GameBootstrapper._gameConfig → GameBootstrapperConfig._modules[]._config).
 * Matched by guid only: a module named in code but absent from every enabled
 * build scene's config is never constructed.
 */
function moduleRegistration(project, assets, moduleConfigs, scenes) {
  if (scenes === null) return { cause: "ProjectSettings/EditorBuildSettings.asset not found" };
  const guidToPath = new Map();
  for (const meta of walkFiles(assets).filter((f) => f.endsWith(".meta"))) {
    const text = readText(meta, 600);
    const m = text && /^guid:\s*([0-9a-f]{32})/m.exec(text);
    if (m) guidToPath.set(m[1], meta.slice(0, -5));
  }
  const scriptGuidToClass = new Map();
  for (const mc of moduleConfigs) {
    const guid = guidOfMeta(join(assets, mc.file));
    if (guid) scriptGuidToClass.set(guid, mc.name);
  }
  const assetGuidToClass = new Map();
  for (const [guid, path] of guidToPath) {
    if (!path.endsWith(".asset")) continue;
    const m = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-f]{32})/.exec(readText(path, 4000) ?? "");
    if (m && scriptGuidToClass.has(m[1])) assetGuidToClass.set(guid, scriptGuidToClass.get(m[1]));
  }
  const listed = new Set();
  const shipped = scenes.filter((s) => s.enabled);
  for (const scene of shipped) {
    const text = readText(join(project, scene.path));
    if (text === null) continue;
    for (const g of text.matchAll(/_gameConfig:\s*\{fileID:\s*-?\d+,\s*guid:\s*([0-9a-f]{32})/g)) {
      const config = readText(guidToPath.get(g[1]) ?? "") ?? "";
      const entries = config.split(/(?=_config:)/).slice(1);
      for (const entry of entries) {
        const ref = /^_config:\s*\{fileID:\s*-?\d+,\s*guid:\s*([0-9a-f]{32})/.exec(entry);
        if (!ref || /_enabled:\s*0\b/.test(entry)) continue;
        const cls = assetGuidToClass.get(ref[1]);
        if (cls) listed.add(cls);
      }
    }
  }
  return { listed: [...listed].sort(), notListed: moduleConfigs.map((m) => m.name).filter((n) => !listed.has(n)).sort() };
}

function readSettings(project) {
  const ps = readText(join(project, "ProjectSettings", "ProjectSettings.asset"));
  const graphics = readText(join(project, "ProjectSettings", "GraphicsSettings.asset"));
  const quality = readText(join(project, "ProjectSettings", "QualitySettings.asset"));
  const out = { found: ps !== null };
  if (ps !== null) {
    const num = (key) => {
      const m = new RegExp(`^\\s*${key}:\\s*(\\d+)`, "m").exec(ps);
      return m ? Number(m[1]) : null;
    };
    const str = (key) => (new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, "m").exec(ps)?.[1] ?? "").trim();
    const orientation = num("defaultScreenOrientation");
    // 0 Portrait, 1 PortraitUpsideDown, 4 AutoRotation (portrait only when
    // both landscape rotations are off).
    out.portraitOnly =
      orientation === 0 ||
      orientation === 1 ||
      (orientation === 4 && num("allowedAutorotateToLandscapeRight") === 0 && num("allowedAutorotateToLandscapeLeft") === 0);
    out.orientation = orientation;
    out.productName = str("productName") !== "";
    out.companyName = str("companyName") !== "" && str("companyName") !== "DefaultCompany";
    const block = /^\s*applicationIdentifier:[ \t]*(\{\})?[ \t]*\n((?:[ \t]{4,}\S.*\n?)*)/m.exec(ps);
    const ids = block && !block[1] ? [...block[2].matchAll(/:\s*(\S+)/g)].map((m) => m[1]) : [];
    out.bundleId = ids.some((id) => id.includes(".") && !/DefaultCompany|com\.Company\.ProductName/.test(id));
  }
  const assigned = (m) => m !== null && Number(m[1]) !== 0;
  out.graphicsFound = graphics !== null;
  out.graphicsPipeline = graphics !== null && assigned(/m_(?:CustomRenderPipeline|DefaultRenderPipeline):\s*\{fileID:\s*(-?\d+)/.exec(graphics));
  const levels = quality === null ? [] : [...quality.matchAll(/customRenderPipeline:\s*\{fileID:\s*(-?\d+)/g)];
  out.qualityFound = quality !== null;
  out.qualityLevels = levels.length;
  out.qualityWithPipeline = levels.filter((m) => Number(m[1]) !== 0).length;
  return out;
}

function packagesState(project) {
  const manifest = readText(join(project, "Packages", "manifest.json")) ?? "";
  const dirs = { core: [], modules: [], mcp: [] };
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const kind = frameworkKind(e.name);
      if (kind) dirs[kind].push(join(dir, e.name));
      else visit(join(dir, e.name), depth + 1);
    }
  };
  visit(join(project, "Packages"), 0);
  visit(join(project, "Assets"), 2);
  return {
    dirs,
    modulesInstalled: dirs.modules.length > 0 || /"com\.strada\.modules[^"]*"\s*:/i.test(manifest),
    urpInstalled: /"com\.unity\.render-pipelines\.universal"\s*:/.test(manifest),
  };
}

function audioState(assets) {
  const files = walkFiles(assets);
  // The game's clips; a framework copy's own sounds are not its to reference.
  const clips = files.filter((f) => AUDIO_EXT.test(f) && !inFrameworkCopy(relative(assets, f)));
  const referenced = new Set();
  for (const f of files.filter((p) => YAML_EXT.test(p))) {
    for (const m of (readText(f) ?? "").matchAll(/guid:\s*([0-9a-f]{32})/g)) referenced.add(m[1]);
  }
  // A clip under Resources/ is loaded by name; nothing in YAML names it.
  const unreferenced = clips.filter((c) => !c.split(sep).includes("Resources") && !referenced.has(guidOfMeta(c) ?? "")).map((c) => relative(assets, c));
  return { clips: clips.length, unreferenced };
}

function buildsState(project) {
  for (const name of ["Builds", "Build"]) {
    const dir = join(project, name);
    try {
      const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
      if (entries.length > 0) return { dir, entries: entries.length };
    } catch {
      /* absent */
    }
  }
  return { dir: null, entries: 0 };
}

export function scanProject(projectPath) {
  const project = resolve(projectPath);
  const assets = join(project, "Assets");
  if (!existsSync(assets) || !statSync(assets).isDirectory()) return { project, cause: `no Assets folder under ${project}` };
  const code = scanGameCode(assets);
  const scenes = buildScenes(project);
  return {
    project,
    code,
    scenes,
    registration: moduleRegistration(project, assets, code.moduleConfigs, scenes),
    settings: readSettings(project),
    packages: packagesState(project),
    audio: audioState(assets),
    builds: buildsState(project),
  };
}

// ─── vaults ─────────────────────────────────────────────────────────────────

const UPSTREAM_NAME = { core: "Strada.Core", modules: "Strada.Modules", mcp: "Strada.MCP" };

/** What one indexed file is, judged from its absolute path. */
export function classifyVaultPath(absPath, upstream) {
  const parts = absPath.split(sep);
  let at = -1;
  let kind = null;
  for (let i = parts.length - 2; i >= 0; i--) {
    kind = frameworkKind(parts[i]);
    if (kind) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    if (/\.cs$/i.test(absPath) && parts.includes("Assets")) return "game-code";
    return /\.md$/i.test(absPath) ? "project-note" : "project-other";
  }
  const inner = parts.slice(at + 1);
  if (inner[0] === "Documentation~") return `${kind}:docs`;
  if (/\.(cs|ts|mts|js|mjs)$/i.test(absPath) && !inner.includes("node_modules") && !inner.includes("dist")) return `${kind}:source`;
  if (/\.(md|txt)$/i.test(absPath)) {
    if (inner.length === 1 && /^(README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY)\b/i.test(inner[0])) return `${kind}:readme`;
    // A vendored copy is plain files in the game's repo, so only the upstream
    // checkout can say whether a note came with the framework or was written
    // into it by a run.
    if (!upstream) return `${kind}:note-unverified`;
    return existsSync(join(upstream, UPSTREAM_NAME[kind], ...inner)) ? `${kind}:upstream-doc` : `${kind}:leaked-note`;
  }
  return `${kind}:other`;
}

/** Named vaults always (a missing one is reported), found ones only when they exist. */
function discoverVaults(project, explicit, packages) {
  const found = [];
  if (project) {
    found.push(join(project, ".strada", "vault", "index.db"));
    for (const dir of [...packages.dirs.core, ...packages.dirs.modules, ...packages.dirs.mcp]) found.push(join(dir, ".strada", "vault", "index.db"));
  }
  return [...new Set([...explicit, ...found.filter((p) => existsSync(p))])];
}

function readVault(path, upstream) {
  const src = openReadOnly("vault index", path);
  if (!src.db) return { path, cause: src.cause };
  try {
    if (!hasTable(src.db, "vault_files")) return { path, cause: `${path} has no vault_files table` };
    // The index lives at <root>/.strada/vault/index.db; its paths are relative to <root>.
    const root = dirname(dirname(dirname(src.path)));
    const counts = {};
    const classes = new Map();
    for (const r of src.db.prepare("SELECT path FROM vault_files").all()) {
      const abs = resolve(root, r.path);
      const cls = classifyVaultPath(abs, upstream);
      classes.set(abs, cls);
      counts[cls] = (counts[cls] ?? 0) + 1;
    }
    const embeddings = hasTable(src.db, "vault_embeddings") ? countOf(src.db, "SELECT count(*) FROM vault_embeddings") : 0;
    const mode = hasTable(src.db, "vault_meta") ? (src.db.prepare("SELECT value FROM vault_meta WHERE key = 'embedding_mode'").get()?.value ?? null) : null;
    return { path: src.path, root, files: classes.size, counts, classes, embeddings, mode };
  } finally {
    src.db.close();
  }
}

// ─── the rungs ──────────────────────────────────────────────────────────────

function campaignsCause(ctx) {
  return ctx.campaignsSrc.db ? null : `campaigns.db not read: ${ctx.campaignsSrc.cause}`;
}

function rung1(ctx) {
  const title = RUNG_TITLES[0];
  if (ctx.log.cause) return blocked(1, title, ctx.log.cause);
  const unknown = newestBootUnknown(ctx.log, ctx.logPath);
  if (unknown) return blocked(1, title, unknown);
  // The newest BOOT, not the newest load: a later boot that loaded nothing
  // writes no load line, so the newest load can belong to a boot long gone.
  const boots = ctx.log.boots;
  const newest = boots.at(-1);
  const withTools = boots.filter((b) => b.loads.length > 0);
  const connected = withTools.filter((b) => b.loads.at(-1).bridgeState === "connected").length;
  const load = newest.loads.at(-1);
  const measured = { boots: boots.length, bootsWithTools: withTools.length, bridgeConnected: connected, registered: Number(load?.registered ?? 0), bootAt: newest.at };
  const checks = [];
  if (load === undefined) {
    const refusal = newest.refusals.at(-1);
    const why = refusal
      ? `${refusal.message}${refusal.error ? ` (${refusal.error})` : ""}`
      : newest.reported
        ? "it reached its boot report without a Strada.MCP load line (no install was found)"
        : "no Strada.MCP load line and no boot report follow it (it is still starting, or it stopped)";
    checks.push(fail(`the newest boot (${newest.at}) loaded no Strada.MCP tools: ${why}`));
  } else {
    checks.push(
      measured.registered > 0
        ? pass(`the newest boot (${newest.at}) registered ${measured.registered} Unity tools from ${load.sourcePath ?? "an unnamed source"}`)
        : fail(`the newest boot (${newest.at}) registered 0 Unity tools`),
      load.bridgeState === "connected"
        ? pass("the editor bridge was connected at that boot")
        : fail(`the editor bridge was ${load.bridgeState ?? "unreported"} at that boot (connected at ${connected} of ${boots.length} boots in the log and its archives)`),
    );
  }
  const bootMs = parseLogTime(newest.at);
  const head = headCommitMs(ctx.brainRoot);
  if (head.cause) checks.push(unmeasured(head.cause));
  else if (!Number.isFinite(bootMs)) checks.push(unmeasured(`the boot's timestamp "${newest.at}" could not be read`));
  else {
    checks.push(
      bootMs >= head.ms
        ? pass(`the boot is not older than HEAD (committed ${isoOf(head.ms)})`)
        : fail(`the boot predates HEAD (committed ${isoOf(head.ms)}): nothing on HEAD has booted`),
    );
  }
  return item(1, title, checks, { measured });
}

function rung2(ctx) {
  const title = RUNG_TITLES[1];
  const cause = campaignsCause(ctx);
  if (cause) return blocked(2, title, cause);
  const all = ctx.store.campaigns;
  const fromIdea = all.filter((c) => c.ideaText !== null);
  const planned = fromIdea.filter((c) => c.milestones.length > 0);
  const text = `${fromIdea.length} of ${all.length} campaigns started from idea_text; ${planned.length} of them reached a plan`;
  return item(2, title, [planned.length > 0 ? pass(text) : fail(text)], { measured: { campaigns: all.length, fromIdea: fromIdea.length, planned: planned.length } });
}

function ledgerCounts(campaign) {
  const rows = campaign.ledger?.rows ?? [];
  const scoped = rows.filter(inScope);
  const ids = new Set(campaign.milestones.map((m) => m.id));
  const owned = scoped.filter((r) => ids.has(ownerOf(r) ?? ""));
  const construct = scoped.filter((r) => typeof r.construct === "string" && r.construct.trim() !== "");
  return { rows: rows.length, scoped: scoped.length, owned: owned.length, construct: construct.length, excluded: rows.filter((r) => r.status === "excluded").length };
}

function rung3(ctx) {
  const title = RUNG_TITLES[2];
  const cause = campaignsCause(ctx);
  if (cause) return blocked(3, title, cause);
  const all = ctx.store.campaigns;
  const withLedger = all.filter((c) => c.ledgerState === "readable" && c.ledger.rows.length > 0);
  const unreadable = all.filter((c) => c.ledgerState === "unreadable").length;
  const fully = withLedger.filter((c) => {
    const n = ledgerCounts(c);
    return n.scoped > 0 && n.owned === n.scoped;
  });
  const column = ctx.store.hasLedgerColumn ? "" : " (campaigns.db has no requirements_json column: no code with the ledger ever opened it)";
  const checks = [
    withLedger.length > 0
      ? pass(`${withLedger.length} of ${all.length} campaigns carry a requirement ledger`)
      : fail(`0 of ${all.length} campaigns carry a requirement ledger${column}`),
  ];
  if (withLedger.length > 0) {
    const detail = withLedger.map((c) => {
      const n = ledgerCounts(c);
      return `${c.id}: ${n.owned} of ${n.scoped} in-scope rows owned by a milestone of its plan`;
    });
    checks.push(fully.length > 0 ? pass(detail.join("; ")) : fail(detail.join("; ")));
  }
  return item(3, title, checks, {
    notes: unreadable > 0 ? [`${unreadable} campaigns hold a ledger this scorecard could not parse`] : [],
    measured: { campaigns: all.length, withLedger: withLedger.length, fullyOwned: fully.length },
  });
}

function rung4(ctx) {
  const title = RUNG_TITLES[3];
  const cause = campaignsCause(ctx);
  if (cause) return blocked(4, title, cause);
  const all = ctx.store.campaigns;
  const withLedger = all.filter((c) => c.ledgerState === "readable" && c.ledger.rows.length > 0);
  const planned = all.filter((c) => c.milestones.length > 0);
  const pastFirst = planned.filter((c) => c.milestones[0]?.status === "green").length;
  const checks = [];
  if (withLedger.length === 0) {
    checks.push(fail(`no campaign has a requirement ledger, so no row is mapped to a framework construct`));
  } else {
    const mapped = withLedger.filter((c) => {
      const n = ledgerCounts(c);
      return n.scoped > 0 && n.construct === n.scoped && n.owned === n.scoped;
    });
    const detail = withLedger.map((c) => {
      const n = ledgerCounts(c);
      return `${c.id}: ${n.construct} of ${n.scoped} in-scope rows name a construct, ${n.owned} an owner`;
    });
    checks.push(mapped.length > 0 ? pass(detail.join("; ")) : fail(detail.join("; ")));
  }
  return item(4, title, checks, {
    notes: [`${pastFirst} of ${planned.length} planned campaigns got past their first milestone`],
    measured: { planned: planned.length, pastFirstMilestone: pastFirst },
  });
}

function rung5(ctx) {
  const title = RUNG_TITLES[4];
  const cause = campaignsCause(ctx);
  if (cause) return blocked(5, title, cause);
  const all = ctx.store.campaigns;
  const byMode = { off: 0, shadow: 0, on: 0 };
  const scopedIds = new Set(all.map((c) => c.id));
  for (const j of ctx.store.judgements ?? []) if (scopedIds.has(j.campaignId)) byMode[j.mode] = (byMode[j.mode] ?? 0) + 1;
  const table = ctx.store.judgements ? `judgements: off ${byMode.off}, shadow ${byMode.shadow}, on ${byMode.on}` : "campaigns.db has no campaign_judgements table";
  const greensOf = (campaigns) => campaigns.flatMap((c) => greenMilestones(c).map((m) => ({ c, m })));
  const provenOf = (greens) => greens.filter(({ c, m }) => gateProof(ctx.store, c, m).proven).length;
  const verdict = (greens, proven, text) => (greens.length > 0 && proven === greens.length ? pass(text) : fail(text));
  if (ctx.campaignFilter) {
    // One campaign, scored on its own (the proof run), is held to every green it has.
    const greens = greensOf(all);
    const proven = provenOf(greens);
    const text = `${proven} of ${greens.length} green milestones were judged green on a proven basis by the scope gate in mode on (${table})`;
    return item(5, title, [verdict(greens, proven, text)], { measured: { greenMilestones: greens.length, provenByGate: proven, judgements: byMode } });
  }
  // Across every campaign, the rung asks what the gate did once it decided.
  // Greens that predate it are left out: those of campaigns created before it
  // first decided anywhere (the earliest scope_gate_since) and never run under
  // it, and those production itself marked legacy when the ledger was first
  // built. Every other green counts, so one that bypassed the gate, or a later
  // campaign run with the gate off, still fails the rung.
  const gated = all.filter((c) => c.scopeGateSince !== null);
  const since = gated.length > 0 ? Math.min(...gated.map((c) => Number(c.scopeGateSince))) : null;
  const before = all.filter((c) => c.scopeGateSince === null && (since === null || c.createdAt < since));
  const inScope = all.filter((c) => !before.includes(c));
  const counted = greensOf(inScope).filter(({ m }) => m.judgementBasis !== "legacy");
  const legacy = greensOf(inScope).length - counted.length;
  const earlier = greensOf(before);
  const proven = provenOf(counted);
  const notes = [
    `${plural(legacy + earlier.length, "green milestone")} not counted: ${legacy} marked legacy (green before the ledger), ${earlier.length} in ${plural(before.length, "campaign")} from before the gate first decided`,
  ];
  const measured = { greenMilestones: counted.length, provenByGate: proven, legacyGreens: legacy, greensBeforeGate: earlier.length, gatedCampaigns: gated.length, judgements: byMode };
  if (gated.length === 0) {
    const text = `no campaign ran under the scope gate in mode on (scope_gate_since is unset on all ${plural(all.length, "campaign")}); ${provenOf(earlier)} of ${earlier.length} green milestones were judged green on a proven basis by the scope gate in mode on (${table})`;
    return item(5, title, [fail(text)], { notes, measured });
  }
  const text = `${proven} of ${counted.length} green milestones in ${plural(inScope.length, "campaign")} since the scope gate first decided were judged green on a proven basis by the scope gate in mode on (${table})`;
  return item(5, title, [verdict(counted, proven, text)], { notes, measured });
}

function projectCause(ctx) {
  if (!ctx.projectPath) return "no --project was given";
  return ctx.project?.cause ?? null;
}

function rung6(ctx) {
  const title = RUNG_TITLES[5];
  const cause = projectCause(ctx);
  if (cause) return blocked(6, title, cause);
  const c = ctx.project.code;
  const checks = [
    c.moduleConfigs.length > 0 ? pass(`the game declares ${plural(c.moduleConfigs.length, "ModuleConfig subclass", "ModuleConfig subclasses")}`) : fail("the game declares no ModuleConfig subclass"),
    c.duplicates.length === 0
      ? pass("no type name is declared in two modules")
      : fail(`${plural(c.duplicates.length, "type name")} declared in two or more modules (${c.duplicates.slice(0, 8).map((d) => d.name).join(", ")}${c.duplicates.length > 8 ? ", …" : ""})`),
    c.emptyOnUpdate.length === 0
      ? pass(`${c.systems.length} systems, none with an empty OnUpdate`)
      : fail(`${c.emptyOnUpdate.length} of ${c.systems.length} systems have an empty OnUpdate (${c.emptyOnUpdate.slice(0, 6).map((s) => s.name).join(", ")})`),
    c.unregisteredServices.length === 0
      ? pass(`${c.services.length} services, all registered`)
      : fail(`${c.unregisteredServices.length} of ${c.services.length} services are never registered (${c.unregisteredServices.slice(0, 6).map((s) => s.name).join(", ")})`),
    c.findObject.length === 0
      ? pass("no FindObject*/GameObject.Find lookups")
      : fail(`${c.findObject.reduce((a, f) => a + f.calls, 0)} FindObject*/GameObject.Find calls in ${plural(c.findObject.length, "file")}`),
    c.newService.length === 0 ? pass("no `new *Service(` in game code") : fail(`${c.newService.length} \`new *Service(\` constructions in game code`),
  ];
  return item(6, title, checks, {
    notes: [
      `${c.withoutCore} of ${c.gameFiles} game .cs files (${pct(c.withoutCore, c.gameFiles)}) reference no Strada.Core namespace (reported, not gated: a file without a Core reference is not by itself a violation)`,
    ],
    measured: {
      gameFiles: c.gameFiles,
      filesWithoutCore: c.withoutCore,
      duplicateTypeNames: c.duplicates.length,
      systems: c.systems.length,
      emptyOnUpdate: c.emptyOnUpdate.length,
      services: c.services.length,
      unregisteredServices: c.unregisteredServices.length,
      moduleConfigs: c.moduleConfigs.length,
      findObjectFiles: c.findObject.length,
      newService: c.newService.length,
    },
  });
}

function rung7(ctx) {
  const title = RUNG_TITLES[6];
  const cause = projectCause(ctx);
  if (cause) return blocked(7, title, cause);
  const { code, packages } = ctx.project;
  const checks = [
    packages.modulesInstalled ? pass("Strada.Modules is installed in the project") : fail("Strada.Modules is not installed in the project (no Packages folder or manifest entry)"),
    code.modulesRefs.length > 0
      ? pass(`${plural(code.modulesRefs.length, "game file")} reference Strada.Modules`)
      : fail(`0 of ${code.gameFiles} game files reference Strada.Modules`),
  ];
  return item(7, title, checks, {
    notes: code.screenTypes.length > 0 ? [`screen-switching types the game declares itself: ${code.screenTypes.join(", ")}`] : [],
    measured: { modulesInstalled: packages.modulesInstalled, filesReferencingModules: code.modulesRefs.length, handRolledScreenTypes: code.screenTypes.length },
  });
}

function playEvidence(campaigns) {
  const builds = [];
  const runs = [];
  const plays = [];
  for (const c of campaigns) {
    for (const m of c.milestones) {
      if (isRecord(m.buildVerdict)) builds.push(m.buildVerdict);
      for (const r of Array.isArray(m.playerRunsByTarget) ? m.playerRunsByTarget : []) if (isRecord(r)) runs.push(r);
      for (const p of [m.playthroughVerdict, m.playerPlaythrough]) if (isRecord(p)) plays.push(p);
    }
  }
  const outcomes = new Set();
  for (const p of plays) {
    if (typeof p.outcome === "string") outcomes.add(p.outcome);
    for (const s of Array.isArray(p.sessions) ? p.sessions : []) if (isRecord(s) && typeof s.outcome === "string") outcomes.add(s.outcome);
  }
  return {
    buildsOk: builds.filter((b) => b.ran === true && b.ok === true).length,
    builds: builds.length,
    runsOk: runs.filter((r) => r.ok === true).length,
    runs: runs.length,
    playsOk: plays.filter((p) => p.found === true && p.ok === true).length,
    plays: plays.length,
    outcomes,
    routes: plays.map((p) => p.inputRoute).filter((r) => typeof r === "string"),
  };
}

function toolLine(learning, tool) {
  const t = learning.tools[tool] ?? { calls: 0, ok: 0 };
  return `${tool}: ${t.calls} calls (${t.ok} succeeded)`;
}

function rung8(ctx) {
  const title = RUNG_TITLES[7];
  const haveCampaigns = Boolean(ctx.campaignsSrc.db);
  const haveLearning = Boolean(ctx.learning);
  if (!haveCampaigns && !haveLearning) return blocked(8, title, `${campaignsCause(ctx)}; learning.db not read: ${ctx.learningSrc.cause}`);
  const ev = haveCampaigns ? playEvidence(ctx.store.campaigns) : null;
  const tools = ctx.learning?.tools ?? {};
  const window = ctx.learning?.toolWindow;
  const where = haveLearning ? ` [learning.db observations ${isoOf(window?.first)} → ${isoOf(window?.last)}]` : "";
  const either = (fromDb, fromCampaign, text) => (fromDb || fromCampaign ? pass(text) : fail(text));
  const checks = [
    either(
      (tools.unity_build_player?.ok ?? 0) > 0,
      (ev?.buildsOk ?? 0) > 0,
      `${haveLearning ? toolLine(ctx.learning, "unity_build_player") : "learning.db not read"}${where}; milestones with a player build that ran and passed: ${ev ? `${ev.buildsOk} of ${ev.builds} build verdicts` : "campaigns.db not read"}`,
    ),
    either(
      (tools.unity_run_player?.ok ?? 0) > 0,
      (ev?.runsOk ?? 0) > 0,
      `${haveLearning ? toolLine(ctx.learning, "unity_run_player") : "learning.db not read"}; player runs that passed: ${ev ? `${ev.runsOk} of ${ev.runs}` : "campaigns.db not read"}`,
    ),
  ];
  if (ev) {
    checks.push(ev.playsOk > 0 ? pass(`${ev.playsOk} of ${ev.plays} play-through verdicts are ok`) : fail(`${ev.playsOk} of ${ev.plays} play-through verdicts are ok`));
    const both = ev.outcomes.has("Won") && ev.outcomes.has("Lost");
    const seen = [...ev.outcomes].sort().join(", ") || "none";
    checks.push(both ? pass(`both Won and Lost were observed (outcomes: ${seen})`) : fail(`Won and Lost were not both observed (outcomes: ${seen})`));
    if (ev.routes.length === 0) {
      checks.push(unmeasured("no play-through record states its input route, so play driven through the game's own Act cannot be told from real input"));
    } else {
      const real = ev.routes.filter((r) => r === "input").length;
      checks.push(real > 0 ? pass(`${real} of ${ev.routes.length} play-throughs were driven through real input`) : fail(`0 of ${ev.routes.length} play-throughs were driven through real input`));
    }
  } else {
    checks.push(unmeasured(campaignsCause(ctx)));
  }
  return item(8, title, checks, {
    measured: {
      buildPlayerCalls: tools.unity_build_player?.calls ?? null,
      buildPlayerOk: tools.unity_build_player?.ok ?? null,
      runPlayerCalls: tools.unity_run_player?.calls ?? null,
      runPlayerOk: tools.unity_run_player?.ok ?? null,
      playthroughsOk: ev?.playsOk ?? null,
      outcomes: ev ? [...ev.outcomes].sort() : null,
    },
  });
}

function retrievalLine(l) {
  const raw = `${l.retrievals.anything} of ${l.retrievals.n} retrievals returned anything`;
  const rolled = l.rollup.n > 0 ? `; ${l.rollup.n} older retrievals rolled up with ${l.rollup.insights} insights returned in total` : "";
  return `${raw}${rolled}`;
}

function rung9(ctx) {
  const title = RUNG_TITLES[8];
  if (!ctx.learning) return blocked(9, title, `learning.db not read: ${ctx.learningSrc.cause}`);
  const l = ctx.learning;
  const returned = l.retrievals.anything + l.rollup.insights;
  const absent = (t) => (l.tables[t] ? "" : ` (no ${t} table)`);
  const later = `${l.laterExposures} of ${l.exposures} exposures showed a lesson to a later run than the one that learned it`;
  const checks = [
    returned > 0 ? pass(retrievalLine(l)) : fail(`${retrievalLine(l)}${absent("retrieval_metrics")}`),
    l.laterExposures > 0
      ? pass(later)
      : l.exposures === 0
        ? fail(`${later}${absent("instinct_exposure_log")}`)
        : l.unprovenancedExposures > 0
          ? unmeasured(
              `lesson provenance not recorded: ${l.unprovenancedExposures} of ${l.exposures} exposures show an instinct with no origin session, so a later run cannot be told from the run that learned it`,
            )
          : fail(later),
  ];
  return item(9, title, checks, {
    notes: [`${l.credits} credits recorded; ${l.instincts} instincts stored`],
    measured: {
      retrievals: l.retrievals.n,
      retrievalsReturningAnything: l.retrievals.anything,
      rolledUpRetrievals: l.rollup.n,
      rolledUpInsights: l.rollup.insights,
      exposures: l.exposures,
      laterExposures: l.laterExposures,
      exposuresWithoutProvenance: l.unprovenancedExposures,
      credits: l.credits,
    },
  });
}

function deliveredUnderGate(ctx, campaign) {
  if (campaign.state !== "done" || !campaign.deliveryReported) return false;
  const greens = greenMilestones(campaign);
  return greens.length > 0 && greens.length === campaign.milestones.length && greens.every((m) => gateProof(ctx.store, campaign, m).proven);
}

function rung10(ctx) {
  const title = RUNG_TITLES[9];
  const cause = campaignsCause(ctx);
  if (cause) return blocked(10, title, cause);
  const all = ctx.store.campaigns;
  const done = all.filter((c) => c.state === "done");
  const gated = done.filter((c) => deliveredUnderGate(ctx, c));
  const text = `${all.length} campaigns, ${done.length} done; ${gated.length} delivered with every milestone judged green on a proven basis by the scope gate in mode on`;
  const checks = [gated.length > 0 ? pass(text) : fail(text)];
  if (gated.length > 0) {
    const counted = gated.map((c) => ownerMessages(ctx.tasksSrc, c, c.updatedAt));
    const clean = counted.filter((c) => c.ok === true);
    checks.push(clean.length > 0 ? clean[0] : counted.find((c) => c.ok === null) ?? counted[0]);
  }
  return item(10, title, checks, { measured: { campaigns: all.length, done: done.length, deliveredUnderGate: gated.length } });
}

// ─── the proof run's criteria ───────────────────────────────────────────────

function chooseProofCampaign(ctx) {
  const store = ctx.store;
  if (!store) return { campaign: null, chosenBy: campaignsCause(ctx) ?? "no campaign store" };
  if (ctx.campaignFilter) return { campaign: store.campaigns[0] ?? null, chosenBy: "--campaign" };
  if (store.all.length === 0) return { campaign: null, chosenBy: "campaigns.db holds no campaign" };
  if (ctx.projectPath) {
    const real = realOrResolved(ctx.projectPath);
    const mine = store.all.filter((c) => realOrResolved(c.projectRoot) === real);
    if (mine.length > 0) return { campaign: mine.at(-1), chosenBy: "the newest campaign on --project" };
  }
  return { campaign: store.all.at(-1), chosenBy: "the newest campaign in campaigns.db" };
}

function criterionA(ctx, run) {
  const checks = [];
  checks.push(run.deliveryReported && run.state === "done" ? pass(`${run.id} was delivered (state done)`) : fail(`${run.id} is ${run.state}, not delivered`));
  checks.push(ownerMessages(ctx.tasksSrc, run, run.updatedAt));
  checks.push(unmeasured("LLM calls per campaign are in no database this scorecard reads"));
  checks.push(unmeasured("restarts during gate work and their re-measurement are not recorded"));
  const hours = (run.updatedAt - run.createdAt) / 3_600_000;
  return item("A", CRITERION_TITLES.A, checks, { notes: [`wall time ${hours.toFixed(1)} h (start → last update)`], measured: { wallHours: Number(hours.toFixed(2)) } });
}

function ledgerBlocked(id, run) {
  if (run.ledgerState === "readable") return null;
  return item(id, CRITERION_TITLES[id], [fail(`${run.id} has ${run.ledgerState === "unreadable" ? "an unreadable" : "no"} requirement ledger`)]);
}

function criterionB(ctx, run) {
  const none = ledgerBlocked("B", run);
  if (none) return none;
  const l = run.ledger;
  const byKind = {};
  for (const r of l.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const gaps = Array.isArray(l.numberingGaps) ? l.numberingGaps : [];
  const overflow = Number(l.overflow?.count ?? 0);
  const checks = [
    l.rows.length > 0 ? pass(`${l.rows.length} rows`) : fail("the ledger holds no row"),
    gaps.length === 0 ? pass("no numbering gap") : fail(`numbering gaps: ${gaps.map((g) => `${g.series} missing ${(g.missing ?? []).join(",")}`).join("; ")}`),
    overflow === 0 ? pass("no row overflow") : fail(`${overflow} requirements overflowed the ledger`),
    unmeasured("whether every numbered rule, screen and value of the spec has a row needs the spec itself; compare the counts by kind with it"),
  ];
  const n = ledgerCounts(run);
  return item("B", CRITERION_TITLES.B, checks, {
    notes: [`rows by kind: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${n.excluded} excluded (deferred)`],
    measured: { rows: l.rows.length, byKind, excluded: n.excluded, numberingGaps: gaps.length, overflow },
  });
}

function criterionC(ctx, run) {
  const none = ledgerBlocked("C", run);
  if (none) return none;
  const n = ledgerCounts(run);
  const first = run.milestones[0]?.id;
  const firstInputs = run.ledger.rows.filter((r) => inScope(r) && r.kind === "input" && ownerOf(r) === first).length;
  const checks = [
    n.scoped > 0 && n.owned === n.scoped ? pass(`${n.owned} of ${n.scoped} in-scope rows have an owner in the plan`) : fail(`${n.owned} of ${n.scoped} in-scope rows have an owner in the plan`),
    n.scoped > 0 && n.construct === n.scoped
      ? pass(`${n.construct} of ${n.scoped} in-scope rows name a framework construct`)
      : fail(`${n.construct} of ${n.scoped} in-scope rows name a framework construct (no architecture map is stored)`),
    firstInputs > 0 ? pass(`the first milestone owns ${plural(firstInputs, "input row")}`) : fail(`the first milestone (${first ?? "none"}) owns no input row`),
  ];
  return item("C", CRITERION_TITLES.C, checks, { measured: { scoped: n.scoped, owned: n.owned, construct: n.construct, firstMilestoneInputRows: firstInputs } });
}

function criterionD(ctx, run) {
  const greens = greenMilestones(run);
  const checks = [greens.length > 0 ? pass(`${greens.length} of ${run.milestones.length} milestones are green`) : fail("no milestone is green")];
  const problems = [];
  const writers = new Set();
  for (const m of greens) {
    const proof = gateProof(ctx.store, run, m);
    if (!proof.proven) {
      problems.push(`${m.id}: ${proof.why}`);
      continue;
    }
    const input = isRecord(proof.judgement.input) ? proof.judgement.input : {};
    const r = isRecord(input.run) ? input.run : null;
    if (!r || r.admitted !== true) problems.push(`${m.id}: no admitted acceptance run`);
    else {
      if (r.revision !== proof.judgement.revision) problems.push(`${m.id}: the run measured ${r.revision}, the judgement ${proof.judgement.revision}`);
      const expected = Array.isArray(r.expected) ? r.expected.length : null;
      if (expected === null || r.total !== expected) problems.push(`${m.id}: total ${r.total ?? "unrecorded"} against ${expected ?? "unrecorded"} expected`);
    }
    for (const s of Array.isArray(input.sources) ? input.sources : []) writers.add(s?.writer?.independence ?? "unrecorded");
  }
  if (greens.length > 0) {
    checks.push(problems.length === 0 ? pass("every green milestone has an admitted, complete acceptance run on its judged revision") : fail(problems.join("; ")));
    checks.push(
      writers.size === 1 && writers.has("different-model")
        ? pass("every acceptance file was written by a different model")
        : fail(`acceptance writer independence: ${[...writers].join(", ") || "no writer recorded"}`),
    );
  }
  checks.push(unmeasured("Run A's false-red criteria need its shadow statistics and a person's sample of 10 parks"));
  return item("D", CRITERION_TITLES.D, checks, { measured: { green: greens.length, problems: problems.length, writers: [...writers] } });
}

function criterionE(ctx, run) {
  const checks = [];
  if (run.ledgerState === "readable") {
    const scoped = run.ledger.rows.filter(inScope);
    const passing = scoped.filter((r) => r.status === "passing").length;
    checks.push(scoped.length > 0 && passing === scoped.length ? pass(`${passing} of ${scoped.length} in-scope rows pass`) : fail(`${passing} of ${scoped.length} in-scope rows pass`));
  } else {
    checks.push(fail(`${run.id} has no readable requirement ledger`));
  }
  const compiled = run.milestones.map((m) => m.compileVerdict).filter(isRecord).at(-1);
  checks.push(compiled ? (compiled.ran && compiled.ok ? pass("the last compile verdict is clean") : fail(`the last compile verdict is ${compiled.ran ? "failing" : "not run"}`)) : fail("no compile verdict is recorded"));
  checks.push(unmeasured("PlayMode and EditMode suite counts are not stored per mode"));
  const pc = projectCause(ctx);
  if (pc) checks.push(unmeasured(`Builds/: ${pc}`));
  else checks.push(ctx.project.builds.entries > 0 ? pass(`${ctx.project.builds.dir} holds ${ctx.project.builds.entries} entries`) : fail("the project has no Builds/ output"));
  const ev = playEvidence([run]);
  checks.push(ev.runsOk > 0 ? pass(`${ev.runsOk} of ${ev.runs} player runs passed`) : fail(`${ev.runsOk} of ${ev.runs} player runs passed`));
  checks.push(ev.playsOk > 0 ? pass(`${ev.playsOk} of ${ev.plays} play-through verdicts are ok`) : fail(`${ev.playsOk} of ${ev.plays} play-through verdicts are ok`));
  const seen = [...ev.outcomes].sort().join(", ") || "none";
  checks.push(ev.outcomes.has("Won") && ev.outcomes.has("Lost") ? pass(`Won and Lost observed (${seen})`) : fail(`Won and Lost not both observed (outcomes: ${seen})`));
  checks.push(
    ev.routes.length === 0
      ? unmeasured("no play-through record states its input route")
      : ev.routes.every((r) => r === "input")
        ? pass("every play-through used real input")
        : fail(`input routes: ${ev.routes.join(", ")}`),
  );
  checks.push(unmeasured("the play-through scenarios (menu → level → result, pause, back key, relaunch) are not recorded by name"));
  return item("E", CRITERION_TITLES.E, checks);
}

function criterionF(ctx) {
  const pc = projectCause(ctx);
  if (pc) return blocked("F", CRITERION_TITLES.F, pc);
  const { code, registration, scenes } = ctx.project;
  const r6 = rung6(ctx).checks.slice(1);
  const checks = [...r6];
  checks.push(code.reflectionBootstrap.length === 0 ? pass("no reflection bootstrap") : fail(`reflection bootstrap in ${code.reflectionBootstrap.join(", ")}`));
  if (registration.cause) checks.push(unmeasured(`module registration: ${registration.cause}`));
  else {
    checks.push(
      registration.notListed.length === 0
        ? pass(`all ${code.moduleConfigs.length} ModuleConfig subclasses are listed by an enabled build scene's bootstrapper`)
        : fail(`${registration.notListed.length} of ${code.moduleConfigs.length} ModuleConfig subclasses are in no enabled build scene's bootstrapper (${registration.notListed.slice(0, 6).join(", ")})`),
    );
  }
  if (scenes === null) checks.push(unmeasured("build scenes: ProjectSettings/EditorBuildSettings.asset not found"));
  else {
    const shipped = scenes.filter((s) => s.enabled);
    const foreign = shipped.filter((s) => !s.path.startsWith("Assets/") || s.path.split("/").some((d) => NON_GAME_DIRS.has(d) || d === "Samples"));
    checks.push(
      shipped.length > 0 && foreign.length === 0
        ? pass(`${shipped.length} enabled build scenes, all game scenes`)
        : fail(shipped.length === 0 ? "no enabled build scene" : `${foreign.length} enabled build scenes are not game scenes (${foreign.map((s) => s.path).join(", ")})`),
    );
  }
  checks.push(unmeasured("DI closure ([Inject] members resolving to a registration) and bus closure are not analysed here"));
  checks.push(unmeasured("Core's ArchitectureValidator needs the Unity editor"));
  checks.push(unmeasured("which screens go through IScreenService needs the spec's screen list"));
  return item("F", CRITERION_TITLES.F, checks);
}

function criterionG(ctx) {
  const pc = projectCause(ctx);
  if (pc) return blocked("G", CRITERION_TITLES.G, pc);
  const s = ctx.project.settings;
  const checks = [];
  if (!s.found) checks.push(unmeasured("ProjectSettings/ProjectSettings.asset not found"));
  else {
    checks.push(s.portraitOnly ? pass("portrait only") : fail(`not portrait only (defaultScreenOrientation ${s.orientation ?? "unset"})`));
    checks.push(s.productName ? pass("product name set") : fail("product name not set"));
    checks.push(s.companyName ? pass("company name set") : fail("company name not set (empty or DefaultCompany)"));
    checks.push(s.bundleId ? pass("bundle id set") : fail("no bundle id set"));
  }
  checks.push(ctx.project.code.targetFrameRate60 > 0 ? pass("game code sets Application.targetFrameRate = 60") : fail("no game code sets Application.targetFrameRate = 60"));
  checks.push(ctx.project.packages.urpInstalled ? pass("URP is in Packages/manifest.json") : fail("URP is not in Packages/manifest.json"));
  if (!s.graphicsFound) checks.push(unmeasured("ProjectSettings/GraphicsSettings.asset not found"));
  else checks.push(s.graphicsPipeline ? pass("a render pipeline asset is assigned on Graphics") : fail("no render pipeline asset is assigned on Graphics"));
  if (!s.qualityFound) checks.push(unmeasured("ProjectSettings/QualitySettings.asset not found"));
  else {
    checks.push(
      s.qualityLevels > 0 && s.qualityWithPipeline === s.qualityLevels
        ? pass(`all ${s.qualityLevels} quality levels assign a render pipeline asset`)
        : fail(`${s.qualityWithPipeline} of ${s.qualityLevels} quality levels assign a render pipeline asset`),
    );
  }
  return item("G", CRITERION_TITLES.G, checks);
}

function criterionH(ctx) {
  return item("H", CRITERION_TITLES.H, [
    ctx.store.hasAssumptionStore ? unmeasured("an assumption store exists but this scorecard does not read it yet") : fail("campaigns.db has no store for assumption records"),
  ]);
}

function criterionI(ctx, run) {
  const checks = [];
  const art = run.milestones.map((m) => m.placeholderArtAtStart).filter(isRecord).at(-1);
  if (!art) checks.push(unmeasured("no placeholder-art count is recorded on any milestone"));
  else if (Number(art.placeholders) === 0) checks.push(pass(`0 of ${art.sprites} sprites are placeholders (project-wide)`));
  else checks.push(unmeasured(`${art.placeholders} of ${art.sprites} sprites are placeholders project-wide; which of them are the spec's elements needs the spec`));
  const pc = projectCause(ctx);
  if (pc) checks.push(unmeasured(`audio: ${pc}`));
  else {
    const a = ctx.project.audio;
    checks.push(
      a.clips > 0 && a.unreferenced.length === 0
        ? pass(`${a.clips} audio clips, all referenced`)
        : fail(a.clips === 0 ? "no audio clip in Assets" : `${a.unreferenced.length} of ${a.clips} audio clips are referenced by nothing (${a.unreferenced.slice(0, 4).join(", ")})`),
    );
  }
  checks.push(unmeasured("persistence of the volume settings is not recorded"));
  return item("I", CRITERION_TITLES.I, checks);
}

function criterionJ(ctx) {
  if (!ctx.learning) return blocked("J", CRITERION_TITLES.J, `learning.db not read: ${ctx.learningSrc.cause}`);
  const l = ctx.learning;
  const returned = l.retrievals.anything + l.rollup.insights;
  return item("J", CRITERION_TITLES.J, [
    l.milestoneLessons > 0 ? pass(`${l.milestoneLessons} instincts carry a milestone or campaign tag`) : fail("0 instincts carry a milestone or campaign tag"),
    l.exposures > 0 ? pass(`${l.exposures} exposure_log rows`) : fail("0 exposure_log rows"),
    returned > 0 ? pass(retrievalLine(l)) : fail(retrievalLine(l)),
  ]);
}

function criterionK(ctx) {
  const read = ctx.vaults.filter((v) => !v.cause);
  if (read.length === 0) {
    const why = ctx.vaults.length === 0 ? "no vault index was found (pass --project or --vault)" : ctx.vaults.map((v) => v.cause).join("; ");
    return blocked("K", CRITERION_TITLES.K, why);
  }
  // A project vault also indexes the framework copies under Packages/, which
  // have vaults of their own: one file is counted once, whichever index holds it.
  const unique = new Map();
  for (const v of read) for (const [abs, cls] of v.classes) unique.set(abs, cls);
  const tally = {};
  for (const cls of unique.values()) tally[cls] = (tally[cls] ?? 0) + 1;
  const sum = (cls) => tally[cls] ?? 0;
  const kinds = ["core", "modules", "mcp"];
  const leaked = kinds.reduce((a, k) => a + sum(`${k}:leaked-note`), 0);
  const unverified = kinds.reduce((a, k) => a + sum(`${k}:note-unverified`), 0);
  const checks = [
    sum("core:docs") > 0 ? pass(`${sum("core:docs")} Core Documentation~ files indexed`) : fail("no Core Documentation~ file is indexed"),
    sum("core:source") > 0 ? pass(`${sum("core:source")} Core source files indexed`) : fail("no Core source file is indexed"),
    sum("modules:source") > 0 ? pass(`${sum("modules:source")} Strada.Modules source files indexed`) : fail("no Strada.Modules source file is indexed"),
  ];
  if (ctx.upstream) checks.push(leaked === 0 ? pass("0 notes inside framework folders that upstream does not have") : fail(`${leaked} indexed notes sit inside framework folders and are not in upstream`));
  else if (unverified === 0) checks.push(pass("no note inside a framework folder is indexed"));
  else checks.push(unmeasured(`${unverified} indexed notes inside framework folders cannot be told from upstream docs without --upstream`));
  const embeddings = read.reduce((a, v) => a + v.embeddings, 0);
  const modes = read.map((v) => v.mode ?? "unrecorded");
  return item("K", CRITERION_TITLES.K, checks, {
    notes: [
      `measured on ${unique.size} distinct files in ${read.length} vault indexes (what retrieval can return), not on a log of what reached a prompt`,
      `embedding mode per index: ${modes.join(", ")}; ${embeddings} embedding rows`,
    ],
    measured: {
      vaults: read.length,
      files: unique.size,
      coreDocs: sum("core:docs"),
      coreSource: sum("core:source"),
      modulesSource: sum("modules:source"),
      gameCode: sum("game-code"),
      leakedNotes: ctx.upstream ? leaked : null,
      embeddingModes: modes,
      embeddings,
    },
  });
}

function criterionL() {
  return blocked("L", CRITERION_TITLES.L, "negative controls run on a copy of the delivered project; this scorecard only reads");
}

function criteria(ctx) {
  const proof = chooseProofCampaign(ctx);
  const run = proof.campaign;
  const needRun = (id) => blocked(id, CRITERION_TITLES[id], `no proof campaign: ${proof.chosenBy}`);
  const list = [
    run ? criterionA(ctx, run) : needRun("A"),
    run ? criterionB(ctx, run) : needRun("B"),
    run ? criterionC(ctx, run) : needRun("C"),
    run ? criterionD(ctx, run) : needRun("D"),
    run ? criterionE(ctx, run) : needRun("E"),
    criterionF(ctx),
    criterionG(ctx),
    ctx.store ? criterionH(ctx) : blocked("H", CRITERION_TITLES.H, campaignsCause(ctx)),
    run ? criterionI(ctx, run) : needRun("I"),
    criterionJ(ctx),
    criterionK(ctx),
    criterionL(),
  ];
  return { proof: { campaign: run?.id ?? null, chosenBy: proof.chosenBy }, list };
}

// ─── facts that are not rungs ───────────────────────────────────────────────

function taskFacts(tasksSrc) {
  if (!tasksSrc.db) return { cause: tasksSrc.cause };
  const db = tasksSrc.db;
  if (!hasTable(db, "tasks")) return { cause: `${tasksSrc.path} has no tasks table` };
  const where = "COALESCE(origin, 'user') = 'user'";
  const byStatus = {};
  for (const r of db.prepare(`SELECT status, count(*) AS n FROM tasks WHERE ${where} GROUP BY status`).all()) byStatus[r.status] = Number(r.n);
  const span = db.prepare("SELECT min(created_at) AS first, max(created_at) AS last, count(*) AS n FROM tasks").get();
  const lastCompleted = db.prepare(`SELECT max(COALESCE(completed_at, updated_at)) AS at FROM tasks WHERE ${where} AND status = 'completed'`).get().at;
  const user = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { tasks: Number(span.n), userTasks: user, byStatus, first: span.first, last: span.last, lastCompletedUserTask: lastCompleted ?? null };
}

// ─── the whole card ─────────────────────────────────────────────────────────

export function defaultPaths(env = process.env, home = homedir()) {
  const stradaHome = env.STRADA_HOME?.trim() ? resolve(env.STRADA_HOME.trim()) : join(home, ".strada");
  return { home: stradaHome, memoryDir: env.MEMORY_DB_PATH?.trim() ? resolve(env.MEMORY_DB_PATH.trim()) : join(stradaHome, ".strada-memory") };
}

/**
 * Measure everything. `opts` mirrors the CLI flags; every path is optional
 * and an absent source turns the rungs that need it into "not measured".
 */
export function scoreNorthStar(opts = {}) {
  const defaults = defaultPaths(opts.env, opts.homeDir);
  const home = opts.home ? resolve(opts.home) : defaults.home;
  const memoryDir = opts.memoryDir ? resolve(opts.memoryDir) : opts.home ? join(home, ".strada-memory") : defaults.memoryDir;
  const campaignsSrc = openReadOnly("campaigns.db", opts.campaignsDb ?? join(memoryDir, "campaigns.db"));
  const tasksSrc = openReadOnly("tasks.db", opts.tasksDb ?? join(memoryDir, "tasks.db"));
  const learningSrc = openReadOnly("learning.db", opts.learningDb ?? join(memoryDir, "learning.db"));
  const logPath = resolve(opts.log ?? join(home, "strada-brain.log"));
  try {
    let store = null;
    if (campaignsSrc.db) {
      store = readCampaignStore(campaignsSrc, opts.campaign ?? null);
      if (store.cause) {
        campaignsSrc.cause = store.cause;
        campaignsSrc.db.close();
        campaignsSrc.db = null;
        store = null;
      } else if (opts.campaign && store.campaigns.length === 0) {
        const err = new Error(`campaign ${opts.campaign} is not in ${campaignsSrc.path}`);
        err.usage = true;
        throw err;
      }
    }
    const project = opts.project ? scanProject(opts.project) : null;
    const packages = project && !project.cause ? project.packages : { dirs: { core: [], modules: [], mcp: [] } };
    const upstream = opts.upstream ? resolve(opts.upstream) : null;
    const vaultPaths = discoverVaults(project && !project.cause ? project.project : null, (opts.vaults ?? []).map((p) => resolve(p)), packages);
    const ctx = {
      campaignsSrc,
      tasksSrc,
      learningSrc,
      store,
      learning: learningSrc.db ? readLearning(learningSrc) : null,
      log: readLog(logPath),
      logPath,
      brainRoot: resolve(opts.brainRoot ?? repoRoot),
      projectPath: opts.project ? resolve(opts.project) : null,
      project,
      upstream,
      vaults: vaultPaths.map((p) => readVault(p, upstream)),
      campaignFilter: opts.campaign ?? null,
    };
    const rungs = [rung1, rung2, rung3, rung4, rung5, rung6, rung7, rung8, rung9, rung10].map((f) => f(ctx));
    const crit = criteria(ctx);
    const tally = (items) => ({
      pass: items.filter((i) => i.verdict === VERDICT.PASS).length,
      fail: items.filter((i) => i.verdict === VERDICT.FAIL).length,
      notMeasured: items.filter((i) => i.verdict === VERDICT.NOT_MEASURED).length,
    });
    const describe = (src, extra) => (src.db ? { path: src.path, read: true, ...extra } : { path: src.path, read: false, cause: src.cause });
    return {
      scorecard: "north-star",
      version: 1,
      generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
      scope: { campaign: ctx.campaignFilter, proofCampaign: crit.proof.campaign, proofCampaignChosenBy: crit.proof.chosenBy },
      sources: {
        campaignsDb: describe(campaignsSrc, { campaigns: store?.all.length ?? 0 }),
        tasksDb: describe(tasksSrc, {}),
        learningDb: describe(learningSrc, {}),
        log: ctx.log.cause
          ? { path: logPath, read: false, cause: ctx.log.cause }
          : { path: logPath, read: true, files: ctx.log.files.length, boots: ctx.log.boots.length, mcpLoads: ctx.log.boots.filter((b) => b.loads.length > 0).length },
        project: !ctx.projectPath
          ? { path: null, read: false, cause: "no --project was given" }
          : project.cause
            ? { path: ctx.projectPath, read: false, cause: project.cause }
            : { path: ctx.projectPath, read: true, gameFiles: project.code.gameFiles },
        vaults: ctx.vaults.map((v) => (v.cause ? { path: v.path, read: false, cause: v.cause } : { path: v.path, read: true, files: v.files, counts: v.counts, mode: v.mode })),
        upstream,
        brainRoot: ctx.brainRoot,
      },
      rungs,
      criteria: crit.list,
      facts: { tasks: taskFacts(tasksSrc) },
      score: { rungs: tally(rungs), criteria: tally(crit.list) },
    };
  } finally {
    for (const src of [campaignsSrc, tasksSrc, learningSrc]) src.db?.close();
  }
}

// ─── text output ────────────────────────────────────────────────────────────

const MARK = { true: "+", false: "x", null: "?" };

function verdictText(i) {
  if (i.verdict === VERDICT.NOT_MEASURED) return `not measured: ${i.cause}`;
  return i.verdict;
}

function formatItem(label, i) {
  const lines = [`${label} ${i.title}: ${verdictText(i)}`];
  for (const c of i.checks) lines.push(`      ${MARK[String(c.ok)]} ${c.text}`);
  for (const n of i.notes) lines.push(`      · ${n}`);
  return lines.join("\n");
}

function sourceLine(name, s) {
  if (!s.read) return `  ${name.padEnd(13)} ${s.cause}`;
  const extra = Object.entries(s)
    .filter(([k]) => !["path", "read", "counts", "mode"].includes(k))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `  ${name.padEnd(13)} ${s.path}${extra ? ` (${extra})` : ""}`;
}

export function formatReport(card) {
  const out = [];
  out.push(`North-star scorecard, ${card.generatedAt}`);
  out.push("Sources (read-only):");
  out.push(sourceLine("campaigns.db", card.sources.campaignsDb));
  out.push(sourceLine("tasks.db", card.sources.tasksDb));
  out.push(sourceLine("learning.db", card.sources.learningDb));
  out.push(sourceLine("daemon log", card.sources.log));
  out.push(sourceLine("project", card.sources.project));
  if (card.sources.vaults.length === 0) out.push(`  ${"vault".padEnd(13)} none found`);
  for (const v of card.sources.vaults) out.push(sourceLine("vault", v));
  out.push(`Scope: ${card.scope.campaign ? `campaign ${card.scope.campaign}` : "all campaigns"}`);
  out.push("");
  out.push("Rungs");
  for (const r of card.rungs) out.push(formatItem(`  ${String(r.id).padStart(2)}.`, r));
  const s = card.score.rungs;
  out.push(`Score: ${s.pass} of ${card.rungs.length} rungs pass, ${s.fail} fail, ${s.notMeasured} not measured`);
  out.push("");
  out.push(`Proof-run criteria (${card.scope.proofCampaign ? `campaign ${card.scope.proofCampaign}, ${card.scope.proofCampaignChosenBy}` : card.scope.proofCampaignChosenBy})`);
  for (const c of card.criteria) out.push(formatItem(`   ${c.id}.`, c));
  const t = card.score.criteria;
  out.push(`Criteria: ${t.pass} of ${card.criteria.length} pass, ${t.fail} fail, ${t.notMeasured} not measured`);
  out.push("");
  out.push("Facts");
  const tf = card.facts.tasks;
  if (tf.cause) out.push(`  tasks: ${tf.cause}`);
  else {
    const st = (k) => tf.byStatus[k] ?? 0;
    out.push(
      `  tasks.db ${isoOf(tf.first)} → ${isoOf(tf.last)}: ${tf.userTasks} user tasks, ${st("completed")} completed (${pct(st("completed"), tf.userTasks)}), ${st("blocked")} blocked (${pct(st("blocked"), tf.userTasks)}), ${st("cancelled")} cancelled, ${st("failed")} failed; last completed user task ${isoOf(tf.lastCompletedUserTask)}`,
    );
  }
  return out.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `north-star-scorecard.mjs — the ten north-star rungs and the proof-run criteria (roadmap WP-0.2)

  --project <dir>         Unity project to scan (rungs 6-7, criteria E-G, I)
  --home <dir>            Strada home (default $STRADA_HOME or ~/.strada)
  --memory-dir <dir>      directory holding the databases (default $MEMORY_DB_PATH or <home>/.strada-memory)
  --campaigns-db <path>   campaigns.db, overriding --memory-dir (likewise --tasks-db, --learning-db)
  --vault <index.db>      a vault index to read (repeatable; <project>/.strada/vault/index.db and
                          framework vaults under <project>/Packages are found by themselves)
  --upstream <dir>        directory holding the Strada.Core / Strada.Modules / Strada.MCP checkouts,
                          to tell vendored framework files from notes runs wrote into them
  --log <path>            daemon log for rung 1, read with its rotated archives (default <home>/strada-brain.log)
  --brain-root <dir>      Brain checkout whose HEAD rung 1 compares the boot with (default: this repository)
  --campaign <id>         measure one campaign only (the proof run)
  --json                  machine-readable output

Every database is opened read-only. exit 0 printed · 2 bad invocation or unknown --campaign`;

export function parseArgs(argv) {
  const args = { vaults: [], json: false, help: false };
  const valued = {
    "--project": "project",
    "--home": "home",
    "--memory-dir": "memoryDir",
    "--campaigns-db": "campaignsDb",
    "--tasks-db": "tasksDb",
    "--learning-db": "learningDb",
    "--upstream": "upstream",
    "--log": "log",
    "--brain-root": "brainRoot",
    "--campaign": "campaign",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" || valued[a] !== undefined) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--vault") args.vaults.push(v);
      else args[valued[a]] = v;
    } else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return args;
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
    return EXIT.MEASURED;
  }
  let card;
  try {
    card = scoreNorthStar(args);
  } catch (err) {
    console.error(err?.usage ? err.message : `scorecard failed: ${err?.stack ?? message(err)}`);
    return EXIT.USAGE;
  }
  process.stdout.write(args.json ? `${JSON.stringify(card, null, 2)}\n` : `${formatReport(card)}\n`);
  return EXIT.MEASURED;
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
if (isDirectExecution()) process.exitCode = main();
