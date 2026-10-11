/**
 * SEC-22: a managed skill whose SKILL.md holds a scalar where a list belongs
 * (`bins: gh`) made `strada skill list` / `info` throw for every skill.
 * Real discovery and gating under a throwaway HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSkillCommands } from "./skill-cli.js";
import { approveWorkspaceSkill, assessWorkspaceSkillTrust } from "./skill-trust.js";

const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
let fakeHome: string;
let logs: string[];

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "strada-skill-cli-"));
  process.env["HOME"] = fakeHome;
  process.env["USERPROFILE"] = fakeHome;
  const dir = join(fakeHome, ".strada", "skills", "scalar-reqs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    "---\nname: scalar-reqs\nversion: 1.0.0\ndescription: d\nrequires:\n  bins: gh\n  env: API_TOKEN\n---\nbody\n",
    "utf-8",
  );
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fakeHome, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSkillCommands(program);
  await program.parseAsync(["node", "strada", "skill", ...args]);
}

describe("skill CLI with malformed requirements (SEC-22)", () => {
  it("skill list keeps listing every skill and shows the malformed one as gated", async () => {
    await run("list", "--json");
    const rows = JSON.parse(logs.join("\n")) as Array<{ name: string; tier: string; status: string; gateReason?: string }>;
    const bad = rows.find((row) => row.name === "scalar-reqs");
    expect(bad?.status).toBe("gated");
    expect(bad?.gateReason).toContain("requires.bins must be an array of strings");
    expect(bad?.gateReason).toContain("requires.env must be an array of strings");
    expect(rows.some((row) => row.tier === "bundled")).toBe(true);
  }, 30_000);

  it("skill info prints the skill instead of throwing", async () => {
    await run("info", "scalar-reqs");
    const text = logs.join("\n");
    expect(text).toContain("Gates: FAILED");
    expect(text).toContain('Requires bins: "gh"');
  }, 30_000);
});

// `strada` changes into its config root (~/.strada) before any command runs
// (initializeRuntimeEnvironment), so process.cwd() inside a command is never
// the directory the user typed `strada skill trust` in. The untrusted-skill
// warning tells them to run it "in <project>".
describe("skill trust / untrust default to the directory strada was started in", () => {
  let project: string;
  const launchedFrom = process.cwd();
  const savedLaunchCwd = process.env["STRADA_LAUNCH_CWD"];
  const skillFiles = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: demo\nversion: 1.0.0\ndescription: d\n---\nbody\n", "utf-8");
    await writeFile(join(dir, "index.js"), "export const tools = [];", "utf-8");
  };

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "strada-skill-cli-proj-"));
    await skillFiles(join(project, "skills", "demo"));
    // A managed skill of the same name: ~/.strada/skills is ~/.strada's own skills/ directory.
    await skillFiles(join(fakeHome, ".strada", "skills", "demo"));
    process.env["STRADA_LAUNCH_CWD"] = project;
    process.chdir(join(fakeHome, ".strada"));
  });

  afterEach(async () => {
    process.chdir(launchedFrom);
    if (savedLaunchCwd === undefined) delete process.env["STRADA_LAUNCH_CWD"];
    else process.env["STRADA_LAUNCH_CWD"] = savedLaunchCwd;
    await rm(project, { recursive: true, force: true });
  });

  it("skill trust approves the launch directory's skill, not ~/.strada's", async () => {
    await run("trust", "demo");
    expect(process.exitCode ?? 0).toBe(0);
    expect(logs.join("\n")).toContain(`approved for ${await realpath(project)}`);
    expect((await assessWorkspaceSkillTrust(project, join(project, "skills", "demo"), "demo")).trusted).toBe(true);
  }, 30_000);

  it("skill untrust revokes the launch directory's approval", async () => {
    await approveWorkspaceSkill(project, join(project, "skills", "demo"));
    await run("untrust", "demo");
    expect(logs.join("\n")).toContain("approval revoked");
    expect((await assessWorkspaceSkillTrust(project, join(project, "skills", "demo"), "demo")).trusted).toBe(false);
  }, 30_000);

  it("refuses ~/.strada as a project: its skills/ is the managed directory, so nothing would consult the record", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    await run("trust", "demo", "--project", join(fakeHome, ".strada"));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("managed skill directory");
    expect(logs.join("\n")).not.toContain("approved for");
    await expect(access(join(fakeHome, ".strada", "trusted-skills.db"))).rejects.toThrow();
  }, 30_000);
});
