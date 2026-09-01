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
  };
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
  }

  save(campaign: Campaign): void {
    this.db
      .prepare(
        `INSERT INTO campaigns (
          id, chat_id, channel_type, user_id, conversation_id, project_root,
          state, idea_text, gdd_path, gdd_text, draft_task_id, draft_attempts,
          milestones_json, current_milestone, created_at, updated_at, last_error,
          auto_revive_at, coverage_audit_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          coverage_audit_note = excluded.coverage_audit_note`,
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

  /** Failed campaigns holding a self-revival appointment (boot re-arm). */
  listAwaitingAutoRevive(): Campaign[] {
    const rows = this.db
      .prepare("SELECT * FROM campaigns WHERE state = 'failed' ORDER BY updated_at DESC")
      .all() as CampaignRow[];
    return rows.map(rowToCampaign).filter((c) => typeof c.autoReviveAt === "number");
  }

  /** Newest failed/cancelled campaign on this chat — the "kampanya devam" target. */
  findLatestRevivable(chatId: string): Campaign | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE chat_id = ? AND state IN ('failed', 'cancelled') ORDER BY updated_at DESC LIMIT 1",
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

  close(): void {
    this.db.close();
  }
}
