import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ProviderPreferenceStore } from "./provider-preferences.js";

const tempDirs: string[] = [];

function createDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "strada-provider-pref-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ProviderPreferenceStore", () => {
  it("persists selection mode together with provider/model", () => {
    const dbPath = createDbPath("provider-preferences.db");
    const store = new ProviderPreferenceStore(dbPath);
    store.initialize();

    store.set("chat-1", "kimi", "kimi-max", "strada-hard-pin");

    expect(store.get("chat-1")).toEqual({
      chatId: "chat-1",
      providerName: "kimi",
      model: "kimi-max",
      selectionMode: "strada-hard-pin",
      updatedAt: expect.any(Number),
    });
    store.close();
  });

  it("migrates legacy rows to bias mode by default", () => {
    const dbPath = createDbPath("provider-preferences.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE provider_preferences (
        chat_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        model TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO provider_preferences (chat_id, provider_name, model, updated_at) VALUES (?, ?, ?, ?)",
    ).run("chat-legacy", "openai", "gpt-5.2", 123);
    db.close();

    const store = new ProviderPreferenceStore(dbPath);
    store.initialize();

    expect(store.get("chat-legacy")).toEqual({
      chatId: "chat-legacy",
      providerName: "openai",
      model: "gpt-5.2",
      selectionMode: "strada-preference-bias",
      updatedAt: 123,
    });
    store.close();
  });
});
