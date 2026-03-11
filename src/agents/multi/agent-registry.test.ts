/**
 * Tests for AgentRegistry -- SQLite-backed agent state persistence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AgentRegistry } from "./agent-registry.js";
import { createAgentId, resolveAgentKey } from "./agent-types.js";
import type { AgentId, AgentInstance } from "./agent-types.js";

function makeAgent(overrides: Partial<AgentInstance> = {}): AgentInstance {
  const id = overrides.id ?? createAgentId();
  const channelType = overrides.channelType ?? "web";
  const chatId = overrides.chatId ?? "chat-1";
  return {
    id,
    key: overrides.key ?? resolveAgentKey(channelType, chatId),
    channelType,
    chatId,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? Date.now(),
    lastActivity: overrides.lastActivity ?? Date.now(),
    budgetCapUsd: overrides.budgetCapUsd ?? 5.0,
    memoryEntryCount: overrides.memoryEntryCount ?? 0,
  };
}

describe("AgentRegistry", () => {
  let db: Database.Database;
  let registry: AgentRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    registry = new AgentRegistry(db);
    registry.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // =========================================================================
  // upsert / getByKey / getById
  // =========================================================================

  describe("upsert + get", () => {
    it("inserts and retrieves by key", () => {
      const agent = makeAgent();
      registry.upsert(agent);
      const found = registry.getByKey(agent.key);
      expect(found).toBeDefined();
      expect(found!.id).toBe(agent.id);
      expect(found!.key).toBe(agent.key);
      expect(found!.channelType).toBe("web");
      expect(found!.chatId).toBe("chat-1");
      expect(found!.status).toBe("active");
      expect(found!.budgetCapUsd).toBe(5.0);
      expect(found!.memoryEntryCount).toBe(0);
    });

    it("inserts and retrieves by id", () => {
      const agent = makeAgent();
      registry.upsert(agent);
      const found = registry.getById(agent.id);
      expect(found).toBeDefined();
      expect(found!.key).toBe(agent.key);
    });

    it("returns undefined for non-existent key", () => {
      expect(registry.getByKey("nonexistent")).toBeUndefined();
    });

    it("returns undefined for non-existent id", () => {
      expect(registry.getById("no-such-id" as AgentId)).toBeUndefined();
    });
  });

  // =========================================================================
  // upsert conflict (same key updates)
  // =========================================================================

  describe("upsert conflict on key", () => {
    it("updates existing agent when key matches (status, lastActivity, budgetCap, memoryCount)", () => {
      const agent = makeAgent({ status: "active", budgetCapUsd: 5.0, memoryEntryCount: 0 });
      registry.upsert(agent);

      const updated = makeAgent({
        id: createAgentId(), // different id
        key: agent.key,      // same key
        channelType: agent.channelType,
        chatId: agent.chatId,
        status: "stopped",
        budgetCapUsd: 10.0,
        memoryEntryCount: 42,
        lastActivity: Date.now() + 1000,
      });
      registry.upsert(updated);

      // Should still be 1 record
      expect(registry.count()).toBe(1);

      const found = registry.getByKey(agent.key)!;
      expect(found.status).toBe("stopped");
      expect(found.budgetCapUsd).toBe(10.0);
      expect(found.memoryEntryCount).toBe(42);
      // id stays as original (ON CONFLICT doesn't update id)
      expect(found.id).toBe(agent.id);
    });
  });

  // =========================================================================
  // getAll
  // =========================================================================

  describe("getAll", () => {
    it("returns all agents ordered by createdAt", () => {
      const a1 = makeAgent({ chatId: "chat-1", createdAt: 100 });
      const a2 = makeAgent({ chatId: "chat-2", createdAt: 200 });
      const a3 = makeAgent({ chatId: "chat-3", createdAt: 150 });
      registry.upsert(a1);
      registry.upsert(a2);
      registry.upsert(a3);

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].createdAt).toBe(100);
      expect(all[1].createdAt).toBe(150);
      expect(all[2].createdAt).toBe(200);
    });

    it("returns empty array when no agents", () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  // =========================================================================
  // updateStatus
  // =========================================================================

  describe("updateStatus", () => {
    it("updates status field", () => {
      const agent = makeAgent();
      registry.upsert(agent);

      registry.updateStatus(agent.id, "budget_exceeded");

      const found = registry.getById(agent.id)!;
      expect(found.status).toBe("budget_exceeded");
    });
  });

  // =========================================================================
  // updateLastActivity
  // =========================================================================

  describe("updateLastActivity", () => {
    it("updates lastActivity timestamp", () => {
      const agent = makeAgent({ lastActivity: 1000 });
      registry.upsert(agent);

      registry.updateLastActivity(agent.id, 9999);

      const found = registry.getById(agent.id)!;
      expect(found.lastActivity).toBe(9999);
    });
  });

  // =========================================================================
  // updateMemoryCount
  // =========================================================================

  describe("updateMemoryCount", () => {
    it("updates memoryEntryCount", () => {
      const agent = makeAgent({ memoryEntryCount: 0 });
      registry.upsert(agent);

      registry.updateMemoryCount(agent.id, 250);

      const found = registry.getById(agent.id)!;
      expect(found.memoryEntryCount).toBe(250);
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  describe("delete", () => {
    it("removes agent record", () => {
      const agent = makeAgent();
      registry.upsert(agent);
      expect(registry.count()).toBe(1);

      registry.delete(agent.id);

      expect(registry.count()).toBe(0);
      expect(registry.getById(agent.id)).toBeUndefined();
    });

    it("silently ignores delete of non-existent id", () => {
      // Should not throw
      registry.delete("nonexistent" as AgentId);
      expect(registry.count()).toBe(0);
    });
  });

  // =========================================================================
  // count
  // =========================================================================

  describe("count", () => {
    it("returns correct count", () => {
      expect(registry.count()).toBe(0);

      registry.upsert(makeAgent({ chatId: "c1" }));
      expect(registry.count()).toBe(1);

      registry.upsert(makeAgent({ chatId: "c2" }));
      expect(registry.count()).toBe(2);
    });
  });
});
