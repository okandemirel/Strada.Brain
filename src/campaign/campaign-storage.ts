/**
 * Campaign Storage
 *
 * SQLite persistence for campaigns, following the GoalStorage pattern:
 * better-sqlite3, shared pragmas, prepared statements. Milestones ride as a
 * JSON column — the ladder is small (<=12) and always read/written whole.
 *
 * The scope gate (GDD plan W03) adds the requirement ledger as a column, the
 * canonical bytes of the system's acceptance files, and an append-only log of
 * every verdict the judge reached with the input that reached it.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Campaign, CampaignMilestone, CampaignState } from "./types.js";
import { ACTIVE_CAMPAIGN_STATES } from "./types.js";
import type {
  AcceptanceSource,
  AcceptanceTestRef,
  AcceptanceWriter,
  GreenBasis,
  GreenInput,
  GreenReason,
  Judgement,
  ReasonClass,
  RequirementLedger,
  RequirementRow,
  ScopeGateMode,
} from "./scope-types.js";
import { ACCEPTANCE_DIR, REQUIREMENT_KINDS, REQUIREMENT_STATUSES } from "./scope-types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  project_root TEXT NOT NULL,
  state TEXT NOT NULL,
  idea_text TEXT,
  gdd_path TEXT,
  gdd_text TEXT,
  draft_task_id TEXT,
  draft_attempts INTEGER NOT NULL DEFAULT 0,
  milestones_json TEXT NOT NULL DEFAULT '[]',
  current_milestone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_state ON campaigns(state);
CREATE INDEX IF NOT EXISTS idx_campaigns_chat ON campaigns(chat_id, state);
CREATE TABLE IF NOT EXISTS campaign_acceptance (
  campaign_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source BLOB NOT NULL,
  meta_json TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, path)
);
CREATE TABLE IF NOT EXISTS campaign_judgements (
  seq INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  green INTEGER NOT NULL,
  state TEXT,
  basis TEXT,
  revision TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  caveats_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_judgements_attempt
  ON campaign_judgements(campaign_id, milestone_id, attempt_key, at);
CREATE TRIGGER IF NOT EXISTS campaign_judgements_no_update BEFORE UPDATE ON campaign_judgements
BEGIN SELECT RAISE(ABORT, 'campaign_judgements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS campaign_judgements_no_delete BEFORE DELETE ON campaign_judgements
BEGIN SELECT RAISE(ABORT, 'campaign_judgements is append-only'); END;
`;

interface CampaignRow {
  id: string;
  chat_id: string;
  channel_type: string;
  user_id: string;
  conversation_id: string | null;
  project_root: string;
  state: string;
  idea_text: string | null;
  gdd_path: string | null;
  gdd_text: string | null;
  gdd_sha256?: string | null;
  gdd_revision?: number | null;
  draft_task_id: string | null;
  draft_attempts: number;
  milestones_json: string;
  current_milestone: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  auto_revive_at: number | null;
  coverage_audit_note?: string | null;
  draft_deferred_since?: number | null;
  delivery_reported?: number | null;
  unmeasurable_revives?: number | null;
  implementation_revives?: number | null;
  pending_coverage_gaps?: string | null;
  delivery_revives?: number | null;
  delivery_rounds_total?: number | null;
  stop_requested_at?: number | null;
  stop_generation?: number | null;
  delivery_proofs_signature?: string | null;
  plan_coverage?: string | null;
  independent_review?: string | null;
  coverage_queue_unreadable?: number | null;
  verified_sessions?: string | null;
  requirements_json?: string | null;
  scope_gate_since?: number | null;
}

/**
 * Session coverage accumulated across runs, or nothing.
 *
 * Keyed by the ARTIFACT it was measured on: coverage of one build says
 * nothing about the next, and a stale accumulator would claim levels a new
 * build never played (Codex 2026-09-13 AJ#11). A row it cannot read is no
 * coverage at all — the next run then asks for the first batch again, which
 * measures more rather than less.
 */
