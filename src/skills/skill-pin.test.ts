import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePin,
  readPin,
  recordPinnedCommit,
  describePinDrift,
  pullSkillCheckout,
  readCurrentGitSha,
} from "./skill-pin.js";

describe("skill-pin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-skill-pin-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a written pin", async () => {
    await writePin(dir, "abc123def4567890");
    const pin = await readPin(dir);
    expect(pin?.pinnedSha).toBe("abc123def4567890");
    expect(pin?.pinnedAtIso).toBeTruthy();
  });

  it("returns null pin when none was recorded", async () => {
    expect(await readPin(dir)).toBeNull();
  });

  it("recordPinnedCommit is null for a non-git directory (workspace skills)", async () => {
    expect(await recordPinnedCommit(dir)).toBeNull();
    expect(await readPin(dir)).toBeNull();
  });

  it("reports nothing for a never-pinned directory (workspace skills)", async () => {
    expect(await describePinDrift(dir, "my-skill")).toBeNull();
  });

  // audited 2026-09-02: a pin with no readable HEAD used to return null — the
  // same answer as "verified clean" — so a checkout that lost its .git (or a
  // git binary that failed) read exactly like a pin that matched.
  it("says the pin CANNOT be verified when a pinned dir has no readable git HEAD", async () => {
    await writePin(dir, "abc123def4567890");
    const msg = await describePinDrift(dir, "my-skill");
    expect(msg).not.toBeNull();
    expect(msg).toContain("abc123def");
    expect(msg).toContain("cannot be verified");
    expect(msg).toContain("my-skill");
  });

  it("is clean at the pinned commit, and unverifiable once .git is removed out of band", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const sha = await recordPinnedCommit(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await describePinDrift(dir, "my-skill")).toBeNull();

    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const msg = await describePinDrift(dir, "my-skill");
    expect(msg).toContain("cannot be verified");
    expect(msg).toContain(sha!.slice(0, 9));
  });

  // SEC-16: git walked up from a skill dir with no .git and pinned/pulled the
  // enclosing repository instead.
  it("never reads or pulls an enclosing repository for a skill dir without .git", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const skill = join(dir, "skills", "inner");
    mkdirSync(skill, { recursive: true });

    expect(await readCurrentGitSha(skill)).toBeNull();
    expect(await recordPinnedCommit(skill)).toBeNull();
    const pulled = await pullSkillCheckout(skill);
    expect(pulled.exitCode).not.toBe(0);
    expect(pulled.stderr).toMatch(/not a git repository/i);
  });

  it("updates over https only, as install does", async () => {
    const origin = join(dir, "origin.git");
    const checkout = join(dir, "skill");
    execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "pipe" });
    const pulled = await pullSkillCheckout(checkout);
    expect(pulled.exitCode).not.toBe(0);
    expect(pulled.stderr).toMatch(/transport 'file' not allowed/);
  });
});
