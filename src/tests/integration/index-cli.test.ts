import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_ENTRY = path.join(process.cwd(), "src", "index.ts");

function runIndexCli(args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", INDEX_ENTRY, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  );
}

describe("index CLI lifecycle commands", () => {
  it("surfaces lifecycle commands in the root help output", () => {
    const output = runIndexCli(["--help"]);

    expect(output).toContain("status");
    expect(output).toContain("kill");
    expect(output).toContain("restart");
  });

  it("runs the status command without falling back to the launcher menu", () => {
    const output = runIndexCli(["status"]);

    expect(output).toContain("Install root:");
    expect(output).toContain("Version: v");
    expect(output).not.toContain("Strada Launcher");
  });

  it("exits non-zero when an async command fails (COR-8)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "strada-cli-exit-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        STRADA_SOURCE_CHECKOUT: "false",
        STRADA_HOME: home,
        UNITY_PROJECT_PATH: path.join(home, "no-such-project"),
      };
      for (const key of Object.keys(env)) {
        if (/_API_KEY$|_AUTH_TOKEN$/.test(key)) delete env[key];
      }
      // `supervise` loads the config inside its async action; an invalid one rejects it.
      const run = spawnSync(process.execPath, ["--import", "tsx", INDEX_ENTRY, "supervise"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
        timeout: 60_000,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Invalid configuration");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  it("shows dedicated help for kill and restart", () => {
    const killHelp = runIndexCli(["kill", "--help"]);
    const restartHelp = runIndexCli(["restart", "--help"]);

    expect(killHelp).toContain("Stop local Strada runtime processes for this install");
    expect(killHelp).not.toContain("Strada Launcher");
    expect(restartHelp).toContain("Restart Strada Brain for this install");
    expect(restartHelp).not.toContain("Strada Launcher");
  });
});
