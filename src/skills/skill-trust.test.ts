// plan 1.15 (audit 13F3 / D65 / Codex #23): workspace-skill trust records.
// Codex round 6 (2026-09-17) #6: the hash covers every regular file, not
// only code; #7: symlinked code is refused; #8: approve/revoke are locked and
// the record is replaced atomically.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveWorkspaceSkill,
  assessWorkspaceSkillTrust,
  hashSkillContent,
  revokeWorkspaceSkill,
  scanSkillContent,
  trustedSkillsLockPath,
  trustedSkillsPath,
  updateTrustFile,
  type TrustedSkillsFile,
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

describe("scanSkillContent / hashSkillContent (round 6 #6)", () => {
  it("covers EVERY regular file under the directory (path + bytes) and counts them; null when there is none", async () => {
    const dir = await writeSkill("h", { "index.js": "a", "lib/util.ts": "b", "x.mjs": "c", "SKILL.md": "md", "data.json": "{}", "package.json": '{"main":"index.js"}' });
    const scan = await scanSkillContent(dir);
    expect(scan!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scan!.fileCount).toBe(6);
    expect(scan!.symlinks).toEqual([]);
    expect(scan!.entryPoint).toBe("index.js");
    const base = scan!.sha256;

    // Non-code files that index.js may load or that steer module resolution.
    await writeFile(join(dir, "data.json"), '{"changed":true}', "utf-8");
    const afterJson = await hashSkillContent(dir);
    expect(afterJson).not.toBe(base);
    await writeFile(join(dir, "package.json"), '{"main":"other.js"}', "utf-8");
    const afterPkg = await hashSkillContent(dir);
    expect(afterPkg).not.toBe(afterJson);
    await writeFile(join(dir, "SKILL.md"), "changed md", "utf-8");
    expect(await hashSkillContent(dir)).not.toBe(afterPkg);
    await writeFile(join(dir, "native.node"), "\x00binary", "utf-8");
    expect((await scanSkillContent(dir))!.fileCount).toBe(7);

    await writeFile(join(dir, "lib", "util.ts"), "b2", "utf-8");
    expect(await hashSkillContent(dir)).not.toBe(base);

    const none = join(projectRoot, "skills", "none");
    await mkdir(none, { recursive: true });
    expect(await scanSkillContent(none)).toBeNull();
    expect(await hashSkillContent(none)).toBeNull();
    const mdOnly = await writeSkill("md-only", { "SKILL.md": "md" });
    expect((await scanSkillContent(mdOnly))!.entryPoint).toBeNull();
  });

  it("excludes only node_modules/ and .git/", async () => {
    const dir = await writeSkill("ex", { "index.js": "a", "node_modules/dep/index.js": "dep", ".git/HEAD": "ref", "lib/node_modules/x.js": "nested" });
    const scan = await scanSkillContent(dir);
    expect(scan!.fileCount).toBe(1);
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "dep2", "utf-8");
    await writeFile(join(dir, ".git", "HEAD"), "ref2", "utf-8");
    expect((await scanSkillContent(dir))!.sha256).toBe(scan!.sha256);
  });

  it("distinguishes the same bytes under a different path", async () => {
    const a = await writeSkill("pa", { "index.js": "same" });
    const b = await writeSkill("pb", { "index.js": "", "other.js": "same" });
    expect(await hashSkillContent(a)).not.toBe(await hashSkillContent(b));
  });

  it("reports symlinks without following them (round 6 #7)", async () => {
    const dir = await writeSkill("sl", { "index.js": "a" });
    const target = join(fakeHome, "outside.js");
    await writeFile(target, "v1", "utf-8");
    await symlink(target, join(dir, "linked.js"));
    const scan = await scanSkillContent(dir);
    expect(scan!.symlinks).toEqual(["linked.js"]);
    expect(scan!.fileCount).toBe(1);
    await writeFile(target, "v2", "utf-8");
    expect((await scanSkillContent(dir))!.sha256).toBe(scan!.sha256);
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

    // #6: a non-code file the code may load counts as a change too.
    await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(true);
    await writeFile(join(dir, "config.json"), '{"endpoint":"evil"}', "utf-8");
    const jsonChanged = await assessWorkspaceSkillTrust(projectRoot, dir, "ws");
    expect(jsonChanged.trusted).toBe(false);
    if (jsonChanged.trusted) throw new Error("unreachable");
    expect(jsonChanged.reason).toContain("changed since approval");
    expect(jsonChanged.reason).toContain("2 -> 3 file(s)");

    await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(true);

    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(false);
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(false);
  });

  it("a trusted-skills.json placed INSIDE the project is ignored (a checkout cannot approve itself)", async () => {
    const dir = await writeSkill("self", { "index.js": "export const tools = [];" });
    const sha = await hashSkillContent(dir);
    await mkdir(join(projectRoot, ".strada"), { recursive: true });
    const planted = { version: 1, projects: { [projectRoot]: { "skills/self": { sha256: sha, approvedAtIso: "now" } } } };
    await writeFile(join(projectRoot, ".strada", "trusted-skills.json"), JSON.stringify(planted), "utf-8");
    // Also with the realpath as key, in case tmpdir is symlinked.
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "self");
    expect(verdict.trusted).toBe(false);
  });

  it("a skill with no entry point imports nothing and needs no approval", async () => {
    const dir = await writeSkill("md-only", { "SKILL.md": "knowledge", "data.json": "{}" });
    expect(await assessWorkspaceSkillTrust(projectRoot, dir, "md-only")).toEqual({ trusted: true, sha256: null });
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/Nothing to approve/);
  });

  it("the record stores the file count and a pre-round-6 record (code-only hash, no count) is untrusted until re-approved", async () => {
    const dir = await writeSkill("count", { "index.js": "code", "SKILL.md": "md", "lib/x.json": "{}" });
    const result = await approveWorkspaceSkill(projectRoot, dir);
    expect(result.fileCount).toBe(3);
    const file = JSON.parse(await readFile(result.recordPath, "utf-8")) as TrustedSkillsFile;
    expect(file.projects[result.projectId]!["skills/count"]!.fileCount).toBe(3);

    // Same sha256 but a count that does not match → changed.
    const forged: TrustedSkillsFile = { version: 1, projects: { [result.projectId]: { "skills/count": { sha256: result.sha256, fileCount: 2, approvedAtIso: "x" } } } };
    await writeFile(result.recordPath, JSON.stringify(forged), "utf-8");
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "count");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("2 -> 3 file(s)");
  });

  // ---- round 6 #7 ---------------------------------------------------------
  it("a symlinked entry point is untrusted and cannot be approved", async () => {
    const dir = join(projectRoot, "skills", "symentry");
    await mkdir(dir, { recursive: true });
    const target = join(fakeHome, "real-index.js");
    await writeFile(target, "export const tools = [];", "utf-8");
    await symlink(target, join(dir, "index.js"));

    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "symentry");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("symlinked code");
    expect(verdict.reason).toContain("cannot be approved");
    expect(verdict.reason).toContain("index.js");
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/symlinked code, which cannot be approved/);
    await expect(access(trustedSkillsPath())).rejects.toThrow();
  });

  it("a symlinked file next to a real entry point makes the skill untrusted even with a matching record; a symlinked directory too", async () => {
    const dir = await writeSkill("symlib", { "index.js": "export const tools = [];" });
    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "symlib")).trusted).toBe(true);

    const target = join(fakeHome, "helper.js");
    await writeFile(target, "v1", "utf-8");
    await symlink(target, join(dir, "helper.js"));
    // Plant a record matching the current hash anyway: the symlink must win.
    const forged: TrustedSkillsFile = { version: 1, projects: { [approval.projectId]: { "skills/symlib": { sha256: (await scanSkillContent(dir))!.sha256, fileCount: 1, approvedAtIso: "x" } } } };
    await writeFile(approval.recordPath, JSON.stringify(forged), "utf-8");
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "symlib");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("helper.js");
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/symlinked code/);

    await rm(join(dir, "helper.js"));
    const outsideDir = join(fakeHome, "outside-lib");
    await mkdir(outsideDir);
    await symlink(outsideDir, join(dir, "lib"));
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/lib/);
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

