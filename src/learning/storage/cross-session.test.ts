/**
 * Cross-Session Learning Transfer Tests
 *
 * Tests for Phase 13 Plan 01: types, config, migration runner, and schema migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateConfig, resetConfigCache } from "../../config/config.js";
import type { Instinct } from "../types.js";

// =============================================================================
// Task 1: Types, Config, and Event Bus contracts
// =============================================================================

describe("CrossSessionConfig", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("should parse defaults correctly", () => {
    const result = validateConfig({
      anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
      unityProjectPath: process.cwd(),
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;

    const config = result.value;
    expect(config.crossSession).toBeDefined();
    expect(config.crossSession.enabled).toBe(true);
    expect(config.crossSession.maxAgeDays).toBe(90);
    expect(config.crossSession.scopeFilter).toBe("project+universal");
    expect(config.crossSession.recencyBoost).toBe(1.0);
    expect(config.crossSession.scopeBoost).toBe(1.1);
    expect(config.crossSession.promotionThreshold).toBe(3);
  });

  it("should accept STRATA_INSTINCT_MAX_AGE_DAYS env var override", () => {
    const result = validateConfig({
      anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
      unityProjectPath: process.cwd(),
      crossSessionMaxAgeDays: "60",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;

    expect(result.value.crossSession.maxAgeDays).toBe(60);
  });

  it("should accept STRATA_INSTINCT_SCOPE_FILTER values", () => {
    for (const filter of ["project-only", "project+universal", "all"] as const) {
      resetConfigCache();
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
        unityProjectPath: process.cwd(),
        crossSessionScopeFilter: filter,
      });
      expect(result.kind).toBe("valid");
      if (result.kind !== "valid") continue;
      expect(result.value.crossSession.scopeFilter).toBe(filter);
    }
  });
});

describe("Instinct provenance fields", () => {
  it("should include originSessionId, originBootCount, crossSessionHitCount, migratedAt", () => {
    // Type-level verification: create an Instinct with provenance fields
    const instinct: Instinct = {
      id: "instinct_test_001" as Instinct["id"],
      name: "Test instinct",
      type: "error_fix",
      status: "active",
      confidence: 0.8 as any,
      triggerPattern: "test pattern",
      action: "test action",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0 as any,
        averageExecutionMs: 0,
      },
      createdAt: Date.now() as any,
      updatedAt: Date.now() as any,
      sourceTrajectoryIds: [],
      tags: [],
      originSessionId: "session_abc",
      originBootCount: 5,
      crossSessionHitCount: 3,
      migratedAt: Date.now() as any,
    };

    expect(instinct.originSessionId).toBe("session_abc");
    expect(instinct.originBootCount).toBe(5);
    expect(instinct.crossSessionHitCount).toBe(3);
    expect(instinct.migratedAt).toBeDefined();
  });
});

describe("LearningEventMap cross-session events", () => {
  it("should include instinct:scope_promoted, instinct:merged, instinct:age_expired", async () => {
    const { TypedEventBus } = await import("../../core/event-bus.js");
    const bus = new TypedEventBus();

    // Verify these event names are accepted by the typed bus
    const events: string[] = [];

    bus.on("instinct:scope_promoted", (payload) => {
      events.push("scope_promoted");
      expect(payload.instinct).toBeDefined();
      expect(payload.projectPath).toBeDefined();
      expect(payload.promotedToUniversal).toBeDefined();
      expect(payload.distinctProjectCount).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    bus.on("instinct:merged", (payload) => {
      events.push("merged");
      expect(payload.winner).toBeDefined();
      expect(payload.loserId).toBeDefined();
      expect(payload.reason).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    bus.on("instinct:age_expired", (payload) => {
      events.push("age_expired");
      expect(payload.instinctId).toBeDefined();
      expect(payload.ageDays).toBeDefined();
      expect(payload.maxAgeDays).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    // Emit test events
    bus.emit("instinct:scope_promoted", {
      instinct: { id: "instinct_test" } as any,
      projectPath: "/test/project",
      promotedToUniversal: true,
      distinctProjectCount: 3,
      timestamp: Date.now(),
    });

    bus.emit("instinct:merged", {
      winner: { id: "instinct_winner" } as any,
      loserId: "instinct_loser" as any,
      reason: "duplicate pattern",
      timestamp: Date.now(),
    });

    bus.emit("instinct:age_expired", {
      instinctId: "instinct_old" as any,
      ageDays: 100,
      maxAgeDays: 90,
      timestamp: Date.now(),
    });

    await bus.shutdown();

    expect(events).toContain("scope_promoted");
    expect(events).toContain("merged");
    expect(events).toContain("age_expired");
  });
});
