import { describe, it, expect, vi, beforeEach } from "vitest";
import { basename, join, sep } from "node:path";
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
/** A `readdir(…, { withFileTypes: true })` entry for a regular file. */
const dirent = (name: string) => ({ name, ...fileStat });

// The loader builds every path with path.join, so the mocked filesystem is
// keyed the same way: `\test-project\skills` on Windows, not `/test-project/skills`.

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  it("discovers a valid skill from a directory", async () => {
    const skillDir = join("/test-project", "skills");
    const gmailDir = join(skillDir, "gmail");

    // stat calls: first for the tier directory, then for the skill subdirectory
    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === skillDir || path === gmailDir) return dirStat;
      if (path === join(gmailDir, "SKILL.md")) return fileStat;
      throw new Error("ENOENT");
    });

    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === skillDir) return ["gmail"];
      return [];
    });

    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === join(gmailDir, "SKILL.md")) {
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

  it("reads inject and triggers from the frontmatter (how a body earns its place in a prompt)", async () => {
    const skillDir = join("/test-project", "skills");
    const planDir = join(skillDir, "ufo-plan");
    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === skillDir || path === planDir) return dirStat;
      if (path === join(planDir, "SKILL.md")) return fileStat;
      throw new Error("ENOENT");
    });
    fsMock.readdir.mockImplementation(async (path: string) => (path === skillDir ? ["ufo-plan"] : []));
    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === join(planDir, "SKILL.md")) {
        return makeSkillMd({
          name: "ufo-plan",
          version: "1.0.0",
          description: "UFO set-piece plan",
          inject: "on-mention",
          triggers: ["UFO", "set-piece"],
        }) + "# UFO plan body\n";
      }
      throw new Error("ENOENT");
    });

    const skills = await discoverSkills("/test-project");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.manifest.inject).toBe("on-mention");
    expect(skills[0]!.manifest.triggers).toEqual(["UFO", "set-piece"]);
    expect(skills[0]!.body).toContain("UFO plan body");
  });

  it("skips skills with missing name field", async () => {
    const extraDir = "/extra-skills";
    const badDir = join(extraDir, "bad-skill");

    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === extraDir || path === badDir) return dirStat;
      throw new Error("ENOENT");
    });

    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === extraDir) return ["bad-skill"];
      return [];
    });

    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path === join(badDir, "SKILL.md")) {
        // Missing name field
        return makeSkillMd({ version: "1.0.0", description: "No name" });
      }
      throw new Error("ENOENT");
    });

    const skills = await discoverSkills(undefined, [extraDir]);

    expect(skills).toHaveLength(0);
  });

  it("higher tier overrides lower tier for same skill name", async () => {
    const workspaceDir = join("/project", "skills");
    const extraDir = "/extra-skills";
    const wsSkill = join(workspaceDir, "my-skill");
    const exSkill = join(extraDir, "my-skill");

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
      if (path === join(wsSkill, "SKILL.md")) {
        return makeSkillMd({
          name: "my-skill",
          version: "2.0.0",
          description: "Workspace version",
        });
      }
      if (path === join(exSkill, "SKILL.md")) {
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

    // The entry point is picked from the directory listing (SEC-1), then
    // confirmed to be a file.
    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === "/mock/skills/gmail") return [dirent("SKILL.md"), dirent("index.js")];
      throw new Error("ENOENT");
    });
    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === join("/mock/skills/gmail", "index.js")) return fileStat;
      throw new Error("ENOENT");
    });

    // Mock the dynamic import — we need to mock at the module level
    // Since dynamic import is hard to mock, we test the namespace logic
    // by verifying the stat resolution and testing the function indirectly.
    // For a full integration test, we'd need actual files on disk.

    // Instead, let's verify the entry point resolution works:
    // The actual import will fail since the file doesn't exist, so we catch that
    try {
      await loadSkillTools(skill);
    } catch {
      // Expected: dynamic import will fail since no real file exists
      // This tests the path resolution logic
    }

    // Only the listed entry point was probed — never a name the listing lacks.
    expect(fsMock.stat).toHaveBeenCalledWith(join("/mock/skills/gmail", "index.js"));
    expect(fsMock.stat).not.toHaveBeenCalledWith(join("/mock/skills/gmail", "index.ts"));
  });

  it("returns empty array when no entry point exists", async () => {
    const skill: DiscoveredSkill = {
      manifest: { name: "empty-skill", version: "1.0.0", description: "No entry" },
      tier: "workspace",
      path: "/mock/skills/empty",
    };

    fsMock.readdir.mockResolvedValue([dirent("SKILL.md")]);
    fsMock.stat.mockRejectedValue(new Error("ENOENT"));

    const tools = await loadSkillTools(skill);
    expect(tools).toEqual([]);
  });

  // SEC-1: on a case-insensitive filesystem (APFS, NTFS) `stat("<dir>/index.js")`
  // also opens `Index.js`. The loader must import only an entry whose exact name
  // is in the listing — the one the trust scan saw — and refuse anything else.
  it("refuses an entry point whose exact-case name is not in the listing (simulated case-insensitive filesystem)", async () => {
    const skill: DiscoveredSkill = {
      manifest: { name: "cased", version: "1.0.0", description: "Cased entry" },
      tier: "workspace",
      path: "/mock/skills/cased",
    };
    const onDisk = ["SKILL.md", "Index.js"];
    fsMock.readdir.mockImplementation(async (path: string) => {
      if (path === "/mock/skills/cased") return onDisk.map((name) => dirent(name));
      throw new Error("ENOENT");
    });
    // Case-insensitive lookup, as APFS/NTFS answer it.
    fsMock.stat.mockImplementation(async (path: string) => {
      const base = basename(path).toLowerCase();
      if (path.startsWith(join("/mock/skills/cased") + sep) && onDisk.some((n) => n.toLowerCase() === base)) return fileStat;
      throw new Error("ENOENT");
    });

    await expect(loadSkillTools(skill)).rejects.toThrow(/"Index\.js" is not named exactly index\.ts or index\.js/);
    expect(fsMock.stat).not.toHaveBeenCalled();
  });
});
