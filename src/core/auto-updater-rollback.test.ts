import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoUpdater, spawnWithTimeout } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { readUpdateHistory, readUpdateHold } from "./update-history.js";

/**
 * Measured live 2026-09-04. The updater pulled at 12:21:27 (1b527dbf →
 * 235e5f9f), a commit landed at 12:23:50, and the failed post-update health
 * check ran `git reset --hard 1b527dbf` at 12:30:39 — destroying both the
 * pulled version bump and that commit. It survived only in the reflog, and
 * nothing in the run log said an update had been attempted at all.
 */
const PRE = "1b527dbfbe451abb35ebd81977c14c073340c204";
const POST = "235e5f9f0000000000000000000000000000aaaa";
const MINE = "dde791790000000000000000000000000000bbbb";

/** A git the test can move under the updater's feet, as a real commit does. */
function fakeGit(opts: { commitDuringWindow: boolean; rebuildFails?: boolean; resetFails?: boolean }): {
  run: (cmd: string, args: string[]) => Promise<string>;
  head: () => string;
  resets: string[];
} {
  let head = PRE;
  const resets: string[] = [];
  return {
    head: () => head,
    resets,
    run: async (cmd: string, args: string[]): Promise<string> => {
      if (cmd === "npm") {
        // The build is what fails, and it is also when the outside world gets
        // to commit: the real window was nine minutes wide. The rolled-back
        // source builds, as it did before the update.
        if (args[0] === "run" && args[1] === "build") {
          if (head === PRE && !opts.rebuildFails) return "";
          if (opts.commitDuringWindow) head = MINE;
          throw new Error("build failed");
        }
        return "";
      }
      if (cmd !== "git") return "";
      const sub = args.join(" ");
      if (sub.startsWith("rev-parse")) return head;
      if (sub.startsWith("status")) return "";
      if (sub.startsWith("pull")) {
        head = POST;
        return "";
      }
      if (sub.startsWith("reset --hard")) {
        if (opts.resetFails) throw new Error("fatal: Unable to create '.git/index.lock': File exists.");
        resets.push(args[2] ?? "");
        head = args[2] ?? head;
        return "";
      }
      if (sub.startsWith("remote")) return "origin";
      if (sub.startsWith("rev-list")) return "1";
      if (sub.startsWith("symbolic-ref") || sub.startsWith("branch")) return "main";
      return "";
    },
  };
}

function updater(git: ReturnType<typeof fakeGit>, notices: string[], installRoot = mkdtempSync(join(tmpdir(), "strada-upd-"))): AutoUpdater {
  const u = Object.create(AutoUpdater.prototype) as AutoUpdater;
  Object.assign(u, {
    installRoot,
    installMethod: "git",
    commandRunner: (cmd: string, args: string[]) => git.run(cmd, args),
    notifyFn: (m: string) => notices.push(m),
  });
  (u as unknown as { resolveGitUpstream(): Promise<{ remote: string; branch: string }> })
    .resolveGitUpstream = async () => ({ remote: "origin", branch: "main" });
  return u;
}

const performUpdate = async (u: AutoUpdater): Promise<void> => {
  try {
    await (u as unknown as { performGitUpdate(): Promise<boolean> }).performGitUpdate();
  } catch {
    /* the build failure is the point */
  }
};

