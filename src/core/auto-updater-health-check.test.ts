/**
 * Post-update health check (14F6 / D75).
 *
 * The check after an update was `node dist/index.js --version`. That proves the
 * entrypoint parses — it does not start a channel, bind a port, open a
 * database, run a bootstrap stage or reach /health, which is exactly the class
 * of failure an update introduces. Every broken update since therefore passed
 * its own health check and stayed installed.
 *
 * `scripts/ci/boot-smoke.mjs` already does the real thing: it starts
 * `dist/index.js start --channel web` in a throwaway home, waits for /health to
 * answer ok, SIGTERMs it and requires a clean exit. The health check runs THAT
 * when it is present, and falls back to `--version` only when it is not.
 */

import { describe, it, expect, afterEach } from "vitest";
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
});

interface Call {
  cmd: string;
  args: string[];
}

function makeInstallRoot(opts: { dist: boolean; bootSmoke: boolean }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "strada-health-")));
  tmpDirs.push(dir);
  if (opts.dist) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "// built entrypoint");
  }
  if (opts.bootSmoke) {
    fs.mkdirSync(path.join(dir, "scripts", "ci"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "ci", "boot-smoke.mjs"), "// smoke");
  }
  return dir;
}

function makeUpdater(installRoot: string, calls: Call[], fail = false): AutoUpdater {
  return new AutoUpdater(
    { autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest", notify: false, autoRestart: false } },
    { isIdle: () => true, getActiveChatIds: () => [], getLastActivityTime: () => 0, recordActivity: () => {} } as never,
    { hasRunningTasks: () => false },
    {
      installRoot,
      commandRunner: async (cmd: string, args: string[]): Promise<string> => {
        calls.push({ cmd, args });
        if (fail) throw new Error("boot smoke failed: /health never answered");
        return "";
      },
    },
  );
}

const runHealthCheck = (updater: AutoUpdater): Promise<void> =>
  (updater as unknown as { runPostUpdateHealthCheck(): Promise<void> }).runPostUpdateHealthCheck();

describe("post-update health check", () => {
  it("runs the real boot smoke when the script is there", async () => {
    const root = makeInstallRoot({ dist: true, bootSmoke: true });
    const calls: Call[] = [];
    await runHealthCheck(makeUpdater(root, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe(path.join(root, "scripts", "ci", "boot-smoke.mjs"));
    // It must NOT settle for asking the binary its version.
    expect(calls[0]!.args).not.toContain("--version");
  });

  it("fails the update when the boot smoke fails", async () => {
    const root = makeInstallRoot({ dist: true, bootSmoke: true });
    const calls: Call[] = [];
    await expect(runHealthCheck(makeUpdater(root, calls, true))).rejects.toThrow(/boot smoke/);
  });

  it("falls back to --version only when no boot smoke ships with the install", async () => {
    const root = makeInstallRoot({ dist: true, bootSmoke: false });
    const calls: Call[] = [];
    await runHealthCheck(makeUpdater(root, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([path.join(root, "dist", "index.js"), "--version"]);
  });

  it("does nothing when there is no build to check", async () => {
    const root = makeInstallRoot({ dist: false, bootSmoke: true });
    const calls: Call[] = [];
    await runHealthCheck(makeUpdater(root, calls));
    expect(calls).toEqual([]);
  });

  it("ships the boot smoke in the published package, so npm installs get the real check", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { files?: string[]; scripts?: Record<string, string> };
    expect(pkg.scripts?.["smoke:boot"]).toBe("node scripts/ci/boot-smoke.mjs");
    expect(pkg.files ?? []).toContain("scripts/ci/boot-smoke.mjs");
  });
});