function parseVerifiedSessions(raw: string | null | undefined): { artifact: string; indices: number[]; byArtifact?: Record<string, number[]>; catalogueByArtifact?: Record<string, number>; perfByArtifact?: Record<string, { avgFps?: number; worstFrameMs?: number; bootSeconds?: number }> } | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const doc = parsed as { artifact?: unknown; indices?: unknown; byArtifact?: unknown; catalogueByArtifact?: unknown; perfByArtifact?: unknown };
    if (typeof doc.artifact !== "string" || doc.artifact === "") return undefined;
    const readIndices = (raw: unknown): number[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const indices: number[] = [];
      for (const entry of raw) {
        if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) return undefined;
        if (!indices.includes(entry)) indices.push(entry);
      }
      return indices.sort((a, b) => a - b);
    };
    const indices = readIndices(doc.indices);
    if (indices === undefined || indices.length === 0) return undefined;
    // Per-artifact coverage (plan 1.10): a malformed entry drops that entry, never the row.
    const byArtifact: Record<string, number[]> = {};
    if (doc.byArtifact !== null && typeof doc.byArtifact === "object" && !Array.isArray(doc.byArtifact)) {
      for (const [digest, list] of Object.entries(doc.byArtifact as Record<string, unknown>)) {
        const read = readIndices(list);
        if (/^[0-9a-f]{64}$/.test(digest) && read !== undefined && read.length > 0) byArtifact[digest] = read;
      }
    }
    const catalogueByArtifact: Record<string, number> = {};
    if (doc.catalogueByArtifact !== null && typeof doc.catalogueByArtifact === "object" && !Array.isArray(doc.catalogueByArtifact)) {
      for (const [digest, count] of Object.entries(doc.catalogueByArtifact as Record<string, unknown>)) {
        if (/^[0-9a-f]{64}$/.test(digest) && typeof count === "number" && Number.isInteger(count) && count >= 1) catalogueByArtifact[digest] = count;
      }
    }
    const perfByArtifact: Record<string, { avgFps?: number; worstFrameMs?: number; bootSeconds?: number }> = {};
    if (doc.perfByArtifact !== null && typeof doc.perfByArtifact === "object" && !Array.isArray(doc.perfByArtifact)) {
      for (const [digest, perf] of Object.entries(doc.perfByArtifact as Record<string, unknown>)) {
        if (!/^[0-9a-f]{64}$/.test(digest) || perf === null || typeof perf !== "object") continue;
        const p = perf as Record<string, unknown>;
        const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const entry = {
          ...(num(p["avgFps"]) === undefined ? {} : { avgFps: num(p["avgFps"])! }),
          ...(num(p["worstFrameMs"]) === undefined ? {} : { worstFrameMs: num(p["worstFrameMs"])! }),
          ...(num(p["bootSeconds"]) === undefined ? {} : { bootSeconds: num(p["bootSeconds"])! }),
        };
        if (Object.keys(entry).length > 0) perfByArtifact[digest] = entry;
      }
    }
    return {
      artifact: doc.artifact,
      indices,
      ...(Object.keys(byArtifact).length > 0 ? { byArtifact } : {}),
      ...(Object.keys(catalogueByArtifact).length > 0 ? { catalogueByArtifact } : {}),
      ...(Object.keys(perfByArtifact).length > 0 ? { perfByArtifact } : {}),
    };
  } catch {
    return undefined;
  }
}

function rowToCampaign(row: CampaignRow): Campaign {
  let milestones: CampaignMilestone[] = [];
  try {
    const parsed: unknown = JSON.parse(row.milestones_json);
    if (Array.isArray(parsed)) milestones = parsed as CampaignMilestone[];
  } catch {
    // A corrupt ladder must not kill resume — treat as empty; the campaign
    // will replan from the GDD rather than crash the boot stage.
    milestones = [];
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    channelType: row.channel_type,
    userId: row.user_id,
    conversationId: row.conversation_id ?? undefined,
    projectRoot: row.project_root,
    state: row.state as CampaignState,
    ideaText: row.idea_text ?? undefined,
    gddPath: row.gdd_path ?? undefined,
    gddText: row.gdd_text ?? undefined,
    gddSha256: row.gdd_sha256 ?? undefined,
    gddRevision: row.gdd_revision ?? undefined,
    draftTaskId: row.draft_task_id ?? undefined,
    draftAttempts: row.draft_attempts,
    milestones,
    currentMilestone: row.current_milestone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? undefined,
    autoReviveAt: row.auto_revive_at ?? undefined,
    coverageAuditNote: row.coverage_audit_note ?? undefined,
    draftDeferredSince: row.draft_deferred_since ?? undefined,
    deliveryReported: row.delivery_reported === 1,
    unmeasurableRevives: row.unmeasurable_revives ?? undefined,
    implementationRevives: row.implementation_revives ?? undefined,
    ...(() => {
      const queue = parseGapQueue(row.pending_coverage_gaps);
      // The stored flag OR this load's own reading: a row damaged once stays
      // flagged across saves until an audit re-establishes the requirements
      // (Codex 2026-09-13 AF#2).
      const unreadable = queue.unreadable === true || row.coverage_queue_unreadable === 1;
      return {
        ...(queue.gaps ? { pendingCoverageGaps: queue.gaps } : {}),
        ...(unreadable ? { coverageQueueUnreadable: true as const } : {}),
      };
    })(),
    deliveryRevives: row.delivery_revives ?? undefined,
    deliveryRoundsTotal: row.delivery_rounds_total ?? undefined,
    stopRequestedAt: row.stop_requested_at ?? undefined,
    stopGeneration: row.stop_generation ?? undefined,
    deliveryProofsSignature: row.delivery_proofs_signature ?? undefined,
    ...(row.plan_coverage ? { planCoverage: parsePlanCoverage(row.plan_coverage) } : {}),
    // The independent opinion was gathered, rendered into the report and then
    // dropped: nothing wrote it, so a lost report meant the boot resend had
    // no review to resend and would pay for another one (Codex 2026-09-12 X).
    ...(row.independent_review ? { independentReview: parseIndependentReview(row.independent_review) } : {}),
    // Session coverage ACCUMULATED across runs, keyed by the artifact it was
    // measured on: one run plays a batch, and a game bigger than one batch is
    // only fully played across several (Codex 2026-09-13 AJ#11).
    ...(() => {
      const verified = parseVerifiedSessions(row.verified_sessions);
      return verified === undefined ? {} : { verifiedSessions: verified };
    })(),
    ...(() => {
      const read = parseRequirementLedger(row.requirements_json);
      const faults = checkFaultsOf(read.ledger);
      return {
        ...(read.ledger ? { requirements: read.ledger } : {}),
        ...(read.unreadable ? { requirementsUnreadable: true as const } : {}),
        ...(faults.length > 0 ? { checkFaults: faults } : {}),
      };
    })(),
    scopeGateSince: row.scope_gate_since ?? undefined,
  };
}

