/**
 * SkillInstaller Unit Tests
 *
 * Tests: skill name validation, repo URL validation, installation flow,
 * error handling (git not found, clone failure, already installed), registry fetching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidSkillName, isValidRepoUrl, installSkillFromRepo } from "./skill-installer.js";

// =============================================================================
// Mocks
// =============================================================================

const fsMock = {
  stat: vi.fn(),
  rm: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => fsMock.stat(...args),
  rm: (...args: unknown[]) => fsMock.rm(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

const execMock = {
  execFileNoThrow: vi.fn(),
};

vi.mock("../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: (...args: unknown[]) => execMock.execFileNoThrow(...args),
}));

const skillConfigMock = {
  setSkillEnabled: vi.fn(),
};

vi.mock("./skill-config.js", () => ({
  setSkillEnabled: (...args: unknown[]) => skillConfigMock.setSkillEnabled(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.stat.mockReset();
  fsMock.rm.mockReset();
  execMock.execFileNoThrow.mockReset();
  skillConfigMock.setSkillEnabled.mockReset();
  skillConfigMock.setSkillEnabled.mockResolvedValue(undefined);
  fsMock.rm.mockResolvedValue(undefined);
});

// =============================================================================
// isValidSkillName
// =============================================================================

describe("isValidSkillName", () => {
  it("accepts valid alphanumeric names", () => {
    expect(isValidSkillName("gmail")).toBe(true);
    expect(isValidSkillName("my-skill")).toBe(true);
    expect(isValidSkillName("skill_v2")).toBe(true);
    expect(isValidSkillName("my.skill.v1")).toBe(true);
    expect(isValidSkillName("A-Z_test")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSkillName("")).toBe(false);
  });

  it("rejects names with special characters", () => {
    expect(isValidSkillName("my skill")).toBe(false);
    expect(isValidSkillName("skill@name")).toBe(false);
    expect(isValidSkillName("skill/name")).toBe(false);
    expect(isValidSkillName("skill\\name")).toBe(false);
    expect(isValidSkillName("$(whoami)")).toBe(false);
  });

  it("rejects dot-only names (path traversal)", () => {
    expect(isValidSkillName(".")).toBe(false);
    expect(isValidSkillName("..")).toBe(false);
    expect(isValidSkillName("...")).toBe(false);
  });

  it("accepts names with dots that are not dot-only", () => {
    expect(isValidSkillName(".hidden")).toBe(true);
    expect(isValidSkillName("a.b")).toBe(true);
  });
});

// =============================================================================
// isValidRepoUrl
// =============================================================================

describe("isValidRepoUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    expect(isValidRepoUrl("https://github.com/user/repo")).toBe(true);
    expect(isValidRepoUrl("https://gitlab.com/user/repo.git")).toBe(true);
  });

  it("rejects HTTP (non-secure) URLs", () => {
    expect(isValidRepoUrl("http://github.com/user/repo")).toBe(false);
  });

  it("rejects SSH URLs", () => {
    expect(isValidRepoUrl("ssh://git@github.com/user/repo")).toBe(false);
  });

  it("rejects git:// protocol", () => {
    expect(isValidRepoUrl("git://github.com/user/repo")).toBe(false);
  });

  it("rejects file:// protocol", () => {
    expect(isValidRepoUrl("file:///tmp/evil")).toBe(false);
  });

  it("rejects ext:: protocol (command execution)", () => {
    expect(isValidRepoUrl("ext::sh -c evil")).toBe(false);
  });

  it("rejects invalid/non-URL strings", () => {
    expect(isValidRepoUrl("not-a-url")).toBe(false);
    expect(isValidRepoUrl("")).toBe(false);
  });
});

// =============================================================================
// installSkillFromRepo
// =============================================================================

describe("installSkillFromRepo", () => {
  // =========================================================================
  // Input validation
  // =========================================================================

  it("rejects invalid skill name", async () => {
    const result = await installSkillFromRepo("bad name!", "https://github.com/x/y");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill name");
  });

  it("rejects non-HTTPS repo URL", async () => {
    const result = await installSkillFromRepo("my-skill", "ssh://git@github.com/x/y");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Only HTTPS");
  });

  // =========================================================================
  // Git availability
  // =========================================================================

  it("returns error when git is not available", async () => {
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 127,
      stdout: "",
      stderr: "command not found: git",
    });

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(false);
    expect(result.error).toContain("git is not installed");
  });

  // =========================================================================
  // Already installed
  // =========================================================================

  it("returns error when skill directory already exists", async () => {
    // git --version succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git version 2.40.0",
      stderr: "",
    });

    // stat returns a directory
    fsMock.stat.mockResolvedValueOnce({
      isDirectory: () => true,
    });

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already installed");
  });

  // =========================================================================
  // Clone failure
  // =========================================================================

  it("returns error and cleans up on git clone failure", async () => {
    // git --version succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git version 2.40.0",
      stderr: "",
    });

    // stat throws (directory does not exist)
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    // git clone fails
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: repository not found",
    });

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Git clone failed");
    // Should attempt cleanup
    expect(fsMock.rm).toHaveBeenCalledWith(
      "/mock-home/.strada/skills/my-skill",
      { recursive: true, force: true },
    );
  });

  // =========================================================================
  // Successful install
  // =========================================================================

  it("successfully clones, validates SKILL.md, and enables the skill", async () => {
    // git --version succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git version 2.40.0",
      stderr: "",
    });

    // stat throws (directory does not exist)
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    // git clone succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Cloning into...",
      stderr: "",
    });

    // SKILL.md exists
    fsMock.stat.mockResolvedValueOnce({
      isFile: () => true,
    });

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(true);
    expect(result.targetDir).toBe("/mock-home/.strada/skills/my-skill");
    expect(skillConfigMock.setSkillEnabled).toHaveBeenCalledWith("my-skill", true);
  });

  it("succeeds even when SKILL.md does not exist (non-fatal)", async () => {
    // git --version succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git version 2.40.0",
      stderr: "",
    });

    // stat throws (directory does not exist)
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    // git clone succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Cloning into...",
      stderr: "",
    });

    // SKILL.md does not exist
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(true);
    expect(skillConfigMock.setSkillEnabled).toHaveBeenCalledWith("my-skill", true);
  });

  // =========================================================================
  // Git clone arguments
  // =========================================================================

  it("passes correct arguments to git clone (shallow, HTTPS-only)", async () => {
    // git --version
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git version 2.40.0",
      stderr: "",
    });

    // stat throws (not installed)
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    // git clone succeeds
    execMock.execFileNoThrow.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    // SKILL.md
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    await installSkillFromRepo("test-skill", "https://github.com/owner/repo");

    const cloneCall = execMock.execFileNoThrow.mock.calls[1];
    expect(cloneCall[0]).toBe("git");
    expect(cloneCall[1]).toEqual([
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/owner/repo",
      "/mock-home/.strada/skills/test-skill",
    ]);
    // Should have timeout
    expect(cloneCall[2]).toBe(60_000);
    // Should restrict protocol to HTTPS
    expect(cloneCall[3]).toEqual({ GIT_ALLOW_PROTOCOL: "https" });
  });

  // =========================================================================
  // Cleanup failure is silent
  // =========================================================================

  it("does not throw if cleanup after failed clone also fails", async () => {
    // git --version
    execMock.execFileNoThrow.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    // stat throws
    fsMock.stat.mockRejectedValueOnce(new Error("ENOENT"));

    // git clone fails
    execMock.execFileNoThrow.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "error" });

    // rm throws too
    fsMock.rm.mockRejectedValueOnce(new Error("permission denied"));

    const result = await installSkillFromRepo("my-skill", "https://github.com/x/y");

    expect(result.success).toBe(false);
    // Should not throw -- error is swallowed
  });
});
