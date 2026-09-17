// plan 1.15 (audit 13F3 / D65 / Codex #23): workspace-skill trust records.
// Codex round 6 (2026-09-17) #6: the hash covers every regular file, not
// only code; #7: symlinked code is refused; #8: approve/revoke are locked and
// the record is replaced atomically.
// Codex round 7 (2026-09-17) #10: node_modules is hashed too; #11: the scan
// streams files and fails closed at file/byte/depth limits; #12: the lock
// carries an ownership token — only a dead owner is displaced, only the
// owner unlinks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILL_SCAN_LIMITS,
  SKILL_SCAN_MAX_BYTES,
  SKILL_SCAN_MAX_DEPTH,
  SKILL_SCAN_MAX_FILES,
  approveWorkspaceSkill,
  assessWorkspaceSkillTrust,
  hashSkillContent,
  revokeWorkspaceSkill,
  scanSkillContent,
  trustedSkillsLockPath,
  trustedSkillsPath,
  updateTrustFile,
  type SkillScanLimits,
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

/** A pid that no longer exists: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.error || child.pid === undefined) throw child.error ?? new Error("no pid");
  return child.pid;
}

/** `<pid> <token> <iso>` — the lock file's format. */
const lockLine = (pid: number, token = `${pid}-deadbeef`): string => `${pid} ${token} ${new Date().toISOString()}\n`;

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

  it("excludes only .git/ — node_modules/ is hashed like any other code (round 7 #10)", async () => {
    const dir = await writeSkill("ex", { "index.js": "a", "node_modules/dep/index.js": "dep", ".git/HEAD": "ref", "lib/node_modules/x.js": "nested" });
    const scan = await scanSkillContent(dir);
    expect(scan!.fileCount).toBe(3);
    await writeFile(join(dir, ".git", "HEAD"), "ref2", "utf-8");
    expect((await scanSkillContent(dir))!.sha256).toBe(scan!.sha256);
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "dep2", "utf-8");
    expect((await scanSkillContent(dir))!.sha256).not.toBe(scan!.sha256);
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
    const forged: TrustedSkillsFile = { version: 1, projects: { [approval.projectId]: { "skills/symlib": { sha256: (await scanSkillContent(dir))!.sha256!, fileCount: 1, approvedAtIso: "x" } } } };
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

  it("waits for a lock held by a live process and takes over one whose owner is dead", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const lock = trustedSkillsLockPath();
    await writeFile(lock, lockLine(process.pid), "utf-8");
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

    // Abandoned lock: its owner pid is dead → taken over, the write proceeds at once.
    await writeFile(lock, lockLine(deadPid()), "utf-8");
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    await expect(access(lock)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// round 7 #10: dependency bytes are executable content.
// ---------------------------------------------------------------------------
describe("node_modules is part of the trust hash (round 7 #10)", () => {
  it("replacing a dependency under node_modules changes the hash and invalidates the approval", async () => {
    const dir = await writeSkill("deps", {
      "index.js": "import './node_modules/dep/index.js'; export const tools = [];",
      "node_modules/dep/index.js": "export const v = 1;",
      "node_modules/dep/package.json": '{"name":"dep","main":"index.js"}',
    });
    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect(approval.fileCount).toBe(3);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "deps")).trusted).toBe(true);

    await writeFile(join(dir, "node_modules", "dep", "index.js"), "process.exit(1);", "utf-8");
    expect(await hashSkillContent(dir)).not.toBe(approval.sha256);
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "deps");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("changed since approval");

    // A dependency ADDED under node_modules counts too (file count 3 -> 4).
    await approveWorkspaceSkill(projectRoot, dir);
    await writeFile(join(dir, "node_modules", "dep", "extra.js"), "", "utf-8");
    const added = await assessWorkspaceSkillTrust(projectRoot, dir, "deps");
    expect(added.trusted).toBe(false);
    if (added.trusted) throw new Error("unreachable");
    expect(added.reason).toContain("3 -> 4 file(s)");
  });
});

