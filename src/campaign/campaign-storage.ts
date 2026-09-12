/**
 * Campaign Storage
 *
 * SQLite persistence for campaigns, following the GoalStorage pattern:
 * better-sqlite3, shared pragmas, prepared statements. Milestones ride as a
 * JSON column — the ladder is small (<=12) and always read/written whole.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Campaign, CampaignMilestone, CampaignState } from "./types.js";
import { ACTIVE_CAMPAIGN_STATES } from "./types.js";

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
  };
}

function parseIndependentReview(raw: string): Campaign["independentReview"] | undefined {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.ok !== "boolean" || typeof p.model !== "string") return undefined;
    return {
      ok: p.ok,
      model: p.model,
      text: typeof p.text === "string" ? p.text : "",
      ms: typeof p.ms === "number" ? p.ms : 0,
      ...(typeof p.error === "string" ? { error: p.error } : {}),
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

export class CampaignStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureSqlitePragmas(this.db, "tasks");
    this.db.exec(SCHEMA_SQL);
    try {
      this.db.exec("ALTER TABLE campaigns ADD COLUMN auto_revive_at INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      this.db.exec("ALTER TABLE campaigns ADD COLUMN coverage_audit_note TEXT");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Self-revivals spent on a proof this machine cannot produce (Codex 2026-09-11 C#2).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN unmeasurable_revives INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Self-revivals spent on an ordinary implementation failure (F#1).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN implementation_revives INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Gaps the audit named and no round has scheduled yet (F#9).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN pending_coverage_gaps TEXT");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Delivery rounds spent on the same missing proofs (H#1).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN delivery_revives INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // A person's stop, recorded when it is SEEN (Codex 2026-09-11 L#3).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN stop_requested_at INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      this.db.exec("ALTER TABLE campaigns ADD COLUMN stop_generation INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Every delivery round, whatever its identity (Codex 2026-09-11 O#5).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN delivery_rounds_total INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      this.db.exec("ALTER TABLE campaigns ADD COLUMN delivery_proofs_signature TEXT");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Audited 2026-09-02: the draft path's deferral clock (24h bound).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN draft_deferred_since INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // Audited 2026-09-02: the delivery report is sent after state=done is
      // persisted, so a crash in that window lost it silently. Backfill runs
      // only on the ALTER that actually adds the column: campaigns that were
      // already `done` reported under the old path, and must not be
      // re-announced by this migration.
      this.db.exec("ALTER TABLE campaigns ADD COLUMN delivery_reported INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE campaigns SET delivery_reported = 1 WHERE state = 'done'");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // 2026-09-10: how the plan covers the GDD's measured section inventory.
      this.db.exec("ALTER TABLE campaigns ADD COLUMN plan_coverage TEXT");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // 2026-09-12: the independent opinion on the delivery. It was gathered,
      // rendered and thrown away, while the boot resend assumed it was there
      // (Codex 2026-09-12 X).
      this.db.exec("ALTER TABLE campaigns ADD COLUMN independent_review TEXT");
    } catch {
      // Column already exists — migration is idempotent.
    }
    try {
      // 2026-09-13: an unreadable requirement queue was derived at load and
      // lost at save — the very next save wrote NULL over the damaged row and
      // the obligation was gone for good (Codex 2026-09-13 AF#2). It is a
      // column now, so the flag survives until an audit re-establishes the
      // requirements.
      this.db.exec("ALTER TABLE campaigns ADD COLUMN coverage_queue_unreadable INTEGER");
    } catch {
      // Column already exists — migration is idempotent.
    }
  }

  save(campaign: Campaign): void {
    this.db
      .prepare(
        `INSERT INTO campaigns (
          id, chat_id, channel_type, user_id, conversation_id, project_root,
          state, idea_text, gdd_path, gdd_text, draft_task_id, draft_attempts,
          milestones_json, current_milestone, created_at, updated_at, last_error,
          auto_revive_at, coverage_audit_note, draft_deferred_since, delivery_reported, plan_coverage,
          independent_review, coverage_queue_unreadable,
          unmeasurable_revives, implementation_revives, pending_coverage_gaps,
          delivery_revives, delivery_proofs_signature, delivery_rounds_total,
          stop_requested_at, stop_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          unmeasurable_revives = excluded.unmeasurable_revives,
          implementation_revives = excluded.implementation_revives,
          pending_coverage_gaps = excluded.pending_coverage_gaps,
          delivery_revives = excluded.delivery_revives,
          delivery_proofs_signature = excluded.delivery_proofs_signature,
          delivery_rounds_total = excluded.delivery_rounds_total,
          stop_requested_at = excluded.stop_requested_at,
          stop_generation = excluded.stop_generation`,
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
      );
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
   * read "delivered" over a game that renders nothing, and "kampanya devam"
   * on them silently did nothing: the query only looked at failed/cancelled,
   * the user was told nothing, and the only way forward was a hand edit of
   * this database. A plain `done` stays final.
   */
  findLatestRevivable(chatId: string): Campaign | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE chat_id = ? AND (" +
          "state IN ('failed', 'cancelled') OR " +
          "(state = 'done' AND milestones_json LIKE '%\"structureRefused\":true%')" +
          ") ORDER BY updated_at DESC LIMIT 1",
      )
      .get(chatId) as CampaignRow | undefined;
    return row ? rowToCampaign(row) : undefined;
  }

  /** The campaign awaiting an approval reply on this conversation, if any. */
  findAwaitingApproval(chatId: string): Campaign | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE chat_id = ? AND state = 'awaiting-approval' ORDER BY created_at DESC LIMIT 1",
      )
      .get(chatId) as CampaignRow | undefined;
    return row ? rowToCampaign(row) : undefined;
  }

  /**
   * A non-terminal campaign on this conversation. Guards intake: while one
   * game is being built, new messages stay ordinary tasks instead of
   * silently forking a second build.
   */
  hasActiveForChat(chatId: string): boolean {
    const placeholders = ACTIVE_CAMPAIGN_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 FROM campaigns WHERE chat_id = ? AND state IN (${placeholders}) LIMIT 1`,
      )
      .get(chatId, ...ACTIVE_CAMPAIGN_STATES);
    return row !== undefined;
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
