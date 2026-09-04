import { describe, expect, it } from "vitest";
import { AutoUpdater } from "./auto-updater.js";

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

function updater(git: ReturnType<typeof fakeGit>, notices: string[]): AutoUpdater {
  const u = Object.create(AutoUpdater.prototype) as AutoUpdater;
  Object.assign(u, {
    installRoot: "/tmp/does-not-matter",
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
    await performUpdate(updater(git, notices));

    expect(git.resets).toEqual([]);
    expect(git.head()).toBe(MINE); // the commit survives
    expect(notices.join(" ")).toContain("rollback REFUSED");
  });

  it("still rolls back when nothing else committed", async () => {
    const git = fakeGit({ commitDuringWindow: false });
    const notices: string[] = [];
    await performUpdate(updater(git, notices));

    expect(git.resets).toEqual([PRE]);
    expect(git.head()).toBe(PRE);
  });
});
