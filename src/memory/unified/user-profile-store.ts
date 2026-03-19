/**
 * UserProfileStore — SQLite-backed persistence for per-user profiles.
 *
 * Stores language, persona, preferences, context summaries, and timestamps.
 * Uses better-sqlite3 prepared statements for synchronous, low-latency access.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfile {
  chatId: string;
  displayName?: string;
  language: string;
  timezone?: string;
  activePersona: string;
  preferences: Record<string, unknown>;
  contextSummary?: string;
  lastTopics: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface AutonomousDefaultOptions {
  enabled: boolean;
  hours: number;
  now?: number;
}

type AutonomousModeStore = Pick<UserProfileStore, "isAutonomousMode" | "setAutonomousMode"> & {
  getProfile?: (chatId: string) => { preferences?: Record<string, unknown> } | null;
};

const AUTONOMOUS_MIN_HOURS = 1;
const AUTONOMOUS_MAX_HOURS = 168;
const AUTONOMOUS_FALLBACK_HOURS = 24;

function sanitizeAutonomousDefaultHours(hours: number): number {
  if (!Number.isFinite(hours)) {
    return AUTONOMOUS_FALLBACK_HOURS;
  }

  return Math.min(
    AUTONOMOUS_MAX_HOURS,
    Math.max(AUTONOMOUS_MIN_HOURS, Math.trunc(hours)),
  );
}

export async function resolveAutonomousModeWithDefault(
  store: AutonomousModeStore,
  chatId: string,
  defaults?: AutonomousDefaultOptions,
): Promise<{ enabled: boolean; expiresAt?: number; remainingMs?: number }> {
  if (typeof store.getProfile === "function") {
    const profile = store.getProfile(chatId);
    const prefs = profile?.preferences ?? {};
    const hasExplicitAutonomousMode = Object.prototype.hasOwnProperty.call(
      prefs,
      "autonomousMode",
    );

    if (!hasExplicitAutonomousMode && defaults?.enabled) {
      const hours = sanitizeAutonomousDefaultHours(defaults.hours);
      const now = defaults.now ?? Date.now();
      await store.setAutonomousMode(chatId, true, now + hours * 3600_000);
    }
  }

  return store.isAutonomousMode(chatId);
}

/** Row shape returned by SQLite SELECT */
interface UserProfileRow {
  chat_id: string;
  display_name: string | null;
  language: string;
  timezone: string | null;
  active_persona: string;
  preferences: string;
  context_summary: string | null;
  last_topics: string;
  first_seen_at: number;
  last_seen_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const USER_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_profiles (
  chat_id         TEXT PRIMARY KEY,
  display_name    TEXT,
  language        TEXT DEFAULT 'en',
  timezone        TEXT,
  active_persona  TEXT DEFAULT 'default',
  preferences     TEXT DEFAULT '{}',
  context_summary TEXT,
  last_topics     TEXT DEFAULT '[]',
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToProfile(row: UserProfileRow): UserProfile {
  const profile: UserProfile = {
    chatId: row.chat_id,
    language: row.language,
    activePersona: row.active_persona,
    preferences: JSON.parse(row.preferences) as Record<string, unknown>,
    lastTopics: JSON.parse(row.last_topics) as string[],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };

  if (row.display_name !== null) {
    profile.displayName = row.display_name;
  }
  if (row.timezone !== null) {
    profile.timezone = row.timezone;
  }
  if (row.context_summary !== null) {
    profile.contextSummary = row.context_summary;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class UserProfileStore {
  private readonly stmtGet: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtSetPersona: Database.Statement;
  private readonly stmtUpdateContext: Database.Statement;
  private readonly stmtTouchLastSeen: Database.Statement;

  constructor(db: Database.Database) {
    // Create table (static SQL, no user input)
    db.exec(USER_PROFILES_SCHEMA);

    // Prepare statements
    this.stmtGet = db.prepare(
      "SELECT * FROM user_profiles WHERE chat_id = ?",
    );

    this.stmtUpsert = db.prepare(`
      INSERT INTO user_profiles (
        chat_id, display_name, language, timezone,
        active_persona, preferences, context_summary, last_topics,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        @chat_id, @display_name,
        COALESCE(@language, 'en'),
        @timezone,
        COALESCE(@active_persona, 'default'),
        COALESCE(@preferences, '{}'),
        @context_summary,
        COALESCE(@last_topics, '[]'),
        @now, @now, @now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        display_name    = COALESCE(@display_name, user_profiles.display_name),
        language        = COALESCE(@language, user_profiles.language),
        timezone        = COALESCE(@timezone, user_profiles.timezone),
        active_persona  = COALESCE(@active_persona, user_profiles.active_persona),
        preferences     = COALESCE(@preferences, user_profiles.preferences),
        context_summary = COALESCE(@context_summary, user_profiles.context_summary),
        last_topics     = COALESCE(@last_topics, user_profiles.last_topics),
        last_seen_at    = @now,
        updated_at      = @now
    `);

    this.stmtSetPersona = db.prepare(`
      INSERT INTO user_profiles (
        chat_id, active_persona,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        @chat_id, @active_persona,
        @now, @now, @now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        active_persona = @active_persona,
        last_seen_at   = @now,
        updated_at     = @now
    `);

    this.stmtUpdateContext = db.prepare(`
      INSERT INTO user_profiles (
        chat_id, context_summary, last_topics,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        @chat_id, @context_summary, @last_topics,
        @now, @now, @now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        context_summary = @context_summary,
        last_topics     = @last_topics,
        last_seen_at    = @now,
        updated_at      = @now
    `);

    this.stmtTouchLastSeen = db.prepare(`
      INSERT INTO user_profiles (
        chat_id,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        @chat_id,
        @now, @now, @now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        last_seen_at = @now,
        updated_at   = @now
    `);
  }

  /**
   * Retrieve a user profile by chatId.
   * Returns null if no profile exists for the given chatId.
   */
  getProfile(chatId: string): UserProfile | null {
    const row = this.stmtGet.get(chatId) as UserProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  /**
   * Create or update a user profile with partial fields.
   * Uses COALESCE to avoid overwriting existing values with null on partial updates.
   * Returns the full profile after the upsert.
   */
  upsertProfile(
    chatId: string,
    updates: Partial<Omit<UserProfile, "chatId" | "firstSeenAt" | "lastSeenAt">>,
  ): UserProfile {
    const now = Date.now();

    this.stmtUpsert.run({
      chat_id: chatId,
      display_name: updates.displayName ?? null,
      language: updates.language ?? null,
      timezone: updates.timezone ?? null,
      active_persona: updates.activePersona ?? null,
      preferences: updates.preferences !== undefined
        ? JSON.stringify(updates.preferences)
        : null,
      context_summary: updates.contextSummary ?? null,
      last_topics: updates.lastTopics !== undefined
        ? JSON.stringify(updates.lastTopics)
        : null,
      now,
    });

    return this.getProfile(chatId)!;
  }

  /**
   * Set the active persona for a user.
   * Auto-creates the profile with defaults if it doesn't exist.
   */
  setActivePersona(chatId: string, persona: string): void {
    const now = Date.now();
    this.stmtSetPersona.run({
      chat_id: chatId,
      active_persona: persona,
      now,
    });
  }

  /**
   * Update the context summary and topics for a user.
   * Auto-creates the profile with defaults if it doesn't exist.
   */
  updateContextSummary(chatId: string, summary: string, topics: string[]): void {
    const now = Date.now();
    this.stmtUpdateContext.run({
      chat_id: chatId,
      context_summary: summary,
      last_topics: JSON.stringify(topics),
      now,
    });
  }

  /**
   * Touch the lastSeenAt timestamp for a user.
   * Auto-creates the profile with defaults if it doesn't exist.
   */
  touchLastSeen(chatId: string): void {
    const now = Date.now();
    this.stmtTouchLastSeen.run({
      chat_id: chatId,
      now,
    });
  }

  // -------------------------------------------------------------------------
  // Autonomous mode convenience methods
  // -------------------------------------------------------------------------

  /**
   * Enable or disable autonomous mode for a user.
   * Stores the flag and optional expiration timestamp in the profile's
   * preferences object.  When disabling, the expiration is removed.
   */
  async setAutonomousMode(
    chatId: string,
    enabled: boolean,
    expiresAt?: number,
  ): Promise<void> {
    const profile = this.getProfile(chatId);
    const prefs: Record<string, unknown> = profile?.preferences
      ? { ...profile.preferences }
      : {};

    prefs.autonomousMode = enabled;

    if (enabled && expiresAt !== undefined) {
      prefs.autonomousExpiresAt = expiresAt;
    } else {
      delete prefs.autonomousExpiresAt;
    }

    this.upsertProfile(chatId, { preferences: prefs });
  }

  /**
   * Check whether autonomous mode is active for a user.
   * If the mode was enabled with an expiration and that time has passed,
   * it is automatically disabled and the updated state is persisted.
   */
  async isAutonomousMode(
    chatId: string,
  ): Promise<{ enabled: boolean; expiresAt?: number; remainingMs?: number }> {
    const profile = this.getProfile(chatId);
    const prefs = profile?.preferences ?? {};

    const enabled = prefs.autonomousMode === true;

    if (!enabled) {
      return { enabled: false };
    }

    const expiresAt =
      typeof prefs.autonomousExpiresAt === "number"
        ? prefs.autonomousExpiresAt
        : undefined;

    if (expiresAt !== undefined) {
      const remainingMs = expiresAt - Date.now();

      if (remainingMs <= 0) {
        // Expired — auto-disable and persist
        await this.setAutonomousMode(chatId, false);
        return { enabled: false };
      }

      return { enabled: true, expiresAt, remainingMs };
    }

    // Enabled with no expiration
    return { enabled: true };
  }
}
