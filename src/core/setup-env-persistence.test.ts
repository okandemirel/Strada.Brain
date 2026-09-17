/**
 * Plan 2.1 (audit 10.1b / D24, D29, D30): setup persistence MERGES into the
 * existing .env — hand-added keys and comments survive, wizard-owned keys are
 * replaced in place or removed, defaults never reset a hand-edited value, and
 * the effective file is read back from disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as dotenvParse } from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeEffectiveBudget,
  ENV_SAVE_LOCK,
  mergeEnvContent,
  parseEnvLines,
  persistSetup,
  recoverAbandonedLock,
  redactEffectiveConfig,
} from "./setup-env-persistence.js";

describe("mergeEnvContent", () => {
  const owned = ["UNITY_PROJECT_PATH", "PROVIDER_CHAIN", "KIMI_API_KEY", "DEEPSEEK_API_KEY", "STRADA_BUDGET_DAILY_USD"];
  const defaults = ["LOG_LEVEL"];

  it("replaces owned keys in place, keeps comments and unknown keys, appends the rest", () => {
    const existing = [
      "# header comment",
      "UNITY_PROJECT_PATH=/old",
      "",
      "# hand-added",
      "MY_KEY=keep-me",
      "LOG_LEVEL=debug",
      "",
    ].join("\n");
    const updates = parseEnvLines([
      "# Generated",
      'UNITY_PROJECT_PATH="/new"',
      'PROVIDER_CHAIN="kimi"',
      "LOG_LEVEL=info",
    ]);

    const result = mergeEnvContent(existing, updates, { ownedKeys: owned, defaultKeys: defaults });

    expect(result.content.split("\n")).toEqual([
      "# header comment",
      'UNITY_PROJECT_PATH="/new"',
      "",
      "# hand-added",
      "MY_KEY=keep-me",
      "LOG_LEVEL=debug",
      "",
      "# Added by Strada.Brain Setup Wizard",
      'PROVIDER_CHAIN="kimi"',
      "",
    ]);
    expect(result.replaced).toEqual(["UNITY_PROJECT_PATH"]);
    expect(result.added).toEqual(["PROVIDER_CHAIN"]);
    expect(result.preserved).toEqual(expect.arrayContaining(["MY_KEY", "LOG_LEVEL"]));
  });

  it("removes an owned key the wizard no longer emits, never a foreign one", () => {
    const existing = "DEEPSEEK_API_KEY=sk-stale\nFOREIGN=1\n";
    const result = mergeEnvContent(existing, parseEnvLines(['KIMI_API_KEY="sk-kimi"']), { ownedKeys: owned });
    expect(result.content).not.toContain("DEEPSEEK_API_KEY");
    expect(result.content).toContain("FOREIGN=1");
    expect(result.removed).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("drops a later duplicate of a rewritten key so the new value is what dotenv reads", () => {
    const existing = "PROVIDER_CHAIN=a\nX=1\nPROVIDER_CHAIN=b\n";
    const result = mergeEnvContent(existing, parseEnvLines(['PROVIDER_CHAIN="kimi"']), { ownedKeys: owned });
    expect(result.content.match(/PROVIDER_CHAIN=/g)).toHaveLength(1);
    expect(result.content).toContain('PROVIDER_CHAIN="kimi"');
  });

  it("moves a multi-line quoted value as one block", () => {
    const existing = 'CERT="line1\nline2"\nUNITY_PROJECT_PATH=/old\n';
    const result = mergeEnvContent(existing, parseEnvLines(['UNITY_PROJECT_PATH="/new"']), { ownedKeys: owned });
    expect(result.content).toBe('CERT="line1\nline2"\nUNITY_PROJECT_PATH="/new"\n');
  });
});

describe("persistSetup", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes generated lines verbatim on a first run and reads the effective map back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-persist-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    const result = await persistSetup(envPath, ["# Generated", 'KIMI_API_KEY="sk-kimi"', "STRADA_BUDGET_DAILY_USD=0"], { ownedKeys: [] });
    expect(fs.readFileSync(envPath, "utf-8")).toBe('# Generated\nKIMI_API_KEY="sk-kimi"\nSTRADA_BUDGET_DAILY_USD=0\n');
    expect(result.effective).toEqual({ KIMI_API_KEY: "sk-kimi", STRADA_BUDGET_DAILY_USD: "0" });
  });

  it("keeps a hand-added key across a second save (2.1 / D29)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-persist-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\nKIMI_API_KEY=old\n");
    const result = await persistSetup(envPath, ['KIMI_API_KEY="new"'], { ownedKeys: ["KIMI_API_KEY"] });
    expect(result.effective).toEqual({ HAND_ADDED: "yes", KIMI_API_KEY: "new" });
    expect(result.preserved).toEqual(["HAND_ADDED"]);
  });
});

describe("describeEffectiveBudget / redactEffectiveConfig", () => {
  it("shows 0 as zero and only a missing key as unlimited (2.1 / D30)", () => {
    expect(describeEffectiveBudget({ STRADA_BUDGET_DAILY_USD: "0" })).toEqual({ dailyUsd: 0, unlimited: false, display: "$0.00" });
    expect(describeEffectiveBudget({ STRADA_BUDGET_DAILY_USD: "12.5" })).toEqual({ dailyUsd: 12.5, unlimited: false, display: "$12.50" });
    expect(describeEffectiveBudget({})).toEqual({ dailyUsd: null, unlimited: true, display: "unlimited" });
  });

  it("reduces secrets to a presence marker", () => {
    expect(redactEffectiveConfig({ KIMI_API_KEY: "sk-1", ANTHROPIC_AUTH_TOKEN: "t", LOG_LEVEL: "info", EMPTY_API_KEY: "" }))
      .toEqual({ KIMI_API_KEY: "<set>", ANTHROPIC_AUTH_TOKEN: "<set>", LOG_LEVEL: "info", EMPTY_API_KEY: "" });
  });
});

describe("persistSetup atomicity and serialization (round 8 #10)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the file by rename, so a reader never sees a truncated .env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-atomic-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\nKIMI_API_KEY=old\n");
    const before = fs.statSync(envPath).ino;
    await persistSetup(envPath, ['KIMI_API_KEY="new"'], { ownedKeys: ["KIMI_API_KEY"] });
    // writeFile() truncates the target in place: the inode survives and a
    // concurrent reader can see the empty window. A completed temp file
    // renamed over the target gives the reader either version, never half.
    expect(fs.statSync(envPath).ino).not.toBe(before);
    expect(fs.readFileSync(envPath, "utf-8")).toContain('KIMI_API_KEY="new"');
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes two saves of one file, so each readback describes its own save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-serial-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\nKIMI_API_KEY=old\n");
    const first = persistSetup(envPath, ['KIMI_API_KEY="first"'], { ownedKeys: ["KIMI_API_KEY"] });
    const second = persistSetup(envPath, ['KIMI_API_KEY="second"'], { ownedKeys: ["KIMI_API_KEY"] });
    const [a, b] = await Promise.all([first, second]);
    expect(a.effective.KIMI_API_KEY).toBe("first");
    expect(b.effective.KIMI_API_KEY).toBe("second");
    expect(a.preserved).toEqual(["HAND_ADDED"]);
    expect(b.preserved).toEqual(["HAND_ADDED"]);
    expect(dotenvParse(fs.readFileSync(envPath, "utf-8")).KIMI_API_KEY).toBe("second");
  });
});

describe("redactEffectiveConfig allowlist (round 8 #11)", () => {
  it("returns a presence marker for every key the wizard does not own", () => {
    const shown = new Set(["LOG_LEVEL", "STRADA_BUDGET_DAILY_USD"]);
    const redacted = redactEffectiveConfig(
      {
        DATABASE_URL: "postgres://user:s3cret@db.internal/app",
        PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI",
        MY_CUSTOM_WEBHOOK_URL: "https://hooks.example/T0/B0/xyz",
        LOG_LEVEL: "debug",
        STRADA_BUDGET_DAILY_USD: "0",
      },
      shown,
    );
    expect(redacted).toEqual({
      DATABASE_URL: "<set>",
      PRIVATE_KEY: "<set>",
      AWS_SECRET_ACCESS_KEY: "<set>",
      MY_CUSTOM_WEBHOOK_URL: "<set>",
      LOG_LEVEL: "debug",
      STRADA_BUDGET_DAILY_USD: "0",
    });
    const body = JSON.stringify(redacted);
    for (const secret of ["s3cret", "RSA PRIVATE KEY", "wJalrXUtnFEMI", "hooks.example"]) {
      expect(body).not.toContain(secret);
    }
  });
});

// =============================================================================
// ROUND 9 #15 — the save lock has to hold ACROSS PROCESSES
//
// Two independently loaded copies of this module stand in for two daemons: each
// gets its own in-process `saveChains` map, so nothing but a lock on the file
// itself can order them. Without one they both read the same base file, the
// second rename wins (the first save's keys are gone), and the first save's
// readback describes the second save's file.
// =============================================================================
describe("persistSetup across processes (round 9 #15)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A module instance with its own state — a stand-in for a second process. */
  async function loadSeparateInstance(): Promise<typeof import("./setup-env-persistence.js")> {
    vi.resetModules();
    return await import("./setup-env-persistence.js");
  }

  function envDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-xproc-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("does not lose one process's merge to the other's stale read", async () => {
    const [a, b] = [await loadSeparateInstance(), await loadSeparateInstance()];
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\n");
    await Promise.all([
      a.persistSetup(envPath, ["A_KEY=1"], { ownedKeys: [] }),
      b.persistSetup(envPath, ["B_KEY=2"], { ownedKeys: [] }),
    ]);
    const onDisk = dotenvParse(fs.readFileSync(envPath, "utf-8"));
    expect(onDisk.HAND_ADDED).toBe("yes");
    expect(onDisk.A_KEY).toBe("1");
    expect(onDisk.B_KEY).toBe("2");
  });

  it("attributes each readback to the save that committed it", async () => {
    const [a, b] = [await loadSeparateInstance(), await loadSeparateInstance()];
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(envPath, "KIMI_API_KEY=old\n");
    const [ra, rb] = await Promise.all([
      a.persistSetup(envPath, ['KIMI_API_KEY="first"'], { ownedKeys: ["KIMI_API_KEY"] }),
      b.persistSetup(envPath, ['KIMI_API_KEY="second"'], { ownedKeys: ["KIMI_API_KEY"] }),
    ]);
    expect(ra.effective.KIMI_API_KEY).toBe("first");
    expect(rb.effective.KIMI_API_KEY).toBe("second");
  });

  it("leaves no lock file behind after a save", async () => {
    const dir = envDir();
    const envPath = path.join(dir, ".env");
    await persistSetup(envPath, ["KIMI_API_KEY=k"], { ownedKeys: [] });
    expect(fs.readdirSync(dir)).toEqual([".env"]);
  });
});

