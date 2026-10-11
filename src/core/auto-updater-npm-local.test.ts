/**
 * npm-local self-update (14F4 / D73).
 *
 * For an `npm-local` install the running code lives at
 * `<owner>/node_modules/strada-brain`, and that is what `resolveInstallRoot()`
 * returns. The updater used it as the cwd for `npm install strada-brain@…`, so
 * npm was asked to install the package INTO the package: it either wrote
 * `node_modules/strada-brain/node_modules/strada-brain` (a copy nothing runs)
 * or edited a package.json that belongs to Strada itself rather than the
 * project that depends on it. The backup/rollback files were written into the
 * same wrong directory, and no version was ever compared — an install ran on
 * every cycle even when the owner already had the target version.
 *
 * These tests put a real owner tree on disk and assert the cwd, the files and
 * the skip.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutoUpdater } from "./auto-updater.js";
import { readUpdateHistory, readUpdateHold } from "./update-history.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs.length = 0;
  vi.restoreAllMocks();
});

function makeTmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "strada-npm-local-")));
  tmpDirs.push(dir);
  return dir;
}

interface Call {
  cmd: string;
  args: string[];
  cwd: string | undefined;
  timeoutMs?: number;
}

/** An owner project with strada-brain installed underneath it. */
function makeOwnerTree(opts: { installedVersion: string; declared?: string }): {
  ownerRoot: string;
  installRoot: string;
} {
  const ownerRoot = makeTmpDir();
  const installRoot = path.join(ownerRoot, "node_modules", "strada-brain");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(
    path.join(ownerRoot, "package.json"),
    JSON.stringify({
      name: "some-project",
      version: "9.9.9",
      dependencies: { "strada-brain": opts.declared ?? `^${opts.installedVersion}` },
    }),
  );
  fs.writeFileSync(path.join(ownerRoot, "package-lock.json"), '{"lockfileVersion": 3}');
  fs.writeFileSync(
    path.join(installRoot, "package.json"),
    JSON.stringify({ name: "strada-brain", version: opts.installedVersion }),
  );
  return { ownerRoot, installRoot };
}

function makeUpdater(opts: {
  installRoot: string;
  calls: Call[];
  notices?: string[];
  latest?: string;
  failInstall?: boolean;
  /** Side effect npm has on the tree before failing (it rewrites manifests). */
  onInstall?: () => void;
  /** Observer run mid-install; unlike `onInstall` it does not fail the install. */
  onInstallSuccess?: () => void;
  channel?: "stable" | "latest";
  stateRoot?: string;
  healthChecker?: () => Promise<void>;
  buildTimeoutMin?: number;
}): AutoUpdater {
  const commandRunner = async (
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> => {
    opts.calls.push({ cmd, args, cwd, timeoutMs });
    if (cmd === "npm" && args[0] === "view") return `${opts.latest ?? "2.0.0"}\n`;
    if (cmd === "npm" && args[0] === "install" && args[1]?.startsWith("strada-brain@")) {
      opts.onInstallSuccess?.();
      opts.onInstall?.();
      if (opts.failInstall || opts.onInstall) throw new Error("npm install failed");
    }
    return "";
  };
  const updater = new AutoUpdater(
    {
      autoUpdate: {
        enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: opts.channel ?? "latest", notify: true, autoRestart: false,
        ...(opts.buildTimeoutMin ? { buildTimeoutMin: opts.buildTimeoutMin } : {}),
      },
    },
    { isIdle: () => true, getActiveChatIds: () => [], getLastActivityTime: () => 0, recordActivity: () => {} } as never,
    { hasRunningTasks: () => false },
    {
      installRoot: opts.installRoot,
      // The update lock's state root (COR-21): a temp dir, not the real ~/.strada.
      stateRoot: opts.stateRoot ?? makeTmpDir(),
      commandRunner,
      // Force the npm-local branch: the global root is somewhere else entirely.
      globalNpmRootResolver: () => path.join(os.tmpdir(), "definitely-not-here"),
      healthChecker: opts.healthChecker ?? (async () => {}),
    },
  );
  if (opts.notices) updater.setNotifyFn((m) => opts.notices!.push(m));
  return updater;
}

describe("AutoUpdater.resolveOwningPackageRoot", () => {
  it("walks up past node_modules to the package that owns the install", () => {
    const { ownerRoot, installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    expect(AutoUpdater.resolveOwningPackageRoot(installRoot)).toBe(ownerRoot);
  });

  it("stops at the nearest owner for a nested install", () => {
    const outer = makeTmpDir();
    const middle = path.join(outer, "node_modules", "some-tool");
    const installRoot = path.join(middle, "node_modules", "strada-brain");
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(path.join(outer, "package.json"), '{"name":"outer"}');
    fs.writeFileSync(path.join(middle, "package.json"), '{"name":"some-tool"}');
    expect(AutoUpdater.resolveOwningPackageRoot(installRoot)).toBe(middle);
  });

  it("keeps a plain project root (no node_modules in the path) as its own owner", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"strada-brain"}');
    expect(AutoUpdater.resolveOwningPackageRoot(dir)).toBe(dir);
  });

  it("returns null when no package.json owns the tree", () => {
    const dir = makeTmpDir();
    const installRoot = path.join(dir, "node_modules", "strada-brain");
    fs.mkdirSync(installRoot, { recursive: true });
    expect(AutoUpdater.resolveOwningPackageRoot(installRoot)).toBeNull();
  });
});