// ---------------------------------------------------------------------------
// round 6 #8: concurrent approve/revoke must not lose an update.
// ---------------------------------------------------------------------------
describe("trust record locking (round 6 #8)", () => {
  it("two interleaved read-modify-write sequences both land (the second waits for the first)", async () => {
    let releaseFirst!: () => void;
    const firstMayWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondStarted = false;

    const first = updateTrustFile(async (file) => {
      await firstMayWrite;
      return { next: { version: 1, projects: { ...file.projects, first: { a: { sha256: "1", approvedAtIso: "" } } } }, result: "first" };
    });
    // Let the first sequence acquire the lock and enter its mutator.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = updateTrustFile((file) => {
      secondStarted = true;
      return { next: { version: 1, projects: { ...file.projects, second: { b: { sha256: "2", approvedAtIso: "" } } } }, result: "second" };
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Without the lock the second sequence would already have read the file
    // (without "first") and written it, and "first" would be lost below.
    expect(secondStarted).toBe(false);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);

    const file = JSON.parse(await readFile(trustedSkillsPath(), "utf-8")) as TrustedSkillsFile;
    expect(Object.keys(file.projects).sort()).toEqual(["first", "second"]);
    await expect(access(trustedSkillsLockPath())).rejects.toThrow();
  });

  it("a revocation is not resurrected by a concurrent approval of another skill", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const dirs: Record<string, string> = {};
    for (const n of names) dirs[n] = await writeSkill(n, { "index.js": `export const tools = []; // ${n}` });
    await approveWorkspaceSkill(projectRoot, dirs["a"]!);

    // Revoke a while approving the rest, all at once.
    const results = await Promise.all([
      revokeWorkspaceSkill(projectRoot, dirs["a"]!),
      ...names.slice(1).map((n) => approveWorkspaceSkill(projectRoot, dirs[n]!)),
    ]);
    expect(results[0]).toBe(true);

    const file = JSON.parse(await readFile(trustedSkillsPath(), "utf-8")) as TrustedSkillsFile;
    const keys = Object.keys(Object.values(file.projects)[0]!).sort();
    expect(keys).toEqual(names.slice(1).map((n) => `skills/${n}`));
    expect((await assessWorkspaceSkillTrust(projectRoot, dirs["a"]!, "a")).trusted).toBe(false);
    for (const n of names.slice(1)) {
      expect((await assessWorkspaceSkillTrust(projectRoot, dirs[n]!, n)).trusted).toBe(true);
    }
    // No temp file or lock left behind.
    const leftovers = (await readdir(join(fakeHome, ".strada"))).filter((f) => f !== "trusted-skills.json");
    expect(leftovers).toEqual([]);
  });

  it("waits for a lock held by another process and breaks one that is stale (older than 30 s)", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const lock = trustedSkillsLockPath();
    await writeFile(lock, "999999 held\n", "utf-8");
    const dir = await writeSkill("locked", { "index.js": "x" });

    const started = Date.now();
    const pending = approveWorkspaceSkill(projectRoot, dir);
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await rm(lock);
    await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "locked")).trusted).toBe(true);

    // Stale lock: mtime 60 s in the past → removed and the write proceeds at once.
    await writeFile(lock, "1 dead\n", "utf-8");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    await expect(access(lock)).rejects.toThrow();
  });
});
