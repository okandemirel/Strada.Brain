import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SkillManager } from "./skill-manager.js";
import type { SkillEntry, SkillConfig } from "./types.js";
import type { DiscoveredSkill } from "./skill-loader.js";
import type { GateResult } from "./skill-gating.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import { withTempDir } from "../test-helpers.js";

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

  describe("loadSingle", () => {
    it("should return null for non-existent path", async () => {
      const mgr = new SkillManager();
      const result = await mgr.loadSingle("/non/existent/path");
      expect(result).toBeNull();
    });

    it("should load a valid SKILL.md and return an entry", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, "my-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          [
            "---",
            "name: my-skill",
            "version: 1.0.0",
            "description: A test skill for loadSingle",
            "---",
            "",
            "# My Skill Content",
          ].join("\n"),
          "utf-8",
        );

        // loadSkillTools is mocked — return empty tools array (no entry point needed)
        mockLoadSkillTools.mockResolvedValue([]);
        mockCheckGates.mockResolvedValue({ passed: true, reasons: [] });

        const mgr = new SkillManager();
        const entry = await mgr.loadSingle(skillDir);

        expect(entry).not.toBeNull();
        expect(entry!.manifest.name).toBe("my-skill");
        // 0 tools but has body content → "active" (knowledge-only skill)
        expect(entry!.status).toBe("active");
        expect(entry!.body).toBe("# My Skill Content");
        expect(entry!.tier).toBe("workspace");
        expect(entry!.path).toBe(skillDir);
      });
    });

    it("should return existing entry without re-loading if skill is already loaded", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, "already-loaded");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          [
            "---",
            "name: already-loaded",
            "version: 1.0.0",
            "description: Already loaded skill",
            "---",
            "",
            "Content here.",
          ].join("\n"),
          "utf-8",
        );

        mockLoadSkillTools.mockResolvedValue([makeTool("some_tool")]);
        mockCheckGates.mockResolvedValue({ passed: true, reasons: [] });

        const mgr = new SkillManager();
        mgr.setToolRegistrar(() => {}, () => {});

        // First load
        const first = await mgr.loadSingle(skillDir);
        expect(first).not.toBeNull();
        expect(first!.status).toBe("active");
        const loadCallsAfterFirst = mockLoadSkillTools.mock.calls.length;

        // Second load — should return existing entry without calling loadSkillTools again
        const second = await mgr.loadSingle(skillDir);
        expect(second).not.toBeNull();
        expect(second!.manifest.name).toBe("already-loaded");
        expect(mockLoadSkillTools.mock.calls.length).toBe(loadCallsAfterFirst);
      });
    });

    it("should return null when SKILL.md has no name field", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, "no-name");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          [
            "---",
            "version: 1.0.0",
            "description: Missing name field",
            "---",
            "",
            "Content without name.",
          ].join("\n"),
          "utf-8",
        );

        const mgr = new SkillManager();
        const result = await mgr.loadSingle(skillDir);
        expect(result).toBeNull();
      });
    });

    it("should return error entry when loadSkillTools throws", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, "broken-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          [
            "---",
            "name: broken-skill",
            "version: 1.0.0",
            "description: Skill with broken tools",
            "---",
            "",
            "Content here.",
          ].join("\n"),
          "utf-8",
        );

        mockCheckGates.mockResolvedValue({ passed: true, reasons: [] });
        mockLoadSkillTools.mockRejectedValue(new Error("Cannot find module './index.js'"));

        const mgr = new SkillManager();
        const entry = await mgr.loadSingle(skillDir);

        expect(entry).not.toBeNull();
        expect(entry!.status).toBe("error");
        expect(entry!.gateReason).toContain("Cannot find module");
      });
    });
  });
});
