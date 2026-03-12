/**
 * Tests for TierRouter
 *
 * Requirements: AGENT-03, AGENT-04
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TierRouter } from "./tier-router.js";
import type { ModelTier } from "./delegation-types.js";

const TEST_TIER_MAP: Record<ModelTier, string> = {
  local: "ollama:llama3.3",
  cheap: "deepseek:deepseek-chat",
  standard: "claude:claude-sonnet-4-20250514",
  premium: "claude:claude-opus-4-20250514",
};

describe("TierRouter", () => {
  let router: TierRouter;

  beforeEach(() => {
    router = new TierRouter(TEST_TIER_MAP);
  });

  describe("resolveProviderSpec", () => {
    it("resolves local tier", () => {
      expect(router.resolveProviderSpec("local")).toBe("ollama:llama3.3");
    });

    it("resolves cheap tier", () => {
      expect(router.resolveProviderSpec("cheap")).toBe("deepseek:deepseek-chat");
    });

    it("resolves standard tier", () => {
      expect(router.resolveProviderSpec("standard")).toBe("claude:claude-sonnet-4-20250514");
    });

    it("resolves premium tier", () => {
      expect(router.resolveProviderSpec("premium")).toBe("claude:claude-opus-4-20250514");
    });
  });

  describe("resolveProviderConfig", () => {
    it("parses provider:model from spec string", () => {
      const config = router.resolveProviderConfig("cheap");
      expect(config).toEqual({ name: "deepseek", model: "deepseek-chat" });
    });

    it("parses claude provider config", () => {
      const config = router.resolveProviderConfig("premium");
      expect(config).toEqual({ name: "claude", model: "claude-opus-4-20250514" });
    });

    it("parses ollama provider config", () => {
      const config = router.resolveProviderConfig("local");
      expect(config).toEqual({ name: "ollama", model: "llama3.3" });
    });
  });

  describe("getEscalationTier", () => {
    it("cheap escalates to standard", () => {
      expect(router.getEscalationTier("cheap")).toBe("standard");
    });

    it("standard escalates to premium", () => {
      expect(router.getEscalationTier("standard")).toBe("premium");
    });

    it("premium returns null (no further escalation)", () => {
      expect(router.getEscalationTier("premium")).toBeNull();
    });

    it("local returns null (excluded from escalation)", () => {
      expect(router.getEscalationTier("local")).toBeNull();
    });
  });

  describe("runtime overrides (in-memory)", () => {
    it("setOverride causes resolveProviderSpec to return overridden tier spec", () => {
      router.setOverride("cheap", "standard");
      expect(router.resolveProviderSpec("cheap")).toBe("claude:claude-sonnet-4-20250514");
    });

    it("getOverride returns the override", () => {
      router.setOverride("cheap", "standard");
      expect(router.getOverride("cheap")).toBe("standard");
    });

    it("getOverride returns undefined when no override", () => {
      expect(router.getOverride("analysis")).toBeUndefined();
    });

    it("clearOverride removes the override", () => {
      router.setOverride("cheap", "premium");
      router.clearOverride("cheap");
      expect(router.getOverride("cheap")).toBeUndefined();
      expect(router.resolveProviderSpec("cheap")).toBe("deepseek:deepseek-chat");
    });

    it("getTypeEffectiveTier returns override when set", () => {
      router.setOverride("code_review", "premium");
      expect(router.getTypeEffectiveTier("code_review", "cheap")).toBe("premium");
    });

    it("getTypeEffectiveTier returns defaultTier when no override", () => {
      expect(router.getTypeEffectiveTier("code_review", "cheap")).toBe("cheap");
    });
  });

  describe("SQLite-persisted overrides", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec(`CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    });

    afterEach(() => {
      db.close();
    });

    it("persists overrides to SQLite", () => {
      const dbRouter = new TierRouter(TEST_TIER_MAP, db);
      dbRouter.setOverride("code_review", "premium");

      const row = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(
        "delegation_tier_override:code_review",
      ) as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe("premium");
    });

    it("loads overrides from SQLite on construction", () => {
      db.prepare("INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)").run(
        "delegation_tier_override:analysis",
        "premium",
        Date.now(),
      );

      const dbRouter = new TierRouter(TEST_TIER_MAP, db);
      expect(dbRouter.getOverride("analysis")).toBe("premium");
    });

    it("clearOverride removes from SQLite", () => {
      const dbRouter = new TierRouter(TEST_TIER_MAP, db);
      dbRouter.setOverride("docs", "standard");
      dbRouter.clearOverride("docs");

      const row = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(
        "delegation_tier_override:docs",
      ) as { value: string } | undefined;
      expect(row).toBeUndefined();
    });
  });
});