describe("auto-update rollback", () => {
  it("REFUSES to reset when the branch moved after the pull", async () => {
    const git = fakeGit({ commitDuringWindow: true });
    const notices: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, notices, root));

    expect(git.resets).toEqual([]);
    expect(git.head()).toBe(MINE); // the commit survives
    expect(notices.join(" ")).toContain("rollback REFUSED");
    // `strada status` reads this — the refusal is on record, not only in chat
    expect(readUpdateHistory(root).at(-1)).toMatchObject({ kind: "rollback-refused", to: MINE });
  });

  it("rebuilds the rolled-back source after a failed build (COR-4)", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const calls: string[] = [];
    const u = updater(git, []);
    (u as unknown as { commandRunner: (cmd: string, args: string[]) => Promise<string> }).commandRunner = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return git.run(cmd, args);
    };
    await performUpdate(u);

    const reset = calls.indexOf(`git reset --hard ${PRE}`);
    expect(reset).toBeGreaterThan(-1);
    // dist/ holds whatever the failed build emitted until the old source is built again.
    expect(calls.slice(reset + 1)).toContain("npm run build");
  });

  it("still rolls back when nothing else committed", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const notices: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, notices, root));

    expect(git.resets).toEqual([PRE]);
    expect(git.head()).toBe(PRE);
    expect(readUpdateHistory(root).at(-1)).toMatchObject({ kind: "rolled-back", to: PRE });
  });

  // `strada status` reads the last event. A rollback whose rebuild failed said
  // "rolled-back" while dist/ held the rejected build, and a reset that threw
  // left the update before it as the last word (audit core-bootstrap#5).
  it("records a rollback whose rebuild fails as failed, not rolled-back", async () => {
    const git = fakeGit({ commitDuringWindow: false, rebuildFails: true });
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, [], root));

    expect(git.resets).toEqual([PRE]);
    const last = readUpdateHistory(root).at(-1);
    expect(last).toMatchObject({ kind: "failed" });
    expect(last?.reason).toContain("rollback did not complete");
  });

  it("records a reset that throws as a failed rollback", async () => {
    const git = fakeGit({ commitDuringWindow: false, resetFails: true });
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, [], root));

    const last = readUpdateHistory(root).at(-1);
    expect(last).toMatchObject({ kind: "failed" });
    expect(last?.reason).toContain("index.lock");
  });
});

/**
 * Audit core-bootstrap#0 (2026-10-11). The update starts only on a clean
 * tree, but then runs for many minutes (pull, installs, build, boot smoke)
 * while agents and the operator keep working in the same checkout. A failed
 * step ran `git reset --hard` over whatever they had changed meanwhile: no
 * stash, no reflog entry, gone. Reproduced with real git and an npm whose
 * build edits a tracked file and fails. These tests use real git, too.
 */