/**
 * Row ids whose system-written check could not be made to work, in ledger
 * order. `Campaign.checkFaults` is this, derived at every load and never
 * stored on its own: the row's status already records the fault, and a second
 * list would keep naming a row after a repair, a waiver or an amendment had
 * moved it on. A fault therefore persists only as `status: "check-fault"`.
 */
export function checkFaultsOf(ledger: RequirementLedger | undefined): string[] {
  return ledger === undefined ? [] : ledger.rows.filter((row) => row.status === "check-fault").map((row) => row.rid);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The stored ledger, or nothing — and AN UNREADABLE LEDGER IS NOT AN ABSENT
 * ONE (the AD#18 lesson of the gap queue). It is read whole or not at all: a
 * ledger with one damaged row dropped is a ledger that forgot an obligation,
 * and the next save would make the loss permanent. Only the shape later code
 * keys on is checked (a known version, rows with a unique id, a known kind and
 * status); anything the type system already guarantees for a ledger this code
 * wrote passes, so what fails is damage or a format this reader predates.
 */
function parseRequirementLedger(raw: string | null | undefined): { ledger?: RequirementLedger; unreadable?: true } {
  if (raw === null || raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: true };
  }
  return isReadableLedger(parsed) ? { ledger: parsed } : { unreadable: true };
}

function isReadableLedger(value: unknown): value is RequirementLedger {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.gddSha256 !== "string" || !isFiniteNumber(value.gddRevision)) return false;
  if (!isFiniteNumber(value.extractedAtMs) || !isFiniteNumber(value.llmAdded)) return false;
  const overflow = value.overflow;
  if (!isRecord(overflow) || !isFiniteNumber(overflow.count) || !Array.isArray(overflow.sections)) return false;
  if (!Array.isArray(value.numberingGaps) || !Array.isArray(value.rows)) return false;
  const rids = new Set<string>();
  for (const row of value.rows as unknown[]) {
    // Results, budgets and waivers are all keyed by rid: two rows sharing one is damage.
    if (!isReadableRow(row) || rids.has(row.rid)) return false;
    rids.add(row.rid);
  }
  return true;
}

function isReadableRow(row: unknown): row is RequirementRow {
  return (
    isRecord(row) &&
    typeof row.rid === "string" &&
    row.rid !== "" &&
    typeof row.encoded === "string" &&
    typeof row.text === "string" &&
    typeof row.section === "string" &&
    (REQUIREMENT_KINDS as readonly unknown[]).includes(row.kind) &&
    (REQUIREMENT_STATUSES as readonly unknown[]).includes(row.status) &&
    Array.isArray(row.ownership) &&
    Array.isArray(row.checks)
  );
}

function parseIndependentReview(raw: string): Campaign["independentReview"] | undefined {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.ok !== "boolean" || typeof p.model !== "string") return undefined;
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
    const gate = isRecord(p.gate)
      ? {
          reopened: strings(p.gate.reopened),
          added: strings(p.gate.added),
          disclosed: strings(p.gate.disclosed),
          mode: p.gate.mode === "shadow" || p.gate.mode === "on" ? p.gate.mode : undefined,
        }
      : undefined;
    return {
      ok: p.ok,
      model: p.model,
      text: typeof p.text === "string" ? p.text : "",
      ms: typeof p.ms === "number" ? p.ms : 0,
      ...(typeof p.error === "string" ? { error: p.error } : {}),
      // What the review's findings did to the ledger (W13); a damaged record is dropped, never half-read.
      ...(gate?.reopened && gate.added && gate.disclosed
        ? {
            gate: {
              reopened: gate.reopened,
              added: gate.added,
              disclosed: gate.disclosed,
              ...(gate.mode === undefined ? {} : { mode: gate.mode }),
            },
          }
        : {}),
    } as Campaign["independentReview"];
  } catch {
    return undefined;
  }
}

function parsePlanCoverage(raw: string): Campaign["planCoverage"] | undefined {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.covered !== "number" || typeof p.total !== "number") return undefined;
    return {
      covered: p.covered,
      total: p.total,
      uncovered: Array.isArray(p.uncovered) ? p.uncovered.map(String) : [],
      excluded: Array.isArray(p.excluded) ? p.excluded.map(String) : [],
      minMilestones: typeof p.minMilestones === "number" ? p.minMilestones : 0,
      maxMilestones: typeof p.maxMilestones === "number" ? p.maxMilestones : 0,
    };
  } catch {
    return undefined;
  }
}

export interface CampaignStorageOptions {
  /**
   * Open an existing database for reading only — no directory, no WAL/pragma
   * writes, no schema or migrations. `strada status` reads a running daemon's
   * database; it must neither take write locks on it nor migrate it from a
   * newer checkout (COR-22).
   */
  readOnly?: boolean;
}

/**
 * Columns added after the first schema, oldest first. `backfill` runs once,
 * in the same transaction as the ALTER that adds the column.
 */
