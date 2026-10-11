/**
 * Measured in the daemon log, 2026-09-18 21:55 .. 2026-09-20 10:34: seven
 * cycles of "Auto-update pulled" followed ~16 min later by "Auto-update step
 * failed {step: npm run build, detail: Command timed out: npm run build}" and
 * a `git reset --hard` back to cc53b13f — every 6 h, each to a newer commit,
 * so the daemon never ran any of the fixes it pulled. The build had a fixed
 * 5-minute budget, the two unconditional `npm install`s before it ate ~11 of
 * those 16 minutes, the timeout carried none of the build's output, and the
 * next check tried again as if nothing had happened. (A manual build on the
 * same host, 2026-10-11, load average 30-106: 69 s.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUpdater, type AutoUpdateConfig } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";

const PRE = "cc53b13f48acb5ce98d9b85ca19cf79cfc96b59a";
const BAD = "5836de7887cdc16efe33b5ad5b4b5ba75f553ab5";
const NEWER = "a5bf2b693f86ebc7fe585aa022d2dc33a046f363";
const HOUR = 60 * 60 * 1000;
const TIMED_OUT =
  "Command timed out after 300 s: npm run build\n" +
  "last output: vite v8.0.0 building for production...\ntransforming (1200) src/App.tsx";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-build-"));
  dirs.push(dir);
  return dir;
}

interface Call { line: string; timeoutMs: number; cwd?: string }

/** A checkout whose `origin/main` the test moves, and whose build fails for chosen SHAs. */
function fakeRepo(opts: { buildFails?: (sha: string) => boolean; changed?: string[] } = {}) {
  let head = PRE;
  let remote = BAD;
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> => {
    calls.push({ line: `${cmd} ${args.join(" ")}`, timeoutMs, cwd });
    if (cmd === "npm" && args[0] === "run" && args[1] === "build") {
      if (opts.buildFails?.(head)) throw new Error(TIMED_OUT);
      return "";
    }
    if (cmd !== "git") return "";
    const sub = args.join(" ");
    if (sub === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main\n";
    if (sub === "rev-parse HEAD") return `${head}\n`;
    if (sub === "rev-parse origin/main") return `${remote}\n`;
    if (sub.startsWith("rev-list --count")) return head === remote ? "0\n" : "1\n";
    if (sub === "show origin/main:package.json") return JSON.stringify({ version: "4.2.940" });
    if (sub.startsWith("pull")) {
      head = remote;
      return "";
    }
    if (sub.startsWith("reset --hard")) {
      head = args[2] ?? head;
      return "";
    }
    if (sub.startsWith("diff --name-only")) return (opts.changed ?? []).join("\n");
    return "";
  };
  return { run, calls, head: () => head, setRemote: (sha: string) => { remote = sha; } };
}

function makeUpdater(
  repo: ReturnType<typeof fakeRepo>,
  notices: string[],
  over: Partial<AutoUpdateConfig> = {},
  installRoot = tmp(),
): AutoUpdater {
  fs.mkdirSync(path.join(installRoot, ".git"), { recursive: true });
  const updater = new AutoUpdater(
    {
      autoUpdate: {
        enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest",
        notify: true, autoRestart: false, ...over,
      },
    },
    { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry,
    { hasRunningTasks: () => false },
    {
      installRoot,
      stateRoot: tmp(),
      commandRunner: repo.run,
      sourceLauncherRefresher: async () => {},
      healthChecker: async () => {},
      isDaemonProcess: () => false,
    },
  );
  updater.setNotifyFn((msg) => notices.push(msg));
  return updater;
}

/** node_modules as `npm install` leaves it: the hidden lockfile is its receipt. */
function installed(dir: string): void {
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
}

function withPortal(root: string): string {
  const portal = path.join(root, "web-portal");
  fs.mkdirSync(portal, { recursive: true });
  fs.writeFileSync(path.join(portal, "package.json"), "{}");
  return portal;
}

const internals = (u: AutoUpdater) => u as unknown as {
  runUpdateCheck(): Promise<void>;
  startIdleMonitoring(): void;
  pendingVersion: string | null;
  idleCheckHandle: ReturnType<typeof setInterval> | null;
};

describe("the build gets a budget sized for this host", () => {
  it("defaults to well above the 5 minutes the September builds overran", async () => {
    const repo = fakeRepo();
    await makeUpdater(repo, []).performUpdate();
    const build = repo.calls.find((c) => c.line === "npm run build");
    expect(build?.timeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("takes the operator's AUTO_UPDATE_BUILD_TIMEOUT_MIN for the install and build steps", async () => {
    const repo = fakeRepo();
    await makeUpdater(repo, [], { buildTimeoutMin: 25 }).performUpdate();
    const steps = repo.calls.filter((c) => c.line === "npm run build" || c.line === "npm install");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((c) => c.timeoutMs)).toEqual(steps.map(() => 25 * 60_000));
  });
});

describe("dependencies are installed when their manifests changed or the tree is not installed", () => {
  it("skips both installs when the pull changed neither manifest and both trees are installed", async () => {
    const root = tmp();
    installed(root);
    installed(withPortal(root));
    const repo = fakeRepo({ changed: [] });
    await expect(makeUpdater(repo, [], {}, root).performUpdate()).resolves.toBe(true);
    expect(repo.calls.filter((c) => c.line === "npm install")).toEqual([]);
    expect(repo.calls.map((c) => c.line)).toContain("npm run build");
  });

  it("installs the portal's dependencies when the pull changed web-portal/package-lock.json", async () => {
    const root = tmp();
    installed(root);
    const portal = withPortal(root);
    installed(portal);
    const repo = fakeRepo({ changed: ["web-portal/package-lock.json"] });
    await makeUpdater(repo, [], {}, root).performUpdate();
    expect(repo.calls.filter((c) => c.line === "npm install").map((c) => c.cwd)).toEqual([portal]);
  });

  it("installs the root's dependencies when the pull changed package-lock.json", async () => {
    const root = tmp();
    installed(root);
    installed(withPortal(root));
    const repo = fakeRepo({ changed: ["package-lock.json"] });
    await makeUpdater(repo, [], {}, root).performUpdate();
    expect(repo.calls.filter((c) => c.line === "npm install").map((c) => c.cwd)).toEqual([root]);
  });

  it("installs the portal when web-portal/node_modules holds only the .tmp a failed `tsc -b` leaves", async () => {
    const root = tmp();
    installed(root);
    const portal = withPortal(root);
    // Measured 2026-10-11: a portal build without its dependencies still
    // creates web-portal/node_modules/.tmp/*.tsbuildinfo, so "the directory
    // exists" is not "the dependencies are installed".
    fs.mkdirSync(path.join(portal, "node_modules", ".tmp"), { recursive: true });
    const repo = fakeRepo({ changed: [] });
    await makeUpdater(repo, [], {}, root).performUpdate();
    expect(repo.calls.filter((c) => c.line === "npm install").map((c) => c.cwd)).toEqual([portal]);
  });

  it("a rollback reinstalls the trees the update reinstalled", async () => {
    const root = tmp();
    installed(root);
    const portal = withPortal(root);
    installed(portal);
    const repo = fakeRepo({ changed: ["web-portal/package-lock.json"], buildFails: (sha) => sha === BAD });
    await expect(makeUpdater(repo, [], {}, root).performUpdate()).rejects.toThrow("timed out");
    const reset = repo.calls.findIndex((c) => c.line === `git reset --hard ${PRE}`);
    expect(reset).toBeGreaterThan(-1);
    expect(repo.calls.slice(reset).filter((c) => c.line === "npm install").map((c) => c.cwd)).toEqual([portal]);
  });
});

describe("a failed update is remembered, backed off and surfaced", () => {
  it("the scheduled check does not attempt the same failed commit again", async () => {
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const notices: string[] = [];
    const u = makeUpdater(repo, notices);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    expect(repo.head()).toBe(PRE);

    await internals(u).runUpdateCheck();
    try {
      expect(internals(u).pendingVersion).toBeNull();
      expect(internals(u).idleCheckHandle).toBeNull();
      expect(notices.join("\n")).toContain(BAD.slice(0, 8));
    } finally {
      u.shutdown();
    }
  });

  it("a webhook-triggered check is held back too, and says so in its result", async () => {
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const u = makeUpdater(repo, []);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    repo.setRemote(NEWER);

    try {
      const result = await u.requestImmediateCheck();
      expect(result.available).toBe(true);
      expect(result.heldBack).toContain(`${BAD.slice(0, 8)} failed at npm run build`);
      expect(internals(u).pendingVersion).toBeNull();
      expect(internals(u).idleCheckHandle).toBeNull();
    } finally {
      u.shutdown();
    }
  });

  it("the failed commit stays held after the backoff runs out: same code, same failure", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 21, 40) });
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const u = makeUpdater(repo, []);
    await expect(u.performUpdate()).rejects.toThrow("timed out");

    try {
      vi.setSystemTime(Date.now() + 3 * 24 * HOUR);
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBeNull();
    } finally {
      u.shutdown();
    }
  });

  it("a newer commit waits out the backoff after a failure, then is attempted", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 21, 40) });
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const u = makeUpdater(repo, []);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    repo.setRemote(NEWER);

    try {
      vi.setSystemTime(Date.now() + 1 * HOUR);
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBeNull();

      vi.setSystemTime(Date.now() + 6 * HOUR);
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBe("4.2.940");
    } finally {
      u.shutdown();
    }
  });

  it("the backoff grows with consecutive failures", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 21, 40) });
    const repo = fakeRepo({ buildFails: () => true });
    const u = makeUpdater(repo, []);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    vi.setSystemTime(Date.now() + 7 * HOUR);
    repo.setRemote(NEWER);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    repo.setRemote("d".repeat(40));

    try {
      // One interval was enough after the first failure; not after the second.
      vi.setSystemTime(Date.now() + 7 * HOUR);
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBeNull();
      vi.setSystemTime(Date.now() + 6 * HOUR);
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBe("4.2.940");
    } finally {
      u.shutdown();
    }
  });

  it("a successful update clears what the failures held back", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 21, 40) });
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const u = makeUpdater(repo, []);
    await expect(u.performUpdate()).rejects.toThrow("timed out");
    repo.setRemote(NEWER);
    // An operator's `strada update` is not held back.
    await expect(u.performUpdate()).resolves.toBe(true);
    repo.setRemote("e".repeat(40));

    try {
      await internals(u).runUpdateCheck();
      expect(internals(u).pendingVersion).toBe("4.2.940");
    } finally {
      u.shutdown();
    }
  });

  it("the failure notice names the commit, the step and the cause, and does not promise a retry every check", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 21, 40) });
    const repo = fakeRepo({ buildFails: (sha) => sha === BAD });
    const notices: string[] = [];
    const u = makeUpdater(repo, notices);
    internals(u).startIdleMonitoring();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      const notice = notices.find((n) => n.includes("npm run build")) ?? "";
      expect(notice).toContain(BAD.slice(0, 8));
      expect(notice).toContain("transforming (1200) src/App.tsx");
      expect(notice).not.toContain("Will retry next check");
    } finally {
      u.shutdown();
    }
  });
});

