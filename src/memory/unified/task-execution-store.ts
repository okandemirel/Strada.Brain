import type Database from "better-sqlite3";

export interface TaskExecutionMemory {
  scopeKey: string;
  sessionSummary?: string;
  openItems: string[];
  topics: string[];
  branchSummary?: string;
  verifierSummary?: string;
  learnedInsights: string[];
  updatedAt: number;
}

interface TaskExecutionMemoryRow {
  scope_key: string;
  session_summary: string | null;
  open_items: string;
  topics: string;
  branch_summary: string | null;
  verifier_summary: string | null;
  learned_insights: string;
  updated_at: number;
}

export interface TaskExecutionSnapshot {
  branchSummary?: string;
  verifierSummary?: string;
  learnedInsights?: readonly string[];
}

const TASK_EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_execution_memory (
  scope_key         TEXT PRIMARY KEY,
  session_summary   TEXT,
  open_items        TEXT DEFAULT '[]',
  topics            TEXT DEFAULT '[]',
  branch_summary    TEXT,
  verifier_summary  TEXT,
  learned_insights  TEXT DEFAULT '[]',
  updated_at        INTEGER NOT NULL
);
`;

function rowToMemory(row: TaskExecutionMemoryRow): TaskExecutionMemory {
  return {
    scopeKey: row.scope_key,
    sessionSummary: row.session_summary ?? undefined,
    openItems: JSON.parse(row.open_items) as string[],
    topics: JSON.parse(row.topics) as string[],
    branchSummary: row.branch_summary ?? undefined,
    verifierSummary: row.verifier_summary ?? undefined,
    learnedInsights: JSON.parse(row.learned_insights) as string[],
    updatedAt: row.updated_at,
  };
}

export class TaskExecutionStore {
  private readonly stmtGet: Database.Statement;
  private readonly stmtUpsert: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(TASK_EXECUTION_SCHEMA);

    this.stmtGet = db.prepare(
      "SELECT * FROM task_execution_memory WHERE scope_key = ?",
    );

    this.stmtUpsert = db.prepare(`
      INSERT INTO task_execution_memory (
        scope_key, session_summary, open_items, topics,
        branch_summary, verifier_summary, learned_insights, updated_at
      ) VALUES (
        @scope_key, @session_summary, COALESCE(@open_items, '[]'), COALESCE(@topics, '[]'),
        @branch_summary, @verifier_summary, COALESCE(@learned_insights, '[]'), @updated_at
      )
      ON CONFLICT(scope_key) DO UPDATE SET
        session_summary  = COALESCE(@session_summary, task_execution_memory.session_summary),
        open_items       = COALESCE(@open_items, task_execution_memory.open_items),
        topics           = COALESCE(@topics, task_execution_memory.topics),
        branch_summary   = COALESCE(@branch_summary, task_execution_memory.branch_summary),
        verifier_summary = COALESCE(@verifier_summary, task_execution_memory.verifier_summary),
        learned_insights = COALESCE(@learned_insights, task_execution_memory.learned_insights),
        updated_at       = @updated_at
    `);
  }

  getMemory(scopeKey: string): TaskExecutionMemory | null {
    const row = this.stmtGet.get(scopeKey) as TaskExecutionMemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  updateSessionSummary(
    scopeKey: string,
    summary: string,
    openItems: readonly string[],
    topics: readonly string[],
  ): TaskExecutionMemory {
    const now = Date.now();
    this.stmtUpsert.run({
      scope_key: scopeKey,
      session_summary: summary,
      open_items: JSON.stringify([...openItems]),
      topics: JSON.stringify([...topics]),
      branch_summary: null,
      verifier_summary: null,
      learned_insights: null,
      updated_at: now,
    });
    return this.getMemory(scopeKey)!;
  }

  updateExecutionSnapshot(
    scopeKey: string,
    snapshot: TaskExecutionSnapshot,
  ): TaskExecutionMemory {
    const now = Date.now();
    this.stmtUpsert.run({
      scope_key: scopeKey,
      session_summary: null,
      open_items: null,
      topics: null,
      branch_summary: snapshot.branchSummary ?? null,
      verifier_summary: snapshot.verifierSummary ?? null,
      learned_insights: snapshot.learnedInsights !== undefined
        ? JSON.stringify([...snapshot.learnedInsights])
        : null,
      updated_at: now,
    });
    return this.getMemory(scopeKey)!;
  }
}