const ADDED_COLUMNS: ReadonlyArray<{ readonly name: string; readonly type: string; readonly backfill?: string }> = [
  { name: "auto_revive_at", type: "INTEGER" },
  { name: "coverage_audit_note", type: "TEXT" },
  // The approved GDD's hash (plan 1.9); rows from before carry null and
  // take the text they hold as approved on first read.
  { name: "gdd_sha256", type: "TEXT" },
  { name: "gdd_revision", type: "INTEGER" },
  // Self-revivals spent on a proof this machine cannot produce (Codex 2026-09-11 C#2).
  { name: "unmeasurable_revives", type: "INTEGER" },
  // Self-revivals spent on an ordinary implementation failure (F#1).
  { name: "implementation_revives", type: "INTEGER" },
  // Gaps the audit named and no round has scheduled yet (F#9).
  { name: "pending_coverage_gaps", type: "TEXT" },
  // Delivery rounds spent on the same missing proofs (H#1).
  { name: "delivery_revives", type: "INTEGER" },
  // A person's stop, recorded when it is SEEN (Codex 2026-09-11 L#3).
  { name: "stop_requested_at", type: "INTEGER" },
  { name: "stop_generation", type: "INTEGER" },
  // Every delivery round, whatever its identity (Codex 2026-09-11 O#5).
  { name: "delivery_rounds_total", type: "INTEGER" },
  { name: "delivery_proofs_signature", type: "TEXT" },
  // Audited 2026-09-02: the draft path's deferral clock (24h bound).
  { name: "draft_deferred_since", type: "INTEGER" },
  // Audited 2026-09-02: the delivery report is sent after state=done is
  // persisted, so a crash in that window lost it silently. The backfill runs
  // only with the ALTER that actually adds the column: campaigns that were
  // already `done` reported under the old path, and must not be re-announced.
  {
    name: "delivery_reported",
    type: "INTEGER NOT NULL DEFAULT 0",
    backfill: "UPDATE campaigns SET delivery_reported = 1 WHERE state = 'done'",
  },
  // 2026-09-10: how the plan covers the GDD's measured section inventory.
  { name: "plan_coverage", type: "TEXT" },
  // 2026-09-12: the independent opinion on the delivery. It was gathered,
  // rendered and thrown away, while the boot resend assumed it was there
  // (Codex 2026-09-12 X).
  { name: "independent_review", type: "TEXT" },
  // 2026-09-13: an unreadable requirement queue was derived at load and lost
  // at save — the very next save wrote NULL over the damaged row and the
  // obligation was gone for good (Codex 2026-09-13 AF#2). It is a column now,
  // so the flag survives until an audit re-establishes the requirements.
  { name: "coverage_queue_unreadable", type: "INTEGER" },
  // 2026-09-13: one play run verifies a BATCH of sessions, so a game bigger
  // than one batch is only fully played across several runs — and nothing
  // remembered which ones had been played (Codex AJ#11).
  { name: "verified_sessions", type: "TEXT" },
  // GDD plan W03: the requirement ledger, read from the approved gddText.
  // NULL is "no ledger", which is what every campaign from before it reads.
  { name: "requirements_json", type: "TEXT" },
  { name: "scope_gate_since", type: "INTEGER" },
];

export class CampaignStorage {
  private readonly db: Database.Database;
  private readonly readOnly: boolean;

