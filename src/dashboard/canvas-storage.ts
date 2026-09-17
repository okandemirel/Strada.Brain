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
  /**
   * JSON array of connections between shapes. The canvas drew them and the
   * store held them, but nothing persisted them: reopening a session showed
   * the boxes without a single arrow (plan 2.6 / audit 11.3 / D33).
   */
  connections?: string;
  viewport?: string; // JSON { x, y, zoom }
  version?: number; // optimistic locking version, auto-incremented on update
  createdAt: number;
  updatedAt: number;
}

/**
 * The version a write is allowed to assume it is replacing.
 *
 * `undefined` — no precondition at all: an unconditional upsert, kept for
 *   callers that never read the row.
 * `CANVAS_VERSION_ABSENT` (0) — "there is no canvas yet": the write must
 *   CREATE. Two windows that both read `canvas: null` used to send no version
 *   at all, so both wrote unconditionally and the second destroyed the first
 *   window's work (r9 #17). An absent canvas is a precondition of its own.
 * a positive integer — "I am replacing exactly this version".
 */
export const CANVAS_VERSION_ABSENT = 0;

/**
 * What a save did. The version is the version OF THIS WRITE — read back in the
 * same statement (`RETURNING`) inside one transaction, never by a later
 * `getBySession()` that could report a concurrent writer's version (r9 #21).
 */
export type CanvasSaveOutcome =
  | { ok: true; version: number }
  | { ok: false; reason: "version_conflict" | "already_exists" };

export class CanvasStorage {
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtGetVersionBySession: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpsertVersioned: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtListByProject: Database.Statement;
  /** write + version read as one atomic unit, so the ack is this write's. */
  private readonly txSave: Database.Transaction<(state: CanvasState) => CanvasSaveOutcome>;

  constructor(private readonly db: Database.Database) {
    this.initialize();

    this.stmtGetBySession = this.db.prepare(
      "SELECT id, session_id, user_id, project_fingerprint, shapes, connections, viewport, version, created_at, updated_at FROM canvas_states WHERE session_id = ?",
    );

    this.stmtGetVersionBySession = this.db.prepare(
      "SELECT id, version FROM canvas_states WHERE session_id = ?",
    );

    this.stmtInsert = this.db.prepare(`
      INSERT INTO canvas_states (id, session_id, user_id, project_fingerprint, shapes, connections, viewport, version, created_at, updated_at)
      VALUES (@id, @sessionId, @userId, @projectFingerprint, @shapes, @connections, @viewport, 1, @createdAt, @updatedAt)
      ON CONFLICT(id) DO NOTHING
      RETURNING version
    `);

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO canvas_states (id, session_id, user_id, project_fingerprint, shapes, connections, viewport, version, created_at, updated_at)
      VALUES (@id, @sessionId, @userId, @projectFingerprint, @shapes, @connections, @viewport, 1, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        shapes = @shapes,
        connections = @connections,
        viewport = @viewport,
        user_id = @userId,
        project_fingerprint = @projectFingerprint,
        version = version + 1,
        updated_at = @updatedAt
      RETURNING version
    `);

    this.stmtUpsertVersioned = this.db.prepare(`
      UPDATE canvas_states SET
        shapes = @shapes,
        connections = @connections,
        viewport = @viewport,
        user_id = @userId,
        project_fingerprint = @projectFingerprint,
        version = version + 1,
        updated_at = @updatedAt
      WHERE id = @id AND version = @version
      RETURNING version
    `);

    this.stmtDelete = this.db.prepare(
      "DELETE FROM canvas_states WHERE session_id = ?",
    );

    this.stmtListByProject = this.db.prepare(
      "SELECT id, session_id, user_id, project_fingerprint, shapes, connections, viewport, version, created_at, updated_at FROM canvas_states WHERE project_fingerprint = ? ORDER BY updated_at DESC LIMIT 100",
    );

    this.txSave = this.db.transaction((state: CanvasState) => this.saveInTransaction(state));
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_states (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        project_fingerprint TEXT,
        shapes TEXT NOT NULL DEFAULT '[]',
        connections TEXT NOT NULL DEFAULT '[]',
        viewport TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Migrations for databases written before these columns existed.
    for (const column of [
      "version INTEGER NOT NULL DEFAULT 1",
      "connections TEXT NOT NULL DEFAULT '[]'",
    ]) {
      try {
        this.db.exec(`ALTER TABLE canvas_states ADD COLUMN ${column}`);
      } catch {
        // Column already exists — ignore
      }
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
          connections: string | null;
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
      connections: row.connections ?? "[]",
      viewport: row.viewport ?? undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Save canvas state under the precondition its `version` states (see
   * CANVAS_VERSION_ABSENT). The outcome carries the version this write
   * produced, read back in the same statement inside one immediate
   * transaction: an ack can never name a version some other connection wrote
   * (r9 #21), and a refused precondition is a conflict, not a silent
   * overwrite (r9 #17).
   */
  save(state: CanvasState): CanvasSaveOutcome {
    return this.txSave.immediate(state);
  }

  private saveInTransaction(state: CanvasState): CanvasSaveOutcome {
    const params = {
      id: state.id,
      sessionId: state.sessionId,
      userId: state.userId ?? null,
      projectFingerprint: state.projectFingerprint ?? null,
      shapes: state.shapes,
      connections: state.connections ?? "[]",
      viewport: state.viewport ?? null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };

    // "There is no canvas yet": create, or tell the caller someone else did.
    if (state.version === CANVAS_VERSION_ABSENT) {
      const existing = this.stmtGetVersionBySession.get(state.sessionId);
      if (existing) return { ok: false, reason: "already_exists" };
      const created = this.stmtInsert.get(params) as { version: number } | undefined;
      if (!created) return { ok: false, reason: "already_exists" };
      return { ok: true, version: created.version };
    }

    // "I am replacing exactly this version."
    if (state.version != null) {
      const updated = this.stmtUpsertVersioned.get({ ...params, version: state.version }) as
        | { version: number }
        | undefined;
      if (updated) return { ok: true, version: updated.version };
      // Nothing matched: either another writer moved the version on, or the
      // row this client held a version for is gone.
      const exists = this.stmtGetVersionBySession.get(state.sessionId);
      if (exists) return { ok: false, reason: "version_conflict" };
      const created = this.stmtInsert.get(params) as { version: number } | undefined;
      return created
        ? { ok: true, version: created.version }
        : { ok: false, reason: "version_conflict" };
    }

    // No precondition — unconditional upsert.
    const written = this.stmtUpsert.get(params) as { version: number } | undefined;
    return written ? { ok: true, version: written.version } : { ok: false, reason: "version_conflict" };
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
      connections: string | null;
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
      connections: row.connections ?? "[]",
      viewport: row.viewport ?? undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
