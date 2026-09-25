import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { acquireRuntimeLock, installLockPath, legacyRuntimeLockPath } from "./runtime-lock.js";
import { kernelEnforcesPermissions } from "../tests/helpers/permission-faults.js";

// An install root nobody may write to (a read_only container, a root-owned
// global npm install). Root ignores chmod, so the write calls under it are
// failed the way that filesystem fails them; reads still work.
const unwritable = vi.hoisted(() => ({ root: undefined as string | undefined, code: "EROFS" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refuse = (syscall: string, target: unknown): void => {
    const root = unwritable.root;
    const path = String(target);
    if (root && (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))) {
      throw Object.assign(new Error(`${unwritable.code}: ${syscall} '${path}'`), { code: unwritable.code, syscall, path });
    }
  };
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => (refuse("mkdir", args[0]), actual.mkdir(...args)),
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => (refuse("open", args[0]), actual.writeFile(...args)),
    open: async (...args: Parameters<typeof actual.open>) => (refuse("open", args[0]), actual.open(...args)),
    link: async (...args: Parameters<typeof actual.link>) => (refuse("link", args[1]), actual.link(...args)),
    rename: async (...args: Parameters<typeof actual.rename>) => (refuse("rename", args[0]), actual.rename(...args)),
    unlink: async (...args: Parameters<typeof actual.unlink>) => (refuse("unlink", args[0]), actual.unlink(...args)),
  };
});

