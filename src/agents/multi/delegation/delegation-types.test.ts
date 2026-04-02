/**
 * Tests for delegation type system and config integration
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DELEGATION_TYPES,
  ESCALATION_CHAIN,
} from "./delegation-types.js";
import type {
  ModelTier,
  DelegationTypeConfig,
  DelegationConfig,
  DelegationResult,
  DelegationMode,
  DelegationStatus,
  DelegationRequest,
  DelegationStartedEvent,
  DelegationCompletedEvent,
  DelegationFailedEvent,
} from "./delegation-types.js";
import { createAgentId } from "../agent-types.js";

describe("delegation-types", () => {
  describe("ModelTier type", () => {
    it("accepts only valid tier values", () => {
      const tiers: ModelTier[] = ["local", "cheap", "standard", "premium"];
      expect(tiers).toHaveLength(4);
    });
  });

  describe("DEFAULT_DELEGATION_TYPES", () => {
    it("contains 4 built-in types", () => {
      expect(DEFAULT_DELEGATION_TYPES).toHaveLength(4);
    });

    it("has code_review with tier cheap", () => {
      const cr = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "code_review");
      expect(cr).toBeDefined();
      expect(cr!.tier).toBe("cheap");
      expect(cr!.timeoutMs).toBe(60000);
      expect(cr!.maxIterations).toBe(10);
    });

    it("has documentation with tier cheap", () => {
      const doc = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "documentation");
      expect(doc).toBeDefined();
      expect(doc!.tier).toBe("cheap");
      expect(doc!.timeoutMs).toBe(45000);
      expect(doc!.maxIterations).toBe(8);
    });

    it("has analysis with tier standard", () => {
      const an = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "analysis");
      expect(an).toBeDefined();
      expect(an!.tier).toBe("standard");
      expect(an!.timeoutMs).toBe(180_000);
      expect(an!.maxIterations).toBe(15);
    });

    it("analysis delegation type has at least 180s timeout", () => {
      const analysisType = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "analysis");
      expect(analysisType).toBeDefined();
      expect(analysisType!.timeoutMs).toBeGreaterThanOrEqual(180_000);
    });

    it("has implementation with tier standard", () => {
      const impl = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "implementation");
      expect(impl).toBeDefined();
      expect(impl!.tier).toBe("standard");
      expect(impl!.timeoutMs).toBe(120000);
      expect(impl!.maxIterations).toBe(20);
    });
  });

  describe("ESCALATION_CHAIN", () => {
    it("has correct order: cheap -> standard -> premium", () => {
      expect(ESCALATION_CHAIN).toEqual(["cheap", "standard", "premium"]);
    });

    it("excludes local tier", () => {
      expect(ESCALATION_CHAIN).not.toContain("local");
    });
  });

  describe("DelegationTypeConfig interface", () => {
    it("has required fields: name, tier, timeoutMs, maxIterations", () => {
      const config: DelegationTypeConfig = {
        name: "test_type",
        tier: "cheap",
        timeoutMs: 30000,
        maxIterations: 5,
      };
      expect(config.name).toBe("test_type");
      expect(config.tier).toBe("cheap");
      expect(config.timeoutMs).toBe(30000);
      expect(config.maxIterations).toBe(5);
    });

    it("accepts optional systemPrompt", () => {
      const config: DelegationTypeConfig = {
        name: "custom",
        tier: "standard",
        timeoutMs: 60000,
        maxIterations: 10,
        systemPrompt: "You are a code reviewer",
      };
      expect(config.systemPrompt).toBe("You are a code reviewer");
    });
  });

  describe("DelegationConfig interface", () => {
    it("has required fields: enabled, maxDepth, maxConcurrentPerParent, tiers, types, verbosity", () => {
      const config: DelegationConfig = {
        enabled: true,
        maxDepth: 2,
        maxConcurrentPerParent: 3,
        tiers: {
          local: "ollama:llama3.3",
          cheap: "deepseek:deepseek-chat",
          standard: "claude:claude-sonnet-4-6-20250514",
          premium: "claude:claude-opus-4-6-20250514",
        },
        types: DEFAULT_DELEGATION_TYPES,
        verbosity: "normal",
      };
      expect(config.enabled).toBe(true);
      expect(config.maxDepth).toBe(2);
      expect(config.maxConcurrentPerParent).toBe(3);
      expect(Object.keys(config.tiers)).toHaveLength(4);
      expect(config.types).toHaveLength(4);
      expect(config.verbosity).toBe("normal");
    });
  });

  describe("DelegationResult interface", () => {
    it("has content and metadata with model/tier/cost/duration/toolsUsed", () => {
      const result: DelegationResult = {
        content: "Review complete",
        metadata: {
          model: "deepseek-chat",
          tier: "cheap",
          costUsd: 0.003,
          durationMs: 5000,
          toolsUsed: ["read_file", "search"],
          escalated: false,
        },
      };
      expect(result.content).toBe("Review complete");
      expect(result.metadata.model).toBe("deepseek-chat");
      expect(result.metadata.tier).toBe("cheap");
      expect(result.metadata.costUsd).toBe(0.003);
      expect(result.metadata.durationMs).toBe(5000);
      expect(result.metadata.toolsUsed).toEqual(["read_file", "search"]);
      expect(result.metadata.escalated).toBe(false);
    });

    it("supports escalation metadata", () => {
      const result: DelegationResult = {
        content: "Analysis done",
        metadata: {
          model: "claude-sonnet-4-6-20250514",
          tier: "standard",
          costUsd: 0.05,
          durationMs: 15000,
          toolsUsed: [],
          escalated: true,
          escalatedFrom: "cheap",
        },
      };
      expect(result.metadata.escalated).toBe(true);
      expect(result.metadata.escalatedFrom).toBe("cheap");
    });
  });

  describe("DelegationMode type", () => {
    it("accepts sync and async", () => {
      const modes: DelegationMode[] = ["sync", "async"];
      expect(modes).toHaveLength(2);
    });
  });

  describe("DelegationStatus type", () => {
    it("accepts all 5 statuses", () => {
      const statuses: DelegationStatus[] = [
        "running",
        "completed",
        "failed",
        "timeout",
        "cancelled",
      ];
      expect(statuses).toHaveLength(5);
    });
  });

  describe("DelegationRequest interface", () => {
    it("has all required fields", () => {
      const request: DelegationRequest = {
        type: "code_review",
        task: "Review auth module",
        parentAgentId: createAgentId(),
        depth: 0,
        mode: "sync",
        toolContext: {
          projectPath: "/test",
          workingDirectory: "/test",
          readOnly: false,
        },
      };
      expect(request.type).toBe("code_review");
      expect(request.task).toBe("Review auth module");
      expect(request.depth).toBe(0);
      expect(request.mode).toBe("sync");
    });

    it("accepts optional context string", () => {
      const request: DelegationRequest = {
        type: "analysis",
        task: "Analyze performance",
        context: "Focus on memory usage",
        parentAgentId: createAgentId(),
        depth: 1,
        mode: "async",
        toolContext: {
          projectPath: "/test",
          workingDirectory: "/test",
          readOnly: true,
        },
      };
      expect(request.context).toBe("Focus on memory usage");
    });
  });

  describe("Event payload types", () => {
    it("DelegationStartedEvent has required fields", () => {
      const event: DelegationStartedEvent = {
        parentAgentId: createAgentId(),
        subAgentId: "sub-1",
        type: "code_review",
        tier: "cheap",
        model: "deepseek-chat",
        depth: 0,
        mode: "sync",
        timestamp: Date.now(),
      };
      expect(event.parentAgentId).toBeDefined();
      expect(event.subAgentId).toBe("sub-1");
      expect(event.type).toBe("code_review");
      expect(event.tier).toBe("cheap");
    });

    it("DelegationCompletedEvent has required fields", () => {
      const event: DelegationCompletedEvent = {
        parentAgentId: createAgentId(),
        subAgentId: "sub-1",
        type: "code_review",
        tier: "cheap",
        model: "deepseek-chat",
        success: true,
        durationMs: 5000,
        costUsd: 0.003,
        escalated: false,
        timestamp: Date.now(),
      };
      expect(event.success).toBe(true);
      expect(event.durationMs).toBe(5000);
      expect(event.costUsd).toBe(0.003);
      expect(event.escalated).toBe(false);
    });

    it("DelegationFailedEvent has required fields", () => {
      const event: DelegationFailedEvent = {
        parentAgentId: createAgentId(),
        subAgentId: "sub-1",
        type: "code_review",
        reason: "Model timeout",
        timestamp: Date.now(),
      };
      expect(event.reason).toBe("Model timeout");
    });

    it("DelegationFailedEvent supports optional originalTier", () => {
      const event: DelegationFailedEvent = {
        parentAgentId: createAgentId(),
        subAgentId: "sub-1",
        type: "analysis",
        reason: "Budget exceeded",
        originalTier: "cheap",
        timestamp: Date.now(),
      };
      expect(event.originalTier).toBe("cheap");
    });
  });
});

describe("delegation config schema", () => {
  // We test config schema integration by importing and validating
  // through the config module
  it("validates taskDelegationEnabled defaults to false", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskDelegationEnabled).toBe(false);
    }
  });

  it("validates agentMaxDelegationDepth defaults to 2", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentMaxDelegationDepth).toBe(2);
    }
  });

  it("validates agentMaxConcurrentDelegations defaults to 3", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentMaxConcurrentDelegations).toBe(3);
    }
  });

  it("validates all 4 tier env vars with provider:model format defaults", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegationTierLocal).toBe("ollama:llama3.3");
      expect(result.data.delegationTierCheap).toBe("deepseek:deepseek-chat");
      expect(result.data.delegationTierStandard).toBe("claude:claude-sonnet-4-6-20250514");
      expect(result.data.delegationTierPremium).toBe("claude:claude-opus-4-6-20250514");
    }
  });

  it("validates delegationVerbosity defaults to normal", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegationVerbosity).toBe("normal");
    }
  });

  it("rejects invalid delegationVerbosity", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
      delegationVerbosity: "debug",
    });
    expect(result.success).toBe(false);
  });

  it("validates agentMaxDelegationDepth rejects out of range", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
      agentMaxDelegationDepth: "0",
    });
    expect(result.success).toBe(false);
  });

  it("validates delegationTypes as optional JSON string", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const customTypes = JSON.stringify([
      { name: "custom", tier: "premium", timeoutMs: 60000, maxIterations: 5 },
    ]);
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
      delegationTypes: customTypes,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegationTypes).toBe(customTypes);
    }
  });

  it("validates delegationMaxIterationsPerType defaults to 10", async () => {
    const { configSchema } = await import("../../../config/config.js");
    const result = configSchema.safeParse({
      unityProjectPath: "/tmp/test",
      anthropicApiKey: "sk-test-key-123456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegationMaxIterationsPerType).toBe(10);
    }
  });
});
