/**
 * Provider Preference Store
 *
 * Per-chat AI provider/model preferences persisted in SQLite.
 * Allows users to set their preferred provider per conversation.
 */

import Database from "better-sqlite3";

export interface ChatProviderPreference {
  chatId: string;
  providerName: string;
  model?: string;
  updatedAt: number;
}

export class ProviderPreferenceStore {
  private db: Database.Database | null = null;
  private stmtGet!: Database.Statement;
  private stmtSet!: Database.Statement;
  private stmtDelete!: Database.Statement;

  constructor(private readonly dbPath: string) {}

  initialize(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_preferences (
        chat_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        model TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare(
      "SELECT chat_id, provider_name, model, updated_at FROM provider_preferences WHERE chat_id = ?",
    );
    this.stmtSet = this.db.prepare(
      "INSERT OR REPLACE INTO provider_preferences (chat_id, provider_name, model, updated_at) VALUES (?, ?, ?, ?)",
    );
    this.stmtDelete = this.db.prepare(
      "DELETE FROM provider_preferences WHERE chat_id = ?",
    );
  }

  get(chatId: string): ChatProviderPreference | undefined {
    const row = this.stmtGet.get(chatId) as
      | { chat_id: string; provider_name: string; model: string | null; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      chatId: row.chat_id,
      providerName: row.provider_name,
      model: row.model ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  set(chatId: string, providerName: string, model?: string): void {
    this.stmtSet.run(chatId, providerName, model ?? null, Date.now());
  }

  delete(chatId: string): void {
    this.stmtDelete.run(chatId);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