describe("acquireRuntimeLock — one install gets exactly one live runtime", () => {
  let configRoot: string;
  let installRoot: string;

  beforeEach(() => {
    configRoot = mkdtempSync(join(tmpdir(), "strada-lock-config-"));
    installRoot = mkdtempSync(join(tmpdir(), "strada-lock-install-"));
  });

  afterEach(() => {
    unwritable.root = undefined;
    unwritable.code = "EROFS";
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(installRoot, { recursive: true, force: true });
  });

  /** The authoritative lock, under the config root (COR-21). */
  const lockPath = () => installLockPath(configRoot, installRoot, "runtime");
  const legacyPath = () => legacyRuntimeLockPath(installRoot);
  const acquire = (channelType: string, pauses?: Parameters<typeof acquireRuntimeLock>[0]["pauses"]) =>
    acquireRuntimeLock({ installRoot, configRoot, channelType, pauses });
  const writeLock = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };

  it("acquires cleanly on an empty install", async () => {
    const result = await acquire("web");
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
      writeLock(lockPath(), JSON.stringify({ pid: sleeper.pid, startedAtIso: new Date().toISOString(), channel: "cli" }));
      const result = await acquire("web");
      expect(result.acquired).toBe(false);
      if (!result.acquired) expect(result.holder.pid).toBe(sleeper.pid);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("takes over a STALE lock whose pid is gone (SIGKILLed predecessor)", async () => {
    // 2^27 is not a plausible live pid on any supported platform.
    writeLock(lockPath(), JSON.stringify({ pid: 134217728, startedAtIso: "2026-01-01T00:00:00Z", channel: "telegram" }));
    const result = await acquire("web");
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();
  });

  it("treats a corrupt lock file as stale instead of wedging startup", async () => {
    writeLock(lockPath(), "{not json at all");
    const result = await acquire("slack");
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();
  });

  it("a delayed stale-lock removal cannot delete a fresh claim (COR-6)", async () => {
    // Both starters judge the same stale lock; the second finishes first.
    writeLock(lockPath(), JSON.stringify({ pid: 134217728, startedAtIso: "2026-01-01T00:00:00Z", channel: "telegram" }));
    let second: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
    const first = await acquire("web", {
      afterJudging: async () => {
        second = await acquire("discord");
      },
    });
    expect(second?.acquired).toBe(true);
    expect(first.acquired).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(), "utf-8"))).toMatchObject({ channel: "discord" });
    if (second?.acquired) await second.release();
  });

  it("a claim is published whole, never as an empty file another starter could call stale (COR-6)", async () => {
    let second: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
    const first = await acquire("web", {
      beforePublish: async () => {
        // Mid-claim, the lock path shows nothing half-written.
        expect(existsSync(lockPath())).toBe(false);
        second = await acquire("discord");
      },
    });
    expect(second).toBeDefined();
    expect([first.acquired, second?.acquired].filter(Boolean)).toHaveLength(1);
    expect(readdirSync(dirname(lockPath())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(dirname(legacyPath())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (first.acquired) await first.release();
    if (second?.acquired) await second.release();
  });

  it("release is idempotent and never clobbers a successor's claim", async () => {
    const first = await acquire("web");
    if (!first.acquired) throw new Error("expected acquisition");
    await first.release();
    await first.release(); // second call must be a no-op

    const second = await acquire("discord");
    if (!second.acquired) throw new Error("expected acquisition");
    // First holder releases late (after a successor took over): must NOT delete
    // the successor's fresh claim.
    await first.release();
    expect(existsSync(lockPath())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf-8"))).toMatchObject({ channel: "discord" });
    await second.release();
  });

  describe("lock location (COR-21)", () => {
    it("starts from a read-only install root (EROFS): the lock lives under the config root", async () => {
      unwritable.root = installRoot;
      const result = await acquire("web");
      if (!result.acquired) throw new Error("a read-only install root must not stop startup");
      expect(existsSync(lockPath())).toBe(true);
      expect(existsSync(legacyPath())).toBe(false);
      await result.release();
      expect(existsSync(lockPath())).toBe(false);
    });

    it("starts from a root-owned install root (EACCES)", async () => {
      if (kernelEnforcesPermissions) {
        chmodSync(installRoot, 0o555);
      } else {
        unwritable.root = installRoot;
        unwritable.code = "EACCES";
      }
      try {
        const result = await acquire("web");
        if (!result.acquired) throw new Error("an unwritable install root must not stop startup");
        expect(existsSync(lockPath())).toBe(true);
        await result.release();
      } finally {
        chmodSync(installRoot, 0o755);
      }
    });

    it("mirrors the claim at the legacy path when the install root is writable, and releases both", async () => {
      const result = await acquire("web");
      if (!result.acquired) throw new Error("expected acquisition");
      // Versions before COR-21 look only here; they must see this runtime.
      expect(readFileSync(legacyPath(), "utf-8")).toBe(readFileSync(lockPath(), "utf-8"));
      await result.release();
      expect(existsSync(legacyPath())).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("a live legacy lock still blocks a second instance, and nothing is claimed", { skip: process.platform === "win32" }, async () => {
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: false });
      try {
        // An older runtime of this install, holding only the old lock.
        writeLock(legacyPath(), JSON.stringify({ pid: sleeper.pid, startedAtIso: new Date().toISOString(), channel: "telegram" }));
        const result = await acquire("web");
        expect(result.acquired).toBe(false);
        if (!result.acquired) expect(result.holder.pid).toBe(sleeper.pid);
        expect(existsSync(lockPath())).toBe(false);
      } finally {
        sleeper.kill("SIGKILL");
      }
    });

    it("a live legacy lock blocks even when the install root is read-only", { skip: process.platform === "win32" }, async () => {
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: false });
      try {
        writeLock(legacyPath(), JSON.stringify({ pid: sleeper.pid, startedAtIso: new Date().toISOString(), channel: "telegram" }));
        unwritable.root = installRoot;
        const result = await acquire("web");
        expect(result.acquired).toBe(false);
      } finally {
        sleeper.kill("SIGKILL");
      }
    });

    it("two new-style starters exclude each other through the config-root lock", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
      const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "runtime-lock.ts")).href;
      const script = [
        `const { acquireRuntimeLock } = await import(${JSON.stringify(moduleUrl)});`,
        `const r = await acquireRuntimeLock({ installRoot: ${JSON.stringify(installRoot)}, configRoot: ${JSON.stringify(configRoot)}, channelType: "child" });`,
        `process.stdout.write(r.acquired ? "acquired\\n" : "refused\\n");`,
        "setInterval(() => {}, 1e6);",
      ].join("\n");
      const scriptPath = join(configRoot, "hold-lock.mts");
      writeFileSync(scriptPath, script);
      const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", scriptPath], { stdio: ["ignore", "pipe", "inherit"] });
      try {
        const [line] = (await once(child.stdout!, "data")) as [Buffer];
        expect(line.toString().trim()).toBe("acquired");
        // Only the config-root lock is left, as on a read-only install root:
        // it alone must keep the second starter out.
        unlinkSync(legacyPath());

        const second = await acquire("web");
        expect(second.acquired).toBe(false);
        if (!second.acquired) expect(second.holder).toMatchObject({ pid: child.pid, channel: "child" });

        child.kill("SIGKILL");
        await once(child, "exit");
        // The holder is gone: its lock is stale and the next starter takes it.
        const third = await acquire("web");
        expect(third.acquired).toBe(true);
        if (third.acquired) await third.release();
      } finally {
        child.kill("SIGKILL");
      }
    });
  });
});