describe("a rollback never discards uncommitted work", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    // The operator's own git config (pull.ff, signing, hooks) is not the test's.
    const empty = join(realpathSync(mkdtempSync(join(tmpdir(), "strada-upd-gitcfg-"))), "config");
    dirs.push(join(empty, ".."));
    writeFileSync(empty, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", empty);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** A checkout one commit behind its origin, as the daemon's is after every push. */
  function behindCheckout(): { checkout: string; seed: string; pre: string; next: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "strada-upd-git-")));
    dirs.push(base);
    const origin = join(base, "origin.git");
    const seed = join(base, "seed");
    const checkout = join(base, "checkout");
    git(base, "init", "-q", "--bare", "-b", "main", origin);
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    for (const repo of [seed]) {
      git(repo, "config", "user.name", "Strada Test");
      git(repo, "config", "user.email", "test@example.invalid");
    }
    writeFileSync(join(seed, ".gitignore"), ".strada/\n.strada-update.lock\nnode_modules/\n");
    writeFileSync(join(seed, "app.ts"), "export const version = 1;\n");
    writeFileSync(join(seed, "README.md"), "# app\n");
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    writeFileSync(join(seed, "package-lock.json"), JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app" } } }));
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "one");
    git(seed, "push", "-q", origin, "main");
    git(base, "clone", "-q", origin, checkout);
    git(checkout, "config", "user.name", "Strada Test");
    git(checkout, "config", "user.email", "test@example.invalid");
    writeFileSync(join(seed, "app.ts"), "export const version = 2;\n");
    git(seed, "commit", "-q", "-am", "two");
    git(seed, "push", "-q", origin, "main");
    return { checkout, seed, pre: git(checkout, "rev-parse", "HEAD"), next: git(seed, "rev-parse", "HEAD") };
  }

  function realUpdater(
    checkout: string,
    notices: string[],
    hooks: {
      npm?: (args: string[]) => Promise<string>;
      beforeGit?: (args: string[]) => void;
      healthChecker?: () => Promise<void>;
    } = {},
  ): AutoUpdater {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "strada-upd-state-")));
    dirs.push(stateRoot);
    const u = new AutoUpdater(
      {
        autoUpdate: {
          enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest", notify: true, autoRestart: false,
        },
      },
      { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry,
      { hasRunningTasks: () => false },
      {
        installRoot: checkout,
        stateRoot,
        commandRunner: async (cmd, args, timeoutMs, cwd) => {
          if (cmd === "npm") return (hooks.npm ?? (async () => ""))(args);
          if (cmd === "git") hooks.beforeGit?.(args);
          return spawnWithTimeout(cmd, args, timeoutMs, cwd);
        },
        sourceLauncherRefresher: async () => {},
        healthChecker: hooks.healthChecker ?? (async () => {}),
        isDaemonProcess: () => false,
      },
    );
    u.setNotifyFn((m) => notices.push(m));
    return u;
  }

  it("keeps an edit made while the build ran, and says the rollback was refused", async () => {
    const repo = behindCheckout();
    const notices: string[] = [];
    const edit = "# app\nhalf-done edit\n";
    let edited = false;
    const u = realUpdater(repo.checkout, notices, {
      npm: async (args) => {
        if (args[0] === "run" && args[1] === "build" && !edited) {
          // An agent working in the checkout during the update window.
          edited = true;
          writeFileSync(join(repo.checkout, "README.md"), edit);
          throw new Error("npm exited with code 2: src/app.ts(1,1): error TS1005: ';' expected.");
        }
        return "";
      },
    });

    await expect(u.performUpdate()).rejects.toThrow("TS1005");

    expect(readFileSync(join(repo.checkout, "README.md"), "utf8")).toBe(edit);
    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.next);
    expect(notices.join("\n")).toMatch(/rollback REFUSED[\s\S]*README\.md/);
    expect(readUpdateHistory(repo.checkout).at(-1)).toMatchObject({ kind: "rollback-refused" });
    expect(readUpdateHold(repo.checkout)).toMatchObject({ target: repo.next, rollback: "refused" });
  });

  // Review of 1dbe763e: after a refused rollback the checkout still holds the
  // failed commit, so the very next check found nothing newer and cleared the
  // hold as caught up. `strada status` lost "NOT rolled back", and the log
  // said the install already had what it held back.
  it("keeps the hold of a refused rollback until the checkout moves past the failed commit", async () => {
    const repo = behindCheckout();
    const u = realUpdater(repo.checkout, [], {
      npm: async (args) => {
        if (args[0] === "run" && args[1] === "build" && git(repo.checkout, "rev-parse", "HEAD") === repo.next) {
          writeFileSync(join(repo.checkout, "README.md"), "# app\nhalf-done edit\n");
          throw new Error("npm exited with code 2: src/app.ts(1,1): error TS1005: ';' expected.");
        }
        return "";
      },
    });
    await expect(u.performUpdate()).rejects.toThrow("TS1005");

    try {
      expect(await u.requestImmediateCheck()).toMatchObject({ available: false, error: null });
      expect(readUpdateHold(repo.checkout)).toMatchObject({ target: repo.next, rollback: "refused" });

      // The operator commits the edit and pulls a fix by hand.
      git(repo.checkout, "commit", "-q", "-am", "finish the edit");
      writeFileSync(join(repo.seed, "app.ts"), "export const version = 3;\n");
      git(repo.seed, "commit", "-q", "-am", "three");
      git(repo.seed, "push", "-q", git(repo.checkout, "remote", "get-url", "origin"), "main");
      git(repo.checkout, "pull", "-q", "--no-rebase", "origin", "main");

      expect(await u.requestImmediateCheck()).toMatchObject({ available: false, error: null });
      expect(readUpdateHold(repo.checkout)).toBeNull();
    } finally {
      u.shutdown();
    }
  });

  it("keeps an edit made during the health check to a file the update itself changed", async () => {
    const repo = behindCheckout();
    const edit = "export const version = 3; // work in progress\n";
    const u = realUpdater(repo.checkout, [], {
      healthChecker: async () => {
        writeFileSync(join(repo.checkout, "app.ts"), edit);
        throw new Error("boot smoke failed: /health never answered");
      },
    });

    await expect(u.performUpdate()).rejects.toThrow("/health never answered");

    expect(readFileSync(join(repo.checkout, "app.ts"), "utf8")).toBe(edit);
    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.next);
  });

  it("does not reset after a pull that never landed, so the edit the pull refused to overwrite survives", async () => {
    const repo = behindCheckout();
    const edit = "export const version = 1; // mine\n";
    const u = realUpdater(repo.checkout, [], {
      beforeGit: (args) => {
        if (args[0] === "pull") writeFileSync(join(repo.checkout, "app.ts"), edit);
      },
    });

    await expect(u.performUpdate()).rejects.toThrow(/would be overwritten/);

    expect(readFileSync(join(repo.checkout, "app.ts"), "utf8")).toBe(edit);
    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.pre);
    expect(readUpdateHistory(repo.checkout).at(-1)).toMatchObject({ kind: "failed" });
  });

  it("undoes the merge a conflicting pull left behind, without a reset", async () => {
    const repo = behindCheckout();
    writeFileSync(join(repo.checkout, "app.ts"), "export const version = 10;\n");
    git(repo.checkout, "commit", "-q", "-am", "an unpushed local commit");
    const local = git(repo.checkout, "rev-parse", "HEAD");
    const resets: string[][] = [];
    const u = realUpdater(repo.checkout, [], {
      beforeGit: (args) => {
        if (args[0] === "reset") resets.push(args);
      },
    });

    await expect(u.performUpdate()).rejects.toThrow(/conflict/i);

    expect(resets).toEqual([]);
    expect(() => git(repo.checkout, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(git(repo.checkout, "status", "--porcelain")).toBe("");
    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(local);
  });

  it("still rolls back over the lockfile its own npm install rewrote", async () => {
    const repo = behindCheckout();
    const lock = readFileSync(join(repo.checkout, "package-lock.json"), "utf8");
    const u = realUpdater(repo.checkout, [], {
      npm: async (args) => {
        if (args[0] === "install") writeFileSync(join(repo.checkout, "package-lock.json"), `${lock}\n`);
        if (args[0] === "run" && git(repo.checkout, "rev-parse", "HEAD") === repo.next) {
          throw new Error("npm exited with code 2: error TS2304");
        }
        return "";
      },
    });

    await expect(u.performUpdate()).rejects.toThrow("TS2304");

    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.pre);
    expect(readUpdateHistory(repo.checkout).at(-1)).toMatchObject({ kind: "rolled-back" });
  });

  // The opted-in stash named the updater's lock as an :(exclude), and git
  // refuses a pathspec naming an ignored path that exists: this checkout's
  // .gitignore lists the lock, and the update holds it the whole time. The
  // refusal came after the stash was saved, so every cycle failed with the
  // changes still in the tree and one more stray stash entry behind. Where
  // the lock is NOT ignored, the exclude must stay: `-u` would stash it away.
  it.each([
    ["ignores", ".strada/\n.strada-update.lock\nnode_modules/\n"],
    ["does not ignore", ".strada/\nnode_modules/\n"],
  ])("stashes and restores local changes when the operator opts in, and the checkout %s the lock the update holds", async (_how, gitignore) => {
    const repo = behindCheckout();
    const edit = "# app\nhalf-done edit\n";
    writeFileSync(join(repo.checkout, ".gitignore"), gitignore);
    writeFileSync(join(repo.checkout, "README.md"), edit);
    writeFileSync(join(repo.checkout, "notes.md"), "an untracked note\n");
    vi.stubEnv("STRADA_AUTO_UPDATE_STASH", "1");
    let lockAtPull: boolean | undefined;
    const u = realUpdater(repo.checkout, [], {
      beforeGit: (args) => {
        if (args[0] === "pull") lockAtPull = existsSync(join(repo.checkout, ".strada-update.lock"));
      },
    });

    await expect(u.performUpdate()).resolves.toBe(true);

    expect(lockAtPull).toBe(true); // never stashed out from under the update
    expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.next);
    expect(readFileSync(join(repo.checkout, "README.md"), "utf8")).toBe(edit);
    expect(readFileSync(join(repo.checkout, "notes.md"), "utf8")).toBe("an untracked note\n");
    expect(readFileSync(join(repo.checkout, ".gitignore"), "utf8")).toBe(gitignore);
    expect(git(repo.checkout, "stash", "list")).toBe("");
  });
});

