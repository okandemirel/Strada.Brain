import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { UserProfileStore, resolveAutonomousModeWithDefault } from "./user-profile-store.js";
import type { UserProfile } from "./user-profile-store.js";

describe("UserProfileStore", () => {
  let db: Database.Database;
  let store: UserProfileStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new UserProfileStore(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // getProfile
  // -------------------------------------------------------------------------

  describe("getProfile", () => {
    it("returns null for unknown chatId", () => {
      const result = store.getProfile("unknown-chat-id");
      expect(result).toBeNull();
    });

    it("returns full profile after upsert", () => {
      store.upsertProfile("chat-1", { displayName: "Alice" });
      const profile = store.getProfile("chat-1");

      expect(profile).not.toBeNull();
      expect(profile!.chatId).toBe("chat-1");
      expect(profile!.displayName).toBe("Alice");
      expect(profile!.language).toBe("en");
      expect(profile!.activePersona).toBe("default");
    });
  });

  // -------------------------------------------------------------------------
  // upsertProfile
  // -------------------------------------------------------------------------

  describe("upsertProfile", () => {
    it("creates new profile with defaults", () => {
      const profile = store.upsertProfile("chat-1", {});

      expect(profile.chatId).toBe("chat-1");
      expect(profile.language).toBe("en");
      expect(profile.activePersona).toBe("default");
      expect(profile.preferences).toEqual({});
      expect(profile.lastTopics).toEqual([]);
      expect(profile.firstSeenAt).toBeGreaterThan(0);
      expect(profile.lastSeenAt).toBeGreaterThan(0);
      expect(profile.displayName).toBeUndefined();
      expect(profile.timezone).toBeUndefined();
      expect(profile.contextSummary).toBeUndefined();
    });

    it("creates new profile with provided values", () => {
      const profile = store.upsertProfile("chat-2", {
        displayName: "Bob",
        language: "tr",
        timezone: "Europe/Istanbul",
        activePersona: "casual",
        preferences: { theme: "dark" },
      });

      expect(profile.chatId).toBe("chat-2");
      expect(profile.displayName).toBe("Bob");
      expect(profile.language).toBe("tr");
      expect(profile.timezone).toBe("Europe/Istanbul");
      expect(profile.activePersona).toBe("casual");
      expect(profile.preferences).toEqual({ theme: "dark" });
    });

    it("updates existing profile without overwriting unrelated fields (COALESCE)", () => {
      // First upsert: create with displayName and language
      store.upsertProfile("chat-3", {
        displayName: "Charlie",
        language: "de",
        timezone: "Europe/Berlin",
        activePersona: "formal",
      });

      // Second upsert: only update language, leave other fields intact
      const updated = store.upsertProfile("chat-3", {
        language: "fr",
      });

      expect(updated.chatId).toBe("chat-3");
      expect(updated.language).toBe("fr"); // updated
      expect(updated.displayName).toBe("Charlie"); // preserved
      expect(updated.timezone).toBe("Europe/Berlin"); // preserved
      expect(updated.activePersona).toBe("formal"); // preserved
    });

    it("preserves firstSeenAt on update but refreshes lastSeenAt", () => {
      const created = store.upsertProfile("chat-4", { displayName: "Dave" });
      const firstSeenOriginal = created.firstSeenAt;

      // Small delay to ensure timestamp differs
      const updated = store.upsertProfile("chat-4", { displayName: "David" });

      expect(updated.firstSeenAt).toBe(firstSeenOriginal);
      expect(updated.lastSeenAt).toBeGreaterThanOrEqual(firstSeenOriginal);
    });
  });

  // -------------------------------------------------------------------------
  // setActivePersona
  // -------------------------------------------------------------------------

  describe("setActivePersona", () => {
    it("persists persona and is retrievable", () => {
      store.upsertProfile("chat-5", {});
      store.setActivePersona("chat-5", "casual");

      const profile = store.getProfile("chat-5");
      expect(profile).not.toBeNull();
      expect(profile!.activePersona).toBe("casual");
    });

    it("auto-creates profile if not exists", () => {
      store.setActivePersona("new-chat", "minimal");

      const profile = store.getProfile("new-chat");
      expect(profile).not.toBeNull();
      expect(profile!.activePersona).toBe("minimal");
      expect(profile!.language).toBe("en"); // default
    });
  });

  // -------------------------------------------------------------------------
  // updateContextSummary
  // -------------------------------------------------------------------------

  describe("updateContextSummary", () => {
    it("stores summary string and topics array", () => {
      store.upsertProfile("chat-6", {});
      store.updateContextSummary("chat-6", "Discussed Unity shaders", [
        "shaders",
        "unity",
        "rendering",
      ]);

      const profile = store.getProfile("chat-6");
      expect(profile).not.toBeNull();
      expect(profile!.contextSummary).toBe("Discussed Unity shaders");
      expect(profile!.lastTopics).toEqual(["shaders", "unity", "rendering"]);
    });

    it("auto-creates profile if not exists", () => {
      store.updateContextSummary("new-chat-2", "First session", ["intro"]);

      const profile = store.getProfile("new-chat-2");
      expect(profile).not.toBeNull();
      expect(profile!.contextSummary).toBe("First session");
      expect(profile!.lastTopics).toEqual(["intro"]);
    });

    it("overwrites previous summary and topics", () => {
      store.upsertProfile("chat-7", {});
      store.updateContextSummary("chat-7", "Session 1", ["topic1"]);
      store.updateContextSummary("chat-7", "Session 2", ["topic2", "topic3"]);

      const profile = store.getProfile("chat-7");
      expect(profile!.contextSummary).toBe("Session 2");
      expect(profile!.lastTopics).toEqual(["topic2", "topic3"]);
    });
  });

  // -------------------------------------------------------------------------
  // touchLastSeen
  // -------------------------------------------------------------------------

  describe("touchLastSeen", () => {
    it("updates lastSeenAt timestamp", () => {
      const created = store.upsertProfile("chat-8", {});
      const originalLastSeen = created.lastSeenAt;

      store.touchLastSeen("chat-8");

      const profile = store.getProfile("chat-8");
      expect(profile).not.toBeNull();
      expect(profile!.lastSeenAt).toBeGreaterThanOrEqual(originalLastSeen);
    });

    it("auto-creates profile if not exists", () => {
      store.touchLastSeen("new-chat-3");

      const profile = store.getProfile("new-chat-3");
      expect(profile).not.toBeNull();
      expect(profile!.language).toBe("en");
      expect(profile!.activePersona).toBe("default");
    });
  });

  describe("resolveAutonomousModeWithDefault", () => {
    it("hydrates autonomous mode for a new identity when defaults are enabled", async () => {
      const baseNow = Date.now() + 60_000;
      const result = await resolveAutonomousModeWithDefault(store, "new-auto-chat", {
        enabled: true,
        hours: 12,
        now: baseNow,
      });

      expect(result.enabled).toBe(true);
      expect(result.expiresAt).toBe(baseNow + 12 * 3600_000);
      expect(store.getProfile("new-auto-chat")?.preferences.autonomousMode).toBe(true);
    });

    it("does not override an explicit disabled autonomy preference", async () => {
      await store.setAutonomousMode("chat-explicit-off", false);

      const result = await resolveAutonomousModeWithDefault(store, "chat-explicit-off", {
        enabled: true,
        hours: 24,
        now: Date.now() + 60_000,
      });

      expect(result).toEqual({ enabled: false });
      expect(store.getProfile("chat-explicit-off")?.preferences.autonomousMode).toBe(false);
    });

    it("preserves an explicit enabled autonomy preference and expiry", async () => {
      const expiresAt = Date.now() + 6 * 3600_000;
      await store.setAutonomousMode("chat-explicit-on", true, expiresAt);

      const result = await resolveAutonomousModeWithDefault(store, "chat-explicit-on", {
        enabled: true,
        hours: 48,
        now: Date.now() + 60_000,
      });

      expect(result.enabled).toBe(true);
      expect(result.expiresAt).toBe(expiresAt);
    });
  });

  // -------------------------------------------------------------------------
  // JSON round-trips
  // -------------------------------------------------------------------------

  describe("JSON preferences round-trip", () => {
    it("stores and retrieves complex preferences object", () => {
      const prefs = {
        theme: "dark",
        fontSize: 14,
        notifications: { email: true, push: false },
        tags: ["unity", "c#"],
        nested: { deep: { value: 42 } },
      };

      store.upsertProfile("chat-9", { preferences: prefs });

      const profile = store.getProfile("chat-9");
      expect(profile).not.toBeNull();
      expect(profile!.preferences).toEqual(prefs);
    });

    it("handles empty preferences object", () => {
      store.upsertProfile("chat-10", { preferences: {} });

      const profile = store.getProfile("chat-10");
      expect(profile!.preferences).toEqual({});
    });

    it("handles empty topics array", () => {
      store.upsertProfile("chat-11", {});
      store.updateContextSummary("chat-11", "No topics", []);

      const profile = store.getProfile("chat-11");
      expect(profile!.lastTopics).toEqual([]);
    });
  });
});
