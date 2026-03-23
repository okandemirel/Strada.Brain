import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillManager } from "./skill-manager.js";
import type { SkillEntry, SkillConfig } from "./types.js";
import type { DiscoveredSkill } from "./skill-loader.js";
import type { GateResult } from "./skill-gating.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDiscoverSkills = vi.fn<() => Promise<DiscoveredSkill[]>>();
const mockLoadSkillTools = vi.fn<(skill: DiscoveredSkill) => Promise<ITool[]>>();
const mockCheckGates = vi.fn<() => Promise<GateResult>>();
const mockReadSkillConfig = vi.fn<() => Promise<SkillConfig>>();

vi.mock("./skill-loader.js", () => ({
  discoverSkills: (...args: unknown[]) => mockDiscoverSkills(...args as []),
  loadSkillTools: (...args: unknown[]) => mockLoadSkillTools(...(args as [DiscoveredSkill])),
}));

vi.mock("./skill-gating.js", () => ({
  checkGates: (...args: unknown[]) => mockCheckGates(...args as []),
}));

vi.mock("./skill-config.js", () => ({
  readSkillConfig: () => mockReadSkillConfig(),
}));

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../plugins/registry.js", () => {
  class MockPluginRegistry {
    private plugins = new Map<string, { metadata: { name: string }; initialize: () => Promise<void>; dispose: () => Promise<void> }>();
    register(plugin: { metadata: { name: string }; initialize: () => Promise<void>; dispose: () => Promise<void> }) {
      this.plugins.set(plugin.metadata.name, plugin);
    }
    getAll() { return [...this.plugins.values()]; }
    async initializeAll() {
      for (const p of this.plugins.values()) {
        await p.initialize();
      }
    }
    async disposeAll() {
      for (const p of this.plugins.values()) {
        await p.dispose();
      }
    }
  }
  return { PluginRegistry: MockPluginRegistry };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): ITool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutionResult> {
      return { success: true, output: name };
    },
  };
}

function makeSkill(name: string, overrides?: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: `${name} skill`,
      capabilities: ["test"],
      ...overrides?.manifest,
    },
    tier: overrides?.tier ?? "bundled",
    path: overrides?.path ?? `/mock/skills/${name}`,
  };
}

beforeEach(() => {
  mockDiscoverSkills.mockReset();
  mockLoadSkillTools.mockReset();
  mockCheckGates.mockReset();
  mockReadSkillConfig.mockReset();

  // Defaults
  mockReadSkillConfig.mockResolvedValue({ entries: {} });
  mockCheckGates.mockResolvedValue({ passed: true, reasons: [] });
  mockLoadSkillTools.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillManager", () => {
  describe("loadAll", () => {
    it("should load skills and mark them active", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("alpha")]);
      mockLoadSkillTools.mockResolvedValue([makeTool("do_stuff")]);

      const mgr = new SkillManager();
      const registeredTools: ITool[] = [];
      mgr.setToolRegistrar(
        (tools) => registeredTools.push(...tools),
        () => {},
      );

      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("active");
      expect(entries[0]!.manifest.name).toBe("alpha");
      expect(registeredTools).toHaveLength(1);
      expect(registeredTools[0]!.name).toBe("do_stuff");
    });

    it("should skip disabled skills", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("disabled-one")]);
      mockReadSkillConfig.mockResolvedValue({
        entries: { "disabled-one": { enabled: false } },
      });

      const mgr = new SkillManager();
      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("disabled");
      expect(mockLoadSkillTools).not.toHaveBeenCalled();
    });

    it("should mark gated skills with reasons", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("gated-one", {
          manifest: {
            name: "gated-one",
            version: "1.0.0",
            description: "needs stuff",
            requires: { bins: ["nonexistent-bin"] },
          },
        }),
      ]);
      mockCheckGates.mockResolvedValue({
        passed: false,
        reasons: ["Required binary not found: nonexistent-bin"],
      });

      const mgr = new SkillManager();
      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("gated");
      expect(entries[0]!.gateReason).toContain("nonexistent-bin");
      expect(mockLoadSkillTools).not.toHaveBeenCalled();
    });

    it("should mark error if loadSkillTools throws", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("broken")]);
      mockLoadSkillTools.mockRejectedValue(new Error("Module not found"));

      const mgr = new SkillManager();
      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("error");
      expect(entries[0]!.gateReason).toContain("Module not found");
    });

    it("should handle multiple skills with mixed statuses", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("active-skill"),
        makeSkill("disabled-skill"),
        makeSkill("gated-skill"),
      ]);
      mockReadSkillConfig.mockResolvedValue({
        entries: { "disabled-skill": { enabled: false } },
      });
      mockCheckGates.mockImplementation(async (requires: unknown) => {
        // Only gated-skill has requirements, others pass
        return { passed: requires === undefined, reasons: requires ? ["missing"] : [] };
      });
      mockLoadSkillTools.mockResolvedValue([makeTool("tool_a")]);

      // Give gated-skill some requirements
      const skills = [
        makeSkill("active-skill"),
        makeSkill("disabled-skill"),
        makeSkill("gated-skill", {
          manifest: {
            name: "gated-skill",
            version: "1.0.0",
            description: "gated",
            requires: { bins: ["missing"] },
          },
        }),
      ];
      mockDiscoverSkills.mockResolvedValue(skills);

      const mgr = new SkillManager();
      mgr.setToolRegistrar(() => {}, () => {});
      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(3);
      const statuses = entries.map((e) => e.status);
      expect(statuses).toContain("active");
      expect(statuses).toContain("disabled");
      expect(statuses).toContain("gated");
    });
  });

  describe("getEntries", () => {
    it("should return all entries after loadAll", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("foo"), makeSkill("bar")]);
      mockLoadSkillTools.mockResolvedValue([]);

      const mgr = new SkillManager();
      await mgr.loadAll();

      expect(mgr.getEntries()).toHaveLength(2);
    });
  });

  describe("dispose", () => {
    it("should clear entries and restore env", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("cleanup-test")]);
      mockLoadSkillTools.mockResolvedValue([makeTool("t1")]);
      mockReadSkillConfig.mockResolvedValue({
        entries: { "cleanup-test": { enabled: true, env: { CLEANUP_VAR: "val" } } },
      });

      const mgr = new SkillManager();
      mgr.setToolRegistrar(() => {}, () => {});
      await mgr.loadAll();

      expect(mgr.getEntries()).toHaveLength(1);

      await mgr.dispose();

      expect(mgr.getEntries()).toHaveLength(0);
      // env should be restored (CLEANUP_VAR was not set before)
      expect(process.env["CLEANUP_VAR"]).toBeUndefined();
    });
  });
});