describe("the cross-process save lock does not become a deadlock (round 9 #15)", () => {
  const tmpDirs: string[] = [];
  const original = { ...ENV_SAVE_LOCK };
  afterEach(() => {
    Object.assign(ENV_SAVE_LOCK, original);
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function envDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-lock-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("breaks a lock whose owning process is gone", async () => {
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\n");
    // A crashed `strada setup`: a lock file naming a pid that no longer exists.
    fs.writeFileSync(`${envPath}.lock`, JSON.stringify({ token: "x", pid: 0x7ffffffe, host: os.hostname(), startedAt: Date.now() }));
    const result = await persistSetup(envPath, ["KIMI_API_KEY=k"], { ownedKeys: [] });
    expect(result.effective.KIMI_API_KEY).toBe("k");
    expect(result.diskMatchesCommit).toBe(true);
    expect(fs.existsSync(`${envPath}.lock`)).toBe(false);
  });

  it("breaks an unreadable lock once it is older than staleMs", async () => {
    ENV_SAVE_LOCK.staleMs = 0;
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(`${envPath}.lock`, "not json at all");
    const result = await persistSetup(envPath, ["KIMI_API_KEY=k"], { ownedKeys: [] });
    expect(result.effective.KIMI_API_KEY).toBe("k");
  });

  it("does not steal a live owner's lock for being OLD (round 10 #5)", async () => {
    // A writer paused between its read and its rename for longer than staleMs
    // is still holding the file: breaking its lock let a second process save,
    // and the first then overwrote it. Age is not death.
    ENV_SAVE_LOCK.staleMs = 0;
    ENV_SAVE_LOCK.timeoutMs = 60;
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(envPath, "KIMI_API_KEY=held\n");
    const lockBody = JSON.stringify({ token: "live", pid: process.pid, host: os.hostname(), startedAt: 0 });
    fs.writeFileSync(`${envPath}.lock`, lockBody);
    // Make it ancient as well, so only the liveness check can save it.
    fs.utimesSync(`${envPath}.lock`, new Date(0), new Date(0));
    await expect(persistSetup(envPath, ['KIMI_API_KEY="stolen"'], { ownedKeys: ["KIMI_API_KEY"] }))
      .rejects.toThrow(new RegExp(`held by pid ${process.pid}`));
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KIMI_API_KEY=held\n");
    // The live owner's lock is untouched, and nothing was left beside it.
    expect(fs.readFileSync(`${envPath}.lock`, "utf-8")).toBe(lockBody);
    expect(fs.readdirSync(path.dirname(envPath)).filter((n) => n.includes(".abandoned."))).toEqual([]);
  });

  it("still breaks an ancient lock from ANOTHER host, which nobody here can ask about (guard)", async () => {
    ENV_SAVE_LOCK.staleMs = 0;
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(`${envPath}.lock`, JSON.stringify({ token: "x", pid: 1, host: "some-other-machine", startedAt: 0 }));
    const result = await persistSetup(envPath, ["KIMI_API_KEY=k"], { ownedKeys: [] });
    expect(result.effective.KIMI_API_KEY).toBe("k");
    expect(fs.existsSync(`${envPath}.lock`)).toBe(false);
  });

  it("refuses the save — writing nothing — while a LIVE process holds the lock", async () => {
    ENV_SAVE_LOCK.timeoutMs = 60;
    ENV_SAVE_LOCK.staleMs = 60_000;
    const envPath = path.join(envDir(), ".env");
    fs.writeFileSync(envPath, "KIMI_API_KEY=old\n");
    // process.pid is alive by definition, so this lock may not be broken.
    fs.writeFileSync(`${envPath}.lock`, JSON.stringify({ token: "x", pid: process.pid, host: os.hostname(), startedAt: Date.now() }));
    await expect(persistSetup(envPath, ['KIMI_API_KEY="new"'], { ownedKeys: ["KIMI_API_KEY"] }))
      .rejects.toThrow(/still saving/);
    // A refused save is a save that did not happen.
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KIMI_API_KEY=old\n");
    expect(fs.readdirSync(path.dirname(envPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

/**
 * Codex round 11 #3. Recovery of an abandoned lock must never expose an
 * unlocked pathname: A judges an abandoned lock, B recovers it and C takes a
 * fresh live lock, A renames C's lock away, D takes the vacant name — and C
 * and D both write `.env`. Recovery is now serialized and re-judged, and the
 * recoverer claims the name itself instead of leaving it open.
 */
describe("abandoned-lock recovery never leaves the pathname unlocked (round 11 #3)", () => {
  const tmpDirs: string[] = [];
  const original = { ...ENV_SAVE_LOCK };
  afterEach(() => {
    Object.assign(ENV_SAVE_LOCK, original);
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function lockDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-aba-"));
    tmpDirs.push(dir);
    return dir;
  }
  const dead = JSON.stringify({ token: "dead", pid: 0x7ffffffe, host: os.hostname(), startedAt: 0 });
  const live = JSON.stringify({ token: "live", pid: process.pid, host: os.hostname(), startedAt: 0 });
  const mine = JSON.stringify({ token: "mine", pid: process.pid, host: os.hostname(), startedAt: 1 });

  it("a STALE judgement cannot remove the live lock that replaced it", async () => {
    // Exactly the reported interleaving: our judgement describes the dead
    // owner's lock, but the file now at that name belongs to a live writer.
    const lockPath = path.join(lockDir(), ".env.lock");
    fs.writeFileSync(lockPath, live);
    const verdict = await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead });
    expect(verdict).toBe("live");
    // The live owner still holds its own bytes, and nothing was left beside it.
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(live);
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual([".env.lock"]);
  });

  it("a stale judgement of an equally dead but DIFFERENT lock is refused too", async () => {
    // The replacement need not be alive for the removal to be wrong: it is a
    // lock nobody judged, so it is re-judged instead of assumed.
    const lockPath = path.join(lockDir(), ".env.lock");
    const otherDead = JSON.stringify({ token: "other", pid: 0x7ffffffd, host: os.hostname(), startedAt: 0 });
    fs.writeFileSync(lockPath, otherDead);
    expect(await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead })).toBe("retry");
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(otherDead);
  });

  it("recovery hands the name to the recoverer, never to nobody", async () => {
    const lockPath = path.join(lockDir(), ".env.lock");
    fs.writeFileSync(lockPath, dead);
    expect(await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead })).toBe("acquired");
    // The pathname is locked by US when the call returns: a third contender
    // arriving now finds it taken instead of free.
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(mine);
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual([".env.lock"]);
  });

  it("a live recovery in progress blocks a second recoverer, and its lock survives", async () => {
    const lockPath = path.join(lockDir(), ".env.lock");
    fs.writeFileSync(lockPath, dead);
    // Another process is inside the critical section right now.
    fs.writeFileSync(`${lockPath}.recovery`, live);
    expect(await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead })).toBe("retry");
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(dead);
    expect(fs.existsSync(`${lockPath}.recovery`)).toBe(true);
  });

  it("a recoverer that died mid-recovery does not block recovery for ever", async () => {
    const lockPath = path.join(lockDir(), ".env.lock");
    fs.writeFileSync(lockPath, dead);
    fs.writeFileSync(`${lockPath}.recovery`, dead);
    // First attempt clears the dead recoverer, the next one gets through.
    expect(await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead })).toBe("retry");
    expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
    expect(await recoverAbandonedLock(lockPath, mine, { verdict: "abandoned", raw: dead })).toBe("acquired");
    expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
  });

  it("a save blocked by another process's recovery refuses at the deadline instead of spinning", async () => {
    // The lock IS recoverable but someone else is recovering it, so every
    // attempt answers 'retry'. Without a deadline on that path the loop spun
    // for ever instead of refusing.
    ENV_SAVE_LOCK.timeoutMs = 50;
    ENV_SAVE_LOCK.staleMs = 60_000;
    const dir = lockDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "KIMI_API_KEY=held\n");
    fs.writeFileSync(`${envPath}.lock`, dead);
    fs.writeFileSync(`${envPath}.lock.recovery`, live);
    await expect(persistSetup(envPath, ['KIMI_API_KEY="new"'], { ownedKeys: ["KIMI_API_KEY"] }))
      .rejects.toThrow(/still saving/);
    // A refused save is a save that did not happen, and the other recoverer's
    // critical section is intact.
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KIMI_API_KEY=held\n");
    expect(fs.readFileSync(`${envPath}.lock.recovery`, "utf-8")).toBe(live);
    expect(fs.readdirSync(dir).filter((n) => n.includes(".abandoned.") || n.endsWith(".tmp"))).toEqual([]);
  });
});
