/**
 * Tests for multi-agent type system
 */

import { describe, it, expect } from "vitest";
import { createAgentId, resolveAgentKey } from "./agent-types.js";
import type { AgentId, AgentStatus, AgentConfig, AgentInstance, AgentLifecycleEvent, AgentBudgetEvent } from "./agent-types.js";

describe("agent-types", () => {
  describe("createAgentId", () => {
    it("returns a UUID string", () => {
      const id = createAgentId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("returns unique ids on successive calls", () => {
      const a = createAgentId();
      const b = createAgentId();
      expect(a).not.toBe(b);
    });
  });

  describe("resolveAgentKey", () => {
    it("creates channelType:chatId composite key", () => {
      expect(resolveAgentKey("web", "chat-123")).toBe("web:chat-123");
      expect(resolveAgentKey("telegram", "456")).toBe("telegram:456");
    });
  });

  describe("type contracts (compile-time verification)", () => {
    it("AgentStatus accepts all valid values", () => {
      const statuses: AgentStatus[] = ["active", "stopped", "budget_exceeded", "evicted"];
      expect(statuses).toHaveLength(4);
    });

    it("AgentConfig has all required fields", () => {
      const config: AgentConfig = {
        enabled: false,
        defaultBudgetUsd: 5.0,
        maxConcurrent: 3,
        idleTimeoutMs: 3600000,
        maxMemoryEntries: 5000,
      };
      expect(config.enabled).toBe(false);
      expect(config.defaultBudgetUsd).toBe(5.0);
      expect(config.maxConcurrent).toBe(3);
      expect(config.idleTimeoutMs).toBe(3600000);
      expect(config.maxMemoryEntries).toBe(5000);
    });

    it("AgentInstance has all required fields", () => {
      const id = createAgentId();
      const agent: AgentInstance = {
        id,
        key: "web:chat-1",
        channelType: "web",
        chatId: "chat-1",
        status: "active",
        createdAt: Date.now(),
        lastActivity: Date.now(),
        budgetCapUsd: 5.0,
        memoryEntryCount: 0,
      };
      expect(agent.id).toBe(id);
      expect(agent.key).toBe("web:chat-1");
    });

    it("AgentLifecycleEvent has required fields", () => {
      const event: AgentLifecycleEvent = {
        agentId: createAgentId(),
        key: "web:chat-1",
        channelType: "web",
        chatId: "chat-1",
        timestamp: Date.now(),
      };
      expect(event.agentId).toBeDefined();
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("AgentBudgetEvent extends lifecycle with budget fields", () => {
      const event: AgentBudgetEvent = {
        agentId: createAgentId(),
        key: "web:chat-1",
        channelType: "web",
        chatId: "chat-1",
        timestamp: Date.now(),
        usedUsd: 2.5,
        capUsd: 5.0,
        pct: 0.5,
      };
      expect(event.usedUsd).toBe(2.5);
      expect(event.capUsd).toBe(5.0);
      expect(event.pct).toBe(0.5);
    });
  });
});
