import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "./skill-manager.js";
import type { SkillEntry, SkillConfig } from "./types.js";
import type { DiscoveredSkill } from "./skill-loader.js";
import type { GateResult } from "./skill-gating.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import { withTempDir } from "../test-helpers.js";
import { approveWorkspaceSkill } from "./skill-trust.js";

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

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => silentLogger,
  getLogger: () => silentLogger,
}));

// The real PluginRegistry is used on purpose (plan 0-B.2): the defect was in
// the interplay between SkillManager's status assignment and the registry's
// topological sort, which a permissive mock could never reproduce.

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

    // audited 2026-09-02: loadAll never passed an app config to checkGates, so
    // every `requires.config` skill was gated with a reason nobody measured.
    it("threads the app config given via setAppConfig into every gate check", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("cfg-skill", {
          manifest: {
            name: "cfg-skill",
            version: "1.0.0",
            description: "needs a config key",
            requires: { config: ["unityProjectPath"] },
          },
        }),
      ]);
      const appConfig = { unityProjectPath: "/proj" };

      const mgr = new SkillManager();
      mgr.setAppConfig(appConfig);
      await mgr.loadAll();

      expect(mockCheckGates).toHaveBeenCalledTimes(1);
      const call = (mockCheckGates as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
      expect(call[0]).toEqual({ config: ["unityProjectPath"] });
      expect(call[1]).toBe(appConfig);
    });

    it("surfaces an unevaluated gate on the active entry instead of hiding it", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("cfg-skill", {
          manifest: {
            name: "cfg-skill",
            version: "1.0.0",
            description: "needs a config key",
            requires: { config: ["llm.apiKey"] },
          },
        }),
      ]);
      mockCheckGates.mockResolvedValue({
        passed: true,
        reasons: [],
        unevaluated: ["Config gate not evaluated (no config object supplied): llm.apiKey"],
      });

      const mgr = new SkillManager();
      const entries = await mgr.loadAll();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("active");
      expect(entries[0]!.gateReason).toContain("not evaluated");
      expect(entries[0]!.gateReason).toContain("llm.apiKey");
      expect(mockLoadSkillTools).toHaveBeenCalledTimes(1);
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

  // -------------------------------------------------------------------------
  // plan 0-B.2 (audit R1/D67 + R2 + Codex #3): dependency preflight.
  // Before: every skill was marked "active" before initializeAll(), and one
  // missing requires.skills entry made topologicalSort() throw past the
  // per-plugin try/catch — no skill initialised, all reported active.
  // -------------------------------------------------------------------------
  describe("requires.skills preflight (plan 0-B.2)", () => {
    const dep = (name: string, skills: string[]) =>
      makeSkill(name, { manifest: { name, version: "1.0.0", description: name, requires: { skills } } });

    it("(a) A requires B → both active, in either discovery order", async () => {
      for (const order of [[dep("A", ["B"]), makeSkill("B")], [makeSkill("B"), dep("A", ["B"])]]) {
        mockDiscoverSkills.mockResolvedValue(order);
        const mgr = new SkillManager();
        const entries = await mgr.loadAll();
        const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e.status]));
        expect(byName, `order ${order.map((s) => s.manifest.name).join(",")}`).toEqual({ A: "active", B: "active" });
        await mgr.dispose();
      }
    });

    it("(b) A requires a skill nobody discovered → A gated naming it; independent C active and initialised", async () => {
      mockDiscoverSkills.mockResolvedValue([dep("A", ["Missing"]), makeSkill("C")]);
      mockLoadSkillTools.mockResolvedValue([makeTool("t")]);
      const registered: string[] = [];
      const mgr = new SkillManager();
      mgr.setToolRegistrar((tools) => registered.push(...tools.map((t) => t.name)), () => {});

      const entries = await mgr.loadAll();
      const a = entries.find((e) => e.manifest.name === "A")!;
      const c = entries.find((e) => e.manifest.name === "C")!;
      expect(a.status).toBe("gated");
      expect(a.gateReason).toContain("Missing");
      expect(a.gateReason).toContain("not discovered");
      expect(c.status).toBe("active");
      // C's initialize() ran — its tools reached the registrar — so the batch was not aborted.
      expect(registered).toEqual(["t"]);
      // A's tools were never imported.
      expect(mockLoadSkillTools.mock.calls.map((c) => c[0].manifest.name)).toEqual(["C"]);
    });

    it("(b') a dependency that is gated/disabled poisons its dependents transitively, with the reason", async () => {
      mockDiscoverSkills.mockResolvedValue([dep("A", ["B"]), dep("B", ["Off"]), makeSkill("Off"), makeSkill("C")]);
      mockReadSkillConfig.mockResolvedValue({ entries: { Off: { enabled: false } } });
      const mgr = new SkillManager();
      const entries = await mgr.loadAll();
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e]));
      expect(byName["Off"]!.status).toBe("disabled");
      expect(byName["B"]!.status).toBe("gated");
      expect(byName["B"]!.gateReason).toContain('"Off" is disabled');
      expect(byName["A"]!.status).toBe("gated");
      expect(byName["A"]!.gateReason).toContain('"B" is gated');
      expect(byName["C"]!.status).toBe("active");
    });

    it("(c) A <-> B cycle → both gated as cyclic, C active", async () => {
      mockDiscoverSkills.mockResolvedValue([dep("A", ["B"]), dep("B", ["A"]), makeSkill("C")]);
      const mgr = new SkillManager();
      const entries = await mgr.loadAll();
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e]));
      expect(byName["A"]!.status).toBe("gated");
      expect(byName["A"]!.gateReason).toMatch(/cycle/i);
      expect(byName["B"]!.status).toBe("gated");
      expect(byName["B"]!.gateReason).toMatch(/cycle/i);
      expect(byName["C"]!.status).toBe("active");
      expect(mockLoadSkillTools.mock.calls.map((c) => c[0].manifest.name)).toEqual(["C"]);
    });

    it("(e) a skill whose initialize() throws ends \"error\" with the reason, never \"active\"", async () => {
      mockDiscoverSkills.mockResolvedValue([makeSkill("boom"), makeSkill("fine")]);
      mockLoadSkillTools.mockImplementation(async (skill) => [makeTool(`${skill.manifest.name}_t`)]);
      const mgr = new SkillManager();
      // initialize() of the skill plugin is where tools reach the registrar.
      mgr.setToolRegistrar((tools) => {
        if (tools.some((t) => t.name === "boom_t")) throw new Error("registrar exploded");
      }, () => {});

      const entries = await mgr.loadAll();
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e]));
      expect(byName["boom"]!.status).toBe("error");
      expect(byName["boom"]!.gateReason).toContain("registrar exploded");
      expect(byName["fine"]!.status).toBe("active");
    });

    it("does not hand requires.skills to checkGates (the preflight measures it) but keeps the other gates intact", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("A", { manifest: { name: "A", version: "1.0.0", description: "A", requires: { skills: ["B"], env: ["X_ENV"] } } }),
        makeSkill("B"),
      ]);
      const mgr = new SkillManager();
      await mgr.loadAll();
      const call = (mockCheckGates as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] !== undefined)!;
      expect(call[0]).toEqual({ env: ["X_ENV"] });
    });
  });

  // -------------------------------------------------------------------------
  // plan 4.9 (audit R2/D68): env overrides are injected BEFORE the gate check
  // and rolled back when the skill does not end active.
  // -------------------------------------------------------------------------
  describe("env injection order (plan 4.9)", () => {
    const KEY = "SKILL_MGR_TEST_GATE_VAR";
    afterEach(() => { delete process.env[KEY]; });

    it("(d) a gate that reads an env var configured for that skill passes; a gated skill's env is restored", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("needs-env", { manifest: { name: "needs-env", version: "1.0.0", description: "x", requires: { env: [KEY] } } }),
        makeSkill("gated-env", { manifest: { name: "gated-env", version: "1.0.0", description: "y", requires: { bins: ["nope"] } } }),
      ]);
      mockReadSkillConfig.mockResolvedValue({
        entries: {
          "needs-env": { enabled: true, env: { [KEY]: "from-user-config" } },
          "gated-env": { enabled: true, env: { GATED_ENV_LEFTOVER: "should-not-survive" } },
        },
      });
      // Real env gate semantics for the first skill: pass iff the var is set at check time.
      const seenAtGate: Record<string, string | undefined> = {};
      mockCheckGates.mockImplementation(async (requires: unknown) => {
        const r = requires as { env?: string[]; bins?: string[] } | undefined;
        if (r?.env) {
          seenAtGate[r.env[0]!] = process.env[r.env[0]!];
          return process.env[r.env[0]!] ? { passed: true, reasons: [] } : { passed: false, reasons: [`Required environment variable not set: ${r.env[0]}`] };
        }
        if (r?.bins) return { passed: false, reasons: ["Required binary not found: nope"] };
        return { passed: true, reasons: [] };
      });

      const mgr = new SkillManager();
      const entries = await mgr.loadAll();
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e]));
      expect(seenAtGate[KEY]).toBe("from-user-config");
      expect(byName["needs-env"]!.status).toBe("active");
      expect(process.env[KEY]).toBe("from-user-config");
      expect(byName["gated-env"]!.status).toBe("gated");
      expect(process.env["GATED_ENV_LEFTOVER"]).toBeUndefined();
      await mgr.dispose();
      expect(process.env[KEY]).toBeUndefined();
    });

    it("rolls env back for a skill parked by the dependency preflight and for one whose initialize() failed", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("dep-gated", { manifest: { name: "dep-gated", version: "1.0.0", description: "x", requires: { skills: ["Missing"] } } }),
        makeSkill("init-fails"),
      ]);
      mockReadSkillConfig.mockResolvedValue({
        entries: {
          "dep-gated": { enabled: true, env: { DEP_GATED_ENV: "1" } },
          "init-fails": { enabled: true, env: { INIT_FAILS_ENV: "1" } },
        },
      });
      mockLoadSkillTools.mockResolvedValue([makeTool("t")]);
      const mgr = new SkillManager();
      mgr.setToolRegistrar(() => { throw new Error("nope"); }, () => {});
      const entries = await mgr.loadAll();
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e.status]));
      expect(byName).toEqual({ "dep-gated": "gated", "init-fails": "error" });
      expect(process.env["DEP_GATED_ENV"]).toBeUndefined();
      expect(process.env["INIT_FAILS_ENV"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // plan 1.15 (audit 13F3/D65 + Codex #23): workspace skills need an approval
  // record OUTSIDE the project before their entry point is imported.
  // -------------------------------------------------------------------------
  describe("workspace trust (plan 1.15)", () => {
    let fakeHome: string;
    let projectRoot: string;
    const savedHome = process.env["HOME"];

    beforeEach(async () => {
      fakeHome = await mkdtemp(join(tmpdir(), "strada-trust-home-"));
      projectRoot = await mkdtemp(join(tmpdir(), "strada-trust-proj-"));
      process.env["HOME"] = fakeHome;
    });
    afterEach(async () => {
      process.env["HOME"] = savedHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    });

    async function writeWorkspaceSkill(name: string, indexJs: string): Promise<DiscoveredSkill> {
      const dir = join(projectRoot, "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: ws\n---\n`, "utf-8");
      await writeFile(join(dir, "index.js"), indexJs, "utf-8");
      return makeSkill(name, { tier: "workspace", path: dir });
    }

    it("(f) no record → untrusted and NOT imported; approved → active; code edited → untrusted again; record under HOME; in-project record ignored", async () => {
      const skill = await writeWorkspaceSkill("ws", "export const tools = [];\n");
      mockDiscoverSkills.mockResolvedValue([skill]);

      // A record planted INSIDE the project must not count.
      await mkdir(join(projectRoot, ".strada"), { recursive: true });
      await writeFile(join(projectRoot, ".strada", "trusted-skills.json"), JSON.stringify({ version: 1, projects: { [projectRoot]: { "skills/ws": { sha256: "x", approvedAtIso: "" } } } }));

      let entries = await new SkillManager().loadAll(projectRoot);
      expect(entries[0]!.status).toBe("untrusted");
      expect(entries[0]!.gateReason).toContain("strada skill trust ws");
      expect(mockLoadSkillTools).not.toHaveBeenCalled();

      await approveWorkspaceSkill(projectRoot, skill.path);
      const recordPath = join(fakeHome, ".strada", "trusted-skills.json");
      const record = JSON.parse(await readFile(recordPath, "utf-8")) as { projects: Record<string, Record<string, { sha256: string }>> };
      expect(Object.values(record.projects)[0]!["skills/ws"]!.sha256).toMatch(/^[0-9a-f]{64}$/);

      entries = await new SkillManager().loadAll(projectRoot);
      expect(entries[0]!.status).toBe("active");
      expect(mockLoadSkillTools).toHaveBeenCalledTimes(1);

      await writeFile(join(skill.path, "index.js"), "export const tools = []; /* changed */\n", "utf-8");
      entries = await new SkillManager().loadAll(projectRoot);
      expect(entries[0]!.status).toBe("untrusted");
      expect(entries[0]!.gateReason).toContain("changed since approval");
      expect(mockLoadSkillTools).toHaveBeenCalledTimes(1);
    });

    it("bundled/managed/extra tiers are not subject to the trust record", async () => {
      mockDiscoverSkills.mockResolvedValue([
        makeSkill("b", { tier: "bundled" }),
        makeSkill("m", { tier: "managed" }),
        makeSkill("x", { tier: "extra" }),
      ]);
      const entries = await new SkillManager().loadAll(projectRoot);
      expect(entries.map((e) => e.status)).toEqual(["active", "active", "active"]);
    });

    it("an untrusted workspace skill's dependents are gated, and it is never registered", async () => {
      const ws = await writeWorkspaceSkill("ws", "export const tools = [];\n");
      mockDiscoverSkills.mockResolvedValue([
        ws,
        makeSkill("needs-ws", { manifest: { name: "needs-ws", version: "1.0.0", description: "d", requires: { skills: ["ws"] } } }),
      ]);
      const entries = await new SkillManager().loadAll(projectRoot);
      const byName = Object.fromEntries(entries.map((e) => [e.manifest.name, e]));
      expect(byName["ws"]!.status).toBe("untrusted");
      expect(byName["needs-ws"]!.status).toBe("gated");
      expect(byName["needs-ws"]!.gateReason).toContain('"ws" is untrusted');
    });

    it("loadSingle applies the same rule to a hot-loaded workspace skill with an entry point", async () => {
      const ws = await writeWorkspaceSkill("hot", "export const tools = [];\n");
      const entry = await new SkillManager().loadSingle(ws.path);
      expect(entry!.status).toBe("untrusted");
      expect(mockLoadSkillTools).not.toHaveBeenCalled();
    });
  });

  describe("loadSingle", () => {
    it("should return null for non-existent path", async () => {
      const mgr = new SkillManager();
      const result = await mgr.loadSingle("/non/existent/path");
      expect(result).toBeNull();
    });

    it("carries the selection metadata (inject, triggers) on hot-load — the boot loader did, this path did not", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, "deploy-notes");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          ["---", "name: deploy-notes", "version: 1.0.0", "description: deploy know-how", "inject: always", "triggers: [deploy, release]", "---", "", "# Deploy"].join("\n"),
          "utf-8",
        );
        mockLoadSkillTools.mockResolvedValue([]);
        mockCheckGates.mockResolvedValue({ passed: true, reasons: [] });
        const mgr = new SkillManager();
        const entry = await mgr.loadSingle(skillDir);
        expect(entry!.manifest.inject).toBe("always");
        expect(entry!.manifest.triggers).toEqual(["deploy", "release"]);
      });
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
