/**
 * The state the runtime keeps per user — skills.json, installed skills, their
 * approvals, the Unity link, clone caches — follows the app home
 * (STRADA_HOME), and an install that kept it in ~/.strada does not lose it
 * when the app home is elsewhere. Real modules on a real disk, with HOME and
 * STRADA_HOME pointed at two separate temp directories.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillConfig, setSkillEnabled } from "../skills/skill-config.js";
import { legacyTrustedSkillsJsonPath, trustedSkillsDbPath } from "../skills/skill-trust.js";
import { discoverSkills } from "../skills/skill-loader.js";
import { unityLinkFilePath } from "../agents/tools/unity/asset-store-cloud.js";
import { stradaGitCacheRoot } from "../intelligence/strada-api-sync.js";

let root: string;
let home: string;
let appHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-home-state-"));
  home = join(root, "home");
  appHome = join(root, "app-home");
  mkdirSync(home);
  // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("STRADA_HOME", appHome);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeManagedSkill(dir: string, name: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: probe\n---\n`);
  return skillDir;
}

async function managedSkillPaths(): Promise<string[]> {
  return (await discoverSkills()).filter((skill) => skill.tier === "managed").map((skill) => skill.path);
}

describe("a fresh install keeps its per-user state in the app home, not homedir()/.strada", () => {
  it("skills.json", async () => {
    await setSkillEnabled("probe", false);
    expect(JSON.parse(readFileSync(join(appHome, "skills.json"), "utf8")).entries).toEqual({ probe: { enabled: false } });
    expect(existsSync(join(home, ".strada")), "wrote under the user's home").toBe(false);
  });

  it("installed skills, their approvals, the Unity link and the clone cache", async () => {
    expect(trustedSkillsDbPath()).toBe(join(appHome, "trusted-skills.db"));
    expect(legacyTrustedSkillsJsonPath()).toBe(join(appHome, "trusted-skills.json"));
    expect(unityLinkFilePath()).toBe(join(appHome, "unity-asset-store.json"));
    expect(stradaGitCacheRoot()).toBe(join(appHome, "framework-cache"));
    const installed = writeManagedSkill(join(appHome, "skills"), "fresh-skill");
    expect(await managedSkillPaths()).toEqual([installed]);
  });
});

describe("an install whose state is still in ~/.strada keeps it when STRADA_HOME names another home", () => {
  it("a skill disabled in ~/.strada/skills.json stays disabled, and a toggle keeps it (SEC-15)", async () => {
    const legacy = join(home, ".strada", "skills.json");
    mkdirSync(join(home, ".strada"));
    writeFileSync(legacy, JSON.stringify({ entries: { banned: { enabled: false } } }));

    expect((await readSkillConfig()).entries).toEqual({ banned: { enabled: false } });
    await setSkillEnabled("other", true);

    expect(JSON.parse(readFileSync(legacy, "utf8")).entries).toEqual({
      banned: { enabled: false },
      other: { enabled: true },
    });
    expect(existsSync(join(appHome, "skills.json")), "split into a second skills.json").toBe(false);
  });

  it("installed skills, their approvals and the Unity link are found where they are", async () => {
    const legacy = join(home, ".strada");
    const installed = writeManagedSkill(join(legacy, "skills"), "old-skill");
    writeFileSync(join(legacy, "trusted-skills.db"), "");
    writeFileSync(join(legacy, "unity-asset-store.json"), "{}");

    expect(await managedSkillPaths()).toEqual([installed]);
    expect(trustedSkillsDbPath()).toBe(join(legacy, "trusted-skills.db"));
    expect(unityLinkFilePath()).toBe(join(legacy, "unity-asset-store.json"));
  });
});