describe("a failed step is logged with the end of its output, where the cause is", () => {
  it("keeps the compiler's error after a long run of npm warnings", async () => {
    const repo = fakeRepo();
    const run = repo.run;
    const noise = "npm warn deprecated some-package@1.0.0: this package is no longer supported\n".repeat(30);
    const u = makeUpdater({ ...repo, run: async (cmd, args, timeoutMs, cwd) => {
      if (cmd === "npm" && args[0] === "run") {
        throw new Error(`npm exited with code 2: ${noise}src/x.ts(1,1): error TS2304: Cannot find name 'y'.`);
      }
      return run(cmd, args, timeoutMs, cwd);
    } }, []);
    const { getLoggerSafe } = await import("../utils/logger.js");
    const logger = getLoggerSafe();
    const logged: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    vi.spyOn(logger, "warn").mockImplementation((msg: string, meta?: unknown) => {
      logged.push({ msg, meta: (meta ?? {}) as Record<string, unknown> });
      return logger;
    });
    await expect(u.performUpdate()).rejects.toThrow("TS2304");
    const failed = logged.find((l) => l.msg === "Auto-update step failed");
    expect(String(failed?.meta["detail"])).toContain("npm exited with code 2");
    expect(String(failed?.meta["detail"])).toContain("TS2304");
  });
});
