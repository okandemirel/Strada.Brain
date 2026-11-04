/**
 * A PROJECT WITH NO REPOSITORY COSTS NO GIT PROCESS.
 *
 * The campaign's repository probes asked git first (`rev-parse HEAD`, then
 * `--is-inside-work-tree`) and looked for a `.git` only after git had failed,
 * so on a project with no repository every probe was two failing spawns.
 * Measured 2026-11-04 on the delivery bounce test: 707 of its 802 git
 * processes were these, and on the Windows runner, where a spawn costs tens of
 * milliseconds, the test ran past its 30 s budget on 2026-10-21 and again on
 * 2026-11-04. The answer is in the filesystem; git is asked only when a
 * repository can exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync as realExecFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { certainlyNoRepository, gitAbove } from "./project-repository.js";

/** Every git command the manager starts, sync or async. */
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record = (file: unknown, args: unknown): void => {
    if (file === "git") spawned.git.push(Array.isArray(args) ? args.map(String) : []);
  };
  const execFileSync = ((file: string, args?: readonly string[], ...rest: unknown[]) => {
    record(file, args);
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, ...rest);
  }) as typeof actual.execFileSync;
  const execFile = ((file: string, args?: unknown, ...rest: unknown[]) => {
    record(file, args);
    return (actual.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  }) as typeof actual.execFile;
  return { ...actual, execFileSync, execFile };
});

interface Probes {
  projectRevision(): string;
  projectRepoState(): "revision" | "none" | "unknown";
  projectRevisionAsync(): Promise<string>;
  projectRepoStateAsync(): Promise<"revision" | "none" | "unknown">;
}

describe("repository probes on a project with no repository", () => {
  let project: string;
  let state: string;
  const managers: CampaignManager[] = [];

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "repo-probe-project-"));
    state = mkdtempSync(join(tmpdir(), "repo-probe-state-"));
    writeFileSync(join(project, "Game.cs"), "class Game {}");
    spawned.git.length = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const m of managers.splice(0)) await m.dispose();
    rmSync(project, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const probesOf = (): Probes => {
    const m = new CampaignManager({
      storage: new CampaignStorage(join(state, "campaigns.db")),
      planner: { planMilestones: vi.fn(), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: new EventEmitter() as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: project,
    });
    managers.push(m);
    return m as unknown as Probes;
  };

  it("answers every probe without starting git", async () => {
    // The temp directory has no .git above it on any runner; say so, or the test proves nothing.
    expect(gitAbove(project)).toBe(false);
    const probes = probesOf();

    expect(probes.projectRevision()).toBe("");
    expect(probes.projectRepoState()).toBe("none");
    expect(await probes.projectRevisionAsync()).toBe("");
    expect(await probes.projectRepoStateAsync()).toBe("none");

    expect(spawned.git).toEqual([]);
  });

  it("still asks git when GIT_DIR points it at a repository elsewhere", () => {
    vi.stubEnv("GIT_DIR", join(state, "elsewhere.git"));
    expect(certainlyNoRepository(project)).toBe(false);
    probesOf().projectRevision();
    expect(spawned.git.length).toBeGreaterThan(0);
  });

  it("still asks git, and reads the revision, once the project is a repository", () => {
    const git = (...args: string[]): string =>
      realExecFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    git("init", "-q");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "first");
    const head = git("rev-parse", "HEAD").trim();

    const probes = probesOf();
    expect(probes.projectRevision()).toBe(head);
    expect(probes.projectRepoState()).toBe("revision");
    expect(spawned.git.length).toBeGreaterThan(0);
  });
});
