/**
 * SEC-22: a managed skill whose SKILL.md holds a scalar where a list belongs
 * (`bins: gh`) made `strada skill list` / `info` throw for every skill.
 * Real discovery and gating under a throwaway HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSkillCommands } from "./skill-cli.js";

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
