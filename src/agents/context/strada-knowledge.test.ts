import { describe, it, expect } from "vitest";
import {
  buildCapabilityManifest,
  buildDepsContext,
  buildIdentitySection,
  buildCrashNotificationSection,
  buildProjectContext,
  buildProjectWorldMemorySection,
} from "./strada-knowledge.js";
import type { CrashRecoveryContext } from "../../identity/crash-recovery.js";
import { makeIdentityState, makeGoalTree } from "../../test-helpers.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { StradaProjectAnalysis } from "../../intelligence/strada-analyzer.js";

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

  it("contains a completion contract", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/completion contract/i);
    expect(result).toMatch(/do not declare success/i);
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

describe("buildIdentitySection", () => {
  it("returns expected format with all fields", () => {
    const state = makeIdentityState();
    const result = buildIdentitySection(state);

    expect(result).toContain("## Agent Identity");
    expect(result).toContain("**Name:** Strada Brain");
    expect(result).toContain("**Boot #:** 5");
    expect(result).toContain("**Uptime (total):**");
    expect(result).toContain("**Created:** 2024-03-08");
    expect(result).toContain("**Project:** /projects/MyGame");
    expect(result).toContain("5 sessions");
  });

  it("omits Project line when projectContext is empty string", () => {
    const state = makeIdentityState({ projectContext: "" });
    const result = buildIdentitySection(state);

    expect(result).not.toContain("**Project:**");
  });

  it("formats 0ms uptime as 'less than a minute'", () => {
    const state = makeIdentityState({ cumulativeUptimeMs: 0 });
    const result = buildIdentitySection(state);

    expect(result).toContain("less than a minute");
  });

  it("formats 3600000ms uptime as '1 hour 0 minutes'", () => {
    const state = makeIdentityState({ cumulativeUptimeMs: 3600000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 0 minutes");
  });

  it("formats 5580000ms uptime as '1 hour 33 minutes'", () => {
    const state = makeIdentityState({ cumulativeUptimeMs: 5580000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 33 minutes");
  });
});

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
      interruptedTrees: [makeGoalTree("Build player"), makeGoalTree("Setup inventory")],
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
      interruptedTrees: [makeGoalTree("Build player")],
    });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("1 goal tree(s)");
    expect(result).toContain("resume or discard");
  });

  it("with 3 trees includes multi-tree guidance", () => {
    const ctx = makeCrashContext({
      interruptedTrees: [
        makeGoalTree("Build player"),
        makeGoalTree("Setup inventory"),
        makeGoalTree("Create UI"),
      ],
    });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("3 goal tree(s)");
    expect(result).toContain("resume or discard");
  });
});

describe("buildProjectContext", () => {
  it("anchors exact file facts to the active project root", () => {
    const result = buildProjectContext("/projects/MyGame");

    expect(result).toContain("Project path: /projects/MyGame");
    expect(result).toContain("verify by reading/searching the file");
    expect(result).toContain("does not exist");
    expect(result).toContain("multiple files could match");
  });
});

describe("buildProjectWorldMemorySection", () => {
  it("combines project root and cached analysis into a single world-memory section", () => {
    const analysis: StradaProjectAnalysis = {
      modules: [{
        name: "Combat",
        className: "CombatModuleConfig",
        filePath: "Assets/Modules/Combat/CombatModuleConfig.cs",
        namespace: "Game.Combat",
        systems: [],
        services: [],
        dependencies: [],
        lineNumber: 1,
      }],
      systems: [],
      components: [],
      services: [],
      mediators: [],
      controllers: [],
      events: [],
      dependencies: [],
      asmdefs: [],
      prefabs: [],
      scenes: [],
      csFileCount: 12,
      analyzedAt: new Date("2026-03-19T00:00:00.000Z"),
    };

    const result = buildProjectWorldMemorySection({
      projectPath: "/projects/MyGame",
      analysis,
    });

    expect(result.content).toContain("## Project/World Memory");
    expect(result.content).toContain("Active project root: /projects/MyGame");
    expect(result.content).toContain("## Cached Project Analysis");
    expect(result.content).toContain("Combat");
    expect(result.contentHashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildDepsContext", () => {
  function makeDepsStatus(overrides?: Partial<StradaDepsStatus>): StradaDepsStatus {
    return {
      coreInstalled: true,
      corePath: "/packages/strada.core",
      modulesInstalled: true,
      modulesPath: "/packages/strada.modules",
      mcpInstalled: true,
      mcpPath: "/tools/Strada.MCP",
      mcpVersion: "1.2.3",
      warnings: [],
      ...overrides,
    };
  }

  it("treats Strada.MCP as a first-class authoritative source", () => {
    const result = buildDepsContext(makeDepsStatus());

    expect(result).toContain("Framework Source Authority");
    expect(result).toContain("Strada.MCP");
    expect(result).toContain("first-class part of the Strada toolchain");
    expect(result).toContain("/tools/Strada.MCP/src/tools");
  });

  it("does not mention Strada.MCP authority when it is not installed", () => {
    const result = buildDepsContext(makeDepsStatus({
      mcpInstalled: false,
      mcpPath: null,
      mcpVersion: null,
    }));

    expect(result).toContain("strada.mcp: NOT INSTALLED");
    expect(result).not.toContain("first-class part of the Strada toolchain");
  });
});
