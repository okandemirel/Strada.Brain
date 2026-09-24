// plan 1.15 (audit 13F3 / D65 / Codex #23): workspace-skill trust records.
// Codex round 6 (2026-09-17) #6: the hash covers every regular file, not
// only code; #7: symlinked code is refused; #8: approve/revoke are serialised
// and a revocation is never resurrected.
// Codex round 7 (2026-09-17) #10: node_modules is hashed too; #11: the scan
// streams files and fails closed at file/byte/depth limits.
// Codex round 9 (2026-09-17) #7/#8: the JSON record and its pid+token lock
// file are gone. Mutual exclusion is SQLite's exclusive writer
// (`~/.strada/trusted-skills.db`), so no ownership claim outlives the
// connection holding it: a crashed writer blocks nothing (#8, pid reuse cannot
// make a dead owner look alive) and two writers cannot both be inside the
// protected mutation (#7, there is no lock to displace and no whole-document
// snapshot to lose an update). The pre-round-9 JSON is imported once.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILL_SCAN_LIMITS,
  LEGACY_JSON_IMPORT_MARKER,
  SKILL_SCAN_MAX_BYTES,
  SKILL_SCAN_MAX_DEPTH,
  SKILL_SCAN_MAX_FILES,
  approveWorkspaceSkill,
  assessWorkspaceSkillTrust,
  hashSkillContent,
  legacyTrustedSkillsJsonPath,
  openSkillTrustStore,
  projectIdentity,
  revokeWorkspaceSkill,
  scanSkillContent,
  trustedSkillsDbPath,
  type LegacyTrustedSkillsJson,
  type SkillScanLimits,
  type SkillTrustEntry,
  type TrustedSkillRecord,
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

/** Read one record the way another process would: its own connection, closed after. */
function readRecord(projectId: string, key: string): TrustedSkillRecord | undefined {
  const store = openSkillTrustStore();
  try {
    return store.get(projectId, key);
  } finally {
    store.close();
  }
}

/** Every approval recorded for a project, as another process sees it. */
function listRecords(projectId: string): readonly SkillTrustEntry[] {
  const store = openSkillTrustStore();
  try {
    return store.list(projectId);
  } finally {
    store.close();
  }
}

/** The only files that may sit beside the record: the database and its WAL pair. */
const SQLITE_FILES = new Set(["trusted-skills.db", "trusted-skills.db-shm", "trusted-skills.db-wal"]);

/** A pid that no longer exists: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.error || child.pid === undefined) throw child.error ?? new Error("no pid");
  return child.pid;
}

/** The pre-round-9 lock file line: `<pid> <token> <iso>`. */
const lockLine = (pid: number, token = `${pid}-deadbeef`): string => `${pid} ${token} ${new Date().toISOString()}\n`;

