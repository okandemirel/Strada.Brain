// plan 1.15 (audit 13F3 / D65 / Codex #23): workspace-skill trust records.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveWorkspaceSkill,
  assessWorkspaceSkillTrust,
  hashSkillExecutableContent,
  revokeWorkspaceSkill,
  trustedSkillsPath,
} from "./skill-trust.js";

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

async function writeSkill(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(projectRoot, "skills", name);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content, "utf-8");
  }
  return dir;
}

describe("trustedSkillsPath", () => {
  it("lives under the user's home, resolved at call time — never inside the project", () => {
    expect(trustedSkillsPath()).toBe(join(fakeHome, ".strada", "trusted-skills.json"));
    expect(trustedSkillsPath().startsWith(projectRoot)).toBe(false);
  });
});

describe("hashSkillExecutableContent", () => {
  it("covers every .ts/.js/.mjs/.cjs under the directory (path + bytes), ignores other files, null when none", async () => {
    const dir = await writeSkill("h", { "index.js": "a", "lib/util.ts": "b", "x.mjs": "c", "y.cjs": "d", "SKILL.md": "md", "data.json": "{}" });
    const base = await hashSkillExecutableContent(dir);
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(dir, "SKILL.md"), "changed md", "utf-8");
    expect(await hashSkillExecutableContent(dir)).toBe(base);

    await writeFile(join(dir, "lib", "util.ts"), "b2", "utf-8");
    expect(await hashSkillExecutableContent(dir)).not.toBe(base);

    const empty = await writeSkill("empty", { "SKILL.md": "md" });
    expect(await hashSkillExecutableContent(empty)).toBeNull();
  });

  it("distinguishes the same bytes under a different path", async () => {
    const a = await writeSkill("pa", { "index.js": "same" });
    const b = await writeSkill("pb", { "index.js": "", "other.js": "same" });
    expect(await hashSkillExecutableContent(a)).not.toBe(await hashSkillExecutableContent(b));
  });
});

describe("assessWorkspaceSkillTrust / approve / revoke", () => {
  it("no record → untrusted with approval instructions; approve → trusted; edit → untrusted (changed); revoke → untrusted", async () => {
    const dir = await writeSkill("ws", { "index.js": "export const tools = [];", "SKILL.md": "x" });

    const before = await assessWorkspaceSkillTrust(projectRoot, dir, "ws");
    expect(before.trusted).toBe(false);
    if (before.trusted) throw new Error("unreachable");
    expect(before.reason).toContain("not approved");
    expect(before.reason).toContain("strada skill trust ws");

    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect(approval.recordPath).toBe(join(fakeHome, ".strada", "trusted-skills.json"));
    expect(approval.skillKey).toBe("skills/ws");
    const file = JSON.parse(await readFile(approval.recordPath, "utf-8")) as { projects: Record<string, Record<string, { sha256: string }>> };
    expect(file.projects[approval.projectId]!["skills/ws"]!.sha256).toBe(approval.sha256);
    // Nothing was written inside the project.
    await expect(access(join(projectRoot, ".strada"))).rejects.toThrow();

    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(true);

    await writeFile(join(dir, "index.js"), "export const tools = []; // edited", "utf-8");
    const changed = await assessWorkspaceSkillTrust(projectRoot, dir, "ws");
    expect(changed.trusted).toBe(false);
    if (changed.trusted) throw new Error("unreachable");
    expect(changed.reason).toContain("changed since approval");

    await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(true);

    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(false);
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(false);
  });

  it("a trusted-skills.json placed INSIDE the project is ignored (a checkout cannot approve itself)", async () => {
    const dir = await writeSkill("self", { "index.js": "export const tools = [];" });
    const sha = await hashSkillExecutableContent(dir);
    await mkdir(join(projectRoot, ".strada"), { recursive: true });
    const planted = { version: 1, projects: { [projectRoot]: { "skills/self": { sha256: sha, approvedAtIso: "now" } } } };
    await writeFile(join(projectRoot, ".strada", "trusted-skills.json"), JSON.stringify(planted), "utf-8");
    // Also with the realpath as key, in case tmpdir is symlinked.
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "self");
    expect(verdict.trusted).toBe(false);
  });

  it("a skill with no entry point imports nothing and needs no approval", async () => {
    const dir = await writeSkill("md-only", { "SKILL.md": "knowledge" });
    expect(await assessWorkspaceSkillTrust(projectRoot, dir, "md-only")).toEqual({ trusted: true, sha256: null });
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/Nothing to approve/);
  });

  it("the project identity is the realpath: an approval through a symlinked root applies to the real root", async () => {
    const dir = await writeSkill("sym", { "index.js": "export const tools = [];" });
    const link = join(fakeHome, "proj-link");
    await symlink(projectRoot, link);
    await approveWorkspaceSkill(link, join(link, "skills", "sym"));
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "sym")).trusted).toBe(true);
  });

  it("records for different projects with the same skill name do not bleed into each other", async () => {
    const dir = await writeSkill("shared", { "index.js": "export const tools = [];" });
    const other = await mkdtemp(join(tmpdir(), "strada-trust-other-"));
    try {
      const otherDir = join(other, "skills", "shared");
      await mkdir(otherDir, { recursive: true });
      await writeFile(join(otherDir, "index.js"), "export const tools = [];", "utf-8");
      await approveWorkspaceSkill(other, otherDir);
      expect((await assessWorkspaceSkillTrust(projectRoot, dir, "shared")).trusted).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