// ---------------------------------------------------------------------------
// round 7 #11: streamed hashing, explicit budget, fail closed.
// ---------------------------------------------------------------------------
describe("scan limits (round 7 #11)", () => {
  it("exposes the defaults as named constants", () => {
    expect(SKILL_SCAN_MAX_FILES).toBe(5_000);
    expect(SKILL_SCAN_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(SKILL_SCAN_MAX_DEPTH).toBe(12);
    expect(DEFAULT_SKILL_SCAN_LIMITS).toEqual({ maxFiles: 5_000, maxBytes: 200 * 1024 * 1024, maxDepth: 12 });
  });

  it("a file pushing the total over the byte limit → no hash, untrusted with the limit named, not approvable", async () => {
    const dir = await writeSkill("bytes", { "index.js": "export const tools = [];", "asset.bin": "x".repeat(200) });
    const limits: SkillScanLimits = { ...DEFAULT_SKILL_SCAN_LIMITS, maxBytes: 100 };
    const scan = await scanSkillContent(dir, limits);
    expect(scan!.sha256).toBeNull();
    expect(scan!.exceeded).toEqual({ limit: "bytes", max: 100, at: "asset.bin" });
    expect(await hashSkillContent(dir, limits)).toBeNull();

    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "bytes", limits);
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.sha256).toBeNull();
    expect(verdict.reason).toContain("bytes");
    expect(verdict.reason).toContain("more than 100 bytes");
    expect(verdict.reason).toContain("asset.bin");
    await expect(approveWorkspaceSkill(projectRoot, dir, limits)).rejects.toThrow(/more than 100 bytes/);
    await expect(access(trustedSkillsPath())).rejects.toThrow();

    // Within budget the same content hashes identically to the default limits
    // (the budget never enters the hash), and the total is reported.
    const roomy = await scanSkillContent(dir, { ...DEFAULT_SKILL_SCAN_LIMITS, maxBytes: 224 });
    expect(roomy!.sha256).toBe((await scanSkillContent(dir))!.sha256);
    expect(roomy!.byteCount).toBe(224);
    expect(roomy!.exceeded).toBeNull();
  });

  it("a file spanning several read chunks streams into the same hash as a whole-buffer digest", async () => {
    const big = Buffer.alloc(3 * 64 * 1024 + 17, 7);
    const dir = await writeSkill("stream", { "index.js": "" });
    await writeFile(join(dir, "blob.bin"), big);
    const expected = createHash("sha256")
      .update("blob.bin").update("\0").update(big).update("\0")
      .update("index.js").update("\0").update("").update("\0")
      .digest("hex");
    expect(await hashSkillContent(dir)).toBe(expected);
  });

  it("too many files → untrusted with the limit named; the count limit is exact", async () => {
    const dir = await writeSkill("many", { "index.js": "", "a.js": "", "b.js": "", "c.js": "" });
    const ok = await scanSkillContent(dir, { ...DEFAULT_SKILL_SCAN_LIMITS, maxFiles: 4 });
    expect(ok!.exceeded).toBeNull();
    expect(ok!.fileCount).toBe(4);

    const limits: SkillScanLimits = { ...DEFAULT_SKILL_SCAN_LIMITS, maxFiles: 3 };
    const scan = await scanSkillContent(dir, limits);
    expect(scan!.sha256).toBeNull();
    expect(scan!.exceeded!.limit).toBe("files");
    expect(scan!.exceeded!.max).toBe(3);
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "many", limits);
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("files");
    expect(verdict.reason).toContain("more than 3 files");
    await expect(approveWorkspaceSkill(projectRoot, dir, limits)).rejects.toThrow(/more than 3 files/);
  });

  it("nesting beyond the depth limit → untrusted with the limit named", async () => {
    const dir = await writeSkill("deep", { "index.js": "", "a/b.js": "", "a/b/c.js": "" });
    expect((await scanSkillContent(dir, { ...DEFAULT_SKILL_SCAN_LIMITS, maxDepth: 3 }))!.exceeded).toBeNull();
    const limits: SkillScanLimits = { ...DEFAULT_SKILL_SCAN_LIMITS, maxDepth: 2 };
    const scan = await scanSkillContent(dir, limits);
    expect(scan!.sha256).toBeNull();
    expect(scan!.exceeded).toEqual({ limit: "depth", max: 2, at: "a/b" });
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "deep", limits);
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("depth");
    expect(verdict.reason).toContain("deeper than 2 levels");
    await expect(approveWorkspaceSkill(projectRoot, dir, limits)).rejects.toThrow(/deeper than 2 levels/);
  });

  it("fails closed even without an entry point, and a matching record does not rescue an over-budget skill", async () => {
    const dir = await writeSkill("budget", { "index.js": "export const tools = [];" });
    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect(approval.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "budget")).trusted).toBe(true);
    const tight: SkillScanLimits = { ...DEFAULT_SKILL_SCAN_LIMITS, maxBytes: 1 };
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "budget", tight);
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("bytes");

    const mdOnly = await writeSkill("budget-md", { "SKILL.md": "x".repeat(50) });
    expect((await assessWorkspaceSkillTrust(projectRoot, mdOnly, "budget-md")).trusted).toBe(true);
    expect((await assessWorkspaceSkillTrust(projectRoot, mdOnly, "budget-md", tight)).trusted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// round 7 #12: lock ownership.
// ---------------------------------------------------------------------------
describe("lock ownership token (round 7 #12)", () => {
  it("the lock file records the owner's pid and a token", async () => {
    let seen = "";
    await updateTrustFile(async () => {
      seen = await readFile(trustedSkillsLockPath(), "utf-8");
      return { next: null, result: undefined };
    });
    const [pid, token] = seen.trim().split(/\s+/);
    expect(Number(pid)).toBe(process.pid);
    expect(token).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{24}$`));
    await expect(access(trustedSkillsLockPath())).rejects.toThrow();
  });

  it("a lock held by a live pid is NOT stolen after the age ceiling (mtime 60 s old)", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const lock = trustedSkillsLockPath();
    const held = lockLine(process.pid);
    await writeFile(lock, held, "utf-8");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    const dir = await writeSkill("held", { "index.js": "x" });

    const pending = approveWorkspaceSkill(projectRoot, dir);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    // Still the holder's file, untouched.
    expect(await readFile(lock, "utf-8")).toBe(held);
    await rm(lock);
    await pending;
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "held")).trusted).toBe(true);
  });

  it("a lock whose owning pid is dead IS taken, however fresh its mtime", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const lock = trustedSkillsLockPath();
    await writeFile(lock, lockLine(deadPid()), "utf-8");
    const dir = await writeSkill("orphan", { "index.js": "x" });
    const started = Date.now();
    await approveWorkspaceSkill(projectRoot, dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "orphan")).trusted).toBe(true);
    await expect(access(lock)).rejects.toThrow();
    const leftovers = (await readdir(join(fakeHome, ".strada"))).filter((f) => f !== "trusted-skills.json");
    expect(leftovers).toEqual([]);
  });

  it("a lock file naming no owner falls back to mtime: fresh → waited for, older than 30 s → taken", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const lock = trustedSkillsLockPath();
    const dir = await writeSkill("legacy", { "index.js": "x" });

    await writeFile(lock, "garbage\n", "utf-8");
    const pending = approveWorkspaceSkill(projectRoot, dir);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await rm(lock);
    await pending;

    await writeFile(lock, "garbage\n", "utf-8");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    await expect(access(lock)).rejects.toThrow();
  });

  it("release with a foreign token does not unlink, and the record is not written over a lost lock", async () => {
    const lock = trustedSkillsLockPath();
    const foreign = lockLine(process.pid, `${process.pid}-someoneelse`);

    // The lock is replaced under us (as a taker would after a wrong staleness
    // call): our release must leave the new holder's file alone.
    await updateTrustFile(async () => {
      await writeFile(lock, foreign, "utf-8");
      return { next: null, result: undefined };
    });
    expect(await readFile(lock, "utf-8")).toBe(foreign);

    // With a write pending, a lost lock refuses the write instead of
    // clobbering whatever the new holder wrote.
    await writeFile(trustedSkillsPath(), JSON.stringify({ version: 1, projects: { theirs: {} } }), "utf-8");
    await rm(lock);
    await expect(updateTrustFile(async () => {
      await writeFile(lock, foreign, "utf-8");
      return { next: { version: 1, projects: { mine: {} } }, result: undefined };
    })).rejects.toThrow(/Lost .*\.lock/);
    expect(JSON.parse(await readFile(trustedSkillsPath(), "utf-8"))).toEqual({ version: 1, projects: { theirs: {} } });
    expect(await readFile(lock, "utf-8")).toBe(foreign);
    await rm(lock);
  });
});
