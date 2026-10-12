import { describe, it, expect } from "vitest";
import {
  renderVaultContext,
  buildVaultProjectContext,
  focusFilesFromMessage,
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
    expect(result.length).toBeLessThanOrEqual(5000);
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
    interruptedTreesMeasured: true,
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

  it("with 0 goal trees names what was counted instead of claiming no work was lost", () => {
    // Only goal trees are counted. A background task that ran without one (supervisor off, or
    // not decomposed) is failed or paused by the restart, and the notice told the model to
    // "reassure the user that no work was lost" anyway.
    const ctx = makeCrashContext({ interruptedTrees: [] });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("0 goal tree(s)");
    expect(result).toContain("goal trees only");
    expect(result).not.toContain("no work was lost");
    expect(result).not.toContain("No interrupted tasks were found");
    expect(result).not.toContain("resume or discard");
  });

  it("when goal-tree detection did not run, reports the count as unknown, not zero", () => {
    const ctx = makeCrashContext({ interruptedTrees: [], interruptedTreesMeasured: false });
    const result = buildCrashNotificationSection(ctx);

    expect(result).toContain("unknown");
    expect(result).not.toContain("0 goal tree(s)");
    expect(result).not.toContain("no work was lost");
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
    expect(result.summary).toContain("root=/projects/MyGame");
    expect(result.summary).toContain("modules=Combat");
    expect(result.fingerprint).toContain("root projects mygame");
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

  it("names the purchased library, not only the local cache, before any art is generated", () => {
    // Measured 2026-09-07: a sprint asked unity_my_assets (the local cache,
    // 4 packages), read "nothing fits" and generated, while the account held
    // 511 purchased packages behind unity_my_assets_cloud.
    const result = buildDepsContext(makeDepsStatus());
    expect(result).toContain("Delivering a Game, Not a Library");
    expect(result).toContain("unity_my_assets_cloud");
    expect(result).toMatch(/purchased library/);
    expect(result).toContain("unity_bind_sprite");
    expect(result).toContain("unity_place_prefab");
  });

  it("treats Strada.MCP as an authoritative source with truthful runtime availability", () => {
    const result = buildDepsContext(makeDepsStatus());

    expect(result).toContain("Framework Source Authority");
    expect(result).toContain("Strada.MCP");
    expect(result).toContain("first-class knowledge source inside the Strada toolchain");
    expect(result).toContain("Only MCP action tools that are executable in the current Brain runtime belong to the live worker tool surface.");
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

  /**
   * WP-1.2: every worker prompt said "Strada.Modules is not available. Do not
   * reference Strada.Modules APIs" while a checkout of it sat beside the
   * install and the same prompt listed its classes from a cached clone. A
   * worker told never to use a ready module hand-rolls its own.
   */
  describe("Strada.Modules that is not installed in the project", () => {
    const checkout = {
      path: "/work/Strada.Modules",
      source: "sibling-checkout" as const,
      version: "1.0.0",
      commit: "abc1234",
    };

    it("says it is available, where, and how it would be installed — not that it does not exist", () => {
      const result = buildDepsContext(makeDepsStatus({ modulesInstalled: false, modulesPath: null, modulesCheckout: checkout }));

      expect(result).not.toContain("Strada.Modules is not available");
      expect(result).not.toContain("Do not reference Strada.Modules APIs");
      expect(result).toContain("available (sibling abc1234), not installed in the project");
      expect(result).toContain("/work/Strada.Modules");
      expect(result).toContain("Packages/Submodules/Strada.Modules");
      expect(result).toContain('"com.strada.modules": "file:Submodules/Strada.Modules"');
      // Not installed still means the project cannot compile against it yet.
      expect(result).toMatch(/cannot (call|use) its APIs until it is installed/);
    });

    it("with no checkout either, still says how it would be installed instead of forbidding it", () => {
      const result = buildDepsContext(makeDepsStatus({ modulesInstalled: false, modulesPath: null }));

      expect(result).not.toContain("Do not reference Strada.Modules APIs");
      expect(result).toContain("Packages/Submodules/Strada.Modules");
      expect(result).toMatch(/cannot (call|use) its APIs until it is installed/);
    });

    it("says nothing of the kind when it is installed (guard)", () => {
      const result = buildDepsContext(makeDepsStatus());

      expect(result).toContain("strada.modules: INSTALLED (/packages/strada.modules)");
      expect(result).not.toMatch(/until it is installed/);
    });
  });
});


describe("renderVaultContext keeps vault + span identity (audit 05.F3 / D47)", () => {
  it("two chunks of one file and the same path in two vaults are all rendered, each named by its vault", () => {
    const out = renderVaultContext([
      { id: "project", hits: [
        { chunk: { path: "Assets/Scripts/PlayerController.cs", content: "void Jump() {}", startLine: 10, endLine: 20 } },
        { chunk: { path: "Assets/Scripts/PlayerController.cs", content: "void Dash() {}", startLine: 40, endLine: 55 } },
      ] },
      { id: "framework", hits: [
        { chunk: { path: "README.md", content: "framework readme", startLine: 1, endLine: 5 } },
      ] },
      { id: "modules", hits: [
        { chunk: { path: "README.md", content: "modules readme", startLine: 1, endLine: 5 } },
      ] },
    ]);
    expect(out).toContain("void Jump()");
    expect(out).toContain("void Dash()");
    expect(out).toContain("[framework] README.md");
    expect(out).toContain("[modules] README.md");
    expect(out).toContain("PlayerController.cs:10-20");
    // Guard: the SAME chunk of the same vault twice is still one.
    const once = renderVaultContext([
      { id: "project", hits: [
        { chunk: { path: "a.cs", content: "x", startLine: 1, endLine: 2 } },
        { chunk: { path: "a.cs", content: "x", startLine: 1, endLine: 2 } },
      ] },
    ]);
    expect(once.match(/### /g)).toHaveLength(1);
  });
});

describe("buildVaultProjectContext seeds the graph re-rank (audit 05.cap, plan 0-A.22)", () => {
  it("files the message names reach the vault as focusFiles", async () => {
    const seen: Array<{ focusFiles?: string[] }> = [];
    const vault = { id: "project", query: async (q: { focusFiles?: string[] }) => { seen.push(q); return { hits: [] }; } };
    await buildVaultProjectContext({
      vaultRegistry: { list: () => [vault] },
      userMessage: "the double jump in Assets/Scripts/PlayerController.cs ignores Assets/Config/input.json",
    });
    expect(seen[0]?.focusFiles).toEqual(["Assets/Scripts/PlayerController.cs", "Assets/Config/input.json"]);
    // Guard: a message naming nothing sends none.
    seen.length = 0;
    await buildVaultProjectContext({ vaultRegistry: { list: () => [vault] }, userMessage: "make the boss harder" });
    expect(seen[0]?.focusFiles).toBeUndefined();
  });

  it("focusFilesFromMessage ignores prose and caps the list", () => {
    expect(focusFilesFromMessage("see docs/GDD.md and ./Assets/A.cs, not example.com")).toEqual(["docs/GDD.md", "Assets/A.cs"]);
    expect(focusFilesFromMessage(Array.from({ length: 12 }, (_u, i) => `Assets/F${i}.cs`).join(" "))).toHaveLength(8);
  });
});