/**
 * Measured 2026-09-07 01:40. "Auto-update rolling back … reason: the build
 * failed" — the fourth such line in three days — while `npm run build` passed
 * by hand every time. The failing command's output was thrown away, and the
 * step (dependencies or build) was not named.
 */
describe("a failed update names the step and keeps the command's words", () => {
  it("keeps the compiler's error text when the build fails", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const notices: string[] = [];
    const u = updater(git, notices);
    const logged: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    (u as unknown as { runCommand: (cmd: string, args: string[]) => Promise<string> }).runCommand = async (
      cmd,
      args,
    ) => {
      if (cmd === "npm" && args[0] === "run") {
        throw new Error("npm exited with code 2: src/x.ts(1,1): error TS2304: Cannot find name 'y'.");
      }
      return git.run(cmd, args);
    };
    const { getLoggerSafe } = await import("../utils/logger.js");
    const real = getLoggerSafe();
    const spy = real ? vi.spyOn(real, "warn").mockImplementation((msg: string, meta?: unknown) => {
      logged.push({ msg, meta: (meta ?? {}) as Record<string, unknown> });
      return real;
    }) : null;
    try {
      await performUpdate(u);
    } finally {
      spy?.mockRestore();
    }
    const failed = logged.find((l) => l.msg === "Auto-update step failed");
    expect(failed?.meta["step"]).toBe("npm run build");
    expect(String(failed?.meta["detail"])).toContain("TS2304");
  });

  it("blames npm install, not the build, when the dependencies fail", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const notices: string[] = [];
    const u = updater(git, notices);
    const logged: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    (u as unknown as { runCommand: (cmd: string, args: string[]) => Promise<string> }).runCommand = async (
      cmd,
      args,
    ) => {
      if (cmd === "npm" && args[0] === "install") throw new Error("Command timed out: npm install");
      return git.run(cmd, args);
    };
    const { getLoggerSafe } = await import("../utils/logger.js");
    const real = getLoggerSafe();
    const spy = real ? vi.spyOn(real, "warn").mockImplementation((msg: string, meta?: unknown) => {
      logged.push({ msg, meta: (meta ?? {}) as Record<string, unknown> });
      return real;
    }) : null;
    try {
      await performUpdate(u);
    } finally {
      spy?.mockRestore();
    }
    expect(logged.find((l) => l.msg === "Auto-update step failed")?.meta["step"]).toBe("npm install");
    expect(logged.find((l) => l.msg === "Auto-update rolling back")?.meta["reason"]).toBe("npm install failed");
  });
});