describe("trustedSkillsDbPath", () => {
  it("lives under the user's home, resolved at call time — never inside the project", () => {
    expect(trustedSkillsDbPath()).toBe(join(fakeHome, ".strada", "trusted-skills.db"));
    expect(trustedSkillsDbPath().startsWith(projectRoot)).toBe(false);
    expect(legacyTrustedSkillsJsonPath()).toBe(join(fakeHome, ".strada", "trusted-skills.json"));
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
    // Asking about an unknown skill creates no record file.
    await expect(access(trustedSkillsDbPath())).rejects.toThrow();

    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect(approval.recordPath).toBe(join(fakeHome, ".strada", "trusted-skills.db"));
    expect(approval.skillKey).toBe("skills/ws");
    expect(readRecord(approval.projectId, "skills/ws")!.sha256).toBe(approval.sha256);
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
    expect(readRecord(approval.projectId, "skills/ws")).toBeUndefined();
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "ws")).trusted).toBe(false);
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(false);
  });

  it("a trust record placed INSIDE the project is ignored (a checkout cannot approve itself)", async () => {
    const dir = await writeSkill("self", { "index.js": "export const tools = [];" });
    const sha = await hashSkillContent(dir);
    await mkdir(join(projectRoot, ".strada"), { recursive: true });
    const planted = { version: 1, projects: { [projectRoot]: { "skills/self": { sha256: sha, approvedAtIso: "now" } } } };
    await writeFile(join(projectRoot, ".strada", "trusted-skills.json"), JSON.stringify(planted), "utf-8");
    // A database inside the project is no authority either.
    const inProject = openSkillTrustStore({ path: join(projectRoot, ".strada", "trusted-skills.db") });
    try {
      inProject.approve(await projectIdentity(projectRoot), "skills/self", { sha256: sha!, fileCount: 1, approvedAtIso: "now" });
    } finally {
      inProject.close();
    }
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "self");
    expect(verdict.trusted).toBe(false);
  });

  it("a skill with no entry point imports nothing and needs no approval", async () => {
    const dir = await writeSkill("md-only", { "SKILL.md": "knowledge", "data.json": "{}" });
    expect(await assessWorkspaceSkillTrust(projectRoot, dir, "md-only")).toEqual({ trusted: true, sha256: null });
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/Nothing to approve/);
  });

  it("the record stores the file count and a record whose count does not match is untrusted until re-approved", async () => {
    const dir = await writeSkill("count", { "index.js": "code", "SKILL.md": "md", "lib/x.json": "{}" });
    const result = await approveWorkspaceSkill(projectRoot, dir);
    expect(result.fileCount).toBe(3);
    expect(readRecord(result.projectId, "skills/count")!.fileCount).toBe(3);

    // Same sha256 but a count that does not match → changed.
    const store = openSkillTrustStore();
    try {
      store.approve(result.projectId, "skills/count", { sha256: result.sha256, fileCount: 2, approvedAtIso: "x" });
    } finally {
      store.close();
    }
    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "count");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.reason).toContain("2 -> 3 file(s)");
  });

  it("a pre-round-6 record (no file count) is judged on its hash alone", async () => {
    const dir = await writeSkill("legacy-count", { "index.js": "code" });
    const projectId = await projectIdentity(projectRoot);
    const sha = (await hashSkillContent(dir))!;
    const store = openSkillTrustStore();
    try {
      store.approve(projectId, "skills/legacy-count", { sha256: sha, approvedAtIso: "x" });
      expect(store.get(projectId, "skills/legacy-count")).toEqual({ sha256: sha, approvedAtIso: "x" });
    } finally {
      store.close();
    }
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "legacy-count")).trusted).toBe(true);
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
    await expect(access(trustedSkillsDbPath())).rejects.toThrow();
  });

  it("a symlinked file next to a real entry point makes the skill untrusted even with a matching record; a symlinked directory too", async () => {
    const dir = await writeSkill("symlib", { "index.js": "export const tools = [];" });
    const approval = await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "symlib")).trusted).toBe(true);

    const target = join(fakeHome, "helper.js");
    await writeFile(target, "v1", "utf-8");
    await symlink(target, join(dir, "helper.js"));
    // Record the current hash anyway: the symlink must win.
    const store = openSkillTrustStore();
    try {
      store.approve(approval.projectId, "skills/symlib", { sha256: (await scanSkillContent(dir))!.sha256!, fileCount: 1, approvedAtIso: "x" });
    } finally {
      store.close();
    }
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

  // ---- SEC-1 ----------------------------------------------------------------
  // On a case-insensitive filesystem the loader's old `stat("index.js")` opened
  // `Index.js`; the scan must count such a file as code, never as "no entry".
  it("a differently-cased entry point is code: untrusted without approval, and cannot be approved (SEC-1)", async () => {
    const dir = await writeSkill("cased", { "SKILL.md": "x", "Index.js": "export const tools = [];" });
    expect((await scanSkillContent(dir))!.entryPoint).toBe("Index.js");

    const verdict = await assessWorkspaceSkillTrust(projectRoot, dir, "cased");
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error("unreachable");
    expect(verdict.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verdict.reason).toContain('"Index.js" is not named exactly index.ts or index.js');
    await expect(approveWorkspaceSkill(projectRoot, dir)).rejects.toThrow(/Index\.js" is not named exactly/);
    await expect(access(trustedSkillsDbPath())).rejects.toThrow();

    for (const variant of ["INDEX.TS", "index.Js"]) {
      const other = await writeSkill(`cased-${variant.replace(/\W/g, "")}`, { [variant]: "" });
      const v = await assessWorkspaceSkillTrust(projectRoot, other, "cased");
      expect(v.trusted).toBe(false);
    }
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
// round 9 #7/#8: the record is a SQLite row, and SQLite is the exclusion.
// ---------------------------------------------------------------------------
describe("trust records in SQLite (round 9 #7/#8)", () => {
  const rec = (sha: string): TrustedSkillRecord => ({ sha256: sha, fileCount: 1, approvedAtIso: new Date().toISOString() });

  it("two writers holding the same stale view both land: every mutation is a keyed upsert, never a whole-document replacement", async () => {
    const projectId = await projectIdentity(projectRoot);
    // Two "processes": two connections over one database file.
    const a = openSkillTrustStore({ busyTimeoutMs: 0 });
    const b = openSkillTrustStore({ busyTimeoutMs: 0 });
    try {
      // Both read the same view before either writes — the read-modify-write
      // interleaving that lost an update while a whole document was replaced.
      expect(a.list(projectId)).toEqual([]);
      expect(b.list(projectId)).toEqual([]);
      a.approve(projectId, "skills/a", rec("aaa"));
      b.approve(projectId, "skills/b", rec("bbb"));
      // A third connection sees both.
      expect(listRecords(projectId).map((e) => e.skillKey)).toEqual(["skills/a", "skills/b"]);
      // And each writer sees the other's row, with no local snapshot in between.
      expect(a.get(projectId, "skills/b")?.sha256).toBe("bbb");
      expect(b.get(projectId, "skills/a")?.sha256).toBe("aaa");
    } finally {
      a.close();
      b.close();
    }
  });

  it("a revocation is not resurrected by a concurrent approval of another skill", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const dirs: Record<string, string> = {};
    for (const n of names) dirs[n] = await writeSkill(n, { "index.js": `export const tools = []; // ${n}` });
    const approval = await approveWorkspaceSkill(projectRoot, dirs["a"]!);

    // Revoke a while approving the rest, all at once.
    const results = await Promise.all([
      revokeWorkspaceSkill(projectRoot, dirs["a"]!),
      ...names.slice(1).map((n) => approveWorkspaceSkill(projectRoot, dirs[n]!)),
    ]);
    expect(results[0]).toBe(true);

    expect(listRecords(approval.projectId).map((e) => e.skillKey)).toEqual(names.slice(1).map((n) => `skills/${n}`));
    expect((await assessWorkspaceSkillTrust(projectRoot, dirs["a"]!, "a")).trusted).toBe(false);
    for (const n of names.slice(1)) {
      expect((await assessWorkspaceSkillTrust(projectRoot, dirs[n]!, n)).trusted).toBe(true);
    }
    // Nothing beside the database: no lock, no temp file, no JSON.
    const leftovers = (await readdir(join(fakeHome, ".strada"))).sort();
    expect(leftovers).toContain("trusted-skills.db");
    expect(leftovers.filter((f) => !SQLITE_FILES.has(f))).toEqual([]);
  });

  it("an exclusive writer is not displaced: a competing write is refused while it is open and lands after the commit", async () => {
    const projectId = await projectIdentity(projectRoot);
    const store = openSkillTrustStore(); // creates the schema
    store.close();

    // Another process holds the writer, mid-mutation.
    const holder = new Database(trustedSkillsDbPath());
    holder.pragma("busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder
      .prepare("INSERT INTO trusted_skills (project_id, skill_key, sha256, file_count, approved_at_iso) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, "skills/holder", "hhh", 1, "now");

    const b = openSkillTrustStore({ busyTimeoutMs: 0 });
    try {
      // Refused — never granted alongside the holder.
      let refusal: NodeJS.ErrnoException | null = null;
      try {
        b.approve(projectId, "skills/b", rec("bbb"));
      } catch (err) {
        refusal = err as NodeJS.ErrnoException;
      }
      expect(refusal?.code).toBe("SQLITE_BUSY");
      expect(refusal?.message).toMatch(/database is locked/);
      expect(b.get(projectId, "skills/holder")).toBeUndefined(); // uncommitted, so invisible
      holder.exec("COMMIT");
      holder.close();
      // Retried after the commit, both rows stand.
      b.approve(projectId, "skills/b", rec("bbb"));
      expect(b.list(projectId).map((e) => e.skillKey)).toEqual(["skills/b", "skills/holder"]);
    } finally {
      b.close();
      if (holder.open) holder.close();
    }
  });

  it("an abandoned transaction leaves no record and no claim: the next writer proceeds at once", async () => {
    const projectId = await projectIdentity(projectRoot);
    const store = openSkillTrustStore();
    store.close();

    // A writer dies mid-mutation: its connection goes away without a commit.
    const dying = new Database(trustedSkillsDbPath());
    dying.exec("BEGIN IMMEDIATE");
    dying
      .prepare("INSERT INTO trusted_skills (project_id, skill_key, sha256, file_count, approved_at_iso) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, "skills/dying", "ddd", 1, "now");
    dying.close();

    const dir = await writeSkill("after", { "index.js": "export const tools = [];" });
    const started = Date.now();
    await approveWorkspaceSkill(projectRoot, dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readRecord(projectId, "skills/dying")).toBeUndefined();
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "after")).trusted).toBe(true);
  });

  it("a SIGKILLed writer blocks nothing — no pid outlives it to look alive (round 9 #8)", async () => {
    const projectId = await projectIdentity(projectRoot);
    const dbPath = trustedSkillsDbPath();
    openSkillTrustStore().close(); // schema

    const childSource = `
      const Database = require("better-sqlite3");
      const fs = require("fs");
      const db = new Database(process.argv[1]);
      db.pragma("journal_mode = WAL");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO trusted_skills (project_id, skill_key, sha256, file_count, approved_at_iso) VALUES (?, ?, ?, ?, ?)")
        .run(${JSON.stringify(projectId)}, "skills/killed", "kkk", 1, "now");
      fs.writeSync(1, "AT_CRASH_POINT\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `;
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", childSource, dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.includes("AT_CRASH_POINT")) resolve();
      });
      child.once("exit", (code) => reject(new Error(`the writer exited before its crash point (${code}): ${stderr}`)));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });

    // The writer is gone with the write lock it held and the row it never
    // committed. Its pid may be handed to any process; nothing consults one.
    const dir = await writeSkill("next", { "index.js": "export const tools = [];" });
    const started = Date.now();
    await approveWorkspaceSkill(projectRoot, dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readRecord(projectId, "skills/killed")).toBeUndefined();
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "next")).trusted).toBe(true);
  }, 25_000);

  it("a leftover trusted-skills.json.lock naming a LIVE pid blocks nothing (round 9 #8: pid reuse)", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    // The pre-round-9 lock of a crashed owner whose pid was handed to a live
    // process (this one). It used to make every acquisition wait out the
    // deadline, whatever the file's age, forever.
    const lock = `${legacyTrustedSkillsJsonPath()}.lock`;
    await writeFile(lock, lockLine(process.pid), "utf-8");
    const past = new Date(Date.now() - 3_600_000);
    await utimes(lock, past, past);
    const dir = await writeSkill("reused-pid", { "index.js": "export const tools = [];" });

    const started = Date.now();
    await approveWorkspaceSkill(projectRoot, dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "reused-pid")).trusted).toBe(true);
    // A dead owner's lock is equally irrelevant.
    await writeFile(lock, lockLine(deadPid()), "utf-8");
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
  });

  it("imports an existing trusted-skills.json once, moves it aside, and never lets it resurrect a later revocation", async () => {
    const dir = await writeSkill("carried", { "index.js": "export const tools = [];" });
    const projectId = await projectIdentity(projectRoot);
    const sha = (await hashSkillContent(dir))!;
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const jsonPath = legacyTrustedSkillsJsonPath();
    const legacy: LegacyTrustedSkillsJson = {
      version: 1,
      projects: {
        [projectId]: { "skills/carried": { sha256: sha, fileCount: 1, approvedAtIso: "2026-01-01T00:00:00.000Z" } },
        // A pre-round-6 record: no file count, and a project that is not ours.
        "/somewhere/else": { "skills/old": { sha256: "0".repeat(64) } as TrustedSkillRecord },
      },
    };
    await writeFile(jsonPath, JSON.stringify(legacy), "utf-8");
    await writeFile(`${jsonPath}.lock`, lockLine(process.pid), "utf-8");

    // Nobody has to re-approve: the carried record still means trusted.
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "carried")).trusted).toBe(true);
    expect(readRecord(projectId, "skills/carried")).toEqual({ sha256: sha, fileCount: 1, approvedAtIso: "2026-01-01T00:00:00.000Z" });
    expect(readRecord("/somewhere/else", "skills/old")).toEqual({ sha256: "0".repeat(64), approvedAtIso: new Date(0).toISOString() });

    // The JSON is no longer an authority: it is moved aside (contents kept) and
    // the dead lock file is gone.
    await expect(access(jsonPath)).rejects.toThrow();
    expect(JSON.parse(await readFile(`${jsonPath}.imported`, "utf-8"))).toEqual(legacy);
    await expect(access(`${jsonPath}.lock`)).rejects.toThrow();
    const store = openSkillTrustStore();
    try {
      expect(store.list(projectId).map((e) => e.skillKey)).toEqual(["skills/carried"]);
    } finally {
      store.close();
    }

    // Revoke, put the original JSON back, and reopen: the marker means it is
    // never imported again, so the revoked approval cannot come back.
    expect(await revokeWorkspaceSkill(projectRoot, dir)).toBe(true);
    await writeFile(jsonPath, JSON.stringify(legacy), "utf-8");
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "carried")).trusted).toBe(false);
    expect(readRecord(projectId, "skills/carried")).toBeUndefined();
    // The restored file is left exactly where the user put it.
    expect(JSON.parse(await readFile(jsonPath, "utf-8"))).toEqual(legacy);

    const marked = new Database(trustedSkillsDbPath(), { readonly: true });
    try {
      expect(marked.prepare("SELECT name FROM trust_migrations").pluck().all()).toEqual([LEGACY_JSON_IMPORT_MARKER]);
    } finally {
      marked.close();
    }
  });

  it("an unparseable trusted-skills.json imports nothing, is left in place, and does not stop approvals", async () => {
    await mkdir(join(fakeHome, ".strada"), { recursive: true });
    const jsonPath = legacyTrustedSkillsJsonPath();
    await writeFile(jsonPath, "{ this is not json", "utf-8");
    const dir = await writeSkill("broken-json", { "index.js": "export const tools = [];" });
    await approveWorkspaceSkill(projectRoot, dir);
    expect((await assessWorkspaceSkillTrust(projectRoot, dir, "broken-json")).trusted).toBe(true);
    expect(await readFile(jsonPath, "utf-8")).toBe("{ this is not json");
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
    // Refused before any record exists: not even the database was created.
    await expect(access(trustedSkillsDbPath())).rejects.toThrow();

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
