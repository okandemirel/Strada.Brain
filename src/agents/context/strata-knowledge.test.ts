import { describe, it, expect } from "vitest";
import { buildCapabilityManifest, buildIdentitySection, buildCrashNotificationSection } from "./strata-knowledge.js";
import type { IdentityState } from "../../identity/identity-state.js";
import type { CrashRecoveryContext } from "../../identity/crash-recovery.js";
import type { GoalTree } from "../../goals/types.js";
import type { GoalNodeId } from "../../goals/types.js";

describe("buildCapabilityManifest", () => {
  it("returns a non-empty string", () => {
    const result = buildCapabilityManifest();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("contains Goal Decomposition section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/goal decomposition/i);
  });

  it("contains Learning Pipeline section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/learning pipeline/i);
  });

  it("contains Tool Chain Synthesis section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/tool chain synthesis/i);
  });

  it("contains Memory section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/memory/i);
  });

  it("contains Introspection section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/introspection/i);
  });

  it("does NOT contain hardcoded tool names that change at runtime", () => {
    const result = buildCapabilityManifest();
    // These are dynamic tool names that should not be in the manifest
    expect(result).not.toMatch(/\bfile_read\b/);
    expect(result).not.toMatch(/\bgrep_search\b/);
    expect(result).not.toMatch(/\bfile_write\b/);
    expect(result).not.toMatch(/\bdotnet_build\b/);
  });

  it("has a length between 500 and 3000 characters", () => {
    const result = buildCapabilityManifest();
    expect(result.length).toBeGreaterThanOrEqual(500);
    expect(result.length).toBeLessThanOrEqual(3000);
  });
});

function makeSampleState(overrides?: Partial<IdentityState>): IdentityState {
  return {
    agentUuid: "550e8400-e29b-41d4-a716-446655440000",
    agentName: "Strata Brain",
    firstBootTs: 1709856000000, // 2024-03-08
    bootCount: 5,
    cumulativeUptimeMs: 5580000, // 1h33m
    lastActivityTs: 1709942400000,
    totalMessages: 42,
    totalTasks: 10,
    projectContext: "/projects/MyGame",
    cleanShutdown: true,
    ...overrides,
  };
}

describe("buildIdentitySection", () => {
  it("returns expected format with all fields", () => {
    const state = makeSampleState();
    const result = buildIdentitySection(state);

    expect(result).toContain("## Agent Identity");
    expect(result).toContain("**Name:** Strata Brain");
    expect(result).toContain("**Boot #:** 5");
    expect(result).toContain("**Uptime (total):**");
    expect(result).toContain("**Created:** 2024-03-08");
    expect(result).toContain("**Project:** /projects/MyGame");
    expect(result).toContain("5 sessions");
  });

  it("omits Project line when projectContext is empty string", () => {
    const state = makeSampleState({ projectContext: "" });
    const result = buildIdentitySection(state);

    expect(result).not.toContain("**Project:**");
  });

  it("formats 0ms uptime as '0 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 0 });
    const result = buildIdentitySection(state);

    expect(result).toContain("0 minutes");
  });

  it("formats 3600000ms uptime as '1 hour 0 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 3600000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 0 minutes");
  });

  it("formats 5580000ms uptime as '1 hour 33 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 5580000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 33 minutes");
  });
});

function makeSampleTree(desc: string): GoalTree {
  const rootId = "goal_test_root" as GoalNodeId;
  return {
    rootId,
    sessionId: "session-1",
    taskDescription: desc,
    nodes: new Map([
      [
        rootId,
        {
          id: rootId,
          parentId: null,
          task: desc,
          dependsOn: [] as readonly GoalNodeId[],
          depth: 0,
          status: "executing" as const,
          createdAt: Date.now() - 600000,
          updatedAt: Date.now() - 300000,
        },
      ],
    ]),
    createdAt: Date.now() - 600000,
  };
}

function makeCrashContext(overrides?: Partial<CrashRecoveryContext>): CrashRecoveryContext {
  return {
    wasCrash: true,
    downtimeMs: 300000,
    lastActivityTs: Date.now() - 300000,
    bootCount: 5,
    interruptedTrees: [],
    ...overrides,
  };
}

describe("buildCrashNotificationSection", () => {
  it("produces section with Crash Recovery Notice heading, downtime, last activity, interrupted task count", () => {
    const ctx = makeCrashContext({
      interruptedTrees: [makeSampleTree("Build player"), makeSampleTree("Setup inventory")],
    });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("## Crash Recovery Notice");
    expect(result).toContain("5 minutes");
    expect(result).toContain("Boot #:** 5");
    expect(result).toContain("2 goal tree(s)");
  });

  it("with 0 interrupted trees mentions no work was lost", () => {
    const ctx = makeCrashContext({ interruptedTrees: [] });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("no work was lost");
    expect(result).not.toContain("resume or discard");
  });

  it("with 1 tree includes single-tree guidance", () => {
    const ctx = makeCrashContext({
      interruptedTrees: [makeSampleTree("Build player")],
    });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("1 goal tree(s)");
    expect(result).toContain("resume or discard");
  });

  it("with 3 trees includes multi-tree guidance", () => {
    const ctx = makeCrashContext({
      interruptedTrees: [
        makeSampleTree("Build player"),
        makeSampleTree("Setup inventory"),
        makeSampleTree("Create UI"),
      ],
    });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("3 goal tree(s)");
    expect(result).toContain("resume or discard");
  });
});
