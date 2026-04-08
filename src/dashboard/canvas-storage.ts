/**
 * Canvas State Persistence
 *
 * SQLite-backed storage for workspace canvas states.
 * Each session can have one canvas state (shapes + viewport).
 * Uses better-sqlite3 with parameterized queries throughout.
 */

import Database from "better-sqlite3";

export interface CanvasState {
  id: string;
  sessionId: string;
  userId?: string;
  projectFingerprint?: string;
  shapes: string; // JSON array of shape objects
  viewport?: string; // JSON { x, y, zoom }
  version?: number; // optimistic locking version, auto-incremented on update
  createdAt: number;
  updatedAt: number;
}

export class CanvasStorage {
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtUpsertVersioned: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtListByProject: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.initialize();

    this.stmtGetBySession = this.db.prepare(
      "SELECT id, session_id, user_id, project_fingerprint, shapes, viewport, version, created_at, updated_at FROM canvas_states WHERE session_id = ?",
    );

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO canvas_states (id, session_id, user_id, project_fingerprint, shapes, viewport, version, created_at, updated_at)
      VALUES (@id, @sessionId, @userId, @projectFingerprint, @shapes, @viewport, 1, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        shapes = @shapes,
        viewport = @viewport,
        user_id = @userId,
        project_fingerprint = @projectFingerprint,
        version = version + 1,
        updated_at = @updatedAt
    `);

    this.stmtUpsertVersioned = this.db.prepare(`
      UPDATE canvas_states SET
        shapes = @shapes,
        viewport = @viewport,
        user_id = @userId,
        project_fingerprint = @projectFingerprint,
        version = version + 1,
        updated_at = @updatedAt
      WHERE id = @id AND version = @version
    `);

    this.stmtDelete = this.db.prepare(
      "DELETE FROM canvas_states WHERE session_id = ?",
    );

    this.stmtListByProject = this.db.prepare(
      "SELECT id, session_id, user_id, project_fingerprint, shapes, viewport, version, created_at, updated_at FROM canvas_states WHERE project_fingerprint = ? ORDER BY updated_at DESC LIMIT 100",
    );
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_states (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        project_fingerprint TEXT,
        shapes TEXT NOT NULL DEFAULT '[]',
        viewport TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Migration: add version column to existing tables
    try {
      this.db.exec("ALTER TABLE canvas_states ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists — ignore
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_canvas_session ON canvas_states(session_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_canvas_project ON canvas_states(project_fingerprint)",
    );
  }

  getBySession(sessionId: string): CanvasState | null {
    const row = this.stmtGetBySession.get(sessionId) as
      | {
          id: string;
          session_id: string;
          user_id: string | null;
          project_fingerprint: string | null;
          shapes: string;
          viewport: string | null;
          version: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id ?? undefined,
      projectFingerprint: row.project_fingerprint ?? undefined,
      shapes: row.shapes,
      viewport: row.viewport ?? undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Save canvas state. Returns false if optimistic locking version conflict detected. */
  save(state: CanvasState): boolean {
    const params = {
      id: state.id,
      sessionId: state.sessionId,
      userId: state.userId ?? null,
      projectFingerprint: state.projectFingerprint ?? null,
      shapes: state.shapes,
      viewport: state.viewport ?? null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };

    // If client provides a version, use optimistic locking
    if (state.version != null) {
      const result = this.stmtUpsertVersioned.run({ ...params, version: state.version });
      if (result.changes === 0) {
        // Check if it's a new row (no conflict) vs version mismatch
        const exists = this.stmtGetBySession.get(state.sessionId);
        if (exists) return false; // version conflict
        this.stmtUpsert.run(params); // new row — safe to insert
      }
      return true;
    }

    // No version provided — unconditional upsert
    this.stmtUpsert.run(params);
    return true;
  }

  delete(sessionId: string): boolean {
    const result = this.stmtDelete.run(sessionId);
    return result.changes > 0;
  }

  listByProject(fingerprint: string): CanvasState[] {
    const rows = this.stmtListByProject.all(fingerprint) as Array<{
      id: string;
      session_id: string;
      user_id: string | null;
      project_fingerprint: string | null;
      shapes: string;
      viewport: string | null;
      version: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id ?? undefined,
      projectFingerprint: row.project_fingerprint ?? undefined,
      shapes: row.shapes,
      viewport: row.viewport ?? undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