describe("npm-local update runs in the owning package", () => {
  it("installs with the owner's directory as cwd, not the installed package's", async () => {
    const { ownerRoot, installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const calls: Call[] = [];
    const updater = makeUpdater({ installRoot, calls, latest: "2.0.0" });

    await expect(updater.performUpdate()).resolves.toBe(true);

    const install = calls.find((c) => c.cmd === "npm" && c.args[0] === "install" && c.args[1]?.startsWith("strada-brain@"));
    expect(install, "no install ran").toBeDefined();
    expect(install!.cwd).toBe(ownerRoot);
    expect(install!.cwd).not.toBe(installRoot);
  });

  it("leaves no backup directory behind after a SUCCESSFUL update (round 10 #21)", async () => {
    const { ownerRoot, installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const calls: Call[] = [];
    const updater = makeUpdater({ installRoot, calls, latest: "2.0.0" });

    await expect(updater.performUpdate()).resolves.toBe(true);

    // The backups were taken from the OWNER (that is where the manifests and
    // node_modules/strada-brain live), so that is where cleanup has to look.
    // Cleaning the installed-package root instead left every backup in place —
    // including `.strada-update-backup-node_modules`, a full copy of the
    // package tree — for the rest of the machine's life, and each cycle
    // rewrote it.
    for (const root of [ownerRoot, installRoot]) {
      const litter = fs
        .readdirSync(root)
        .filter((entry) => entry.startsWith(".strada-update-backup"));
      expect(litter, `backup litter in ${root}`).toEqual([]);
    }
  });

  it("copies the package tree into the backup while the update runs, then removes it", async () => {
    // The guard above is only worth something if a backup was really made: a
    // cleanup that "passes" because nothing was ever written proves nothing.
    const { ownerRoot, installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    fs.writeFileSync(path.join(installRoot, "marker.txt"), "running copy");
    const calls: Call[] = [];
    const seenDuringInstall: string[] = [];
    const updater = makeUpdater({
      installRoot,
      calls,
      latest: "2.0.0",
      onInstallSuccess: () => {
        seenDuringInstall.push(
          ...fs.readdirSync(ownerRoot).filter((e) => e.startsWith(".strada-update-backup")),
        );
      },
    });

    await expect(updater.performUpdate()).resolves.toBe(true);

    expect(seenDuringInstall.sort()).toEqual([
      ".strada-update-backup-node_modules",
      ".strada-update-backup-package-lock.json",
      ".strada-update-backup-package.json",
    ]);
    expect(
      fs.readdirSync(ownerRoot).filter((e) => e.startsWith(".strada-update-backup")),
    ).toEqual([]);
  });

  it("rolls the OWNER's manifest back when the install fails", async () => {
    const { ownerRoot, installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const ownerPkgPath = path.join(ownerRoot, "package.json");
    const ownerPkg = fs.readFileSync(ownerPkgPath, "utf8");
    const calls: Call[] = [];
    const notices: string[] = [];
    const updater = makeUpdater({
      installRoot,
      calls,
      notices,
      latest: "2.0.0",
      // npm rewrites the dependency range in the owner's package.json before it
      // fails; the rollback has to put that file back, and it can only do that
      // if the backup was taken from the owner and not from the installed copy.
      onInstall: () => {
        fs.writeFileSync(
          ownerPkgPath,
          JSON.stringify({ name: "some-project", version: "9.9.9", dependencies: { "strada-brain": "^2.0.0" } }),
        );
      },
    });

    await expect(updater.performUpdate()).rejects.toThrow(/npm install failed/);

    // Rolled back in place: the owner's manifest is byte-identical…
    expect(fs.readFileSync(path.join(ownerRoot, "package.json"), "utf8")).toBe(ownerPkg);
    // …and no backup litter is left in either directory.
    for (const root of [ownerRoot, installRoot]) {
      const litter = fs
        .readdirSync(root)
        .filter((entry) => entry.startsWith(".strada-update-backup"));
      expect(litter, `backup litter in ${root}`).toEqual([]);
    }
  });

  it("compares versions first and does not reinstall what the owner already has", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "2.0.0" });
    const calls: Call[] = [];
    const notices: string[] = [];
    const updater = makeUpdater({ installRoot, calls, notices, latest: "2.0.0" });

    await expect(updater.performUpdate()).resolves.toBe(false);
    // Nothing to install is not lock contention: the CLI must not say
    // "another update is already running" (COR-21).
    expect(updater.wasLockedOut()).toBe(false);

    expect(
      calls.filter((c) => c.cmd === "npm" && c.args[0] === "install"),
      "installed despite already being at the target version",
    ).toEqual([]);
    expect(notices.join(" ")).toMatch(/2\.0\.0/);
  });

  it("still updates when the owner's installed version is behind", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.9.0" });
    const calls: Call[] = [];
    const updater = makeUpdater({ installRoot, calls, latest: "2.0.0" });

    await expect(updater.performUpdate()).resolves.toBe(true);
    expect(
      calls.some((c) => c.cmd === "npm" && c.args[0] === "install" && c.args[1] === "strada-brain@latest"),
    ).toBe(true);
  });
});