  constructor(dbPath: string, options: CampaignStorageOptions = {}) {
    this.readOnly = options.readOnly === true;
    if (options.readOnly) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 5000");
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureSqlitePragmas(this.db, "tasks");
    try {
      this.db.exec(SCHEMA_SQL);
      this.addMissingColumns();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /**
   * Bring an older database up to ADDED_COLUMNS (CMP-15).
   *
   * Each ALTER used to sit in a `catch {}` that read every failure as "the
   * column already exists": a busy or read-only database left the column
   * missing and every later save threw "no such column". The columns present
   * are now read from the table itself, only the missing ones are added, and
   * a failure that did not leave the column behind is thrown. A column and
   * its backfill are one transaction: a crash between them used to leave the
   * column added and the backfill never run.
   */
  private addMissingColumns(): void {
    const present = (): Set<string> =>
      new Set((this.db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).map((c) => c.name));
    const have = present();
    for (const column of ADDED_COLUMNS) {
      if (have.has(column.name)) continue;
      try {
        this.db.transaction(() => {
          this.db.exec(`ALTER TABLE campaigns ADD COLUMN ${column.name} ${column.type}`);
          if (column.backfill !== undefined) this.db.exec(column.backfill);
        })();
      } catch (err) {
        // Another process sharing the database added it first: that is done.
        if (present().has(column.name)) continue;
        throw err;
      }
    }
  }

  save(campaign: Campaign): void {
    // A ledger this process could not read is kept as stored, not overwritten
    // with NULL: the AF#2 shape, where the next save erased the damaged
    // obligations for good. The flag is derived from those same bytes at every
    // load, so it survives without a column of its own; a rebuilt ledger
    // (`requirements` set) replaces them and clears it.
    const keepStoredLedger = campaign.requirements === undefined && campaign.requirementsUnreadable === true;
    this.db
      .prepare(
        `INSERT INTO campaigns (
          id, chat_id, channel_type, user_id, conversation_id, project_root,
          state, idea_text, gdd_path, gdd_text, draft_task_id, draft_attempts,
          milestones_json, current_milestone, created_at, updated_at, last_error,
          auto_revive_at, coverage_audit_note, draft_deferred_since, delivery_reported, plan_coverage,
          independent_review, coverage_queue_unreadable, verified_sessions,
          unmeasurable_revives, implementation_revives, pending_coverage_gaps,
          delivery_revives, delivery_proofs_signature, delivery_rounds_total,
          stop_requested_at, stop_generation, gdd_sha256, gdd_revision,
          requirements_json, scope_gate_since
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          gdd_path = excluded.gdd_path,
          gdd_text = excluded.gdd_text,
          draft_task_id = excluded.draft_task_id,
          draft_attempts = excluded.draft_attempts,
          milestones_json = excluded.milestones_json,
          current_milestone = excluded.current_milestone,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error,
          auto_revive_at = excluded.auto_revive_at,
          coverage_audit_note = excluded.coverage_audit_note,
          draft_deferred_since = excluded.draft_deferred_since,
          delivery_reported = excluded.delivery_reported,
          plan_coverage = excluded.plan_coverage,
          independent_review = excluded.independent_review,
          coverage_queue_unreadable = excluded.coverage_queue_unreadable,
          verified_sessions = excluded.verified_sessions,
          unmeasurable_revives = excluded.unmeasurable_revives,
          implementation_revives = excluded.implementation_revives,
          pending_coverage_gaps = excluded.pending_coverage_gaps,
          delivery_revives = excluded.delivery_revives,
          delivery_proofs_signature = excluded.delivery_proofs_signature,
          delivery_rounds_total = excluded.delivery_rounds_total,
          stop_requested_at = excluded.stop_requested_at,
          stop_generation = excluded.stop_generation,
          gdd_sha256 = excluded.gdd_sha256,
          gdd_revision = excluded.gdd_revision,
          scope_gate_since = excluded.scope_gate_since,
          requirements_json = CASE WHEN ? = 1 THEN campaigns.requirements_json ELSE excluded.requirements_json END`,
      )
      .run(
        campaign.id,
        campaign.chatId,
        campaign.channelType,
        campaign.userId,
        campaign.conversationId ?? null,
        campaign.projectRoot,
        campaign.state,
        campaign.ideaText ?? null,
        campaign.gddPath ?? null,
        campaign.gddText ?? null,
        campaign.draftTaskId ?? null,
        campaign.draftAttempts,
        JSON.stringify(campaign.milestones),
        campaign.currentMilestone,
        campaign.createdAt,
        campaign.updatedAt,
        campaign.lastError ?? null,
        campaign.autoReviveAt ?? null,
        campaign.coverageAuditNote ?? null,
        campaign.draftDeferredSince ?? null,
        campaign.deliveryReported ? 1 : 0,
        campaign.planCoverage ? JSON.stringify(campaign.planCoverage) : null,
        campaign.independentReview ? JSON.stringify(campaign.independentReview) : null,
        campaign.coverageQueueUnreadable === true ? 1 : null,
        campaign.verifiedSessions && campaign.verifiedSessions.indices.length > 0
          ? JSON.stringify(campaign.verifiedSessions)
          : null,
        campaign.unmeasurableRevives ?? null,
        campaign.implementationRevives ?? null,
        campaign.pendingCoverageGaps && campaign.pendingCoverageGaps.length > 0
          ? JSON.stringify(campaign.pendingCoverageGaps)
          : null,
        campaign.deliveryRevives ?? null,
        campaign.deliveryProofsSignature ?? null,
        campaign.deliveryRoundsTotal ?? null,
        campaign.stopRequestedAt ?? null,
        campaign.stopGeneration ?? null,
        campaign.gddSha256 ?? null,
        campaign.gddRevision ?? null,
        campaign.requirements !== undefined ? JSON.stringify(campaign.requirements) : null,
        campaign.scopeGateSince ?? null,
        // Binds the `?` in the CASE above, which follows every VALUES placeholder.
        keepStoredLedger ? 1 : 0,
      );
  }

  /**
   * Store the canonical bytes of one acceptance file, replacing what was
   * stored at that path. These bytes are what every restore writes back over
   * the project, so a file is refused, loudly, unless they are exactly what a
   * later `listAcceptance` will return: the source must encode to UTF-8 and
   * back unchanged, `sha256` must be the hash of those bytes, and the path
   * must lie under ACCEPTANCE_DIR (a restore writes there and nowhere else).
   */
  putAcceptance(campaignId: string, file: AcceptanceSource, writtenAtMs: number): void {
    assertAcceptancePath(file.path);
    const bytes = Buffer.from(file.source, "utf8");
    if (bytes.toString("utf8") !== file.source) {
      throw new Error(
        `acceptance file ${file.path}: the source is not valid UTF-8 text (a lone surrogate), so the stored bytes would not be the source given`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== file.sha256) {
      throw new Error(`acceptance file ${file.path}: sha256 ${file.sha256} is not the hash of its source (${actual})`);
    }
    const meta: AcceptanceMeta = { writer: file.writer, revisions: file.revisions, tests: file.tests };
    this.db
      .prepare(
        `INSERT INTO campaign_acceptance (campaign_id, milestone_id, path, sha256, source, meta_json, written_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, path) DO UPDATE SET
          milestone_id = excluded.milestone_id,
          sha256 = excluded.sha256,
          source = excluded.source,
          meta_json = excluded.meta_json,
          written_at = excluded.written_at`,
      )
      .run(campaignId, file.milestoneId, file.path, file.sha256, bytes, JSON.stringify(meta), writtenAtMs);
  }

  /**
   * The campaign's acceptance files (one milestone's, when named), by path.
   * Bytes that no longer hash to their sha256, or a writer and test list that
   * cannot be read, throw: restoring damaged bytes as canonical would plant
   * them in the project, and leaving the file out would have the restore
   * delete it as foreign.
   */
  listAcceptance(campaignId: string, milestoneId?: string): StoredAcceptance[] {
    if (this.tableMissing("campaign_acceptance")) return [];
    const rows = (
      milestoneId === undefined
        ? this.db.prepare("SELECT * FROM campaign_acceptance WHERE campaign_id = ? ORDER BY path").all(campaignId)
        : this.db
            .prepare("SELECT * FROM campaign_acceptance WHERE campaign_id = ? AND milestone_id = ? ORDER BY path")
            .all(campaignId, milestoneId)
    ) as AcceptanceRow[];
    return rows.map(rowToAcceptance);
  }

  /** Remove one stored acceptance file; false when there was none at that path. */
  deleteAcceptance(campaignId: string, path: string): boolean {
    return this.db.prepare("DELETE FROM campaign_acceptance WHERE campaign_id = ? AND path = ?").run(campaignId, path).changes > 0;
  }

  /**
   * Append one verdict with the whole input the judge read, so any verdict
   * can be replayed. The log is append-only — there is no update method, and
   * triggers refuse UPDATE and DELETE on the table — and a second verdict for
   * the same attempt in the same millisecond is a second entry, not an error.
   * The milestone, mode and revision are the input's own, so the stored
   * columns cannot disagree with the stored input.
   */
  appendJudgement(entry: JudgementEntry): StoredJudgement {
    const { input, judgement } = entry;
    const inputJson = JSON.stringify(input);
    const inputSha256 = sha256Hex(Buffer.from(inputJson, "utf8"));
    this.db
      .prepare(
        `INSERT INTO campaign_judgements (
          campaign_id, milestone_id, attempt_key, at, mode, green, state, basis, revision,
          reasons_json, caveats_json, input_json, input_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.campaignId,
        input.milestoneId,
        entry.attemptKey,
        entry.atMs,
        input.mode,
        judgement.green ? 1 : 0,
        judgement.green ? null : judgement.state,
        judgement.green ? judgement.basis : null,
        input.revision,
        JSON.stringify(judgement.green ? [] : judgement.reasons),
        JSON.stringify(judgement.green ? judgement.caveats : []),
        inputJson,
        inputSha256,
      );
    return {
      campaignId: entry.campaignId,
      milestoneId: input.milestoneId,
      attemptKey: entry.attemptKey,
      atMs: entry.atMs,
      mode: input.mode,
      revision: input.revision,
      judgement,
      input,
      inputSha256,
    };
  }

  /** The campaign's verdicts (one milestone's, when named), oldest first, in the order they were appended. */
  listJudgements(campaignId: string, milestoneId?: string): StoredJudgement[] {
    if (this.tableMissing("campaign_judgements")) return [];
    const rows = (
      milestoneId === undefined
        ? this.db.prepare("SELECT * FROM campaign_judgements WHERE campaign_id = ? ORDER BY at, seq").all(campaignId)
        : this.db
            .prepare("SELECT * FROM campaign_judgements WHERE campaign_id = ? AND milestone_id = ? ORDER BY at, seq")
            .all(campaignId, milestoneId)
    ) as JudgementRow[];
    return rows.map(rowToJudgement);
  }

  /**
   * A read-only open never migrates (COR-22), so a database an older daemon
   * wrote has none of the W03 tables: it holds no files and no verdicts, which
   * is the truth, not an error. A read-write open created them in the constructor.
   */
  private tableMissing(table: string): boolean {
    if (!this.readOnly) return false;
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined;
  }

  get(id: string): Campaign | undefined {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as
      | CampaignRow
      | undefined;
    return row ? rowToCampaign(row) : undefined;
  }

  /** Campaigns that a fresh boot must re-attach to. */
  listActive(): Campaign[] {
    const placeholders = ACTIVE_CAMPAIGN_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM campaigns WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...ACTIVE_CAMPAIGN_STATES) as CampaignRow[];
    return rows.map(rowToCampaign);
  }

  /**
   * Delivered campaigns whose delivery report was never actually sent — the
   * crash/messenger-failure window between persisting `done` and the report
   * landing in the chat. Boot re-sends these (audited 2026-09-02).
   */
  /**
   * Recently finished campaigns, for the boot sweep that stops their
   * stragglers. A terminal campaign is never resumed, so nothing else looks
   * at it — and the executor's keep-alive happily revives its blocked tasks
   * on every restart (audited 2026-09-03).
   */
  listRecentTerminal(limit = 10): Campaign[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE state IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit) as CampaignRow[];
    return rows.map(rowToCampaign);
  }

  listUnreportedDeliveries(): Campaign[] {
    const rows = this.db
      .prepare(
        // A partial delivery that stopped on a standing refusal is `failed`
        // with lastError "NOT DELIVERED — …" — its report is owed just the
        // same (review 2026-09-07). The column defaults to 0, so the flag
        // alone cannot tell such a campaign from one that merely failed.
        // The prefix is not the debt, though: a person's own stop writes it
        // too and owes no report, so every writer of the prefix sets the flag
        // once nothing is owed — when its notice landed, or at once for a
        // person's stop. Without that a restart billed a reviewer run and
        // posted a delivery report for a cancel (audit 2026-10-11, campaign#3).
        "SELECT * FROM campaigns WHERE (state = 'done' AND (delivery_reported IS NULL OR delivery_reported = 0)) " +
          "OR (state = 'failed' AND delivery_reported = 0 AND last_error LIKE 'NOT DELIVERED%') ORDER BY updated_at ASC",
      )
      .all() as CampaignRow[];
    return rows.map(rowToCampaign);
  }

  /** Failed campaigns holding a self-revival appointment (boot re-arm). */
  listAwaitingAutoRevive(): Campaign[] {
    const rows = this.db
      .prepare("SELECT * FROM campaigns WHERE state = 'failed' ORDER BY updated_at DESC")
      .all() as CampaignRow[];
    return rows.map(rowToCampaign).filter((c) => typeof c.autoReviveAt === "number");
  }

  /**
   * Newest campaign on this chat that "kampanya devam" may revive.
   *
   * Failed and cancelled ones, and — audited 2026-09-06 — a `done` one whose
   * final sprint still carries the structural refusal. Under the current
   * code such a campaign never reaches `done` (it stops at `failed`, see
   * campaign-manager's NOT DELIVERED path); rows written before that fix
   * read "delivered" although the structural gate had refused the tree, and
   * "kampanya devam" on them silently did nothing: the query only looked at
   * failed/cancelled,
   * the user was told nothing, and the only way forward was a hand edit of
   * this database. A plain `done` stays final.
   */
  findLatestRevivable(chatId: string, belongs?: (campaign: Campaign) => boolean): Campaign | undefined {
    return this.firstMatching(
      "SELECT * FROM campaigns WHERE chat_id = ? AND (" +
        "state IN ('failed', 'cancelled') OR " +
        "(state = 'done' AND milestones_json LIKE '%\"structureRefused\":true%')" +
        ") ORDER BY updated_at DESC",
      [chatId],
      belongs,
    );
  }

  /**
   * The campaign on this chat that is parked with a self-revival appointment:
   * `failed`, so not active, yet it will submit work again by itself. A
   * person's stop must reach it (audit 2026-10-11, campaign#0).
   */
  findParkedForChat(chatId: string, belongs?: (campaign: Campaign) => boolean): Campaign | undefined {
    return this.firstMatching(
      "SELECT * FROM campaigns WHERE chat_id = ? AND state = 'failed' AND auto_revive_at IS NOT NULL ORDER BY updated_at DESC",
      [chatId],
      belongs,
    );
  }

  /** The campaign awaiting an approval reply on this conversation, if any. */
  findAwaitingApproval(chatId: string, belongs?: (campaign: Campaign) => boolean): Campaign | undefined {
    return this.firstMatching(
      "SELECT * FROM campaigns WHERE chat_id = ? AND state = 'awaiting-approval' ORDER BY created_at DESC",
      [chatId],
      belongs,
    );
  }

  /**
   * A non-terminal campaign on this conversation. Guards intake: while one
   * game is being built, new messages stay ordinary tasks instead of
   * silently forking a second build.
   */
  /** The non-terminal campaign this chat is running, when there is one — the newest. */
  findActiveForChat(chatId: string, belongs?: (campaign: Campaign) => boolean): Campaign | undefined {
    const placeholders = ACTIVE_CAMPAIGN_STATES.map(() => "?").join(", ");
    return this.firstMatching(
      `SELECT * FROM campaigns WHERE chat_id = ? AND state IN (${placeholders}) ORDER BY updated_at DESC`,
      [chatId, ...ACTIVE_CAMPAIGN_STATES],
      belongs,
    );
  }

  hasActiveForChat(chatId: string, belongs?: (campaign: Campaign) => boolean): boolean {
    return this.findActiveForChat(chatId, belongs) !== undefined;
  }

  /**
   * The first row, in the query's order, that `belongs` accepts (every row
   * when it is omitted). One database can hold several projects' campaigns
   * (CMP-7), and "the same project" is a comparison of resolved paths the
   * caller owns, not an SQL equality on however the root was spelled.
   */
  private firstMatching(
    sql: string,
    params: readonly unknown[],
    belongs: ((campaign: Campaign) => boolean) | undefined,
  ): Campaign | undefined {
    for (const row of this.db.prepare(sql).all(...params) as CampaignRow[]) {
      const campaign = rowToCampaign(row);
      if (belongs === undefined || belongs(campaign)) return campaign;
    }
    return undefined;
  }

  /**
   * A non-terminal campaign on this PROJECT, whatever chat it came from. The
   * per-chat guard let a web chat and the CLI each start a build against the
   * same repo — two ladders writing over each other.
   */
  hasActiveForProject(projectRoot: string): boolean {
    const placeholders = ACTIVE_CAMPAIGN_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 FROM campaigns WHERE project_root = ? AND state IN (${placeholders}) LIMIT 1`,
      )
      .get(projectRoot, ...ACTIVE_CAMPAIGN_STATES);
    return row !== undefined;
  }

  /**
   * Whether the database is still usable.
   *
   * A deferred callback that outlives the storage must be able to ASK rather
   * than throw: audited 2026-09-04, two `setTimeout(…, 0)` resubmit hops in
   * CampaignManager called `get()` after close and raised an uncaught
   * "The database connection is not open" — an unhandled rejection in
   * production and, in the test run, two unhandled errors beside 565 passing
   * tests, which vitest itself warns may be masking false positives.
   */
  isOpen(): boolean {
    return this.db.open;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The gap queue as stored: a JSON array of strings, or nothing at all.
 *
 * AN UNREADABLE QUEUE IS NOT AN EMPTY ONE. Truncated JSON, a non-array, a row
 * of nulls — every one of them returned `undefined`, which the campaign reads
 * as "no requirements are waiting": the obligations a previous run discovered
 * silently stopped existing, and with the audit budget spent nothing ever
 * reconstructed them (Codex 2026-09-12 AD#18). `unreadable` says the row held
 * something this reader could not use, so the campaign can re-establish the
 * requirements from the GDD instead of delivering without them.
 */
function parseGapQueue(raw: string | null | undefined): { gaps?: string[]; unreadable?: true } {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: true };
  }
  if (!Array.isArray(parsed)) return { unreadable: true };
  const items = parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (items.length === 0) return parsed.length > 0 ? { unreadable: true } : {};
  // SOME entries usable and some not is still a partial loss.
  return items.length < parsed.length ? { gaps: items, unreadable: true } : { gaps: items };
}

// =============================================================================
// ACCEPTANCE FILES AND VERDICTS (GDD plan W03)
// =============================================================================

/** An acceptance file as stored: its canonical bytes and when the system last wrote them. */
export interface StoredAcceptance extends AcceptanceSource {
  writtenAtMs: number;
}

/** One verdict to append, with the input the judge read. */
export interface JudgementEntry {
  readonly campaignId: string;
  /** Which attempt of the milestone was judged; the settle path chooses the spelling. */
  readonly attemptKey: string;
  readonly atMs: number;
  readonly input: GreenInput;
  readonly judgement: Judgement;
}

export interface StoredJudgement {
  readonly campaignId: string;
  readonly milestoneId: string;
  readonly attemptKey: string;
  readonly atMs: number;
  readonly mode: ScopeGateMode;
  readonly revision: string;
  readonly judgement: Judgement;
  /** The judge's input exactly as appended; absent when `unreadable`. */
  readonly input?: GreenInput;
  readonly inputSha256: string;
  /**
   * Why this verdict cannot be replayed (its input no longer hashes to
   * `inputSha256`, or a stored part does not parse). The entry is still
   * listed: a dropped one would read as "never judged".
   */
  readonly unreadable?: string;
}

interface AcceptanceMeta {
  writer: AcceptanceWriter;
  revisions: number;
  tests: AcceptanceTestRef[];
}

interface AcceptanceRow {
  campaign_id: string;
  milestone_id: string;
  path: string;
  sha256: string;
  source: Buffer | string;
  meta_json: string;
  written_at: number;
}

interface JudgementRow {
  campaign_id: string;
  milestone_id: string;
  attempt_key: string;
  at: number;
  mode: string;
  green: number;
  state: string | null;
  basis: string | null;
  revision: string;
  reasons_json: string;
  caveats_json: string;
  input_json: string;
  input_sha256: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** "/"-separated, relative, strictly under ACCEPTANCE_DIR, with no empty, "." or ".." segment. */
function assertAcceptancePath(path: string): void {
  const inside =
    path.startsWith(`${ACCEPTANCE_DIR}/`) &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!inside) {
    throw new Error(`acceptance file ${JSON.stringify(path)} is not a project-relative path under ${ACCEPTANCE_DIR}/`);
  }
}

function rowToAcceptance(row: AcceptanceRow): StoredAcceptance {
  const bytes = typeof row.source === "string" ? Buffer.from(row.source, "utf8") : Buffer.from(row.source);
  const actual = sha256Hex(bytes);
  if (actual !== row.sha256) {
    throw new Error(
      `stored acceptance file ${row.path} (campaign ${row.campaign_id}) no longer hashes to its sha256 ${row.sha256} (${actual}); its canonical bytes are damaged`,
    );
  }
  const meta = parseAcceptanceMeta(row.meta_json);
  if (meta === undefined) {
    throw new Error(`stored acceptance file ${row.path} (campaign ${row.campaign_id}) has a writer and test list that cannot be read`);
  }
  return {
    milestoneId: row.milestone_id,
    path: row.path,
    sha256: row.sha256,
    source: bytes.toString("utf8"),
    writer: meta.writer,
    revisions: meta.revisions,
    tests: meta.tests,
    writtenAtMs: row.written_at,
  };
}

const isWriter = (value: unknown): value is AcceptanceWriter =>
  isRecord(value) &&
  typeof value.provider === "string" &&
  typeof value.model === "string" &&
  (value.independence === "different-model" || value.independence === "same-model");

function parseAcceptanceMeta(raw: string): AcceptanceMeta | undefined {
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(meta) || !isWriter(meta.writer) || !isFiniteNumber(meta.revisions) || !Array.isArray(meta.tests)) return undefined;
  const tests = meta.tests as unknown[];
  const readable = tests.every(
    (t) =>
      isRecord(t) &&
      typeof t.rid === "string" &&
      typeof t.testName === "string" &&
      typeof t.bodySha === "string" &&
      (t.writer === undefined || isWriter(t.writer)),
  );
  return readable ? { writer: meta.writer, revisions: meta.revisions, tests: tests as AcceptanceTestRef[] } : undefined;
}

function rowToJudgement(row: JudgementRow): StoredJudgement {
  const problems: string[] = [];
  const parseList = <T>(raw: string, what: string): T[] => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // reported below
    }
    problems.push(`its ${what} do not parse`);
    return [];
  };
  let input: GreenInput | undefined;
  if (sha256Hex(Buffer.from(row.input_json, "utf8")) !== row.input_sha256) {
    problems.push(`its stored input no longer hashes to its input_sha256 ${row.input_sha256}`);
  } else {
    try {
      input = JSON.parse(row.input_json) as GreenInput;
    } catch {
      problems.push("its stored input does not parse");
    }
  }
  const judgement: Judgement =
    row.green === 1
      ? { green: true, basis: row.basis as GreenBasis, caveats: parseList<string>(row.caveats_json, "caveats") }
      : { green: false, state: row.state as ReasonClass, reasons: parseList<GreenReason>(row.reasons_json, "reasons") };
  return {
    campaignId: row.campaign_id,
    milestoneId: row.milestone_id,
    attemptKey: row.attempt_key,
    atMs: row.at,
    mode: row.mode as ScopeGateMode,
    revision: row.revision,
    judgement,
    ...(input === undefined ? {} : { input }),
    inputSha256: row.input_sha256,
    ...(problems.length > 0 ? { unreadable: problems.join("; ") } : {}),
  };
}
