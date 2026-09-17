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
  channel?: "stable" | "latest";
}): AutoUpdater {
  const commandRunner = async (
    cmd: string,
    args: string[],
    _timeoutMs: number,
    cwd?: string,
  ): Promise<string> => {
    opts.calls.push({ cmd, args, cwd });
    if (cmd === "npm" && args[0] === "view") return `${opts.latest ?? "2.0.0"}\n`;
    if (cmd === "npm" && args[0] === "install" && args[1]?.startsWith("strada-brain@")) {
      opts.onInstall?.();
      if (opts.failInstall || opts.onInstall) throw new Error("npm install failed");
    }
    return "";
  };
  const updater = new AutoUpdater(
    { autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: opts.channel ?? "latest", notify: true, autoRestart: false } },
    { isIdle: () => true, getActiveChatIds: () => [], getLastActivityTime: () => 0, recordActivity: () => {} } as never,
    { hasRunningTasks: () => false },
    {
      installRoot: opts.installRoot,
      commandRunner,
      // Force the npm-local branch: the global root is somewhere else entirely.
      globalNpmRootResolver: () => path.join(os.tmpdir(), "definitely-not-here"),
      healthChecker: async () => {},
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
