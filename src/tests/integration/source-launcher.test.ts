import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("source launcher install-command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("installs user-local wrappers and updates the detected zsh profile idempotently", () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada launcher home "));
    const tempBin = path.join(tempHome, ".local", "bin");
    const outsideCwd = path.join(tempHome, "outside");
    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_BIN_HOME: tempBin,
      SHELL: "/bin/zsh",
    };

    tempDirs.push(tempHome);

    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "strada");
    rmSync(outsideCwd, { recursive: true, force: true });
    mkdirSync(outsideCwd, { recursive: true });

    const firstRun = execFileSync("bash", [scriptPath, "install-command"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });

    expect(firstRun).toContain("Installed user-local Strada commands:");
    expect(firstRun).toContain("Updated shell profile:");
    expect(firstRun).toContain("without changing directories");
    expect(firstRun).toContain(`${scriptPath} setup`);
    expect(firstRun).toContain(`${scriptPath} doctor`);
    expect(existsSync(path.join(tempBin, "strada"))).toBe(true);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(true);

    const zshrcPath = path.join(tempHome, ".zshrc");
    expect(existsSync(zshrcPath)).toBe(true);

    const firstProfile = readFileSync(zshrcPath, "utf8");
    expect(firstProfile).toContain("# >>> Strada command >>>");
    expect(firstProfile).toContain(`export PATH="${tempBin}:$PATH"`);

    const secondRun = execFileSync("bash", [scriptPath, "install-command"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(secondRun).toContain("Shell profile already contains the Strada PATH entry:");

    const secondProfile = readFileSync(zshrcPath, "utf8");
    expect(secondProfile.match(/# >>> Strada command >>>/g)?.length ?? 0).toBe(1);

    const helpOutput = execFileSync(path.join(tempBin, "strada"), ["--help"], {
      cwd: outsideCwd,
      env: {
        ...env,
        PATH: `${tempBin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(helpOutput).toContain("Usage: strada");
  });
});
