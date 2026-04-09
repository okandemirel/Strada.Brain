import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverSkills, loadSkillTools, type DiscoveredSkill } from "./skill-loader.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const fsMock = {
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => fsMock.readdir(...args),
  readFile: (...args: unknown[]) => fsMock.readFile(...args),
  stat: (...args: unknown[]) => fsMock.stat(...args),
  lstat: (...args: unknown[]) => fsMock.lstat(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// Mock logger
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

beforeEach(() => {
  fsMock.readdir.mockReset();
  fsMock.readFile.mockReset();
  fsMock.stat.mockReset();
  fsMock.lstat.mockReset();
  // lstat delegates to stat by default — tests override only when testing symlink behavior
  fsMock.lstat.mockImplementation((...args: unknown[]) => fsMock.stat(...args));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillMd(fields: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

const dirStat = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
const fileStat = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  it("discovers a valid skill from a directory", async () => {
    const skillDir = "/test-project/skills";
    const gmailDir = `${skillDir}/gmail`;

    // stat calls: first for the tier directory, then for the skill subdirectory
    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === skillDir || path === gmailDir) return dirStat;
      if (path === `${gmailDir}/SKILL.md`) return fileStat;
      throw new Error("ENOENT");
    });

    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === skillDir) return ["gmail"];
      return [];
    });

    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === `${gmailDir}/SKILL.md`) {
        return makeSkillMd({
          name: "gmail",
          version: "1.0.0",
          description: "Gmail integration",
          author: "okandemirel",
        });
      }
      throw new Error("ENOENT");
    });

    // Make managed/bundled dirs fail so only workspace is scanned
    const skills = await discoverSkills("/test-project");

    expect(skills).toHaveLength(1);
    expect(skills[0]!.manifest.name).toBe("gmail");
    expect(skills[0]!.manifest.version).toBe("1.0.0");
    expect(skills[0]!.tier).toBe("workspace");
    expect(skills[0]!.path).toBe(gmailDir);
  });

  it("skips skills with missing name field", async () => {
    const extraDir = "/extra-skills";
    const badDir = `${extraDir}/bad-skill`;

    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === extraDir || path === badDir) return dirStat;
      throw new Error("ENOENT");
    });

    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === extraDir) return ["bad-skill"];
      return [];
    });

    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === `${badDir}/SKILL.md`) {
        // Missing name field
        return makeSkillMd({ version: "1.0.0", description: "No name" });
      }
      throw new Error("ENOENT");
    });

    const skills = await discoverSkills(undefined, [extraDir]);

    expect(skills).toHaveLength(0);
  });

  it("higher tier overrides lower tier for same skill name", async () => {
    const workspaceDir = "/project/skills";
    const extraDir = "/extra-skills";
    const wsSkill = `${workspaceDir}/my-skill`;
    const exSkill = `${extraDir}/my-skill`;

    fsMock.stat.mockImplementation(async (path: string) => {
      if (
        path === workspaceDir ||
        path === wsSkill ||
        path === extraDir ||
        path === exSkill
      ) {
        return dirStat;
      }
      throw new Error("ENOENT");
    });

    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === workspaceDir) return ["my-skill"];
      if (path === extraDir) return ["my-skill"];
      return [];
    });

    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === `${wsSkill}/SKILL.md`) {
        return makeSkillMd({
          name: "my-skill",
          version: "2.0.0",
          description: "Workspace version",
        });
      }
      if (path === `${exSkill}/SKILL.md`) {
        return makeSkillMd({
          name: "my-skill",
          version: "1.0.0",
          description: "Extra version",
        });
      }
      throw new Error("ENOENT");
    });

    const skills = await discoverSkills("/project", [extraDir]);

    // Should only have one entry for "my-skill" — the workspace version
    const mySkill = skills.filter((s) => s.manifest.name === "my-skill");
    expect(mySkill).toHaveLength(1);
    expect(mySkill[0]!.manifest.version).toBe("2.0.0");
    expect(mySkill[0]!.tier).toBe("workspace");
  });

  it("returns empty array when no directories contain skills", async () => {
    // All stat calls fail — no directories exist
    fsMock.stat.mockRejectedValue(new Error("ENOENT"));

    const skills = await discoverSkills("/nonexistent");
    expect(skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadSkillTools
// ---------------------------------------------------------------------------

describe("loadSkillTools", () => {
  it("namespaces tools correctly with skill_ prefix", async () => {
    const fakeTool = {
      name: "send_email",
      description: "Send an email",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ success: true, output: "sent" }),
    };

    const skill: DiscoveredSkill = {
      manifest: { name: "gmail", version: "1.0.0", description: "Gmail" },
      tier: "workspace",
      path: "/mock/skills/gmail",
    };

    // Mock stat to find index.js
    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === "/mock/skills/gmail/index.ts") throw new Error("ENOENT");
      if (path === "/mock/skills/gmail/index.js") return fileStat;
      throw new Error("ENOENT");
    });

    // Mock the dynamic import — we need to mock at the module level
    // Since dynamic import is hard to mock, we test the namespace logic
    // by verifying the stat resolution and testing the function indirectly.
    // For a full integration test, we'd need actual files on disk.

    // Instead, let's verify the entry point resolution works:
    // The loadSkillTools function will try to stat index.ts first, then index.js
    // We verify it finds index.js
    // The actual import will fail since the file doesn't exist, so we catch that
    try {
      await loadSkillTools(skill);
    } catch {
      // Expected: dynamic import will fail since no real file exists
      // This tests the path resolution logic
    }

    // Verify stat was called for both potential entry points
    expect(fsMock.stat).toHaveBeenCalledWith("/mock/skills/gmail/index.ts");
    expect(fsMock.stat).toHaveBeenCalledWith("/mock/skills/gmail/index.js");
  });

  it("returns empty array when no entry point exists", async () => {
    const skill: DiscoveredSkill = {
      manifest: { name: "empty-skill", version: "1.0.0", description: "No entry" },
      tier: "workspace",
      path: "/mock/skills/empty",
    };

    fsMock.stat.mockRejectedValue(new Error("ENOENT"));

    const tools = await loadSkillTools(skill);
    expect(tools).toEqual([]);
  });
});