/**
 * Audit core-bootstrap#5 and the review of 7fc26d9f. An npm update recorded
 * nothing, so `strada status` said "Last auto-update: none recorded" through
 * updates and rollbacks alike; its hold was written into the install root,
 * which `npm install` replaces and a root-owned prefix refuses; and its
 * package installs kept the fixed 5-minute budget the git builds outgrew.
 */
describe("an npm update is recorded, held and budgeted like a git one", () => {
  /** Where `strada status` reads this install's records: under the writable state root. */
  const recordsOf = (updater: AutoUpdater, stateRoot: string): string => {
    const root = updater.getUpdateRecordsRoot();
    expect(path.relative(stateRoot, root).startsWith("..")).toBe(false);
    return root;
  };

  it("records a successful update in the history `strada status` reads", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const stateRoot = makeTmpDir();
    const updater = makeUpdater({ installRoot, calls: [], latest: "2.0.0", stateRoot });

    await expect(updater.performUpdate()).resolves.toBe(true);
    expect(readUpdateHistory(recordsOf(updater, stateRoot)).at(-1)).toMatchObject({ kind: "pulled", from: "1.0.0" });
  });

  it("records a failed install's rollback", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const stateRoot = makeTmpDir();
    const updater = makeUpdater({ installRoot, calls: [], latest: "2.0.0", stateRoot, failInstall: true });

    await expect(updater.performUpdate()).rejects.toThrow(/npm install failed/);
    expect(readUpdateHistory(recordsOf(updater, stateRoot)).at(-1))
      .toMatchObject({ kind: "rolled-back", from: "2.0.0", to: "1.0.0" });
  });

  it("holds a version whose health check failed back under the writable state root, and records the rollback", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const stateRoot = makeTmpDir();
    const updater = makeUpdater({
      installRoot,
      calls: [],
      latest: "2.0.0",
      stateRoot,
      healthChecker: async () => { throw new Error("boot smoke failed: /health never answered"); },
    });

    await expect(updater.performUpdate()).rejects.toThrow("/health never answered");
    const records = recordsOf(updater, stateRoot);
    expect(readUpdateHold(records)).toMatchObject({
      target: "2.0.0",
      step: "the post-update health check",
      rollback: "rolled-back",
    });
    expect(readUpdateHold(installRoot)).toBeNull();
    expect(readUpdateHistory(records).at(-1)).toMatchObject({ kind: "rolled-back" });
  });

  it("gives the package install the operator's AUTO_UPDATE_BUILD_TIMEOUT_MIN, not a fixed 5 minutes", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const calls: Call[] = [];
    const updater = makeUpdater({ installRoot, calls, latest: "2.0.0", buildTimeoutMin: 25 });

    await expect(updater.performUpdate()).resolves.toBe(true);
    const install = calls.find((c) => c.cmd === "npm" && c.args[0] === "install" && c.args[1]?.startsWith("strada-brain@"));
    expect(install?.timeoutMs).toBe(25 * 60_000);
  });

  it("gives the rollback's reinstall the same budget", async () => {
    const { installRoot } = makeOwnerTree({ installedVersion: "1.0.0" });
    const calls: Call[] = [];
    const updater = makeUpdater({ installRoot, calls, latest: "2.0.0", buildTimeoutMin: 25, failInstall: true });

    await expect(updater.performUpdate()).rejects.toThrow(/npm install failed/);
    const reinstall = calls.find((c) => c.cmd === "npm" && c.args.length === 1 && c.args[0] === "install");
    expect(reinstall?.timeoutMs).toBe(25 * 60_000);
  });

  // Review of 1dbe763e: every package install of a user wrote the one
  // <config root>/.strada/auto-update{,-hold}.json, while the update lock
  // beside it is keyed per install (COR-21). A failed health check in one
  // project held back and backed off the other, and `strada status` in one
  // showed the other's last update.
  it("keeps the history and hold of installs that share a config root apart", async () => {
    const stateRoot = makeTmpDir();
    const failing = makeOwnerTree({ installedVersion: "1.0.0" });
    const healthy = makeOwnerTree({ installedVersion: "1.0.0" });
    const a = makeUpdater({
      installRoot: failing.installRoot,
      calls: [],
      latest: "2.0.0",
      stateRoot,
      healthChecker: async () => { throw new Error("boot smoke failed: /health never answered"); },
    });
    const b = makeUpdater({ installRoot: healthy.installRoot, calls: [], latest: "2.0.0", stateRoot });
    await expect(a.performUpdate()).rejects.toThrow("/health never answered");

    try {
      const result = await b.requestImmediateCheck();
      expect(result).toMatchObject({ available: true, error: null });
      expect(result.heldBack).toBeUndefined();
      expect(readUpdateHistory(b.getUpdateRecordsRoot())).toEqual([]);
      expect(readUpdateHold(a.getUpdateRecordsRoot())).toMatchObject({ target: "2.0.0" });
    } finally {
      b.shutdown();
    }
  });
});