describe("the updater's own lock is not a local change", () => {
  it("does not stash when the only untracked path is .strada-update.lock", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const stashes: string[] = [];
    const run = git.run;
    git.run = async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") return "?? .strada-update.lock\n";
      if (cmd === "git" && args[0] === "stash") stashes.push(args.join(" "));
      return run(cmd, args);
    };
    await performUpdate(updater(git, []));
    expect(stashes).toEqual([]);
  });

  it("a dirty tree DEFERS the update by default: no stash, no pull (unattended safety 2026-09-10)", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const stashes: string[] = [];
    const pulls: string[][] = [];
    const run = git.run;
    git.run = async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") return " M src/a.ts\n?? .strada-update.lock\n";
      if (cmd === "git" && args[0] === "stash") stashes.push(args.join(" "));
      if (cmd === "git" && args[0] === "pull") pulls.push(args);
      return run(cmd, args);
    };
    delete process.env["STRADA_AUTO_UPDATE_STASH"];
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, [], root));
    expect(stashes).toEqual([]);
    expect(pulls).toEqual([]);
    expect(readUpdateHistory(root).map((e) => e.kind)).toEqual(["deferred"]);
  });

  it("stashes real changes only when the operator opts in (STRADA_AUTO_UPDATE_STASH=1), and leaves the lock out of the stash", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const stashes: string[] = [];
    const run = git.run;
    git.run = async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") return " M src/a.ts\n?? .strada-update.lock\n";
      if (cmd === "git" && args[0] === "stash") stashes.push(args.join(" "));
      return run(cmd, args);
    };
    process.env["STRADA_AUTO_UPDATE_STASH"] = "1";
    try {
      await performUpdate(updater(git, []));
    } finally {
      delete process.env["STRADA_AUTO_UPDATE_STASH"];
    }
    expect(stashes[0]).toContain("push -u");
    expect(stashes[0]).toContain(":(exclude).strada-update.lock");
  });
});

describe("the pull merges local commits instead of refusing", () => {
  // Measured 2026-09-07 07:50 (first cycle with the step logged): "git
  // exited with code 128 … hint: You have divergent branches" — the checkout
  // carried unpushed commits, origin carried a version bump, and a pull
  // without a strategy refused. That was the "build failed" of three days.
  it("passes --no-rebase", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const pulls: string[][] = [];
    const run = git.run;
    git.run = async (cmd, args) => {
      if (cmd === "git" && args[0] === "pull") pulls.push(args);
      return run(cmd, args);
    };
    await performUpdate(updater(git, []));
    expect(pulls[0]).toContain("--no-rebase");
  });
});
