import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireRuntimeLock } from "./runtime-lock.js";

describe("acquireRuntimeLock — one install gets exactly one live runtime", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "strada-lock-"));
    mkdirSync(join(root, ".strada"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const lockPath = () => join(root, ".strada", "runtime.lock");

  it("acquires cleanly on an empty install", async () => {
    const result = await acquireRuntimeLock({ installRoot: root, channelType: "web" });
    if (!result.acquired) throw new Error("expected acquisition");
    expect(JSON.parse(readFileSync(lockPath(), "utf-8"))).toMatchObject({
      pid: process.pid,
      channel: "web",
    });
    await result.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("refuses when a LIVE foreign process holds the lock", { skip: process.platform === "win32" }, async () => {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: false });
    try {
      writeFileSync(lockPath(), JSON.stringify({ pid: sleeper.pid, startedAtIso: new Date().toISOString(), channel: "cli" }));
      const result = await acquireRuntimeLock({ installRoot: root, channelType: "web" });
      expect(result.acquired).toBe(false);
      if (!result.acquired) expect(result.holder.pid).toBe(sleeper.pid);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("takes over a STALE lock whose pid is gone (SIGKILLed predecessor)", async () => {
    // 2^27 is not a plausible live pid on any supported platform.
    writeFileSync(lockPath(), JSON.stringify({ pid: 134217728, startedAtIso: "2026-01-01T00:00:00Z", channel: "telegram" }));
    const result = await acquireRuntimeLock({ installRoot: root, channelType: "web" });
    expect(result.acquired).toBe(true);
    await result.release();
  });

  it("treats a corrupt lock file as stale instead of wedging startup", async () => {
    writeFileSync(lockPath(), "{not json at all");
    const result = await acquireRuntimeLock({ installRoot: root, channelType: "slack" });
    expect(result.acquired).toBe(true);
    await result.release();
  });

  it("release is idempotent and never clobbers a successor's claim", async () => {
    const first = await acquireRuntimeLock({ installRoot: root, channelType: "web" });
    if (!first.acquired) throw new Error("expected acquisition");
    await first.release();
    await first.release(); // second call must be a no-op

    const second = await acquireRuntimeLock({ installRoot: root, channelType: "discord" });
    if (!second.acquired) throw new Error("expected acquisition");
    // First holder releases late (after a successor took over): must NOT delete
    // the successor's fresh claim.
    await first.release();
    expect(existsSync(lockPath())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf-8"))).toMatchObject({ channel: "discord" });
    await second.release();
  });
});
