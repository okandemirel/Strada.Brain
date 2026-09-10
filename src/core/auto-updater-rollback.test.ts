import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoUpdater } from "./auto-updater.js";
import { readUpdateHistory } from "./update-history.js";

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
function fakeGit(opts: { commitDuringWindow: boolean }): {
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
        // to commit: the real window was nine minutes wide.
        if (args[0] === "run" && args[1] === "build") {
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

  it("still rolls back when nothing else committed", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const notices: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "strada-upd-"));
    await performUpdate(updater(git, notices, root));

    expect(git.resets).toEqual([PRE]);
    expect(git.head()).toBe(PRE);
    expect(readUpdateHistory(root).at(-1)).toMatchObject({ kind: "rolled-back", to: PRE });
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
